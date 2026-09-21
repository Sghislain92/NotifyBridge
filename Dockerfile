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

# 3. CRÉATION DES DOSSIERS DE PERSISTANCE (CRUCIAL POUR RAILWAY)
# .wwebjs_auth stocke les cookies/session WhatsApp (sans cela, WhatsApp détecte
# un environnement "jetable" et bloque le scan du QR code).
# data/ stocke le magasin de clés API (hash uniquement) — montez un volume
# Railway sur /app/data pour que les clés survivent aux redéploiements.
RUN mkdir -p .wwebjs_auth data \
    && groupadd -r notifybridge && useradd -r -g notifybridge -d /app notifybridge \
    && chown -R notifybridge:notifybridge /app

# 4. Installation des dépendances Node.js
COPY package*.json ./
RUN npm install --omit=dev \
    && chown -R notifybridge:notifybridge /app/node_modules

# 5. Copie du code source
COPY --chown=notifybridge:notifybridge . .

# 6. Variables d'environnement pour Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV NODE_ENV=production
ENV API_KEYS_DIR=/app/data

EXPOSE 3000

# 7. Le conteneur ne tourne plus en root : réduit l'impact d'une éventuelle
# exécution de code arbitraire côté Chrome/Puppeteer.
USER notifybridge

# 8. Healthcheck: /api/health est public (pas de clé API requise)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://localhost:' + (process.env.PORT || 8080) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# 9. Lancement de l'API
CMD ["npm", "start"]