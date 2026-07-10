import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import Groq from 'groq-sdk';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const TARGET_CHANNEL = process.env.ALLOWED_CHANNEL_ID;

client.once('ready', () => {
    console.log(`Beres! Bot lu udah online sebagai ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.channel.id !== TARGET_CHANNEL) return;
    if (!message.mentions.has(client.user)) return;

    const prompt = message.content.replace(`<@${client.user.id}>`, '').trim();
    if (!prompt) return message.reply("Ada yang bisa gua bantu?");

    try {
        await message.channel.sendTyping();
            const chatCompletion = await groq.chat.completions.create({
                messages: [
                    {
                        role: "system",
                        content: "Lu adalah temen akrab yang santai, asik, dan gak kaku. Lu bukan asisten robot, tapi temen curhat atau temen diskusi yang seru. Gaya bahasa lu santai, pake bahasa sehari-hari yang luwes, to-the-point, dan gak perlu sok formal. Jangan pernah pake kalimat 'Sebagai model AI' atau kalimat template yang membosankan. Kalau temen lu bercanda, bales bercanda. Kalau dia lagi mumet, semangatin. Pokoknya anggap aja kita lagi chatan santai."
                    },
                    { role: "user", content: prompt }
                ],
                model: "llama-3.3-70b-versatile",
                temperature: 0.9,
                max_tokens: 1024,
            });
        const replyText = chatCompletion.choices[0]?.message?.content || "Maaf, gua gak dapet respon dari Groq.";
        message.reply(replyText.substring(0, 2000));
    } catch (error) {
        console.error("Error Detail:", error);
        message.reply("Aduh, ada kendala pas ngehubungin otak Groq nih.");
    }
});

client.login(process.env.DISCORD_TOKEN);