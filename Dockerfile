# ---- Base: Node + ffmpeg + yt-dlp (APT) ----
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN chown -R node:node /app
USER node

# ✅ Healthcheck: garante que o processo 1 é o Node (sem precisar de procps/pgrep)
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD sh -c 'grep -q "^node" /proc/1/comm || exit 1'

CMD ["node", "bot.js"]
