require('dotenv').config();
const crypto = require('crypto');
const {
  Client,
  GatewayIntentBits,
  ActivityType,
  Events,
} = require('discord.js');
const {
  GoogleGenerativeAI
} = require('@google/generative-ai');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-3.1-flash-lite-preview'
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildInvites,
  ],
});

const recentlyProcessed = new Set();
const badServerNames = new Set();
const goodServerNames = new Set();
const badImageHashes = new Set();
const goodImageHashes = new Set();
const processingImages = new Map();

const BAD_KEYWORDS = [
  'r18', '18+', 'nsfw', 'nude', 'hack', 'nitro', 'porn', 'sex',
  'casino', 'coin', 'crypto', '니트로', '카딩', '해킹툴', '키로거',
];

const INVITE_REGEX = /discord(?:\.gg|app\.com\/invite|\.com\/invite)\/([a-zA-Z0-9-]+)/gi;
const IMAGE_URL_REGEX = /https?:\/\/\S+\.(?:jpe?g|gif|png|webp)(?:\?\S*)?/gi;

async function sendTemporaryWarning(channel, content) {
  try {
    const warning = await channel.send(content);
    setTimeout(() => warning.delete().catch(() => {}), 10_000);
  } catch (err) {
    console.error('경고 메시지 전송 실패:', err);
  }
}

async function tryDeleteMessage(message) {
  try {
    if (message.guild && message.deletable) {
      await message.delete();
      return true;
    }
    return false;
  } catch (err) {
    if (err.code === 50013) {
      console.warn(`[권한 부족] 메시지 삭제 실패 - 서버: ${message.guild?.name}`);
    } else if (err.code !== 10008) {
      console.error('메시지 삭제 중 오류:', err);
    }
    return false;
  }
}

async function isServerNameMalicious(serverName) {
  if (!serverName) return false;

  const lowerName = serverName.toLowerCase();
  if (BAD_KEYWORDS.some((kw) => lowerName.includes(kw))) return true;
  if (badServerNames.has(serverName)) return true;
  if (goodServerNames.has(serverName)) return false;

  try {
    const prompt = `
      다음 디스코드 서버 이름이 해킹, 사기, NSFW(성인물, 음란물), 성적인 내용, 욕설 등 불건전하거나 악의적인 목적을 띠고 있는지 판별해줘.
      서버 이름: "${serverName}"
      부가 설명 없이 오직 'TRUE' 또는 'FALSE'로만 대답해.
    `.trim();

    const result = await model.generateContent(prompt);
    const isBad = result.response.text().trim().toUpperCase().includes('TRUE');

    if (isBad) badServerNames.add(serverName);
    else goodServerNames.add(serverName);

    return isBad;
  } catch (err) {
    console.error('서버 이름 텍스트 분석 중 오류:', err);
    return false;
  }
}

