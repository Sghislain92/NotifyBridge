const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const axios = require('axios');

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
const messageTracking = {};
const API_KEY = "BWxD1xkzuPxJ0luWnsaECtn3CVZkYG6dtNUxnwUsBWWwYwvkKYl1ZZWnDuP6M";

// Middleware d'authentification
app.use((req, res, next) => {
    if (req.headers["x-api-key"] !== API_KEY) {
        return res.status(401).json({ error: "Authentification API échouée" });
    }
    next();
});

// ============================================
// UTILITAIRES
// ============================================

async function downloadFile(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(response.data, 'binary');
    } catch (err) {
        throw new Error(`Erreur téléchargement fichier: ${err.message}`);
    }
}

async function createMessageMedia(mediaUrl, mediaType) {
    try {
        const buffer = await downloadFile(mediaUrl);
        const base64 = buffer.toString('base64');
        return new MessageMedia(mediaType, base64);
    } catch (err) {
        throw new Error(`Erreur création media: ${err.message}`);
    }
}

function getMimeType(url) {
    const ext = url.split('.').pop().toLowerCase();
    const mimeTypes = {
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls': 'application/vnd.ms-excel',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'zip': 'application/zip',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'mp4': 'video/mp4',
        'avi': 'video/x-msvideo',
        'mov': 'video/quicktime',
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'm4a': 'audio/mp4'
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

function getMessageStatus(ack) {
    const statusMap = {
        0: 'pending',
        1: 'sent',
        2: 'delivered',
        3: 'read',
        4: 'played'
    };
    return statusMap[ack] || 'unknown';
}

/**
 * POST /api/sessions/:sessionId/start
 * Démarre une nouvelle session WhatsApp avec mode Stealth
 * CODE ORIGINAL QUI FONCTIONNE
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

    sessions[sessionId] = { client: null, status: "STARTING", qr: null, phoneNumber: null, messages: {} };

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
        sessions[sessionId].phoneNumber = client.info.wid.user;
        console.log(`[${sessionId}] ✅ Session opérationnelle ! Numéro: ${sessions[sessionId].phoneNumber}`);
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

    // Événement: Changement de statut de message (ACK)
    client.on('message_ack', (msg, ack) => {
        try {
            const messageId = msg.id.id;
            const status = getMessageStatus(ack);
            
            // Enregistrer le changement de statut
            if (messageTracking[messageId]) {
                messageTracking[messageId].status = status;
                messageTracking[messageId].ack = ack;
                messageTracking[messageId].lastUpdate = new Date();
            }

            // Aussi enregistrer dans la session
            if (sessions[sessionId] && sessions[sessionId].messages[messageId]) {
                sessions[sessionId].messages[messageId].status = status;
                sessions[sessionId].messages[messageId].ack = ack;
            }

            console.log(`[${sessionId}] Message ${messageId}: ${status}`);
        } catch (err) {
            console.error(`[${sessionId}] Erreur message_ack:`, err);
        }
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
        return res.json({ status: "WORKING", message: "Déjà connecté", phoneNumber: session.phoneNumber });
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
    res.json({ status: session.status, phoneNumber: session.phoneNumber });
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
    res.json({ status: "ok", timestamp: new Date().toISOString(), activeSessions: Object.keys(sessions).length });
});

// ============================================
// ENDPOINTS D'ENVOI DE MESSAGES (AJOUTÉS MINIMALEMENT)
// ============================================

/**
 * POST /api/messages/send
 * Envoie un message (texte, image, vidéo, audio, fichier)
 */
app.post("/api/messages/send", async (req, res) => {
    try {
        const { sessionId, to, text, image, video, audio, file, fileName, mentions, reactions } = req.body;

        if (!sessionId || !to || !text) {
            return res.status(400).json({
                ok: false,
                error: "Paramètres obligatoires manquants: sessionId, to, text"
            });
        }

        const session = sessions[sessionId];
        if (!session || !session.client || session.status !== "WORKING") {
            return res.status(400).json({
                ok: false,
                error: "Session non connectée ou non trouvée"
            });
        }

        const client = session.client;
        let messageOptions = {};
        let mediaToSend = null;

        // Gestion des mentions
        if (mentions && Array.isArray(mentions) && mentions.length > 0) {
            messageOptions.mentions = mentions;
        }

        // Gestion des médias (priorité: image > video > audio > file)
        if (image) {
            const media = await createMessageMedia(image, 'image/jpeg');
            messageOptions.caption = text;
            mediaToSend = media;
        } else if (video) {
            const media = await createMessageMedia(video, 'video/mp4');
            messageOptions.caption = text;
            mediaToSend = media;
        } else if (audio) {
            const media = await createMessageMedia(audio, 'audio/mpeg');
            mediaToSend = media;
        } else if (file) {
            if (!fileName) {
                return res.status(400).json({
                    ok: false,
                    error: "fileName requis pour les fichiers"
                });
            }
            const mimeType = getMimeType(file);
            const media = await createMessageMedia(file, mimeType);
            media.filename = fileName;
            mediaToSend = media;
        }

        // Envoi du message
        const messageContent = mediaToSend || text;
        const result = await client.sendMessage(to, messageContent, messageOptions);

        const messageId = result.id.id;

        // Enregistrement du message pour le suivi
        messageTracking[messageId] = {
            sessionId: sessionId,
            to: to,
            text: text,
            status: 'sent',
            ack: 1,
            timestamp: new Date(),
            lastUpdate: new Date(),
            hasMedia: !!mediaToSend
        };

        // Aussi enregistrer dans la session
        if (!session.messages) session.messages = {};
        session.messages[messageId] = messageTracking[messageId];

        // Gestion des réactions
        if (reactions) {
            try {
                await client.react(messageId, reactions);
            } catch (err) {
                console.warn(`Erreur ajout réaction: ${err.message}`);
            }
        }

        res.json({
            ok: true,
            message: "Message envoyé",
            messageId: messageId,
            sessionId: sessionId,
            to: to,
            status: "sent",
            hasMedia: !!mediaToSend,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error("Erreur envoi message:", err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * POST /api/messages/batch
 * Envoie le même message à plusieurs destinataires
 */
app.post("/api/messages/batch", async (req, res) => {
    try {
        const { sessionId, recipients, text, image, video, audio, file, fileName, mentions } = req.body;

        if (!sessionId || !recipients || !Array.isArray(recipients) || recipients.length === 0 || !text) {
            return res.status(400).json({
                ok: false,
                error: "Paramètres manquants: sessionId, recipients (array), text"
            });
        }

        const session = sessions[sessionId];
        if (!session || !session.client || session.status !== "WORKING") {
            return res.status(400).json({
                ok: false,
                error: "Session non connectée ou non trouvée"
            });
        }

        const client = session.client;
        const results = [];
        const errors = [];

        for (const recipient of recipients) {
            try {
                let messageOptions = {};
                let mediaToSend = null;

                if (mentions && Array.isArray(mentions) && mentions.length > 0) {
                    messageOptions.mentions = mentions;
                }

                if (image) {
                    const media = await createMessageMedia(image, 'image/jpeg');
                    messageOptions.caption = text;
                    mediaToSend = media;
                } else if (video) {
                    const media = await createMessageMedia(video, 'video/mp4');
                    messageOptions.caption = text;
                    mediaToSend = media;
                } else if (audio) {
                    const media = await createMessageMedia(audio, 'audio/mpeg');
                    mediaToSend = media;
                } else if (file && fileName) {
                    const mimeType = getMimeType(file);
                    const media = await createMessageMedia(file, mimeType);
                    media.filename = fileName;
                    mediaToSend = media;
                }

                const messageContent = mediaToSend || text;
                const result = await client.sendMessage(recipient, messageContent, messageOptions);

                const messageId = result.id.id;

                // Enregistrement du message
                messageTracking[messageId] = {
                    sessionId: sessionId,
                    to: recipient,
                    text: text,
                    status: 'sent',
                    ack: 1,
                    timestamp: new Date(),
                    lastUpdate: new Date(),
                    hasMedia: !!mediaToSend
                };

                if (!session.messages) session.messages = {};
                session.messages[messageId] = messageTracking[messageId];

                results.push({
                    recipient,
                    status: "sent",
                    messageId: messageId
                });
            } catch (err) {
                errors.push({
                    recipient,
                    status: "failed",
                    error: err.message
                });
            }

            // Délai entre les envois
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        res.json({
            ok: true,
            message: `Messages envoyés: ${results.length}/${recipients.length}`,
            sessionId: sessionId,
            results: results,
            errors: errors.length > 0 ? errors : undefined,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error("Erreur envoi batch:", err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ============================================
// ENDPOINTS DE SUIVI DES MESSAGES (POLLING)
// ============================================

/**
 * GET /api/messages/:messageId/status
 * Récupère le statut actuel d'un message
 */
app.get("/api/messages/:messageId/status", (req, res) => {
    const messageId = req.params.messageId;
    const message = messageTracking[messageId];

    if (!message) {
        return res.status(404).json({
            ok: false,
            error: "Message non trouvé"
        });
    }

    res.json({
        ok: true,
        messageId: messageId,
        sessionId: message.sessionId,
        to: message.to,
        status: message.status,
        ack: message.ack,
        timestamp: message.timestamp,
        lastUpdate: message.lastUpdate,
        hasMedia: message.hasMedia
    });
});

/**
 * GET /api/sessions/:sessionId/messages
 * Récupère tous les messages d'une session
 */
app.get("/api/sessions/:sessionId/messages", (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions[sessionId];

    if (!session) {
        return res.status(404).json({
            ok: false,
            error: "Session non trouvée"
        });
    }

    const messages = Object.entries(session.messages || {}).map(([messageId, msg]) => ({
        messageId,
        ...msg
    }));

    res.json({
        ok: true,
        sessionId: sessionId,
        count: messages.length,
        messages: messages
    });
});

/**
 * GET /api/sessions/:sessionId/messages/status/:status
 * Récupère les messages d'une session filtrés par statut
 */
app.get("/api/sessions/:sessionId/messages/status/:status", (req, res) => {
    const sessionId = req.params.sessionId;
    const filterStatus = req.params.status;
    const session = sessions[sessionId];

    if (!session) {
        return res.status(404).json({
            ok: false,
            error: "Session non trouvée"
        });
    }

    const messages = Object.entries(session.messages || {})
        .filter(([, msg]) => msg.status === filterStatus)
        .map(([messageId, msg]) => ({
            messageId,
            ...msg
        }));

    res.json({
        ok: true,
        sessionId: sessionId,
        filter: filterStatus,
        count: messages.length,
        messages: messages
    });
});

// ============================================
// ENDPOINTS DE STATISTIQUES
// ============================================

/**
 * GET /api/stats
 * Récupère les statistiques globales
 */
app.get("/api/stats", (req, res) => {
    const stats = {
        activeSessions: Object.keys(sessions).length,
        trackedMessages: Object.keys(messageTracking).length,
        messagesByStatus: {
            pending: Object.values(messageTracking).filter(m => m.status === 'pending').length,
            sent: Object.values(messageTracking).filter(m => m.status === 'sent').length,
            delivered: Object.values(messageTracking).filter(m => m.status === 'delivered').length,
            read: Object.values(messageTracking).filter(m => m.status === 'read').length,
            played: Object.values(messageTracking).filter(m => m.status === 'played').length
        },
        sessions: Object.entries(sessions).map(([sessionId, session]) => ({
            sessionId,
            status: session.status,
            phoneNumber: session.phoneNumber,
            messagesCount: Object.keys(session.messages || {}).length
        }))
    };

    res.json({
        ok: true,
        timestamp: new Date().toISOString(),
        stats: stats
    });
});

// ============================================
// DÉMARRAGE DU SERVEUR
// ============================================

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`\n🚀 NotifyBridge Stealth API FINAL prête sur le port ${port}`);
    console.log(`📍 Endpoint de démarrage : POST http://localhost:${port}/api/sessions/VOTRE_ID/start`);
    console.log(`📍 Récupérer QR : GET http://localhost:${port}/api/sessions/VOTRE_ID/qr`);
    console.log(`📍 Vérifier statut : GET http://localhost:${port}/api/sessions/VOTRE_ID/status`);
    console.log(`📍 Envoyer message : POST http://localhost:${port}/api/messages/send`);
    console.log(`📍 Suivi message : GET http://localhost:${port}/api/messages/MESSAGE_ID/status\n`);
});