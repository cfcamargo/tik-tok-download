// bot.js
require('dotenv').config();

const isProd = process.env.NODE_ENV === 'production';
console.log('[ENV] isProd =', isProd);

const TelegramBot = require('node-telegram-bot-api');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

// === BIBLIOTECA SCRAPER ===
// Usado apenas para TikTok
const scraper = require('btch-downloader');

// ===================================================================================
// Configurações de Download e Agentes
// ===================================================================================
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 90000);
const DOWNLOAD_HEADER_TIMEOUT_MS = Number(process.env.DOWNLOAD_HEADER_TIMEOUT_MS || 20000);
const DOWNLOAD_MAX_RETRIES = Number(process.env.DOWNLOAD_MAX_RETRIES || 3);
const DOWNLOAD_RETRY_BASE_MS = Number(process.env.DOWNLOAD_RETRY_BASE_MS || 800);
const TELEGRAM_FILE_MAX_BYTES = 49 * 1024 * 1024; // Limite do Telegram (50MB)

const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 20 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 20 });

// ===================================================================================
// FFmpeg / YT-DLP: Configuração dos Binários
// ===================================================================================
let ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

function pickYtDlpPath() {
  const candidates = [
    process.env.YTDLP_PATH,
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    'yt-dlp',
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (!p.includes('/')) return p; // deixa o execFile resolver pelo PATH
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return 'yt-dlp';
}

const YTDLP_PATH = pickYtDlpPath();

// Cookies opcionais para Pinterest (linha única, ex.: "cookie1=...; cookie2=...")
const PINTEREST_COOKIES = (process.env.PINTEREST_COOKIES || '').trim();

// Log de binários
execFile(YTDLP_PATH, ['--version'], (e, out) => {
  if (e) console.error('[YT-DLP] yt-dlp indisponível:', e.message);
  else console.log('[YT-DLP] Versão:', (out || '').split('\n')[0]);
});
execFile(ffmpegPath, ['-version'], (e, out) => {
  if (e) console.error('[FFMPEG] FFmpeg indisponível:', e.message);
  else console.log('[FFMPEG] Versão:', (out || '').split('\n')[0].match(/ffmpeg version \S+/i)?.[0] || 'OK');
});

// ===================================================================================
// Config / ACL por @username (via .env)
// ===================================================================================
const TOKEN = process.env.TELEGRAM_TOKEN;
if (!TOKEN) {
  console.error('[BOT] Faltou TELEGRAM_TOKEN no .env/ambiente.');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: false, filepath: false });

// Lock anti-duplicação
if (globalThis.__BOT_RUNNING__) {
  console.log('[BOT] Já inicializado. Encerrando esta instância para evitar duplicação.');
  process.exit(0);
}
globalThis.__BOT_RUNNING__ = true;

function normalizeUsername(u) {
  return String(u || '').trim().replace(/^@/, '').toLowerCase();
}
const ALLOWED_USERNAMES = new Set(
  String(process.env.ALLOWED_USERNAMES || '')
    .split(',')
    .map(normalizeUsername)
    .map(s => s.trim())
    .filter(Boolean)
);

function isAllowed(msg) {
  const uname = normalizeUsername(msg?.from?.username);
  return ALLOWED_USERNAMES.has(uname);
}

async function replyNotAllowed(msg) {
  try {
    await bot.sendMessage(
      msg.chat.id,
      '🚫 Você não tem permissão para usar este bot.\n' +
      'Peça ao admin para adicionar seu @username em ALLOWED_USERNAMES no .env.'
    );
  } catch {}
}

// ===================================================================================
// Utils gerais
// ===================================================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractFirstUrl(text = '') {
  const m = text.match(/https?:\/\/\S+/i);
  return m ? m[0].replace(/[)\]}>"'\s]+$/, '') : null;
}

async function sendInstructions(chatId) {
  const text = `👋 Envie um link:
• TikTok → uso btch-downloader
• Pinterest → uso yt-dlp
• YouTube Shorts (ou YouTube) → uso yt-dlp

Comandos:
• /start ou /ajuda — esta mensagem
• /cancelar — cancela o processo

Dicas:
• Links encurtados (pin.it) eu expando automaticamente.
• Limite do Telegram: ~50MB por arquivo.
• Pinterest às vezes exige cookies; se necessário, defina a env PINTEREST_COOKIES.`;
  try {
    await bot.sendMessage(chatId, text, { disable_web_page_preview: true });
  } catch {}
}

