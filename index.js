import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import Groq from 'groq-sdk';
import { tavily } from '@tavily/core';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

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

client.once('ready', () => {
    console.log(`Denis online sebagai ${client.user.tag}`);
});

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

    try {
        await message.channel.sendTyping();

        // Step 1: Decider
        const deciderCall = await groq.chat.completions.create({
            messages: [
                { role: "system", content: SEARCH_DECIDER_PROMPT },
                { role: "user", content: prompt }
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
        const mainCall = await groq.chat.completions.create({
            messages: [
                { role: "system", content: finalSystemPrompt },
                ...history.slice(-MAX_HISTORY_SENT)
            ],
            model: "llama-3.3-70b-versatile",
            temperature: 0.85,
            max_tokens: 512,
        });

        const responseText = mainCall.choices[0]?.message?.content || "Eh Lik, gua agak nge-bug nih.";
        history.push({ role: "assistant", content: responseText });

        message.reply(responseText.substring(0, 2000));

    } catch (error) {
        console.error("[ERROR]", error);
        message.reply("Aduh Lik, otak gua nge-hang bentar. Coba chat lagi.");
    }
});

client.login(process.env.DISCORD_TOKEN);