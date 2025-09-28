// bot.js
require('dotenv').config();

const isProd = process.env.NODE_ENV === 'production';
console.log('[ENV] isProd =', isProd);

const TelegramBot = require('node-telegram-bot-api');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const scraper = require('btch-downloader');

const ffmpeg = require('fluent-ffmpeg');

// ---- FFmpeg/FFprobe paths ----
if (isProd) {
  // Produção: usar binários do sistema (ex.: Docker com apk/apt add ffmpeg)
  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH || '/usr/bin/ffmpeg');
  ffmpeg.setFfprobePath(process.env.FFPROBE_PATH || '/usr/bin/ffprobe');
} else {
  // Dev: usar pacotes npm
  const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
  const ffprobeStatic = require('ffprobe-static');
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// ===================================================================================
// Config / ACL por @username (via .env)
// ===================================================================================
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false, filepath: false });

// Lock simples para evitar dupla inicialização (ex.: nodemon)
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
  } catch { }
}

// ===================================================================================
// Estado por chat para coletar metadados passo a passo
// ===================================================================================
/** state: chatId -> { awaiting: boolean, pendingUrl: string, stepIndex: number, meta: Record<string,string> } */
const state = new Map();

// Ordem dos campos de metadados (sem "date" — será preenchida automaticamente)
const META_STEPS = [
  { key: 'title', label: 'título' },
  { key: 'artist', label: 'artista' },
  { key: 'comment', label: 'comentário' },
  { key: 'description', label: 'descrição' },
  { key: 'genre', label: 'gênero' },
];

// ===================================================================================
/* Utils de stream / download */
// ===================================================================================
function streamToBuffer(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0;
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

function getStream(urlStr, { maxRedirects = 5, timeoutMs = 30000 } = {}) {
  if (maxRedirects < 0) return Promise.reject(new Error('Too many redirects'));
  const u = new URL(urlStr);
  const isHttps = u.protocol === 'https:';
  const client = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' },
      },
      (res) => {
        const status = res.statusCode || 0;

        if (status >= 300 && status < 400 && res.headers.location) {
          const next = new URL(res.headers.location, u).toString();
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

        res._contentType = res.headers['content-type'] || '';
        resolve(res);
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function downloadToBufferWithType(url, opts = {}) {
  const { maxBytes } = opts;
  const res = await getStream(url, opts);
  const buf = await streamToBuffer(res, maxBytes);
  return { buffer: buf, contentType: res._contentType };
}

// Helpers gerais
function extractFirstUrl(text = '') {
  const m = text.match(/https?:\/\/\S+/i);
  return m ? m[0].replace(/[)\]}>"'\s]+$/, '') : null;
}

function sanitizeMetaValue(v = '') {
  // remove quebras de linha e '='; se ficar vazio, retorna undefined (pular)
  const cleaned = String(v)
    .replace(/[\r\n]+/g, ' ')
    .replace(/=/g, '-')
    .trim();
  return cleaned.length ? cleaned.slice(0, 200) : undefined;
}

function buildFinalMeta(meta = {}) {
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      out[k] = String(v).trim();
    }
  }
  // Data automática YYYY-MM-DD
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  out.date = `${yyyy}-${mm}-${dd}`;
  return out;
}

// Resolve URL direta do vídeo (TikTok share → btch-downloader)
async function resolveDirectVideoUrl(shareUrl) {
  if (/\.mp4(\?|$)/i.test(shareUrl)) return shareUrl;

  const result = await scraper.ttdl(shareUrl);
  let candidate = null;

  if (typeof result.video === 'string') {
    candidate = result.video;
  } else if (Array.isArray(result.video) && result.video.length) {
    candidate = result.video[0];
  } else if (result.video && typeof result.video === 'object') {
    candidate = result.video.nowm || result.video.hd || result.video.sd || result.video.wm ||
      result.video.url || result.video.link;
    if (!candidate) {
      const firstKey = Object.keys(result.video)[0];
      candidate = result.video[firstKey];
    }
  }

  if (!candidate || typeof candidate !== 'string') {
    throw new Error('Não consegui resolver uma URL direta do vídeo.');
  }
  return candidate;
}

// ===================================================================================
// FFmpeg: reescrever metadados (sem reencodar)
// ===================================================================================
async function rewriteVideoMetadata(inputBuffer, meta = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-meta-'));
  const inPath = path.join(tmpDir, crypto.randomBytes(6).toString('hex') + '.mp4');
  const outPath = path.join(tmpDir, crypto.randomBytes(6).toString('hex') + '.mp4');

  try {
    await fs.writeFile(inPath, inputBuffer);

    await new Promise((resolve, reject) => {
      let cmd = ffmpeg(inPath)
        .outputOptions([
          '-map_metadata', '-1',      // remove metadados originais
          '-c', 'copy',               // sem reencode
          '-movflags', '+faststart'   // bom para streaming/Telegram
        ])
        .on('error', reject)
        .on('end', resolve);

      Object.entries(meta).forEach(([k, v]) => {
        if (!v) return; // só aplica se tiver valor
        cmd = cmd.outputOptions(['-metadata', `${k}=${v}`]);
      });

      cmd.save(outPath);
    });

    const out = await fs.readFile(outPath);
    return out;
  } finally {
    try { fsSync.existsSync(inPath) && (await fs.unlink(inPath)); } catch { }
    try { fsSync.existsSync(outPath) && (await fs.unlink(outPath)); } catch { }
    try { await fs.rmdir(tmpDir); } catch { }
  }
}

