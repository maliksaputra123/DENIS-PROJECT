// providers.js
// ── LAYER MULTI-PROVIDER ──────────────────────────────────────────────────────
// Semua provider di sini OpenAI-compatible, jadi dipanggil lewat fetch biasa —
// GAK butuh install SDK tambahan (groq-sdk / @google/genai udah gak dipake).
//
// Cara kerjanya: index.js manggil chatComplete('main'/'decider'/'eval', {...}).
// Kita coba provider paling atas dulu; kalau gagal / kena limit / lagi cooldown,
// otomatis turun ke provider berikutnya. Kalau semua gagal, baru throw.
//
// MAU NAMBAH / GANTI PROVIDER? Cukup tambahin blok baru di array PROVIDERS di
// bawah (asal endpoint-nya OpenAI-compatible: /chat/completions ala OpenAI).
// Contoh alternatif gratis-tanpa-CC lain: OpenRouter, GitHub Models.
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDERS = [
    {
        name: 'Groq',
        baseURL: 'https://api.groq.com/openai/v1',
        apiKey: process.env.GROQ_API_KEY,
        models: {
            main: 'qwen/qwen3-32b',
            decider: 'llama-3.1-8b-instant',
            eval: 'llama-3.1-8b-instant',
        },
        extraBody: {
            main: { reasoning_effort: 'none' },
        },
    },
    {
        name: 'Cerebras',
        baseURL: 'https://api.cerebras.ai/v1',
        apiKey: process.env.CEREBRAS_API_KEY,
        models: {
            main: 'llama-3.3-70b',
            decider: 'llama-3.3-70b',
            eval: 'llama-3.3-70b',
        },
    },
];

// ── RETRY CONFIG ──────────────────────────────────────────────────────────────
// MAX_RETRIES: berapa kali coba ulang sebelum nyerah & fallback ke provider lain.
// CAP_MS: batas atas waktu tunggu antar retry (biar gak nunggu terlalu lama).
// COOLDOWN_MS: kalau udah habis retry & masih gagal, skip provider ini selama ini.
const RETRY_CONFIG = {
    MAX_RETRIES: 2,
    CAP_MS: 8_000,
    COOLDOWN_MS: 60_000,
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const cooldowns = new Map();
const onCooldown = (name) => (cooldowns.get(name) || 0) > Date.now();

export function getProviderStatus() {
    return PROVIDERS.map(p => ({
        name: p.name,
        configured: !!p.apiKey,
        cooldownUntil: cooldowns.get(p.name) || 0,
    }));
}

async function callProvider(p, task, { messages, temperature, maxTokens }) {
    const model = p.models[task] || p.models.main;
    const body = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(p.extraBody?.[task] || {}),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    let res;
    try {
        res = await fetch(`${p.baseURL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${p.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }

    // Balikin status 429 biar bisa dihandle retry di luar
    if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after'));
        return { rateLimited: true, retryAfter: retryAfter > 0 ? retryAfter * 1000 : null };
    }

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('respons kosong');
    return { content, model };
}

// Wrapper dengan retry logic. Kalau 429, tunggu dulu (exponential backoff)
// sebelum nyoba lagi. Baru set cooldown & throw kalau retry habis.
async function callWithRetry(p, task, opts) {
    const { MAX_RETRIES, CAP_MS, COOLDOWN_MS } = RETRY_CONFIG;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const result = await callProvider(p, task, opts);

        if (!result.rateLimited) return result; // sukses, langsung balik

        // Kena 429 — hitung berapa lama nunggu
        // Exponential backoff: 1s → 2s → 4s, tapi di-cap & pakai retry-after
        // dari header kalau ada (Groq biasanya kirim ini, lebih akurat).
        const backoff = Math.min(1_000 * 2 ** attempt, CAP_MS);
        const waitMs = result.retryAfter ?? backoff;

        if (attempt < MAX_RETRIES) {
            console.warn(`[PROVIDER ${p.name}] 429 — tunggu ${Math.round(waitMs / 1000)}s lalu retry (${attempt + 1}/${MAX_RETRIES})...`);
            await sleep(waitMs);
        } else {
            // Udah habis retry, set cooldown biar request berikutnya skip langsung
            cooldowns.set(p.name, Date.now() + COOLDOWN_MS);
            throw new Error(`rate limit, udah retry ${MAX_RETRIES}x, cooldown ${COOLDOWN_MS / 1000}s`);
        }
    }
}

export async function chatComplete(task, opts) {
    const errors = [];

    for (const p of PROVIDERS) {
        if (!p.apiKey) { errors.push(`${p.name}: key belum di-set`); continue; }
        if (onCooldown(p.name)) {
            const secs = Math.ceil((cooldowns.get(p.name) - Date.now()) / 1000);
            errors.push(`${p.name}: cooldown ~${secs}s`);
            continue;
        }

        try {
            const { content, model } = await callWithRetry(p, task, opts);
            return { content, provider: p.name, model };
        } catch (err) {
            console.error(`[PROVIDER ${p.name}] ${err.message}`);
            errors.push(`${p.name}: ${err.message}`);
        }
    }

    throw new Error(`Semua provider gagal → ${errors.join(' | ')}`);
}