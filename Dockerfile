# Use a imagem base oficial do Node.js (LTS, slim para ser menor)
FROM node:20-slim

# === 1. INSTALAÇÃO DE DEPENDÊNCIAS DE SISTEMA ===
# Adiciona utilitários básicos (procps = ps, grep), Python, venv e ffmpeg
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    ffmpeg \
    procps \
    && rm -rf /var/lib/apt/lists/*

# === 2. INSTALAÇÃO DO YT-DLP EM AMBIENTE VIRTUAL ===
# Cria um ambiente virtual temporário para evitar o erro 'externally-managed-environment'
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv $VIRTUAL_ENV

# Adiciona o ambiente virtual ao PATH
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Instala o yt-dlp dentro do ambiente virtual (agora deve funcionar)
RUN pip install yt-dlp

# Move o binário yt-dlp para um local global (/usr/local/bin) e limpa o venv
RUN mv $VIRTUAL_ENV/bin/yt-dlp /usr/local/bin/yt-dlp && \
    rm -rf $VIRTUAL_ENV

# === 3. CONFIGURAÇÃO DA APLICAÇÃO NODE.JS ===
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY . .

# === 4. CONFIGURAÇÕES DE AMBIENTE ===
ENV NODE_ENV production
ENV YTDLP_PATH yt-dlp
ENV FFMPEG_PATH ffmpeg

# === 5. HEALTHCHECK E COMANDO (Agora com 'ps' e 'grep' disponíveis) ===
# Healthcheck: Verifica a cada 10s se o processo 'node' principal ainda está ativo.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s \
  CMD ["sh", "-c", "ps aux | grep -v grep | grep node || exit 1"]

CMD ["node", "bot.js"]