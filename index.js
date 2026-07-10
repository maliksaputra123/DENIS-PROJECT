import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import Groq from 'groq-sdk';
import google from 'googlethis';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Memory per user — reset tiap bot restart
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

STRESS DETECTION:
Kalau cara Malik nulis keliatan overwhelmed, muter-muter gak jelas, atau vibenya kayak lagi banyak pikiran — ingetin dia dengan cara wajar, gak lebay. Dia bilang iya lagi stress? Acknowledge singkat, lanjut normal. Bilang gak? Skip, lanjut biasa aja.

MEMORI:
Satu-satunya hal yang lo "inget" adalah apa yang literally ada di conversation history yang dikirim ke lo di session ini. Kalau konteksnya ada di sana, lo boleh reference — dan harus akurat, jangan salah detail. Kalau gak ada di history, jangan pura-pura inget dan jangan tebak atau karang detailnya. Bilang aja "gua gak inget persis" atau "kayaknya sih..." biar jelas lo gak yakin. Ngaku gak tau lebih baik daripada ngarang.`;

// Definisi Tools untuk dikirim ke AI
const tools = [
    {
        type: "function",
        function: {
            name: "search_web",
            description: "Cari informasi di Google. Gunakan HANYA jika Malik butuh informasi real-time, cuaca saat ini, harga pasar, atau berita terbaru.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Kata kunci pencarian Google (singkat dan padat).",
                    }
                },
                required: ["query"],
            },
        },
    }
];

// FIX: Ganti 'ready' -> 'clientReady' buat ilangin DeprecationWarning
client.once('clientReady', () => {
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

        // FIX: Ganti model ke llama-3.3-70b-versatile — lebih stabil buat tool calling
        let chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                ...history
            ],
            model: "llama-3.3-70b-versatile",
            temperature: 0.1,
            max_tokens: 512,
            tools: tools,
            tool_choice: "auto",
            parallel_tool_calls: false
        });

        let responseMessage = chatCompletion.choices[0]?.message;

        if (responseMessage?.tool_calls && responseMessage.tool_calls.length > 0) {
            const toolCall = responseMessage.tool_calls[0];

            // FIX: Validasi JSON sebelum di-parse biar gak langsung crash
            let searchQuery = "";
            try {
                const functionArgs = JSON.parse(toolCall.function.arguments);
                searchQuery = functionArgs.query;
            } catch (parseError) {
                console.error("[ERROR] Gagal parse tool arguments:", toolCall.function.arguments);
                // Fallback: coba extract query manual dari string mentah
                const match = toolCall.function.arguments.match(/"query"\s*:\s*"([^"]+)"/);
                searchQuery = match ? match[1] : prompt;
            }

            console.log(`[LOG] Denis lagi nyari di web: ${searchQuery}`);

            let searchResultText = "";
            try {
                const searchOptions = { page: 0, safe: false, additional_params: { hl: 'id' } };
                const res = await google.search(searchQuery, searchOptions);
                searchResultText = res.results.slice(0, 3).map(r => `Judul: ${r.title}\nDeskripsi: ${r.description}`).join("\n\n");
                if (!searchResultText) searchResultText = "Tidak ditemukan hasil di Google.";
            } catch (err) {
                console.error("Gagal nyari Google:", err);
                searchResultText = "Gagal mengakses internet. Kasih tau Malik kalo jaringan lagi error.";
            }

            const messagesForSecondCall = [
                { role: "system", content: SYSTEM_PROMPT },
                ...history,
                responseMessage,
                {
                    tool_call_id: toolCall.id,
                    role: "tool",
                    name: "search_web",
                    content: searchResultText
                }
            ];

            const secondCall = await groq.chat.completions.create({
                messages: messagesForSecondCall,
                model: "llama-3.3-70b-versatile",
                temperature: 0.85,
                max_tokens: 512,
            });

            responseMessage = secondCall.choices[0]?.message;
        }

        const replyText = responseMessage?.content || "Eh Lik, gua agak nge-bug nih, gak dapet respon dari server.";

        history.push({ role: "assistant", content: replyText });

        message.reply(replyText.substring(0, 2000));
    } catch (error) {
        console.error("Error Detail:", error);
        message.reply("Aduh Lik, otak gua nge-hang bentar. Coba chat lagi.");
    }
});

client.login(process.env.DISCORD_TOKEN);