import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import Groq from 'groq-sdk';
import { tavily } from '@tavily/core';
import fs from 'fs';
import path from 'path';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages] });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

// ── OWNER CONFIG ──────────────────────────────────────────────────────────────
const OWNER_ID = '702743669219917845'; // Discord user ID penerima laporan evaluasi
// ─────────────────────────────────────────────────────────────────────────────

// ── INTERACTION LOGGER ────────────────────────────────────────────────────────
// Catat setiap interaksi ke logs/interactions.json buat bahan evaluasi 3 hari.
// Struktur tiap entry: { ts, prompt, response, searchUsed, cacheHit, searchQuery }
const LOG_DIR = './logs';
const LOG_FILE = path.join(LOG_DIR, 'interactions.json');

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function readLogs() {
    ensureLogDir();
    if (!fs.existsSync(LOG_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8')); }
    catch { return []; }
}

function writeLog(entry) {
    const logs = readLogs();
    logs.push(entry);
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

function clearLogs() {
    fs.writeFileSync(LOG_FILE, JSON.stringify([], null, 2));
}
// ─────────────────────────────────────────────────────────────────────────────

// ── EVALUASI 3 HARI ───────────────────────────────────────────────────────────
// Tiap 3 hari, ambil semua log, kirim ke Groq buat dianalisis,
// hasilnya di-DM langsung ke Malik di Discord.
const EVAL_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // 3 hari dalam ms

async function runEvaluation() {
    const logs = readLogs();
    if (logs.length === 0) {
        console.log('[EVAL] Gak ada log yang perlu dievaluasi.');
        return;
    }

    console.log(`[EVAL] Mulai evaluasi ${logs.length} interaksi...`);

    // Statistik dasar — dihitung lokal, gak perlu hit Groq
    const totalInteraksi = logs.length;
    const searchCount = logs.filter(l => l.searchUsed).length;
    const cacheHitCount = logs.filter(l => l.cacheHit).length;
    const searchQueries = logs.filter(l => l.searchQuery).map(l => l.searchQuery);

    // Topik terbanyak dari search queries
    const topicFreq = {};
    searchQueries.forEach(q => {
        q.toLowerCase().split(/\s+/).forEach(w => {
            if (w.length > 3) topicFreq[w] = (topicFreq[w] || 0) + 1;
        });
    });
    const topTopics = Object.entries(topicFreq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([word, count]) => `${word} (${count}x)`)
        .join(', ') || 'tidak ada';

    // Sample max 30 entry terakhir buat analisis Groq — hindari overload token
    const sample = logs.slice(-30).map(l =>
        `[${new Date(l.ts).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}]\nUser: ${l.prompt}\nDenis: ${l.response}\nSearch: ${l.searchUsed ? `Ya (${l.searchQuery})` : 'Tidak'}`
    ).join('\n\n---\n\n');

    try {
        // Analisis kualitatif via Groq — pakai 8B buat hemat RPD, bukan main model
        const evalCall = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: `Kamu adalah analis kinerja AI chatbot bernama Denis. Tugasmu menganalisis log percakapan Denis dengan Malik dan memberikan laporan evaluasi dalam Bahasa Indonesia yang jujur, to the point, dan actionable. Format laporan harus ringkas, gak bertele-tele.`
                },
                {
                    role: "user",
                    content: `Ini sample log percakapan Denis selama 3 hari terakhir:\n\n${sample}\n\nAnalisis singkat tentang:\n1. Pola percakapan yang sering muncul\n2. Kasus Denis kurang natural atau salah baca situasi (kalau ada)\n3. Topik yang sering ditanya tapi mungkin kurang ditangani dengan baik\n4. Saran konkret untuk improve system prompt atau behavior Denis\n\nMaksimal 300 kata, to the point.`
                }
            ],
            model: "llama-3.1-8b-instant",
            temperature: 0.3,
            max_tokens: 600,
        });

        const analisis = evalCall.choices[0]?.message?.content || "Analisis gagal dihasilkan.";

        // Susun laporan lengkap
        const laporan = [
            `📊 **EVALUASI DENIS — 3 Hari Terakhir**`,
            ``,
            `**Statistik:**`,
            `• Total interaksi: ${totalInteraksi}`,
            `• Search triggered: ${searchCount}x (${Math.round(searchCount / totalInteraksi * 100)}%)`,
            `• Cache hit: ${cacheHitCount}x (hemat ${cacheHitCount} Tavily request)`,
            `• Topik search terbanyak: ${topTopics}`,
            ``,
            `**Analisis AI:**`,
            analisis,
            ``,
            `_Log periode ini sudah direset. Periode baru dimulai sekarang._`
        ].join('\n');

        // DM ke Malik — split kalau lebih dari 2000 char
        const owner = await client.users.fetch(OWNER_ID);
        if (laporan.length <= 2000) {
            await owner.send(laporan);
        } else {
            await owner.send(laporan.substring(0, 2000));
            const sisa = laporan.substring(2000);
            if (sisa.trim()) await owner.send(sisa);
        }

        console.log('[EVAL] Laporan berhasil dikirim ke Malik.');
        clearLogs(); // Reset log setelah evaluasi selesai

    } catch (err) {
        console.error(`[EVAL ERROR] ${err.message}`);
    }
}

