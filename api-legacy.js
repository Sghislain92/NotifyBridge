const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');

/**
 * CONFIGURATION STEALTH AVANCÉE
 * Le plugin Stealth masque les variables Puppeteer qui trahissent l'automatisation
 * (navigator.webdriver, chrome.runtime, etc.)
 */
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());
app.use(cors());

const sessions = {};
const API_KEY = "BWxD1xkzuPxJ0luWnsaECtn3CVZkYG6dtNUxnwUsBWWwYwvkKYl1ZZWnDuP6M";

// Middleware d'authentification
app.use((req, res, next) => {
    if (req.headers["x-api-key"] !== API_KEY) {
        return res.status(401).json({ error: "Authentification API échouée" });
    }
    next();
});

/**
 * POST /api/sessions/:sessionId/start
 * Démarre une nouvelle session WhatsApp avec mode Stealth
 */
app.post("/api/sessions/:sessionId/start", async (req, res) => {
    const sessionId = req.params.sessionId;

    // 1. Nettoyage préventif si une session existe déjà
    if (sessions[sessionId] && sessions[sessionId].client) {
        console.log(`[${sessionId}] Fermeture de l'ancienne instance...`);
        try {
            await sessions[sessionId].client.destroy();
        } catch (e) {
            console.error(`[${sessionId}] Erreur lors de la destruction :`, e.message);
        }
    }

    sessions[sessionId] = { client: null, status: "STARTING", qr: null };

    // 2. Initialisation du client avec stratégie de camouflage maximale
    const client = new Client({
        authStrategy: new LocalAuth({ 
            clientId: sessionId,
            dataPath: './.wwebjs_auth' // Dossier persistant (doit être créé dans le Dockerfile)
        }),
        // Forçage d'une version Web stable pour éviter les incompatibilités de détection
        webVersionCache: { 
            type: 'remote', 
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1035691214-alpha.html' 
        },
        puppeteer: {
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-infobars',
                '--window-position=0,0',
                '--ignore-certificate-errors',
                '--ignore-certificate-errors-spki-list',
                '--disable-extensions',
                // User-Agent Windows récent pour paraître "humain"
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            ]
        }
    });

    // 3. Gestion des événements
    client.on('qr', async (qr) => {
        try {
            const qrCodeBase64 = await qrcode.toDataURL(qr);
            sessions[sessionId].qr = qrCodeBase64;
            sessions[sessionId].status = "SCAN_QR";
            console.log(`[${sessionId}] QR Code généré - En attente de scan...`);
        } catch (err) {
            console.error(`[${sessionId}] Erreur génération QR :`, err);
        }
    });

    client.on('ready', () => { 
        sessions[sessionId].status = "WORKING"; 
        sessions[sessionId].qr = null; 
        console.log(`[${sessionId}] ✅ Session opérationnelle !`);
    });

    client.on('authenticated', () => {
        console.log(`[${sessionId}] 🔓 Authentification réussie`);
    });

    client.on('auth_failure', msg => {
        console.error(`[${sessionId}] ❌ Échec d'authentification :`, msg);
        sessions[sessionId].status = "AUTH_FAILURE";
    });

    client.on('disconnected', (reason) => {
        console.log(`[${sessionId}] 🔌 Déconnecté :`, reason);
        sessions[sessionId].status = "DISCONNECTED";
    });

    // 4. Lancement
    sessions[sessionId].client = client;
    client.initialize().catch(err => {
        console.error(`[${sessionId}] Erreur fatale initialisation :`, err);
        sessions[sessionId].status = "ERROR";
    });

    res.json({ 
        ok: true, 
        message: "Initialisation de la session WhatsApp lancée en mode Stealth",
        sessionId: sessionId 
    });
});

/**
 * GET /api/sessions/:sessionId/qr
 * Récupère le QR code et le statut de la session
 */
app.get("/api/sessions/:sessionId/qr", (req, res) => {
    const session = sessions[req.params.sessionId];
    if (!session) return res.status(404).json({ error: "Session non trouvée" });
    
    if (session.status === "WORKING") {
        return res.json({ status: "WORKING", message: "Déjà connecté" });
    }
    
    if (!session.qr) {
        return res.json({ status: session.status, message: "QR non encore disponible" });
    }
    
    res.json({ qr: session.qr, status: session.status });
});

/**
 * GET /api/sessions/:sessionId/status
 * Vérifie le statut d'une session
 */
app.get("/api/sessions/:sessionId/status", (req, res) => {
    const session = sessions[req.params.sessionId];
    if (!session) return res.status(404).json({ error: "Session non trouvée" });
    res.json({ status: session.status });
});

/**
 * DELETE /api/sessions/:sessionId
 * Détruit une session
 */
app.delete("/api/sessions/:sessionId", async (req, res) => {
    const session = sessions[req.params.sessionId];
    if (!session) return res.status(404).json({ error: "Session non trouvée" });
    
    try {
        if (session.client) {
            await session.client.destroy();
        }
        delete sessions[req.params.sessionId];
        res.json({ ok: true, message: "Session détruite" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/health
 * Vérification de santé de l'API
 */
app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`\n🚀 NotifyBridge Stealth API prête sur le port ${port}`);
    console.log(`📍 Endpoint de démarrage : POST http://localhost:${port}/api/sessions/VOTRE_ID/start`);
    console.log(`📍 Récupérer QR : GET http://localhost:${port}/api/sessions/VOTRE_ID/qr`);
    console.log(`📍 Vérifier statut : GET http://localhost:${port}/api/sessions/VOTRE_ID/status\n`);
});