// ===================================================================================
// HTTP: stream / download helpers
// ===================================================================================
async function getStream(urlStr, opts = {}) {
  const {
    method = 'GET',
    maxRedirects = 5,
    timeoutMs = DOWNLOAD_TIMEOUT_MS,
    headerTimeoutMs = DOWNLOAD_HEADER_TIMEOUT_MS,
    attempt = 1,
    maxRetries = DOWNLOAD_MAX_RETRIES,
    headers: extraHeaders = {},
  } = opts;

  if (maxRedirects < 0) throw new Error('Too many redirects');

  const url = new URL(urlStr);
  const isHttps = url.protocol === 'https:';
  const client = isHttps ? https : http;
  const agent = isHttps ? HTTPS_AGENT : HTTP_AGENT;

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://www.google.com/',
    ...extraHeaders,
  };

  const overallDeadline = Date.now() + timeoutMs;

  const doRequest = () =>
    new Promise((resolve, reject) => {
      const req = client.request(
        {
          method,
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          headers,
          agent,
          family: 4,
        },
        (res) => {
          const status = res.statusCode || 0;

          if (status >= 300 && status < 400 && res.headers.location) {
            const next = new URL(res.headers.location, url).toString();
            res.resume();
            getStream(next, { ...opts, maxRedirects: maxRedirects - 1 }).then(resolve).catch(reject);
            return;
          }

          if (status < 200 || status >= 300) {
            res.resume();
            reject(new Error(`Request failed with status ${status}`));
            return;
          }

          res._contentType = res.headers['content-type'] || '';
          res._finalUrl = url.toString();
          resolve(res);
        }
      );

      req.setTimeout(headerTimeoutMs, () => req.destroy(new Error('Header timeout')));
      const overallTimer = setTimeout(() => req.destroy(new Error('Request timeout')), timeoutMs);
      req.on('error', (e) => { clearTimeout(overallTimer); reject(e); });
      req.end();
    });

  try {
    return await doRequest();
  } catch (err) {
    if (attempt < maxRetries) {
      const backoff = DOWNLOAD_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(`[HTTP] Falha (tentativa ${attempt}/${maxRetries}): ${err.message}`);
      await sleep(backoff);
      return getStream(urlStr, { ...opts, attempt: attempt + 1 });
    }
    throw err;
  }
}

function streamToBuffer(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (typeof maxBytes === 'number' && total > maxBytes) {
        stream.destroy();
        reject(new Error(`Response too large (> ${maxBytes} bytes)`));
        return;
      }
      chunks.push(buf);
    });
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}

async function downloadToBufferWithType(url, opts = {}) {
  const { maxBytes } = opts;
  const res = await getStream(url, opts);
  const buf = await streamToBuffer(res, maxBytes);
  return { buffer: buf, contentType: res._contentType };
}

// Expande encurtadores (ex.: pin.it -> pinterest.com/pin/…)
async function expandUrl(urlStr) {
  try {
    const res = await getStream(urlStr, { method: 'GET', maxRedirects: 5 });
    return res._finalUrl || urlStr;
  } catch {
    return urlStr;
  }
}

// ===================================================================================
// TikTok via btch-downloader (somente TikTok)
// ===================================================================================
async function getTikTokDirectUrl(url) {
  const result = await scraper.ttdl(url);
  if (!result) throw new Error('btch-downloader (ttdl) retornou nulo.');

  let r = result;
  if (r.result && r.result.result) r = r.result.result;
  else if (r.result) r = r.result;

  const candidate = r.video_url || r.url ||
    (Array.isArray(r.video) ? r.video[0] : r.video) ||
    r.downloadUrl || r.link;

  if (!candidate) throw new Error('btch-downloader (ttdl) não conseguiu extrair a URL.');
  return candidate;
}

// ===================================================================================
// Pinterest / YouTube (Shorts) via yt-dlp
// ===================================================================================
async function downloadMediaWithYtdlp(url) {
  const args = [
    '--ignore-config',
    '-f', 'best',
    '--recode-video', 'mp4',
    '-o', '-',
    '--limit-rate', '5M',
    '--no-warnings',
    '--no-check-certificate',
    '--no-mtime',
    '--no-progress',
    '--quiet',
    '--ffmpeg-location', ffmpegPath,
    '--concurrent-fragments', '1',

    // Headers úteis
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
    '--add-header', 'Accept-Language: pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    '--add-header', 'Referer: https://www.pinterest.com/',
    '--geo-bypass',
  ];

  if (PINTEREST_COOKIES) {
    args.push('--add-header', `Cookie: ${PINTEREST_COOKIES}`);
  }

  args.push(url);

  return new Promise((resolve, reject) => {
    const child = execFile(YTDLP_PATH, args, { encoding: 'buffer', maxBuffer: TELEGRAM_FILE_MAX_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          const errStr = stderr.toString();
          console.error('[YT-DLP] Erro (STDERR):', errStr.substring(0, 800));
          return reject(new Error(`YT-DLP falhou (código ${error.code}).`));
        }

        const mediaBuffer = Buffer.from(stdout);
        if (mediaBuffer.length === 0) return reject(new Error('YT-DLP retornou arquivo vazio.'));

        let contentType = 'application/octet-stream';
        const header = mediaBuffer.subarray(0, 4).toString('hex');
        if (header.includes('ffd8')) contentType = 'image/jpeg';
        else if (header.includes('000000') && mediaBuffer.subarray(4, 8).toString().includes('ftyp'))
          contentType = 'video/mp4';
        else if (mediaBuffer.length > 2 * 1024 * 1024) contentType = 'video/mp4';

        console.log(`[YT-DLP] Download concluído. ${mediaBuffer.length} bytes.`);
        resolve({ buffer: mediaBuffer, contentType });
      });
  });
}