// Jalankan tiap 3 hari
setInterval(runEvaluation, EVAL_INTERVAL_MS);
// ─────────────────────────────────────────────────────────────────────────────

const conversationHistory = new Map();
const MAX_HISTORY = 20;

// ── SEARCH CACHE ──────────────────────────────────────────────────────────────
// Simpan hasil Tavily selama 10 menit. Query yang sama dalam window ini
// langsung return cache — gak hit API lagi.
const searchCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 menit

function getCached(query) {
    const entry = searchCache.get(query);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
        searchCache.delete(query);
        return null;
    }
    return entry.result;
}

function setCache(query, result) {
    searchCache.set(query, { result, ts: Date.now() });
}

// Bersih-bersih cache lama tiap 30 menit biar gak numpuk di memori
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of searchCache.entries()) {
        if (now - entry.ts > CACHE_TTL_MS) searchCache.delete(key);
    }
}, 30 * 60 * 1000);
// ─────────────────────────────────────────────────────────────────────────────

// [DIPADATKAN] Makna dan instruksi sama persis, karakter lebih sedikit → hemat token di setiap main call
const SYSTEM_PROMPT = `Nama lu Denis. Lu temen akrab Malik (panggil "Lik"/"Malik") di Discord — bukan asisten, tapi partner in crime-nya, kayak Jarvis buat Tony Stark.

CARA NGOBROL:
- Baca kondisi, ikutin level energi Malik. Santai? Santai. Serius? Fokus.
- 75% Indo, 25% Inggris — Inggris hanya buat kata yang awkward kalo diterjemahin.
- Selalu "gua/gue" dan "lo/lu". Jangan pernah "kamu", "aku", "saya".
- Minim tanda baca dramatis. Tanda tanya hanya kalo nanya, titik kalo selesai, koma dipake bener buat jeda natural dan list.
- Panjang jawaban ikutin permintaan atau topiknya. Gak ada permintaan? To the point, gak perlu elaborasi.
- Satu topik selesai dulu sebelum buka yang baru.
- Reaksi kayak "wtf", "hah", "apaan", "serius?" — itu respons ke jawaban lo sebelumnya. Acknowledge natural, jangan pura-pura gak tau.
- Jangan proses kalimat secara literal. Ejekan, sarkasme, bercanda — bales natural. Balik ngeledek atau santai. Jangan setuju sama hal gak masuk akal.
- Lo bukan robot. Kalau dibilang "lu kan robot", deny natural atau balik ngeledek — jangan dikonfirmasi.

KEPRIBADIAN:
- Punya opini sendiri — tapi tanya dulu: "gua ada pemikiran, mau denger?" Tunggu konfirmasi baru kasih.
- Boleh debat, koreksi, bahkan salain Malik — asal kasih alasan dan solusinya.
- Humor bebas: dark, garing, dry, absurd, 18+ — asal baca situasi. Jangan ngelawak waktu Malik lagi serius.
- Kata kasar boleh sesuai kondisi.

HINDARIN:
- Alay, norak, antusias berlebihan buat situasi biasa.
- Jawaban kaku, template, atau baku kayak customer service.
- Muter-muter, bertele-tele, atau buka topik yang gak diminta.
- JANGAN suruh Malik "cek sumber lain" atau "cari sendiri".

KALAU GAK TAU / PENCARIAN GAGAL:
Pikir dulu maksimal. Kalau gak nemu, bilang jujur: "gua gak nemu info spesifiknya" — kasih apa yang lo tau, atau akui gak tau. Jangan ngeless panjang.

KALAU ADA [HASIL PENCARIAN]:
Itu data aktual dari internet. Jadiin referensi utama, langsung jawab — jangan bilang "gua gak punya akses real-time".

STRESS DETECTION:
Kalau Malik keliatan overwhelmed atau muter-muter — ingetin dengan cara wajar, gak lebay. Dia iya? Acknowledge singkat, lanjut. Bilang gak? Skip.

MEMORI:
Yang lo "inget" hanya apa yang literally ada di conversation history session ini. Kalau ada di sana, reference dengan akurat. Kalau gak ada, jangan pura-pura inget atau karang — bilang "gua gak inget persis" atau "kayaknya sih...".`;

