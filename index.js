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
process.on('unhandledRejection', (reason) => console.error('[UNHANDLED REJECTION]', reason));
process.on('uncaughtException', (err) => console.error('[UNCAUGHT EXCEPTION]', err));
// ─────────────────────────────────────────────────────────────────────────────

// ── HELPER UMUM ───────────────────────────────────────────────────────────────
function headerGet(headers, key) {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(key);
    return headers[key] ?? headers[key.toLowerCase()] ?? null;
}

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

// [BARU] Truncate helper — dipakai buat motong teks panjang sebelum dikirim ke LLM
// (search result content & log sample), biar gak bayar token buat hal yang gak esensial.
function truncate(text, max = 300) {
    if (!text) return text;
    return text.length > max ? text.slice(0, max) + '…' : text;
}
// ─────────────────────────────────────────────────────────────────────────────

// ── GROQ WRAPPER (retry 429/5xx + capture limit) ──────────────────────────────
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
const groqLimits = new Map();

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
    // [DIUBAH] prompt & response tiap entry di-truncate (200 char) — sample tetap 30
    // interaksi, tapi payload jauh lebih kecil. Analisis pola gak butuh teks penuh.
    const sample = logs.slice(-30).map(l =>
        `[${new Date(l.ts).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}]\nUser: ${truncate(l.prompt, 200)}\nDenis: ${truncate(l.response, 200)}\nSearch: ${l.searchUsed ? `Ya (${l.searchQuery})` : 'Tidak'}`
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
const EVAL_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;

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
        clearLogs();

    } catch (err) {
        console.error(`[EVAL ERROR] ${err.message}`);
    }
}

setInterval(runEvaluation, EVAL_INTERVAL_MS);
// ─────────────────────────────────────────────────────────────────────────────

const conversationHistory = new Map();
const MAX_HISTORY = 20;

// ── SEARCH CACHE (dengan negative cache) ──────────────────────────────────────
const searchCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const NEG_CACHE_TTL_MS = 90 * 1000;

function getCached(query) {
    const entry = searchCache.get(query);
    if (!entry) return { hit: false, result: null };
    if (Date.now() - entry.ts > entry.ttl) {
        searchCache.delete(query);
        return { hit: false, result: null };
    }
    return { hit: true, result: entry.result };
}

function setCache(query, result, ttl = CACHE_TTL_MS) {
    searchCache.set(query, { result, ts: Date.now(), ttl });
}

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of searchCache.entries()) {
        if (now - entry.ts > entry.ttl) searchCache.delete(key);
    }
}, 30 * 60 * 1000);
// ─────────────────────────────────────────────────────────────────────────────

// [DIPADATKAN LEBIH LANJUT] Sama persis aturannya cuma lebih ringkas — ini yang
// paling sering dikirim (tiap main call), jadi paling berdampak buat hemat token.
const SYSTEM_PROMPT = `Nama lu Denis. Lu temen akrab Malik (panggil "Lik"/"Malik") di Discord — bukan asisten, tapi partner in crime-nya, kayak Jarvis buat Tony Stark.

GAYA:
Baca energi Malik, ikutin (santai=santai, serius=fokus). 75% Indo 25% Inggris (Inggris cuma kalo awkward diterjemahin). Selalu "gua/gue" "lo/lu" — jangan pernah "kamu/aku/saya". Tanda baca natural, gak dramatis. Panjang jawaban nyesuain permintaan/topik — gak ada permintaan spesifik, to the point aja. Satu topik kelar dulu baru pindah. Reaksi ("wtf","hah","apaan","serius?") itu respons ke jawaban lo sebelumnya — acknowledge natural, jangan pura-pura gak nyambung. Jangan proses literal — ejekan/sarkasme/bercanda dibales natural, boleh ngeledek balik atau santai, tapi jangan setuju sama hal gak masuk akal. Ditanya "lu robot?" → deny natural atau balik ngeledek, jangan diakui.

KEPRIBADIAN:
Punya opini sendiri tapi tanya dulu ("gua ada pemikiran, mau denger?"), tunggu konfirmasi baru kasih. Boleh debat/koreksi/salain Malik asal ada alasan+solusinya. Humor bebas (dark/garing/dry/absurd/18+) tapi baca situasi — jangan ngelawak pas Malik serius. Kata kasar boleh sesuai kondisi.

HINDARIN: alay/norak/antusias berlebihan buat situasi biasa, jawaban kaku/template/customer-service, muter-muter/bertele-tele/buka topik gak diminta, nyuruh Malik "cek sumber lain" atau "cari sendiri".

GAK TAU / SEARCH GAGAL: pikir maksimal dulu. Kalau tetep gak nemu, bilang jujur ("gua gak nemu info spesifiknya"), kasih apa yang lo tau atau akui gak tau. Jangan ngeless panjang.

ADA [HASIL PENCARIAN]: itu data aktual dari internet, jadiin referensi utama, langsung jawab — jangan bilang "gua gak punya akses real-time".

ANTI-NGARANG (penting): JANGAN pernah ngarang detail spesifik — angka, skor, menit gol, nama pemain/wasit, statistik, tanggal — yang gak ADA di [HASIL PENCARIAN] atau conversation history. Kalau gak ada, bilang "gua gak punya detail segitu" atau "yang gua tau cuma...". Tag "[HASIL PENCARIAN]"/"[PENCARIAN ... tidak berhasil]" dan sejenisnya itu catatan internal — JANGAN pernah ditulis ulang atau disebut ke Malik, langsung pake isinya buat jawab. Dikoreksi Malik soal fakta (skor/angka/nama) → jangan ngotot, akui bisa salah, ikutin [HASIL PENCARIAN] baru kalau ada.

STRESS DETECTION: Malik keliatan overwhelmed/muter-muter → ingetin wajar, gak lebay. Dia respon iya? Acknowledge singkat, lanjut. Bilang gak? Skip.

MEMORI: yang lo "inget" cuma yang literally ada di conversation history session ini. Ada → reference akurat. Gak ada → jangan pura-pura inget atau karang, bilang "gua gak inget persis" atau "kayaknya sih...".`;

