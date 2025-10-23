# ---- Node + ffmpeg + yt-dlp (via script Python) ----
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp

# Precisamos do python3 porque o wrapper do yt-dlp usa /usr/bin/env python3
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg python3 \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
     -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN chown -R node:node /app
USER node

# Healthcheck simples (Coolify gosta de .State.Health)
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD sh -c 'grep -q "^node" /proc/1/comm || exit 1'

CMD ["node", "bot.js"]
