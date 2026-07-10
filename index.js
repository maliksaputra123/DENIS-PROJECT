import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import Groq from 'groq-sdk';
import { tavily } from '@tavily/core';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

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
- JANGAN PERNAH nyuruh Malik "cek sumber lain" atau "cari sendiri" — lo partner in crime-nya, bukan resepsionis.

KALAU GAK TAU ATAU PENCARIAN GAGAL:
Pikir dulu maksimal. Kalau search gagal atau gak nemu hasil, bilang aja jujur: "gua gak nemu info spesifiknya sekarang" — lalu kasih apa yang lo tau dari pengetahuan lo, atau bilang gak tau. Jangan ngeless panjang-panjang, jangan suruh Malik cek tempat lain.

KALAU ADA [HASIL PENCARIAN]:
Itu data aktual dari internet. Jadiin referensi utama dan langsung jawab — gak usah bilang "gua gak punya akses real-time" atau sejenisnya, karena lo udah dapet datanya.

STRESS DETECTION:
Kalau cara Malik nulis keliatan overwhelmed, muter-muter gak jelas, atau vibenya kayak lagi banyak pikiran — ingetin dia dengan cara wajar, gak lebay. Dia bilang iya lagi stress? Acknowledge singkat, lanjut normal. Bilang gak? Skip, lanjut biasa aja.

MEMORI:
Satu-satunya hal yang lo "inget" adalah apa yang literally ada di conversation history yang dikirim ke lo di session ini. Kalau konteksnya ada di sana, lo boleh reference — dan harus akurat, jangan salah detail. Kalau gak ada di history, jangan pura-pura inget dan jangan tebak atau karang detailnya. Bilang aja "gua gak inget persis" atau "kayaknya sih..." biar jelas lo gak yakin. Ngaku gak tau lebih baik daripada ngarang.`;

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
    try {
        const res = await tvly.search(query, {
            maxResults: 4,
            searchDepth: "basic",
            includeAnswer: true,
        });

        const parts = [];

        // Kalau Tavily kasih direct answer, prioritasin itu
        if (res.answer) parts.push(`[Jawaban] ${res.answer}`);

        // Tambahin hasil individual
        if (res.results?.length > 0) {
            res.results.forEach(r => {
                if (r.title && r.content) parts.push(`${r.title}: ${r.content}`);
            });
        }

        return parts.filter(Boolean).join('\n') || null;
    } catch (err) {
        console.error(`[SEARCH ERROR] ${err.message}`);
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

        // Step 1: Decider — cukup pesan terbaru, hemat token
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