// ===================================================================================
// Mensagens de ajuda / passos
// ===================================================================================
async function sendInstructions(chatId) {
  const text =
    `Envie **um link** do TikTok (ou uma URL direta .mp4).

Eu vou perguntar os metadados **um por vez**:
• título
• artista
• comentário
• descrição
• gênero

A **data** será preenchida automaticamente com a data de hoje.

Comandos:
• /pular — pula o campo atual
• /cancelar — cancela o processo (também vale /cancel)`;
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

async function askCurrentStep(chatId) {
  const s = state.get(chatId);
  const step = META_STEPS[s.stepIndex];
  await bot.sendMessage(
    chatId,
    `Me envie o **${step.label}**.\n(Digite /pular para deixar em branco, ou /cancelar para cancelar)`,
    { parse_mode: 'Markdown' }
  );
}

// ===================================================================================
// Handlers
// ===================================================================================
bot.on('message', async (msg) => {
  if (!isAllowed(msg)) return replyNotAllowed(msg);

  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;

  // Comandos globais
  if (/^\/cancelar\b/i.test(text) || /^\/cancel\b/i.test(text)) {
    state.delete(chatId);
    await bot.sendMessage(chatId, 'Ok, cancelei. Quando quiser é só mandar um link novamente.');
    return;
  }
  if (/^\/start\b/i.test(text)) {
    await sendInstructions(chatId);
    return;
  }

  // Se estamos aguardando o valor de um campo de metadado
  const s = state.get(chatId);
  if (s && s.awaiting) {
    if (/^\/pular\b/i.test(text)) {
      s.stepIndex++;
    } else {
      const step = META_STEPS[s.stepIndex];
      const val = sanitizeMetaValue(text);
      if (val !== undefined) s.meta[step.key] = val; // se vazio, considera "pulado"
      s.stepIndex++;
    }

    // Terminou → processa vídeo
    if (s.stepIndex >= META_STEPS.length) {
      state.delete(chatId);
      try {
        await bot.sendChatAction(chatId, 'upload_video');

        const directUrl = await resolveDirectVideoUrl(s.pendingUrl);
        const { buffer, contentType } = await downloadToBufferWithType(directUrl, {
          maxRedirects: 5,
          timeoutMs: 30000,
          maxBytes: 49 * 1024 * 1024
        });

        if (!/^video\//i.test(contentType)) {
          await bot.sendMessage(chatId, `A URL resolvida não parece ser vídeo. Content-Type: "${contentType}".`);
          return;
        }

        const finalMeta = buildFinalMeta(s.meta);
        const processed = await rewriteVideoMetadata(buffer, finalMeta);

        await bot.sendVideo(
          chatId,
          processed,
          { caption: 'Prontinho! Vídeo com metadados atualizados.' },
          { filename: 'video.mp4', contentType: 'video/mp4' }
        );
      } catch (err) {
        console.error(err);
        await bot.sendMessage(chatId, `Falha ao processar o vídeo: ${err.message}`);
      }
      return;
    }

    // Ainda tem campos → pergunta o próximo
    await askCurrentStep(chatId);
    return;
  }

  // Não estamos aguardando meta: tenta detectar URL na mensagem
  const url = extractFirstUrl(text);
  if (!url) {
    if (text && text.length < 60) await sendInstructions(chatId);
    return;
  }

  // Inicia o fluxo de metadados
  state.set(chatId, { awaiting: true, pendingUrl: url, stepIndex: 0, meta: {} });
  await bot.sendMessage(
    chatId,
    'Link recebido! Vou perguntar os metadados um por vez.\n' +
    'Você pode usar /pular para deixar algum em branco ou /cancelar para cancelar.'
  );
  await askCurrentStep(chatId);
});

// ===================================================================================
// Boot: remover webhook (qualquer versão) e iniciar polling (evita 409)
// ===================================================================================
(async () => {
  try {
    // compat: algumas versões usam deleteWebHook (H maiúsculo), outras deleteWebhook
    if (typeof bot.deleteWebHook === 'function') {
      await bot.deleteWebHook({ drop_pending_updates: true });
    } else if (typeof bot.deleteWebhook === 'function') {
      await bot.deleteWebhook({ drop_pending_updates: true });
    } else if (typeof bot.setWebHook === 'function') {
      // fallback: limpar webhook definindo vazio
      await bot.setWebHook('', { drop_pending_updates: true });
    }

    await bot.startPolling();
    console.log('[BOT] Polling iniciado.');
  } catch (e) {
    console.error('[BOT] Falha ao iniciar polling:', e);
    process.exit(1);
  }
})();

// Encerramento limpo (evita sessão paralela em redeploy)
process.on('SIGTERM', async () => { try { await bot.stopPolling(); } catch { } process.exit(0); });
process.on('SIGINT', async () => { try { await bot.stopPolling(); } catch { } process.exit(0); });


console.log('✅ Bot rodando. Pressione Ctrl+C para encerrar.');