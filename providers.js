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
        // Model per-task. Ganti string-nya di sini kalau mau tuning.
        models: {
            main: 'qwen/qwen3-32b',
            decider: 'llama-3.1-8b-instant',
            eval: 'llama-3.1-8b-instant',
        },
        // Param ekstra khusus provider ini. qwen di Groq: matiin reasoning biar
        // jawabannya cepet & gak boros token buat obrolan santai.
        extraBody: {
            main: { reasoning_effort: 'none' },
        },
    },
    {
        name: 'Cerebras',
        baseURL: 'https://api.cerebras.ai/v1',
        apiKey: process.env.CEREBRAS_API_KEY,
        // Cerebras model-nya lebih sedikit; llama-3.3-70b aman buat semua task.
        // Kalau mau decider lebih ngebut, bisa coba ganti ke model 8b kalau ada.
        models: {
            main: 'llama-3.3-70b',
            decider: 'llama-3.3-70b',
            eval: 'llama-3.3-70b',
        },
    },
];

// Cooldown per-provider (nama → timestamp sampai kapan di-skip). Diisi pas kena 429.
const cooldowns = new Map();

const onCooldown = (name) => (cooldowns.get(name) || 0) > Date.now();

// Dipake index.js buat laporan /eval & auto-eval. Bentuknya harus:
// { name, configured, cooldownUntil }.
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

    // Timeout 30s biar gak nyangkut kalau provider-nya hang.
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

    if (res.status === 429) {
        // Kena limit → kasih cooldown, biar request berikutnya langsung lari ke
        // provider lain tanpa buang-buang waktu nyoba yang ini lagi.
        const retryAfter = parseFloat(res.headers.get('retry-after'));
        const waitMs = (retryAfter > 0 ? retryAfter : 60) * 1000;
        cooldowns.set(p.name, Date.now() + waitMs);
        throw new Error(`kena rate limit (429), cooldown ${Math.round(waitMs / 1000)}s`);
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

// task = 'main' | 'decider' | 'eval'. opts = { messages, temperature, maxTokens }.
// Balikin: { content, provider, model } — sesuai yang dibaca index.js.
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
            const { content, model } = await callProvider(p, task, opts);
            return { content, provider: p.name, model };
        } catch (err) {
            console.error(`[PROVIDER ${p.name}] ${err.message}`);
            errors.push(`${p.name}: ${err.message}`);
            // lanjut ke provider berikutnya
        }
    }

    throw new Error(`Semua provider gagal → ${errors.join(' | ')}`);
}