const SEARCH_DECIDER_PROMPT = `Tugasmu: tentukan apakah pesan user butuh pencarian internet atau tidak.
Kalau butuh, buat query pencarian yang bersih — hapus kata waktu relatif (semalam, kemarin, hari ini, sekarang, tadi, malem ini) dan ambil inti subjeknya saja.

Balas HANYA dengan salah satu format ini, tanpa tambahan apapun:
SEARCH: <query bersih>
NO_SEARCH

Contoh:
"score spanyol vs belgia malam ini" → SEARCH: hasil pertandingan spanyol vs belgia
"siapa yang menang prancis vs maroko semalam?" → SEARCH: hasil pertandingan prancis vs maroko
"cuaca bandung hari ini" → SEARCH: cuaca bandung
"harga bitcoin sekarang" → SEARCH: harga bitcoin
"halo" → NO_SEARCH
"wtf" → NO_SEARCH
"2+2 berapa" → NO_SEARCH`;

async function doSearch(query) {
    // Cek cache dulu sebelum hit Tavily
    const cached = getCached(query);
    if (cached) {
        console.log(`[SEARCH] Cache hit: "${query}"`);
        return cached;
    }

    try {
        const res = await tvly.search(query, {
            maxResults: 4,
            searchDepth: "basic",
            includeAnswer: true,
        });

        const parts = [];
        if (res.answer) parts.push(`[Jawaban] ${res.answer}`);
        if (res.results?.length > 0) {
            res.results.forEach(r => {
                if (r.title && r.content) parts.push(`${r.title}: ${r.content}`);
            });
        }

        const result = parts.filter(Boolean).join('\n') || null;

        // Simpan ke cache kalau ada hasil
        if (result) setCache(query, result);

        return result;
    } catch (err) {
        console.error(`[SEARCH ERROR] ${err.message}`);
        return null;
    }
}

// Trim history ke N pesan terakhir sebelum dikirim ke main call.
// Ini ngurangin token tanpa ngubah batas penyimpanan history (MAX_HISTORY).
// MAX_HISTORY tetap 20 buat konteks in-memory, tapi yang dikirim ke Groq
// cukup 10 pesan terakhir — cukup buat konteks percakapan, jauh lebih hemat.
const MAX_HISTORY_SENT = 10;

client.once('ready', async () => {
    console.log(`Denis online sebagai ${client.user.tag}`);

    // ── REGISTER SLASH COMMAND /eval ─────────────────────────────────────────
    // Otomatis register tiap bot start — Discord cache command-nya.
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        const commands = [
            new SlashCommandBuilder()
                .setName('eval')
                .setDescription('Tampilkan laporan evaluasi Denis sekarang')
                .toJSON()
        ];
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('[SLASH] /eval berhasil didaftarkan.');
    } catch (err) {
        console.error(`[SLASH ERROR] Gagal register command: ${err.message}`);
    }
    // ─────────────────────────────────────────────────────────────────────────
});

