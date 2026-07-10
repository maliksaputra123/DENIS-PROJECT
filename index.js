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

// ── GLOBAL SAFETY NET ─────────────────────────────────────────────────────────
// Biar bot gak diem-diem mati kalau ada promise/error yang lolos.
process.on('unhandledRejection', (reason) => console.error('[UNHANDLED REJECTION]', reason));
process.on('uncaughtException', (err) => console.error('[UNCAUGHT EXCEPTION]', err));
// ─────────────────────────────────────────────────────────────────────────────

// ── HELPER UMUM ───────────────────────────────────────────────────────────────
// Ambil value header baik dari Headers (fetch) maupun plain object (APIError).
function headerGet(headers, key) {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(key);
    return headers[key] ?? headers[key.toLowerCase()] ?? null;
}

// Pecah teks jadi potongan <=2000 char, usahain motong di newline biar rapi.
function splitMessage(text, max = 2000) {
    if (text.length <= max) return [text];
    const chunks = [];
    let current = "";
    for (const line of text.split('\n')) {
        if (current.length + line.length + 1 > max) {
            if (current) chunks.push(current);
            if (line.length > max) {
                for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
                current = "";
            } else {
                current = line;
            }
        } else {
            current = current ? current + '\n' + line : line;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}
// ─────────────────────────────────────────────────────────────────────────────

// ── GROQ WRAPPER (retry 429/5xx + capture limit) ──────────────────────────────
// Semua call ke Groq lewat sini. Otomatis retry pas kena rate limit (hormatin
// header retry-after) atau error server, sekalian nangkep sisa kuota dari header.
async function groqCreate(params, { retries = 3 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const { data, response } = await groq.chat.completions.create(params).withResponse();
            if (params.model) captureGroqLimits(params.model, response);
            return data;
        } catch (err) {
            lastErr = err;
            const status = err?.status;
            if (status === 429 && attempt < retries) {
                const retryAfter = parseFloat(headerGet(err?.headers, 'retry-after'));
                const waitMs = Math.min((retryAfter > 0 ? retryAfter : 2 ** attempt) * 1000, 30000);
                console.warn(`[GROQ 429] attempt ${attempt + 1}/${retries}, nunggu ${(waitMs / 1000).toFixed(1)}s`);
                await new Promise(r => setTimeout(r, waitMs));
                continue;
            }
            if (status >= 500 && attempt < retries) {
                const waitMs = (2 ** attempt) * 1000;
                console.warn(`[GROQ ${status}] attempt ${attempt + 1}/${retries}, nunggu ${(waitMs / 1000).toFixed(1)}s`);
                await new Promise(r => setTimeout(r, waitMs));
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}
// ─────────────────────────────────────────────────────────────────────────────

// ── INTERACTION LOGGER (append-only JSONL) ────────────────────────────────────
// Ditulis append-only biar gak baca-tulis seluruh file tiap pesan (hemat I/O,
// gak ada read-modify-write). readLogs tetap kompatibel sama format array lama.
const LOG_DIR = './logs';
const LOG_FILE = path.join(LOG_DIR, 'interactions.jsonl');

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function readLogs() {
    ensureLogDir();
    if (!fs.existsSync(LOG_FILE)) return [];
    try {
        const raw = fs.readFileSync(LOG_FILE, 'utf-8').trim();
        if (!raw) return [];
        // Fallback: kalau file lama masih format JSON array
        if (raw.startsWith('[')) {
            try { return JSON.parse(raw); } catch { /* lanjut parse per-line */ }
        }
        return raw.split('\n').map(line => {
            try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
    } catch { return []; }
}

function writeLog(entry) {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
}

function clearLogs() {
    fs.writeFileSync(LOG_FILE, '');
}
// ─────────────────────────────────────────────────────────────────────────────

// ── LIMIT MONITOR (Groq header + Tavily usage) ────────────────────────────────
// Groq nyimpen sisa kuota di response header tiap request (walau sukses).
// x-ratelimit-limit-requests = RPD (harian), remaining = sisa harian.
const groqLimits = new Map(); // model -> { limitReq, remainingReq, ts }

function captureGroqLimits(model, response) {
    try {
        const h = response?.headers;
        if (!h) return;
        const num = (k) => {
            const v = headerGet(h, k);
            if (v == null) return null;
            const n = parseInt(v, 10);
            return Number.isNaN(n) ? null : n;
        };
        groqLimits.set(model, {
            limitReq: num('x-ratelimit-limit-requests'),
            remainingReq: num('x-ratelimit-remaining-requests'),
            ts: Date.now(),
        });
    } catch { /* jangan sampai parsing header bikin bot crash */ }
}

function fmtGroqLine(model) {
    const l = groqLimits.get(model);
    if (!l || l.limitReq == null || l.remainingReq == null) {
        return `• ${model}: belum ke-capture (chat dulu biar ke-baca)`;
    }
    const used = l.limitReq - l.remainingReq;
    const pct = l.limitReq ? Math.round(used / l.limitReq * 100) : 0;
    return `• ${model}: ${used}/${l.limitReq} req harian (${pct}% kepake, sisa ${l.remainingReq})`;
}

// Tavily /usage — GET dengan Bearer API key + timeout 5 detik biar gak nge-gantung.
async function getTavilyUsage() {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    try {
        const res = await fetch('https://api.tavily.com/usage', {
            headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
            signal: controller.signal,
        });
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        console.error(`[TAVILY USAGE ERROR] ${err.message}`);
        return null;
    } finally {
        clearTimeout(t);
    }
}

function fmtTavilyLine(u) {
    if (!u?.key || u.key.limit == null) return `• Tavily: gagal ambil data usage`;
    const { usage: used, limit } = u.key;
    const pct = limit ? Math.round(used / limit * 100) : 0;
    return `• Tavily: ${used}/${limit} credit (${pct}% kepake, sisa ${limit - used})`;
}

// Susun blok "Limit / Kuota" buat ditempel ke laporan
async function buildLimitBlock() {
    const tavilyUsage = await getTavilyUsage();
    return [
        ``,
        `**Limit / Kuota:**`,
        fmtGroqLine("qwen/qwen3-32b"),
        fmtGroqLine("llama-3.1-8b-instant"),
        fmtTavilyLine(tavilyUsage),
    ].join('\n');
}
// ─────────────────────────────────────────────────────────────────────────────

// ── BUILDER LAPORAN EVALUASI (dipakai /eval manual & evaluasi otomatis) ────────
function buildStats(logs) {
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

    return { totalInteraksi, searchCount, cacheHitCount, topTopics };
}

async function analyzeLogsWithGroq(logs) {
    const sample = logs.slice(-30).map(l =>
        `[${new Date(l.ts).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}]\nUser: ${l.prompt}\nDenis: ${l.response}\nSearch: ${l.searchUsed ? `Ya (${l.searchQuery})` : 'Tidak'}`
    ).join('\n\n---\n\n');

    const evalCall = await groqCreate({
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

    return evalCall.choices[0]?.message?.content || "Analisis gagal dihasilkan.";
}
// ─────────────────────────────────────────────────────────────────────────────

// ── EVALUASI 3 HARI ───────────────────────────────────────────────────────────
const EVAL_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // 3 hari dalam ms

async function runEvaluation() {
    const logs = readLogs();
    if (logs.length === 0) {
        console.log('[EVAL] Gak ada log yang perlu dievaluasi.');
        return;
    }

    console.log(`[EVAL] Mulai evaluasi ${logs.length} interaksi...`);

    try {
        const { totalInteraksi, searchCount, cacheHitCount, topTopics } = buildStats(logs);
        const analisis = await analyzeLogsWithGroq(logs);
        const limitBlock = await buildLimitBlock();

        const laporan = [
            `📊 **EVALUASI DENIS — 3 Hari Terakhir**`,
            ``,
            `**Statistik:**`,
            `• Total interaksi: ${totalInteraksi}`,
            `• Search triggered: ${searchCount}x (${Math.round(searchCount / totalInteraksi * 100)}%)`,
            `• Cache hit: ${cacheHitCount}x (hemat ${cacheHitCount} Tavily request)`,
            `• Topik search terbanyak: ${topTopics}`,
            limitBlock,
            ``,
            `**Analisis AI:**`,
            analisis,
            ``,
            `_Log periode ini sudah direset. Periode baru dimulai sekarang._`
        ].join('\n');

        const owner = await client.users.fetch(OWNER_ID);
        for (const chunk of splitMessage(laporan)) {
            await owner.send(chunk);
        }

        console.log('[EVAL] Laporan berhasil dikirim ke Malik.');
        clearLogs(); // Reset log setelah evaluasi selesai

    } catch (err) {
        console.error(`[EVAL ERROR] ${err.message}`);
    }
}

setInterval(runEvaluation, EVAL_INTERVAL_MS);
// ─────────────────────────────────────────────────────────────────────────────

const conversationHistory = new Map();
const MAX_HISTORY = 20;

// ── SEARCH CACHE (dengan negative cache) ──────────────────────────────────────
// Simpan hasil Tavily 10 menit. Search yang GAGAL di-cache singkat (90 detik)
// biar query rusak yang sama gak ngehit Tavily terus-terusan.
const searchCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;  // 10 menit buat hasil sukses
const NEG_CACHE_TTL_MS = 90 * 1000;   // 90 detik buat hasil gagal/kosong

function getCached(query) {
    const entry = searchCache.get(query);
    if (!entry) return { hit: false, result: null };
    if (Date.now() - entry.ts > entry.ttl) {
        searchCache.delete(query);
        return { hit: false, result: null };
    }
    return { hit: true, result: entry.result }; // result bisa null (negative cache)
}

function setCache(query, result, ttl = CACHE_TTL_MS) {
    searchCache.set(query, { result, ts: Date.now(), ttl });
}

// Bersih-bersih cache lama tiap 30 menit biar gak numpuk di memori
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of searchCache.entries()) {
        if (now - entry.ts > entry.ttl) searchCache.delete(key);
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

ANTI-NGARANG (penting):
- JANGAN pernah ngarang detail spesifik: angka, skor, menit gol, nama pemain, nama wasit, statistik, tanggal. Kalau detail itu gak ADA di [HASIL PENCARIAN] atau conversation history, jangan disebut. Bilang "gua gak punya detail segitu" atau "yang gua tau cuma...".
- Sampaikan apa yang beneran ada di data. Jangan dilengkapin sendiri biar keliatan lengkap.
- Tag "[HASIL PENCARIAN]", "[PENCARIAN ... tidak berhasil]" dan sejenisnya itu catatan internal — JANGAN pernah ditulis ulang atau disebut ke Malik. Langsung pake isinya buat jawab.
- Kalau Malik ngoreksi fakta lo (skor/angka/nama), jangan ngotot. Akui bisa salah; kalau ada [HASIL PENCARIAN] baru, ikutin itu.

STRESS DETECTION:
Kalau Malik keliatan overwhelmed atau muter-muter — ingetin dengan cara wajar, gak lebay. Dia iya? Acknowledge singkat, lanjut. Bilang gak? Skip.

MEMORI:
Yang lo "inget" hanya apa yang literally ada di conversation history session ini. Kalau ada di sana, reference dengan akurat. Kalau gak ada, jangan pura-pura inget atau karang — bilang "gua gak inget persis" atau "kayaknya sih...".`;

const SEARCH_DECIDER_PROMPT = `Tugasmu: tentukan apakah pesan user butuh pencarian internet atau tidak.
Kalau butuh, buat query pencarian yang bersih — hapus kata waktu relatif (semalam, kemarin, hari ini, sekarang, tadi, malem ini) dan ambil inti subjeknya saja.

Kalau user ngoreksi/ngeragukan fakta yang butuh data terkini (skor, hasil, angka, tanggal, siapa menang) — misal "bukan 2-1 ya?", "serius hasilnya segitu?", "yakin?" — dan konteksnya soal yang tadi dicari, tetap SEARCH ulang subjeknya buat verifikasi.

Balas HANYA dengan salah satu format ini, tanpa tambahan apapun:
SEARCH: <query bersih>
NO_SEARCH

Contoh:
"score spanyol vs belgia malam ini" → SEARCH: hasil pertandingan spanyol vs belgia
"siapa yang menang prancis vs maroko semalam?" → SEARCH: hasil pertandingan prancis vs maroko
"cuaca bandung hari ini" → SEARCH: cuaca bandung
"harga bitcoin sekarang" → SEARCH: harga bitcoin
Konteks: tadi nanya skor spanyol vs belgia → "bukan nya 2-1 ya" → SEARCH: hasil pertandingan spanyol vs belgia
"halo" → NO_SEARCH
"wtf" → NO_SEARCH
"2+2 berapa" → NO_SEARCH`;

// Pre-filter murah: skip decider LLM buat reaksi/filler yang jelas gak butuh search.
// Sengaja konservatif — kata yang bisa jadi koreksi fakta (serius, yakin, masa, hah)
// TIDAK dimasukin, biar rule re-search di decider tetap jalan.
const TRIVIAL_WORDS = new Set([
    'wkwk', 'wkwkwk', 'wk', 'lol', 'lmao', 'wow', 'sip', 'siap', 'gas', 'yoi',
    'mantap', 'mantul', 'oke', 'ok', 'okay', 'nice', 'cool', 'hmm', 'hmmm',
    'gg', 'anjay', 'njir', 'wadaw', 'wah'
]);

function isTrivial(text) {
    const t = text.toLowerCase().replace(/[^\w\s]/g, '').trim();
    if (t.length <= 2) return true;
    const words = t.split(/\s+/);
    return words.length <= 2 && words.every(w => TRIVIAL_WORDS.has(w));
}

async function doSearch(query) {
    const cached = getCached(query);
    if (cached.hit) {
        console.log(`[SEARCH] Cache hit: "${query}"`);
        return cached.result; // bisa null kalau ini negative cache
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
        // Sukses → cache 10 menit. Kosong → negative cache 90 detik.
        setCache(query, result, result ? CACHE_TTL_MS : NEG_CACHE_TTL_MS);
        return result;
    } catch (err) {
        console.error(`[SEARCH ERROR] ${err.message}`);
        setCache(query, null, NEG_CACHE_TTL_MS); // negative cache biar gak spam Tavily
        return null;
    }
}

const MAX_HISTORY_SENT = 10;

client.once('ready', async () => {
    console.log(`Denis online sebagai ${client.user.tag}`);

    // ── REGISTER SLASH COMMAND /eval ─────────────────────────────────────────
    // Kalau GUILD_ID di-set di .env → daftar ke guild itu (update instan).
    // Kalau enggak → global (propagasi bisa sampai 1 jam).
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        const commands = [
            new SlashCommandBuilder()
                .setName('eval')
                .setDescription('Tampilkan laporan evaluasi Denis sekarang')
                .toJSON()
        ];
        if (process.env.GUILD_ID) {
            await rest.put(Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID), { body: commands });
            console.log('[SLASH] /eval didaftarkan ke guild (instan).');
        } else {
            await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
            console.log('[SLASH] /eval didaftarkan global (bisa lama propagasinya).');
        }
    } catch (err) {
        console.error(`[SLASH ERROR] Gagal register command: ${err.message}`);
    }
    // ─────────────────────────────────────────────────────────────────────────
});

// ── HANDLER /eval ─────────────────────────────────────────────────────────────
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

    try {
        const { totalInteraksi, searchCount, cacheHitCount, topTopics } = buildStats(logs);
        const analisis = await analyzeLogsWithGroq(logs);
        const limitBlock = await buildLimitBlock();

        const laporan = [
            `📊 **EVALUASI DENIS — Manual**`,
            ``,
            `**Statistik (${totalInteraksi} interaksi):**`,
            `• Search triggered: ${searchCount}x (${Math.round(searchCount / totalInteraksi * 100)}%)`,
            `• Cache hit: ${cacheHitCount}x (hemat ${cacheHitCount} Tavily request)`,
            `• Topik search terbanyak: ${topTopics}`,
            limitBlock,
            ``,
            `**Analisis AI:**`,
            analisis,
            ``,
            `_Log tidak direset — data tetap terkumpul untuk evaluasi otomatis 3 hari._`
        ].join('\n');

        // Split kalau >2000 char: chunk pertama editReply, sisanya followUp.
        const chunks = splitMessage(laporan);
        await interaction.editReply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp({ content: chunks[i], ephemeral: true });
        }

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

    // Guard: /eval itu slash command, bukan buat di-mention.
    if (prompt.toLowerCase() === '/eval') {
        return message.reply('Buat evaluasi, ketik `/eval` sebagai slash command (pilih dari menu), bukan di-mention ya Lik.');
    }

    const userId = message.author.id;
    if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);

    const history = conversationHistory.get(userId);
    history.push({ role: "user", content: prompt });
    while (history.length > MAX_HISTORY) history.shift();

    // ── TYPING PERSIST ────────────────────────────────────────────────────────
    message.channel.sendTyping().catch(() => {});
    const typingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);

    try {
        // Step 1: Decider — skip LLM kalau pesannya reaksi/filler sepele (hemat kuota).
        let deciderResponse;
        if (isTrivial(prompt)) {
            deciderResponse = "NO_SEARCH";
            console.log('[DECIDER] skip (trivial) → NO_SEARCH');
        } else {
            const deciderContext = history.slice(-3).map(m => `${m.role === "user" ? "User" : "Denis"}: ${m.content}`).join('\n');
            const deciderInput = `Konteks percakapan terakhir:\n${deciderContext}\n\nPesan terbaru user: ${prompt}`;

            const deciderCall = await groqCreate({
                messages: [
                    { role: "system", content: SEARCH_DECIDER_PROMPT },
                    { role: "user", content: deciderInput }
                ],
                model: "llama-3.1-8b-instant",
                temperature: 0.0,
                max_tokens: 32,
            });
            deciderResponse = deciderCall.choices[0]?.message?.content?.trim() || "NO_SEARCH";
            console.log(`[DECIDER] ${deciderResponse}`);
        }

        // Step 2: Search kalau perlu
        const searchUsed = deciderResponse.startsWith("SEARCH:");
        const searchQuery = searchUsed ? deciderResponse.replace("SEARCH:", "").trim() : null;
        let cacheHit = false;
        let searchContext = "";

        if (searchUsed) {
            cacheHit = getCached(searchQuery).hit; // cek SEBELUM doSearch biar metriknya akurat
            console.log(`[SEARCH] Query: ${searchQuery}`);
            const results = await doSearch(searchQuery);

            if (results) {
                searchContext = `\n\n[HASIL PENCARIAN untuk "${searchQuery}"]:\n${results}`;
                console.log(`[SEARCH] Berhasil`);
            } else {
                searchContext = `\n\n[PENCARIAN "${searchQuery}" tidak berhasil — gak ada data yang ketemu. Jujur aja ke Malik kalau lo gak nemu infonya, kasih apa yang lo tau dari pengetahuan lo kalo ada, dan JANGAN suruh dia cek sumber lain.]`;
                console.log(`[SEARCH] Gagal`);
            }
        }

        // Step 3: Final system prompt
        const currentDate = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
        const finalSystemPrompt = SYSTEM_PROMPT
            + `\n\nWaktu sekarang: ${currentDate}.`
            + searchContext;

        // Step 4: Main call
        const mainCall = await groqCreate({
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
            searchUsed,
            cacheHit,
            searchQuery,
        });

        clearInterval(typingInterval);
        message.reply(responseText.substring(0, 2000));

    } catch (error) {
        clearInterval(typingInterval);
        console.error("[ERROR]", error);
        message.reply("Aduh Lik, otak gua nge-hang bentar. Coba chat lagi.");
    }
});

client.login(process.env.DISCORD_TOKEN).catch((err) => {
    console.error('[LOGIN ERROR]', err.message);
    process.exit(1);
});