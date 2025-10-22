# ---- Base: Node + ffmpeg + yt-dlp ----
FROM node:20-bookworm-slim

# Evita prompts interativos
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
# Opcional (teu código já usa esse path por padrão):
ENV YTDLP_PATH=/usr/local/bin/yt-dlp

# Sistema: ffmpeg, python3/pip para instalar yt-dlp, e libs básicas
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates curl python3 python3-pip ffmpeg \
  && pip3 install --no-cache-dir yt-dlp \
  && apt-get purge -y --auto-remove \
  && rm -rf /var/lib/apt/lists/*

# Diretório da app
WORKDIR /app

# Copia apenas manifestos para cache de dependências
COPY package*.json ./

# Instala só dependências de produção
RUN npm ci --omit=dev

# Copia o resto do projeto
COPY . .

# Garante permissões para usuário não-root
RUN chown -R node:node /app
USER node

# Não expomos portas: é um bot por polling (saída apenas)
# Opcional: healthcheck simples (confirma que o processo Node está vivo)
# HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
#   CMD node -e "process.exit(0)"

# Comando de inicialização
CMD ["node", "bot.js"]