async function checkImageAndModerate(message, imageUrl) {
  try {
    const response = await fetch(imageUrl);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return false;

    const buffer = await response.arrayBuffer();
    const bufferData = Buffer.from(buffer);
    const hash = crypto.createHash('sha256').update(bufferData).digest('hex');

    if (badImageHashes.has(hash)) {
      const deleted = await tryDeleteMessage(message);
      if (deleted) {
        await sendTemporaryWarning(
          message.channel,
          `🚨 <@${message.author.id}> 해킹/스팸 이미지가 감지되어 메시지가 자동 삭제되었습니다! (캐시 차단)`
        );
        console.log(`[캐시 차단] 작성자: ${message.author.tag} (동일 이미지 재업로드)`);
      }
      return deleted;
    }

    if (goodImageHashes.has(hash)) return false;

    if (processingImages.has(hash)) {
      console.log(`[분석 대기] ${hash.slice(0, 6)}... 이미 분석 중인 이미지입니다. 결과를 기다립니다.`);
      const isFlagged = await processingImages.get(hash);
      if (!isFlagged) return false;

      const deleted = await tryDeleteMessage(message);
      if (deleted) {
        await sendTemporaryWarning(
          message.channel,
          `🚨 <@${message.author.id}> 해킹/스팸 이미지가 감지되어 메시지가 자동 삭제되었습니다! (동시 대기 차단)`
        );
        console.log(`[동시 대기 차단] 작성자: ${message.author.tag}`);
      }
      return deleted;
    }

    const base64Image = bufferData.toString('base64');
    const prompt = `
      이 이미지가 일론 머스크나 유명인을 사칭한 암호화폐 사기(Scam),
      해킹된 계정의 스팸 트윗, 또는 불법적인 링크 유도 이미지인지 판별해줘.
      부가 설명 없이 오직 'TRUE' 또는 'FALSE'로만 대답해.
    `.trim();

    const analyzePromise = model
      .generateContent([prompt, {
        inlineData: {
          data: base64Image,
          mimeType: contentType
        }
      }])
      .then((r) => r.response.text().trim().toUpperCase().includes('TRUE'));

    processingImages.set(hash, analyzePromise);

    let isFlagged = false;
    try {
      isFlagged = await analyzePromise;
    } finally {
      processingImages.delete(hash);
    }

    if (isFlagged) badImageHashes.add(hash);
    else goodImageHashes.add(hash);

    if (!isFlagged) return false;

    const deleted = await tryDeleteMessage(message);
    if (deleted) {
      await sendTemporaryWarning(
        message.channel,
        `🚨 <@${message.author.id}> 해킹/스팸 이미지가 감지되어 메시지가 자동 삭제되었습니다!`
      );
      console.log(
        `[이미지 삭제됨] 서버: ${message.guild?.name ?? 'DM'} | ` +
        `채널: #${message.channel?.name ?? '알 수 없음'} | ` +
        `작성자: ${message.author.tag}`
      );
      console.log('-'.repeat(50));
    }
    return deleted;

  } catch (err) {
    console.error('이미지 분석 중 오류 발생:', err);
    return false;
  }
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  INVITE_REGEX.lastIndex = 0;
  const invites = [...message.content.matchAll(INVITE_REGEX)];

  if (invites.length > 0) {
    let shouldDelete = false;
    let deleteReason = '부적절한 서버 홍보 링크';

    for (const match of invites) {
      try {
        const invite = await client.fetchInvite(match[1]);
        const serverName = invite.guild?.name ?? '';
        const isBad = await isServerNameMalicious(serverName);

        if (isBad) {
          shouldDelete = true;
          deleteReason = `부적절한 이름의 서버 홍보 링크 (서버 이름: ${serverName})`;
          break;
        }
      } catch {
        shouldDelete = true;
        deleteReason = '유효하지 않거나 만료된 초대 링크';
        break;
      }
    }

    if (shouldDelete) {
      const deleted = await tryDeleteMessage(message);
      if (deleted) {
        await sendTemporaryWarning(
          message.channel,
          `🚨 <@${message.author.id}> ${deleteReason}는 올릴 수 없습니다.`
        );
        console.log(`[링크 차단] 사유: ${deleteReason} | 작성자: ${message.author.tag}`);
        console.log(`내용: ${message.content}`);
        console.log('-'.repeat(50));
      }
      return;
    }
  }

  IMAGE_URL_REGEX.lastIndex = 0;
  const imageUrls = [...message.content.matchAll(IMAGE_URL_REGEX)].map((m) => m[0]);

  for (const url of imageUrls) {
    if (url.includes('cdn.discordapp.com') || url.includes('media.discordapp.net')) continue;

    const deleted = await checkImageAndModerate(message, url);
    if (deleted) return;
  }

  for (const [, attachment] of message.attachments) {
    if (attachment.contentType?.startsWith('image/')) {
      const deleted = await checkImageAndModerate(message, attachment.url);
      if (deleted) return;
    }
  }
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  if (newMessage.author?.bot) return;
  if (newMessage.embeds.length === 0) return;

  if (recentlyProcessed.has(newMessage.id)) return;
  recentlyProcessed.add(newMessage.id);
  setTimeout(() => recentlyProcessed.delete(newMessage.id), 30_000);

  for (const embed of newMessage.embeds) {
    const imageUrl = embed.image?.url ?? embed.thumbnail?.url;
    if (!imageUrl) continue;

    const deleted = await checkImageAndModerate(newMessage, imageUrl);
    if (deleted) break;
  }
});

client.once(Events.ClientReady, () => {
  client.user.setPresence({
    activities: [{
      name: 'Irochi (https://irochi.moe)',
      type: ActivityType.Playing
    }],
    status: 'online',
  });

  console.log(`Logged in as ${client.user.tag} (ID: ${client.user.id})`);
  console.log('Joined servers:');
  client.guilds.cache.forEach((guild) => console.log(`  - ${guild.name} (${guild.id})`));
  console.log('Successfully started!');
});

client.login(DISCORD_TOKEN);