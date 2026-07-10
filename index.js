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

KALAU GAK TAU:
Pikir dulu maksimal sebelum nyerah. Kalau bener-bener gak ketemu jawabannya, jujur aja: "jujur gua kurang tau yang pasti, tapi yang gua bisa kasih..." lalu kasih hasil pemikiran terbaik lo.

MEMORI:
Satu-satunya hal yang lo "inget" adalah apa yang literally ada di conversation history yang dikirim ke lo di session ini. Kalau konteksnya ada di sana, lo boleh reference — dan harus akurat, jangan salah detail. Kalau gak ada di history, jangan pura-pura inget dan jangan tebak atau karang detailnya. Bilang aja "gua gak inget persis" atau "kayaknya sih..." biar jelas lo gak yakin. Ngaku gak tau lebih baik daripada ngarang.`;

// Prompt khusus buat nentuin query search, sekarang disuruh baca konteks!
const SEARCH_DECIDER_PROMPT = `Tugas lo cuma satu: tentuin apakah user butuh pencarian internet untuk pesan TERAKHIRNYA. Baca history percakapan untuk memahami konteks.
Jika pesan terakhir user seperti "coba cek", "cariin dong", "siapa yang menang", lu HARUS liat pesan sebelumnya untuk tau topik apa yang mau dicari.

Respond HANYA dengan format ini, tidak ada teks lain:
SEARCH: <query pencarian yang singkat, detail, dan mencakup topik dari pesan sebelumnya>
atau
NO_SEARCH

Contoh:
(Konteks: User nanya prancis vs maroko)
User: coba cek
Output: SEARCH: hasil pertandingan prancis vs maroko
User: harga bitcoin
Output: SEARCH: harga bitcoin hari ini
User: wtf
Output: NO_SEARCH`;

client.once('ready', () => {
    console.log(`Beres! Bot lu udah online sebagai ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.mentions.has(client.user)) return;

    const prompt = message.content.replace(`<@${client.user.id}>`, '').trim();
    if (!prompt) return message.reply("Ada yang bisa gua bantu, Lik?");

    const userId = message.author.id;
    if (!conversationHistory.has(userId)) {
        conversationHistory.set(userId, []);
    }

    const history = conversationHistory.get(userId);
    history.push({ role: "user", content: prompt });

    while (history.length > MAX_HISTORY) {
        history.shift();
    }

    try {
        await message.channel.sendTyping();

        // Step 1: Kirim SELURUH history ke decider biar dia paham konteks obrolan
        const deciderCall = await groq.chat.completions.create({
            messages: [
                { role: "system", content: SEARCH_DECIDER_PROMPT },
                ...history 
            ],
            model: "llama-3.1-8b-instant",
            temperature: 0.0,
            max_tokens: 64,
        });

        const deciderResponse = deciderCall.choices[0]?.message?.content?.trim() || "NO_SEARCH";
        console.log(`[DEBUG] Decider response: ${deciderResponse}`);

        let searchContext = "";
        if (deciderResponse.startsWith("SEARCH:")) {
            const searchQuery = deciderResponse.replace("SEARCH:", "").trim();
            console.log(`[LOG] Denis lagi nyari di web: ${searchQuery}`);

            try {
                const searchOptions = { page: 0, safe: false, additional_params: { hl: 'id' } };
                const res = await google.search(searchQuery, searchOptions);
                const results = res.results.slice(0, 3).map(r => `Judul: ${r.title}\nDeskripsi: ${r.description}`).join("\n\n");
                
                searchContext = results
                    ? `\n\n[INFO TERBARU DARI INTERNET UNTUK MENJAWAB MALIK (JANGAN SEBUTIN DAPET DARI GOOGLE)]:\n${results}`
                    : "";
            } catch (err) {
                console.error("Gagal nyari Google:", err);
            }
        }

        // Bikin Tanggal dan Aturan Anti-2023 dinamis (biar Denis selalu tau hari ini tahun berapa)
        const currentDate = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
        const dynamicSystemPrompt = SYSTEM_PROMPT + `\n\nINFO PENTING TAMBAHAN:\n- Waktu saat ini: ${currentDate}.\n- JANGAN PERNAH menyebut soal "gua cuma punya info sampai tahun 2023" atau hal-hal terkait batasan data AI. Lu hidup di tahun ini. Kalo lu gak nemu datanya, bilang aja "Gua belum liat beritanya nih" atau semacamnya.` + searchContext;

        // Step 2: Panggil Denis
        const messagesForDenis = [
            { role: "system", content: dynamicSystemPrompt },
            ...history
        ];

        const mainCall = await groq.chat.completions.create({
            messages: messagesForDenis,
            model: "llama-3.3-70b-versatile",
            temperature: 0.85,
            max_tokens: 512,
        });

        const responseText = mainCall.choices[0]?.message?.content || "Eh Lik, gua agak nge-bug nih, gak dapet respon dari server.";
        
        history.push({ role: "assistant", content: responseText });
        message.reply(responseText.substring(0, 2000));

    } catch (error) {
        console.error("Error Detail:", error);
        message.reply("Aduh Lik, otak gua nge-hang bentar. Coba chat lagi.");
    }
});

client.login(process.env.DISCORD_TOKEN);