// ===================================================================================
// Handler principal
// ===================================================================================
bot.on('message', async (msg) => {
  if (!isAllowed(msg)) return replyNotAllowed(msg);

  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;

  if (/^\/start\b|^\/ajuda\b|^\/help\b/i.test(text)) return sendInstructions(chatId);
  if (/^\/cancelar\b|^\/cancel\b/i.test(text)) return bot.sendMessage(chatId, 'Ok. Cancelado.');

  const url0 = extractFirstUrl(text);
  if (!url0) {
    if (text && text.length < 60) await sendInstructions(chatId);
    return;
  }

  let statusMsg, finalBuffer, finalContentType, usedScraper = '';
  try {
    statusMsg = await bot.sendMessage(chatId, 'Recebido! Resolvendo o link...', { reply_to_message_id: msg.message_id });

    // Expande encurtadores (especialmente pin.it)
    const url = await expandUrl(url0);
    const isTikTok = /tiktok\.com/i.test(url);
    const isPinterest = /pinterest\.com/i.test(url) || /pin\.it/i.test(url0);
    const isYouTube = /youtube\.com|youtu\.be/i.test(url); // inclui Shorts

    if (isTikTok) {
      usedScraper = 'btch-downloader (TikTok)';
      await bot.editMessageText('Link do TikTok detectado. Usando btch-downloader...', { chat_id: chatId, message_id: statusMsg.message_id });
      const directUrl = await getTikTokDirectUrl(url);
      const { buffer, contentType } = await downloadToBufferWithType(directUrl, { maxBytes: TELEGRAM_FILE_MAX_BYTES });
      finalBuffer = buffer; finalContentType = contentType;
    } else if (isPinterest || isYouTube) {
      usedScraper = 'yt-dlp';
      await bot.editMessageText(`Link ${isPinterest ? 'do Pinterest' : 'do YouTube'} detectado. Usando yt-dlp...`, { chat_id: chatId, message_id: statusMsg.message_id });

      // Sem fallback: se falhar, retorna erro claro
      const result = await downloadMediaWithYtdlp(url);
      finalBuffer = result.buffer; finalContentType = result.contentType;
    } else {
      throw new Error('Plataforma não suportada. Envie link do TikTok, Pinterest ou YouTube/Shorts.');
    }

    await bot.editMessageText(`Download concluído via ${usedScraper}! Enviando...`, { chat_id: chatId, message_id: statusMsg.message_id });

    const isVideo = /^video\//i.test(finalContentType) || finalBuffer.length > 2 * 1024 * 1024;
    if (isVideo) {
      await bot.sendChatAction(chatId, 'upload_video');
      await bot.sendVideo(chatId, finalBuffer, { caption: `Prontinho! (Fonte: ${usedScraper})` }, { filename: 'media.mp4', contentType: 'video/mp4' });
    } else {
      await bot.sendChatAction(chatId, 'upload_photo');
      await bot.sendPhoto(chatId, finalBuffer, { caption: `Prontinho! (Fonte: ${usedScraper})` }, { filename: 'media.jpg', contentType: finalContentType || 'image/jpeg' });
    }

    await bot.deleteMessage(chatId, statusMsg.message_id);
  } catch (err) {
    console.error(`[${chatId}] Falha ao processar ${url0}:`, err);
    const extra =
      /pinterest/i.test(url0) && !PINTEREST_COOKIES
        ? '\n⚠️ Dica: Para alguns pins, defina PINTEREST_COOKIES na Environment (linha única com cookies do Pinterest).'
        : '';
    const errorText = `❌ Falha ao processar o link (via ${usedScraper || 'desconhecido'}): ${err.message}${extra}`;
    if (statusMsg) await bot.editMessageText(errorText, { chat_id: chatId, message_id: statusMsg.message_id });
    else await bot.sendMessage(chatId, errorText);
  }
});

// ===================================================================================
// Boot: remover webhook e iniciar polling
// ===================================================================================
(async () => {
  try {
    await bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
    await bot.startPolling();
    console.log('[BOT] Polling iniciado.');
  } catch (e) {
    console.error('[BOT] Falha ao iniciar polling:', e);
    process.exit(1);
  }
})();

process.on('SIGTERM', async () => { try { await bot.stopPolling(); } catch {} process.exit(0); });
process.on('SIGINT', async () => { try { await bot.stopPolling(); } catch {} process.exit(0); });

console.log('✅ Bot rodando (TikTok → btch-downloader | Pinterest/YouTube → yt-dlp). Pressione Ctrl+C para encerrar.');
