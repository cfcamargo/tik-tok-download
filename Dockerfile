# ---- Base: Node + ffmpeg + yt-dlp (APT) ----
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp

# Instala ffmpeg e yt-dlp via APT (evita PEP 668)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates curl ffmpeg yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Cache de deps
COPY package*.json ./
RUN npm ci --omit=dev

# Código
COPY . .

# Permissões e usuário não-root
RUN chown -R node:node /app
USER node

# (bot usa polling; sem portas)
CMD ["node", "bot.js"]
