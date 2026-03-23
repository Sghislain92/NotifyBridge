const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const axios = require('axios');

/**
 * CONFIGURATION STEALTH AVANCÉE
 */
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));
app.use(cors());

// ============================================
// STOCKAGE EN MÉMOIRE (Sessions + Messages)
// ============================================

// Stockage des sessions actives
const sessions = {};

// Stockage des messages avec leurs statuts
// Structure: { messageId: { to, text, status, timestamp, ack } }
const messageTracking = {};

// ============================================
// UTILITAIRES
// ============================================

/**
 * Télécharge un fichier depuis une URL
 */
async function downloadFile(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(response.data, 'binary');
    } catch (err) {
        throw new Error(`Erreur téléchargement fichier: ${err.message}`);
    }
}

/**
 * Crée un MessageMedia à partir d'une URL
 */
async function createMessageMedia(mediaUrl, mediaType) {
    try {
        const buffer = await downloadFile(mediaUrl);
        const base64 = buffer.toString('base64');
        return new MessageMedia(mediaType, base64);
    } catch (err) {
        throw new Error(`Erreur création media: ${err.message}`);
    }
}

/**
 * Récupère le type MIME à partir de l'extension de fichier
 */
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

/**
 * Convertit les codes ACK WhatsApp en statuts lisibles
 */
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

// ============================================
// ENDPOINTS
// ============================================

/**
 * GET /api/health
 * Vérifier que l'API fonctionne
 */
app.get("/api/health", (req, res) => {
    res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        activeSessions: Object.keys(sessions).length,
        trackedMessages: Object.keys(messageTracking).length
    });
});

/**
 * POST /api/sessions/:sessionId/start
 * Démarre une nouvelle session WhatsApp
 */
app.post("/api/sessions/:sessionId/start", async (req, res) => {
    try {
        const sessionId = req.params.sessionId;

        console.log(`[Session ${sessionId}] Démarrage...`);

        // Nettoyage si une session existe déjà
        if (sessions[sessionId] && sessions[sessionId].client) {
            console.log(`[Session ${sessionId}] Fermeture de l'ancienne instance...`);
            try {
                await sessions[sessionId].client.destroy();
            } catch (e) {
                console.error(`[Session ${sessionId}] Erreur destruction:`, e.message);
            }
        }

        // Initialisation de la session
        sessions[sessionId] = {
            client: null,
            status: "STARTING",
            qr: null,
            phoneNumber: null,
            createdAt: new Date(),
            messages: {}
        };

        // Création du client WhatsApp
        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: `session-${sessionId}`,
                dataPath: './.wwebjs_auth'
            }),
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
                    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                ]
            }
        });

        // Événement: QR Code généré
        client.on('qr', async (qr) => {
            try {
                const qrCodeBase64 = await qrcode.toDataURL(qr);
                sessions[sessionId].qr = qrCodeBase64;
                sessions[sessionId].status = "SCAN_QR";
                console.log(`[Session ${sessionId}] QR Code généré`);
            } catch (err) {
                console.error(`[Session ${sessionId}] Erreur QR:`, err);
            }
        });

        // Événement: Client prêt
        client.on('ready', async () => {
            try {
                const phoneNumber = client.info.wid.user;
                sessions[sessionId].status = "WORKING";
                sessions[sessionId].qr = null;
                sessions[sessionId].phoneNumber = phoneNumber;
                console.log(`[Session ${sessionId}] ✅ Session opérationnelle! Numéro: ${phoneNumber}`);
            } catch (err) {
                console.error(`[Session ${sessionId}] Erreur ready:`, err);
            }
        });

        // Événement: Authentification réussie
        client.on('authenticated', async () => {
            console.log(`[Session ${sessionId}] 🔓 Authentification réussie`);
        });

        // Événement: Échec d'authentification
        client.on('auth_failure', async (msg) => {
            try {
                sessions[sessionId].status = "AUTH_FAILURE";
                console.error(`[Session ${sessionId}] ❌ Échec auth:`, msg);
            } catch (err) {
                console.error(`[Session ${sessionId}] Erreur auth_failure:`, err);
            }
        });

        // Événement: Déconnexion
        client.on('disconnected', async (reason) => {
            try {
                sessions[sessionId].status = "DISCONNECTED";
                console.log(`[Session ${sessionId}] 🔌 Déconnecté:`, reason);
            } catch (err) {
                console.error(`[Session ${sessionId}] Erreur disconnected:`, err);
            }
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

                console.log(`[Session ${sessionId}] Message ${messageId}: ${status}`);
            } catch (err) {
                console.error(`[Session ${sessionId}] Erreur message_ack:`, err);
            }
        });

        // Initialisation du client
        sessions[sessionId].client = client;
        client.initialize().catch(err => {
            console.error(`[Session ${sessionId}] Erreur init:`, err);
            sessions[sessionId].status = "ERROR";
        });

        res.json({
            ok: true,
            message: "Session initialisée",
            sessionId: sessionId,
            status: "STARTING"
        });
    } catch (err) {
        console.error('Erreur démarrage session:', err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * GET /api/sessions/:sessionId/qr
 * Récupère le QR code
 */
app.get("/api/sessions/:sessionId/qr", (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions[sessionId];
    
    if (!session) {
        return res.status(404).json({ ok: false, error: "Session non trouvée" });
    }

    if (session.status === "WORKING") {
        return res.json({
            ok: true,
            status: "WORKING",
            message: "Déjà connecté",
            phoneNumber: session.phoneNumber
        });
    }

    if (!session.qr) {
        return res.json({
            ok: true,
            status: session.status,
            message: "QR non disponible",
            qr: null
        });
    }

    res.json({
        ok: true,
        status: session.status,
        qr: session.qr
    });
});

/**
 * GET /api/sessions/:sessionId/status
 * Récupère le statut de la session
 */
app.get("/api/sessions/:sessionId/status", (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions[sessionId];
    
    if (!session) {
        return res.status(404).json({ ok: false, error: "Session non trouvée" });
    }
    
    res.json({
        ok: true,
        sessionId: sessionId,
        status: session.status,
        phoneNumber: session.phoneNumber,
        createdAt: session.createdAt,
        messagesTracked: Object.keys(session.messages).length
    });
});

/**
 * DELETE /api/sessions/:sessionId
 * Déconnecte et supprime la session
 */
app.delete("/api/sessions/:sessionId", async (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        const session = sessions[sessionId];
        
        if (!session) {
            return res.status(404).json({ ok: false, error: "Session non trouvée" });
        }

        if (session.client) {
            await session.client.destroy();
        }

        delete sessions[sessionId];

        res.json({
            ok: true,
            message: "Session détruite",
            sessionId: sessionId
        });
    } catch (err) {
        console.error('Erreur suppression session:', err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ============================================
// ENDPOINT UNIFIÉ D'ENVOI DE MESSAGES
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
            createdAt: session.createdAt,
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
    console.log(`\n🚀 NotifyBridge API STATELESS prête sur le port ${port}`);
    console.log(`📍 Base URL: http://localhost:${port}`);
    console.log(`🔓 Pas d'authentification (gérée en PHP)`);
    console.log(`💾 Pas de BD (gérée en PHP)`);
    console.log(`📊 Polling des statuts de messages disponible\n`);
});