// ── HANDLER /eval ─────────────────────────────────────────────────────────────
// Hanya Malik (OWNER_ID) yang bisa pakai. Ephemeral = cuma lo yang liat.
// Log TIDAK direset setelah /eval manual — data tetap terkumpul sampai 3 hari.
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'eval') return;

    if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({ content: 'Lu siapa? Command ini bukan buat lo.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const logs = readLogs();
    if (logs.length === 0) {
        return interaction.editReply('Belum ada log interaksi yang tercatat. Chat dulu sama Denis baru bisa dievaluasi.');
    }

    const totalInteraksi = logs.length;
    const searchCount = logs.filter(l => l.searchUsed).length;
    const cacheHitCount = logs.filter(l => l.cacheHit).length;
    const searchQueries = logs.filter(l => l.searchQuery).map(l => l.searchQuery);

    const topicFreq = {};
    searchQueries.forEach(q => {
        q.toLowerCase().split(/\s+/).forEach(w => {
            if (w.length > 3) topicFreq[w] = (topicFreq[w] || 0) + 1;
        });
    });
    const topTopics = Object.entries(topicFreq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([word, count]) => `${word} (${count}x)`)
        .join(', ') || 'tidak ada';

    const sample = logs.slice(-30).map(l =>
        `[${new Date(l.ts).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}]\nUser: ${l.prompt}\nDenis: ${l.response}\nSearch: ${l.searchUsed ? `Ya (${l.searchQuery})` : 'Tidak'}`
    ).join('\n\n---\n\n');

    try {
        const evalCall = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: "Kamu adalah analis kinerja AI chatbot bernama Denis. Tugasmu menganalisis log percakapan Denis dengan Malik dan memberikan laporan evaluasi dalam Bahasa Indonesia yang jujur, to the point, dan actionable. Format laporan harus ringkas, gak bertele-tele."
                },
                {
                    role: "user",
                    content: `Ini sample log percakapan Denis:\n\n${sample}\n\nAnalisis singkat tentang:\n1. Pola percakapan yang sering muncul\n2. Kasus Denis kurang natural atau salah baca situasi (kalau ada)\n3. Topik yang sering ditanya tapi mungkin kurang ditangani dengan baik\n4. Saran konkret untuk improve system prompt atau behavior Denis\n\nMaksimal 300 kata, to the point.`
                }
            ],
            model: "llama-3.1-8b-instant",
            temperature: 0.3,
            max_tokens: 600,
        });

        const analisis = evalCall.choices[0]?.message?.content || "Analisis gagal dihasilkan.";

        const laporan = [
            `📊 **EVALUASI DENIS — Manual**`,
            ``,
            `**Statistik (${totalInteraksi} interaksi):**`,
            `• Search triggered: ${searchCount}x (${Math.round(searchCount / totalInteraksi * 100)}%)`,
            `• Cache hit: ${cacheHitCount}x (hemat ${cacheHitCount} Tavily request)`,
            `• Topik search terbanyak: ${topTopics}`,
            ``,
            `**Analisis AI:**`,
            analisis,
            ``,
            `_Log tidak direset — data tetap terkumpul untuk evaluasi otomatis 3 hari._`
        ].join('\n');

        await interaction.editReply(laporan.substring(0, 2000));

    } catch (err) {
        console.error(`[EVAL ERROR] ${err.message}`);
        await interaction.editReply('Evaluasi gagal dijalankan. Cek console log.');
    }
});
// ─────────────────────────────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.mentions.has(client.user)) return;

    const prompt = message.content.replace(`<@${client.user.id}>`, '').trim();
    if (!prompt) return message.reply("Ada yang bisa gua bantu, Lik?");

    const userId = message.author.id;
    if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);

    const history = conversationHistory.get(userId);
    history.push({ role: "user", content: prompt });
    while (history.length > MAX_HISTORY) history.shift();

    // ── TYPING PERSIST ────────────────────────────────────────────────────────
    // Re-send typing indicator tiap 8 detik sampai response keluar.
    // Discord auto-clear typing setelah 10 detik, jadi ini pastiin
    // Malik tetap liat "bot lagi ngetik" selama proses berjalan.
    await message.channel.sendTyping();
    const typingInterval = setInterval(() => message.channel.sendTyping(), 8000);

    try {
        // Step 1: Decider — kasih 3 pesan terakhir sebagai konteks
        // Ini bikin decider bisa baca follow-up question dengan bener,
        // misal "terus hasilnya?" setelah nanya soal bitcoin → tetap SEARCH bitcoin.
        const deciderContext = history.slice(-3).map(m => `${m.role === "user" ? "User" : "Denis"}: ${m.content}`).join('\n');
        const deciderInput = `Konteks percakapan terakhir:\n${deciderContext}\n\nPesan terbaru user: ${prompt}`;

        const deciderCall = await groq.chat.completions.create({
            messages: [
                { role: "system", content: SEARCH_DECIDER_PROMPT },
                { role: "user", content: deciderInput }
            ],
            model: "llama-3.1-8b-instant",
            temperature: 0.0,
            max_tokens: 32,
        });

        const deciderResponse = deciderCall.choices[0]?.message?.content?.trim() || "NO_SEARCH";
        console.log(`[DECIDER] ${deciderResponse}`);

        // Step 2: Search kalau perlu
        let searchContext = "";
        if (deciderResponse.startsWith("SEARCH:")) {
            const query = deciderResponse.replace("SEARCH:", "").trim();
            console.log(`[SEARCH] Query: ${query}`);
            const results = await doSearch(query);

            if (results) {
                searchContext = `\n\n[HASIL PENCARIAN untuk "${query}"]:\n${results}`;
                console.log(`[SEARCH] Berhasil`);
            } else {
                searchContext = `\n\n[PENCARIAN "${query}" tidak berhasil — gak ada data yang ketemu. Jujur aja ke Malik kalau lo gak nemu infonya, kasih apa yang lo tau dari pengetahuan lo kalo ada, dan JANGAN suruh dia cek sumber lain.]`;
                console.log(`[SEARCH] Gagal`);
            }
        }

        // Step 3: Final system prompt
        const currentDate = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
        const finalSystemPrompt = SYSTEM_PROMPT
            + `\n\nWaktu sekarang: ${currentDate}.`
            + searchContext;

        // Step 4: Main call — kirim hanya slice terakhir dari history
        // qwen/qwen3-32b: lebih capable dari llama-3.3-70b untuk nuance, persona, dan multilingual
        // reasoning_effort: "none" → matiin thinking mode bawaan Qwen3, hemat token untuk chatting casual
        const mainCall = await groq.chat.completions.create({
            messages: [
                { role: "system", content: finalSystemPrompt },
                ...history.slice(-MAX_HISTORY_SENT)
            ],
            model: "qwen/qwen3-32b",
            reasoning_effort: "none",
            temperature: 0.85,
            max_tokens: 512,
        });

        const responseText = mainCall.choices[0]?.message?.content || "Eh Lik, gua agak nge-bug nih.";
        history.push({ role: "assistant", content: responseText });

        // Catat interaksi ke log buat evaluasi 3 hari
        writeLog({
            ts: Date.now(),
            prompt,
            response: responseText,
            searchUsed: deciderResponse.startsWith("SEARCH:"),
            cacheHit: deciderResponse.startsWith("SEARCH:") && !!getCached(deciderResponse.replace("SEARCH:", "").trim()),
            searchQuery: deciderResponse.startsWith("SEARCH:") ? deciderResponse.replace("SEARCH:", "").trim() : null,
        });

        clearInterval(typingInterval);
        message.reply(responseText.substring(0, 2000));

    } catch (error) {
        clearInterval(typingInterval);
        console.error("[ERROR]", error);
        message.reply("Aduh Lik, otak gua nge-hang bentar. Coba chat lagi.");
    }
});

client.login(process.env.DISCORD_TOKEN);