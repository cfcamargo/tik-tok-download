# Use a imagem base oficial do Node.js (LTS, slim para ser menor)
FROM node:20-slim

# === 1. INSTALAÇÃO DE DEPENDÊNCIAS DE SISTEMA ===
# Instala python3, pip, e o ffmpeg (CRUCIAL para yt-dlp juntar streams)
# O --no-install-recommends mantém a imagem menor.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# === 2. INSTALAÇÃO DO YT-DLP ===
# Instala o yt-dlp globalmente. Isso o coloca no PATH, resolvendo o erro ENOENT.
RUN pip3 install yt-dlp

# === 3. CONFIGURAÇÃO DA APLICAÇÃO NODE.JS ===
WORKDIR /usr/src/app

# Copia os arquivos de configuração do Node e instala as dependências
COPY package.json package-lock.json ./
# O --omit=dev garante que dependências de desenvolvimento (como instaladores de ffmpeg do NPM)
# não sejam instaladas, pois já instalamos o ffmpeg no sistema.
RUN npm install --omit=dev

# Copia o código fonte (incluindo o bot.js)
COPY . .

# === 4. CONFIGURAÇÕES DE AMBIENTE ===
# Define o ambiente como produção
ENV NODE_ENV production

# Define as variáveis de caminho para os binários de produção.
# No container, eles estão no PATH, então o valor é apenas o nome do binário.
ENV YTDLP_PATH yt-dlp
ENV FFMPEG_PATH ffmpeg

# === 5. COMANDO DE INICIALIZAÇÃO ===
# Inicia a aplicação
CMD ["node", "bot.js"]