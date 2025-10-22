# Use a imagem base oficial do Node.js (LTS, slim para ser menor)
FROM node:20-slim

# === 1. INSTALAÇÃO DE DEPENDÊNCIAS DE SISTEMA E PYTHON ===
# Instala python3, pip, python3-full (necessário para venv) e ffmpeg
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# === 2. INSTALAÇÃO DO YT-DLP EM AMBIENTE VIRTUAL ===
# Cria um ambiente virtual temporário
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv $VIRTUAL_ENV

# Adiciona o ambiente virtual ao PATH
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Instala o yt-dlp dentro do ambiente virtual
RUN pip install yt-dlp

# Move o binário yt-dlp para um local global para garantir que o Node.js o encontre facilmente
# O executável agora está garantido em /usr/local/bin
RUN mv $VIRTUAL_ENV/bin/yt-dlp /usr/local/bin/yt-dlp && \
    rm -rf $VIRTUAL_ENV

# === 3. CONFIGURAÇÃO DA APLICAÇÃO NODE.JS ===
WORKDIR /usr/src/app

# Copia os arquivos de configuração do Node e instala as dependências
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# Copia o código fonte (incluindo o bot.js)
COPY . .

# === 4. CONFIGURAÇÕES DE AMBIENTE ===
# Define o ambiente como produção
ENV NODE_ENV production

# Define as variáveis de caminho para os binários de produção.
# Eles estão no PATH, então o valor é apenas o nome do binário.
ENV YTDLP_PATH yt-dlp
ENV FFMPEG_PATH ffmpeg

# HEALTHCHECK explícito:
# Inicia a checagem após 5s e verifica a cada 5s se o processo "node" está rodando.
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s \
  CMD ps aux | grep -v grep | grep node || exit 1

# === 5. COMANDO DE INICIALIZAÇÃO ===
CMD ["node", "bot.js"]
