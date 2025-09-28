# Dockerfile
FROM node:20-alpine AS base
WORKDIR /app

# Instala apenas dependências de produção (se seu projeto não precisa buildar TS/webpack)
COPY package*.json ./
RUN npm ci --omit=dev

# Instala tini (sinais) e ffmpeg/ffprobe do SO
RUN apk add --no-cache tini ffmpeg

# Copia código
COPY . .

# Variáveis de runtime
ENV NODE_ENV=production
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV FFPROBE_PATH=/usr/bin/ffprobe

# Verificação em build – falha cedo se não tiver ffmpeg/ffprobe
RUN ffmpeg -version && ffprobe -version

# Usuário não-root
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "process.exit(0)"
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","bot.js"]
