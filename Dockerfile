# -------- Base com Node ----------
FROM node:20-alpine AS base
WORKDIR /app

# -------- Instala dependências em camadas ----------
FROM base AS deps
COPY package*.json ./
# Instala só prod deps (mais leve)
RUN npm ci --omit=dev

# -------- Runtime ----------
FROM base AS runner
ENV NODE_ENV=production

# init para repassar sinais corretamente (CTRL+C, SIGTERM)
RUN apk add --no-cache tini

# (Opcional) Se quiser usar o ffmpeg do SO em vez do @ffmpeg-installer:
# RUN apk add --no-cache ffmpeg

WORKDIR /app

# Copia node_modules já resolvido
COPY --from=deps /app/node_modules ./node_modules

# Copia o restante do código
COPY . .

# Usa usuário não-root por segurança
RUN addgroup -S app && adduser -S app -G app \
  && chown -R app:app /app
USER app

# Variáveis de ambiente (defina no Coolify; aqui ficam só placeholders)
ENV TELEGRAM_TOKEN=""
ENV ALLOWED_USERNAMES=""

# Healthcheck simples (container considerado saudável enquanto o processo existir)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "process.exit(0)"

# Entrypoint com tini + comando padrão
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "bot.js"]
