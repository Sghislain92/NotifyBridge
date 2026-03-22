FROM node:20-slim

# 1. Installation des dépendances système pour Chrome et Puppeteer
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libxss1 \
    libu2f-udev \
    libvulkan1 \
    xvfb \
    --no-install-recommends

# 2. Installation de Google Chrome Stable
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 3. CRÉATION DU DOSSIER DE PERSISTANCE (CRUCIAL POUR RAILWAY)
# Ce dossier stockera les cookies et le cache de session WhatsApp.
# Sans cela, WhatsApp détecte un environnement "jetable" et bloque le scan du QR code.
RUN mkdir -p .wwebjs_auth && chmod 777 .wwebjs_auth

# 4. Installation des dépendances Node.js
COPY package*.json ./
RUN npm install --only=production

# 5. Copie du code source
COPY . .

# 6. Variables d'environnement pour Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV NODE_ENV=production

EXPOSE 3000

# 7. Lancement de l'API
CMD ["npm", "start"]