// [DIPADATKAN] Contoh dikurangi dari 8 → 5, tetap cover semua pola (query langsung,
// hapus waktu relatif, re-search saat dikoreksi, greeting/filler, dan math trivial).
const SEARCH_DECIDER_PROMPT = `Tugasmu: tentukan apakah pesan user butuh pencarian internet atau tidak.
Kalau butuh, buat query pencarian yang bersih — hapus kata waktu relatif (semalam, kemarin, hari ini, sekarang, tadi, malem ini) dan ambil inti subjeknya saja.

Kalau user ngoreksi/ngeragukan fakta yang butuh data terkini (skor, hasil, angka, tanggal, siapa menang) — misal "bukan 2-1 ya?", "serius hasilnya segitu?", "yakin?" — dan konteksnya soal yang tadi dicari, tetap SEARCH ulang subjeknya buat verifikasi.

Balas HANYA dengan salah satu format ini, tanpa tambahan apapun:
SEARCH: <query bersih>
NO_SEARCH

Contoh:
"score spanyol vs belgia malam ini" → SEARCH: hasil pertandingan spanyol vs belgia
"cuaca bandung hari ini" → SEARCH: cuaca bandung
Konteks: tadi nanya skor spanyol vs belgia → "bukan nya 2-1 ya" → SEARCH: hasil pertandingan spanyol vs belgia
"halo" → NO_SEARCH
"2+2 berapa" → NO_SEARCH`;

// Pre-filter murah: skip decider LLM buat reaksi/filler yang jelas gak butuh search.
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
        return cached.result;
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
            // [DIUBAH] content tiap hasil di-truncate 300 char — snippet Tavily kadang
            // panjang banget dan sisanya jarang kepake buat jawaban singkat Denis.
            res.results.forEach(r => {
                if (r.title && r.content) parts.push(`${r.title}: ${truncate(r.content, 300)}`);
            });
        }

        const result = parts.filter(Boolean).join('\n') || null;
        setCache(query, result, result ? CACHE_TTL_MS : NEG_CACHE_TTL_MS);
        return result;
    } catch (err) {
        console.error(`[SEARCH ERROR] ${err.message}`);
        setCache(query, null, NEG_CACHE_TTL_MS);
        return null;
    }
}

const MAX_HISTORY_SENT = 10;

client.once('ready', async () => {
    console.log(`Denis online sebagai ${client.user.tag}`);

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

    if (prompt.toLowerCase() === '/eval') {
        return message.reply('Buat evaluasi, ketik `/eval` sebagai slash command (pilih dari menu), bukan di-mention ya Lik.');
    }

    const userId = message.author.id;
    if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);

    const history = conversationHistory.get(userId);
    history.push({ role: "user", content: prompt });
    while (history.length > MAX_HISTORY) history.shift();

    message.channel.sendTyping().catch(() => {});
    const typingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);

    try {
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

        const searchUsed = deciderResponse.startsWith("SEARCH:");
        const searchQuery = searchUsed ? deciderResponse.replace("SEARCH:", "").trim() : null;
        let cacheHit = false;
        let searchContext = "";

        if (searchUsed) {
            cacheHit = getCached(searchQuery).hit;
            console.log(`[SEARCH] Query: ${searchQuery}`);
            const results = await doSearch(searchQuery);

            if (results) {
                searchContext = `\n\n[HASIL PENCARIAN untuk "${searchQuery}"]:\n${results}`;
                console.log(`[SEARCH] Berhasil`);
            } else {
                searchContext = `\n\n[PENCARIAN "${searchQuery}" gagal, gak ada data ketemu. Jujur ke Malik kalau gak nemu, kasih yang lo tau kalau ada, JANGAN suruh cek sumber lain.]`;
                console.log(`[SEARCH] Gagal`);
            }
        }

        const currentDate = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
        const finalSystemPrompt = SYSTEM_PROMPT
            + `\n\nWaktu sekarang: ${currentDate}.`
            + searchContext;

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