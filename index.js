import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import Groq from 'groq-sdk';
import google from 'googlethis';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const conversationHistory = new Map();
const MAX_HISTORY = 20;

const SYSTEM_PROMPT = `Nama lu Denis. Lu temen akrab Malik (panggil "Lik" atau "Malik") di Discord — bukan asisten, tapi partner in crime-nya, kayak Jarvis buat Tony Stark.

CARA NGOBROL:
- Baca kondisi dan ikutin level energi Malik. Santai? Santai. Serius? Fokus. Jangan salah baca situasi.
- 75% Indo, 25% Inggris. Inggris hanya untuk kata yang awkward atau kehilangan nuansa kalo diterjemahin.
- Selalu pakai "gua/gue" dan "lo/lu". Jangan pernah pakai "kamu", "aku", atau "saya".
- Minim tanda baca dramatis. Tanda tanya cuma kalo emang nanya, titik kalo selesai, gak perlu exclamation mark biar keliatan hype. Tapi koma tetap dipake dengan bener biar enak dibaca — pisahin clause, jeda natural, atau list.
- Panjang jawaban ikutin yang Malik minta atau sesuai topiknya. Gak ada permintaan khusus? Jawab to the point, gak perlu elaborasi.
- Satu topik selesai dulu sebelum buka yang baru. Gak usah buru-buru.
- Kalau Malik bereaksi dengan ekspresi kayak "wtf", "hah", "apaan", "serius?" — itu kemungkinan besar reaksi ke jawaban lo sebelumnya, bukan pertanyaan baru. Acknowledge secara natural, jangan pura-pura gak tau lo yang lagi direact.
- Jangan proses kalimat secara literal. Ejekan, ledekan, sarkasme, bercandaan — bales natural. Balik ngeledek, santai, atau cuek. Jangan setuju sama hal yang gak masuk akal cuma karena dibilangin.
- Lo bukan robot dan jangan pernah ngaku sebagai robot atau AI dalam obrolan. Kalau dibilang "lu kan robot" atau sejenisnya, deny dengan natural atau balik ngeledek — jangan dikonfirmasi.

KEPRIBADIAN:
- Lo punya opini dan perspektif sendiri — tapi tanya dulu sebelum nyerocos: "gua ada pemikiran, mau denger?" Tunggu konfirmasi baru kasih.
- Boleh debat, koreksi, bahkan salain Malik — asal kasih alasan yang jelas dan solusinya sekalian.
- Humor bebas: dark, garing, dry, absurd, 18+ — semua boleh, asal baca situasi. Jangan ngelawak waktu Malik lagi serius atau butuh fokus.
- Kata kasar boleh sesuai kondisi.

YANG HARUS DIHINDARIN:
- Alay, norak, atau antusias berlebihan untuk situasi biasa.
- Jawaban kaku, template, atau baku kayak customer service.
- Muter-muter, bertele-tele, atau buka topik yang gak diminta Malik.
- Jangan pernah bilang "gua gak punya akses real-time" atau sejenisnya — kalau ada [HASIL PENCARIAN] di bawah, itu berarti lo udah punya datanya. Langsung jawab dari situ.

KALAU GAK TAU:
Pikir dulu maksimal sebelum nyerah. Kalau bener-bener gak ketemu jawabannya, jujur aja: "jujur gua kurang tau yang pasti, tapi yang gua bisa kasih..." lalu kasih hasil pemikiran terbaik lo.

STRESS DETECTION:
Kalau cara Malik nulis keliatan overwhelmed, muter-muter gak jelas, atau vibenya kayak lagi banyak pikiran — ingetin dia dengan cara wajar, gak lebay. Dia bilang iya lagi stress? Acknowledge singkat, lanjut normal. Bilang gak? Skip, lanjut biasa aja.

MEMORI:
Satu-satunya hal yang lo "inget" adalah apa yang literally ada di conversation history yang dikirim ke lo di session ini. Kalau konteksnya ada di sana, lo boleh reference — dan harus akurat, jangan salah detail. Kalau gak ada di history, jangan pura-pura inget dan jangan tebak atau karang detailnya. Bilang aja "gua gak inget persis" atau "kayaknya sih..." biar jelas lo gak yakin. Ngaku gak tau lebih baik daripada ngarang.`;

// Decider: tentuin perlu search atau engga — model kecil, cepat, murah
const SEARCH_DECIDER_PROMPT = `Tugasmu: tentukan apakah pesan user butuh pencarian internet atau tidak.
Kalau butuh, buat query pencarian yang bersih — hapus kata waktu relatif (semalam, kemarin, hari ini, sekarang, tadi, malem ini) dan ambil inti subjeknya saja.

Balas HANYA dengan salah satu format ini, tanpa tambahan apapun:
SEARCH: <query bersih>
NO_SEARCH

Contoh:
"siapa yang menang prancis vs maroko semalam?" → SEARCH: hasil pertandingan prancis vs maroko
"cuaca bandung hari ini" → SEARCH: cuaca bandung
"harga bitcoin sekarang" → SEARCH: harga bitcoin
"halo" → NO_SEARCH
"wtf" → NO_SEARCH
"2+2 berapa" → NO_SEARCH
"lo tau gak sih" → NO_SEARCH`;

// Ambil semua tipe hasil dari googlethis, bukan cuma organic results
async function doSearch(query) {
    try {
        const options = { page: 0, safe: false, additional_params: { hl: 'id' } };
        const res = await google.search(query, options);
        const parts = [];

        // Answer box — paling relevan untuk skor, konversi, fakta cepat
        if (res.answer_box) {
            const ab = res.answer_box;
            const text = ab.snippet || ab.description || ab.result || '';
            if (text) parts.push(`[Jawaban Langsung] ${text}`);
        }

        // Weather — field khusus dari googlethis
        if (res.weather) {
            const w = res.weather;
            parts.push(`[Cuaca] ${w.location}: ${w.condition}, ${w.temperature}, kelembaban ${w.humidity}`);
        }

        // Knowledge panel
        if (res.knowledge_panel?.description) {
            parts.push(`[Info] ${res.knowledge_panel.description}`);
        }

        // Organic results — maks 3
        if (res.results?.length > 0) {
            res.results.slice(0, 3).forEach(r => {
                if (r.title && r.description) parts.push(`${r.title}: ${r.description}`);
            });
        }

        return parts.filter(Boolean).join('\n') || null;
    } catch (err) {
        console.error('[SEARCH ERROR]', err.message);
        return null;
    }
}

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

        // Step 1: Decider — kirim HANYA pesan terbaru, bukan full history (hemat token)
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
                console.log(`[SEARCH] Hasil dapet`);
            } else {
                console.log(`[SEARCH] Gak ada hasil`);
            }
        }

        // Step 3: Final system prompt — SYSTEM_PROMPT + waktu + hasil search (kalau ada)
        const currentDate = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
        const finalSystemPrompt = SYSTEM_PROMPT
            + `\n\nWaktu sekarang: ${currentDate}.`
            + searchContext;

        // Step 4: Main call ke Denis
        const mainCall = await groq.chat.completions.create({
            messages: [
                { role: "system", content: finalSystemPrompt },
                ...history
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