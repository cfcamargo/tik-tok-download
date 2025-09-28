const TelegramBot = require('node-telegram-bot-api');
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");
const scraper = require('btch-downloader'); // <— pacote do seu exemplo

const bot = new TelegramBot('8357476102:AAEu-_U6WucGG-WGJX1XqJoM4U5MoZT_7W4', { polling: true });

// ==== utils de stream (os mesmos que você já tem) ============================
function streamToBuffer(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (typeof maxBytes === "number" && total > maxBytes) {
        stream.destroy();
        reject(new Error(`Response too large (> ${maxBytes} bytes)`));
        return;
      }
      chunks.push(buf);
    });
    stream.once("end", () => resolve(Buffer.concat(chunks)));
    stream.once("error", reject);
  });
}

function getStream(urlStr, { maxRedirects = 5, timeoutMs = 30000 } = {}) {
  if (maxRedirects < 0) return Promise.reject(new Error("Too many redirects"));
  const url = new URL(urlStr);
  const isHttps = url.protocol === "https:";
  const client = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "*/*",
        },
      },
      (res) => {
        const status = res.statusCode || 0;

        if (status >= 300 && status < 400 && res.headers.location) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          getStream(next, { maxRedirects: maxRedirects - 1, timeoutMs })
            .then(resolve).catch(reject);
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`Request failed with status ${status}`));
          return;
        }

        res._contentType = res.headers["content-type"] || "";
        resolve(res);
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error("Request timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function downloadToBufferWithType(url, opts = {}) {
  const { maxBytes } = opts;
  const res = await getStream(url, opts);
  const buf = await streamToBuffer(res, maxBytes);
  return { buffer: buf, contentType: res._contentType };
}

// ==== comandos do bot ========================================================
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    'Olá! Envie /tiktok <link> para tentar obter o vídeo e /download <url.mp4> para baixar uma URL direta.'
  );
});

// Mantém seu /download para URLs diretas de mídia
// bot.onText(/\/download (.+)/, async (msg, match) => {
//   const chatId = msg.chat.id;
//   const url = (match && match[1] || '').trim();

//   try {
//     await bot.sendChatAction(chatId, 'upload_video');
//     const { buffer, contentType } = await downloadToBufferWithType(url, {
//       maxRedirects: 5,
//       timeoutMs: 30000,
//       maxBytes: 49 * 1024 * 1024,
//     });

//     if (!/^video\//i.test(contentType)) {
//       await bot.sendMessage(chatId, `A URL não parece ser vídeo. Content-Type: "${contentType}".`);
//       return;
//     }

//     await bot.sendVideo(
//       chatId,
//       buffer,
//       { caption: 'Aqui está seu vídeo.' },
//       { filename: 'video.mp4', contentType }
//     );
//   } catch (err) {
//     console.error(err);
//     await bot.sendMessage(chatId, `Falha ao baixar/enviar: ${err.message}`);
//   }
// });

// NOVO: /tiktok <link compartilhado do TikTok>
// usa btch-downloader para resolver a URL direta do vídeo
bot.onText(/\/download (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const shareUrl = (match && match[1] || '').trim();
  await bot.sendMessage(chatId, 'Recebi o link princesa, vou validar e gerar o download');

  if (!/^https?:\/\//i.test(shareUrl)) {
    await bot.sendMessage(chatId, 'Amor, esse link nao rolou, envie um link válido.');
    return;
  }

  try {
    await bot.sendChatAction(chatId, 'typing');

    // 1) Resolve URLs de mídia via btch-downloader
    // O pacote costuma retornar algo como { audio, video }
    // onde "video" pode ser string ou array/obj com múltiplas qualidades.
    const result = await scraper.ttdl(shareUrl);

    // 2) Escolher a melhor URL de vídeo disponível, de forma defensiva
    let candidate = null;

    // casos comuns:
    // - result.video é string
    if (typeof result.video === 'string') {
      candidate = result.video;
    }
    // - result.video é array de strings
    else if (Array.isArray(result.video) && result.video.length) {
      candidate = result.video[0];
    }
    // - result.video é objeto com chaves (ex.: { hd, sd, nowm, wm })
    else if (result.video && typeof result.video === 'object') {
      // preferência: alguma chave conhecida ou a primeira disponível
      candidate = result.video.nowm || result.video.hd || result.video.sd || result.video.wm;
      if (!candidate) {
        const firstKey = Object.keys(result.video)[0];
        candidate = result.video[firstKey];
      }
    }

    if (!candidate || typeof candidate !== 'string') {
      await bot.sendMessage(chatId, 'Não consegui resolver uma URL direta do vídeo.Compenso com um docinho depois');
      return;
    }

    // 3) Baixar e enviar (como no /download), com validação do Content-Type
    await bot.sendChatAction(chatId, 'upload_video');

    const { buffer, contentType } = await downloadToBufferWithType(candidate, {
      maxRedirects: 5,
      timeoutMs: 30000,
      maxBytes: 49 * 1024 * 1024,
    });

    if (!/^video\//i.test(contentType)) {
      await bot.sendMessage(
        chatId,
        `A URL resolvida não parece ser vídeo. Content-Type: "${contentType}".`
      );
      return;
    }

    await bot.sendVideo(
      chatId,
      buffer,
      { caption: 'Consegui princesa, video enviado' },
      { filename: 'video.mp4', contentType }
    );
  } catch (err) {
    console.error('Erro no /tiktok:', err);
    await bot.sendMessage(chatId, `Falha ao processar o link: ${err.message}`);
  }
});
