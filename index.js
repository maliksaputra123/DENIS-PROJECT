import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import Groq from 'groq-sdk';
import google from 'googlethis';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const conversationHistory = new Map();
const MAX_HISTORY = 20;

// SYSTEM PROMPT ASLI LU GUA BALIKIN UTUH
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

STRESS DETECTION:
Kalau cara Malik nulis keliatan overwhelmed, muter-muter gak jelas, atau vibenya kayak lagi banyak pikiran — ingetin dia dengan cara wajar, gak lebay. Dia bilang iya lagi stress? Acknowledge singkat, lanjut normal. Bilang gak? Skip, lanjut biasa aja.

MEMORI:
Satu-satunya hal yang lo "inget" adalah apa yang literally ada di conversation history yang dikirim ke lo di session ini. Kalau konteksnya ada di sana, lo boleh reference — dan harus akurat, jangan salah detail. Kalau gak ada di history, jangan pura-pura inget dan jangan tebak atau karang detailnya. Bilang aja "gua gak inget persis" atau "kayaknya sih..." biar jelas lo gak yakin. Ngaku gak tau lebih baik daripada ngarang.`;

// PROMPT DECIDER TETAP PAKE ATURAN BERSIHIN WAKTU
const SEARCH_DECIDER_PROMPT = `Tugas lo cuma satu: buat query pencarian internet berdasarkan pesan user.
ATURAN WAJIB:
- HAPUS semua kata penunjuk waktu relatif seperti "semalam", "kemarin", "hari ini", "sekarang", "tadi". Kata-kata ini merusak pencarian Google.
- Ambil inti subjeknya saja.

Respond HANYA dengan format:
SEARCH: <query bersih tanpa kata waktu>
atau NO_SEARCH

Contoh:
User: siapa yang menang prancis vs maroko semalam?
Output: SEARCH: hasil pertandingan prancis vs maroko
User: cuaca bandung malem ini
Output: SEARCH: cuaca bandung
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
            console.log(`[LOG] Denis nyari di web: ${searchQuery}`);

            try {
                const searchOptions = { page: 0, safe: false, additional_params: { hl: 'id' } };
                const res = await google.search(searchQuery, searchOptions);
                const results = res.results.slice(0, 3).map(r => `${r.title}: ${r.description}`).join("\n");
                
                searchContext = results
                    ? `\n\n[CONTEKAN FAKTA DARI INTERNET]:\n${results}`
                    : "";
            } catch (err) {
                console.error("Gagal nyari Google:", err);
            }
        }

        const currentDate = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
        
        // PENEKANAN MUTLAK DIBAWAH PROMPT LU BIAR DENIS TETEP NURUT
        const dynamicSystemPrompt = SYSTEM_PROMPT + `\n\nINFO PENTING UNTUK SAAT INI:
- Waktu saat ini: ${currentDate}.
- ATURAN MUTLAK: Jika ada [CONTEKAN FAKTA DARI INTERNET] di bawah ini, LANGSUNG JAWAB HASILNYA SECARA SINGKAT DAN TO THE POINT TANPA BASA BASI.
- JANGAN PERNAH protes atau ngebantah Malik soal perbedaan waktu (misal: Malik nanya kejadian "semalam", padahal di contekan kejadiannya udah lama). ABAIKAN LOGIKA WAKTU. Lu cukup sebutin aja hasil pertandingan atau jawabannya sesuai contekan!
- Jangan pernah bilang "kayaknya belum ada info terbaru", kalau contekannya ngasih hasil pertandingan, langsung berikan faktanya.` + searchContext;

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

        const responseText = mainCall.choices[0]?.message?.content || "Eh Lik, gua agak nge-bug nih.";
        
        history.push({ role: "assistant", content: responseText });
        message.reply(responseText.substring(0, 2000));

    } catch (error) {
        console.error("Error Detail:", error);
        message.reply("Aduh Lik, otak gua nge-hang bentar. Coba chat lagi.");
    }
});

client.login(process.env.DISCORD_TOKEN);