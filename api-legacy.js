const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
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
// CONFIGURATION
// ============================================
const API_KEY = "BWxD1xkzuPxJ0luWnsaECtn3CVZkYG6dtNUxnwUsBWWwYwvkKYl1ZZWnDuP6M";
const JWT_SECRET = process.env.JWT_SECRET || "your-super-secret-jwt-key-change-in-production";
const JWT_EXPIRY = "24h";

// Configuration de la base de données
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'c1286229c_wazana_paiements',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

// Pool de connexions MySQL
const pool = mysql.createPool(dbConfig);

// Stockage des sessions actives en mémoire (avec récupération depuis la BD au démarrage)
const sessions = {};
const sessionTokens = {};

// ============================================
// UTILITAIRES
// ============================================

/**
 * Génère un JWT Token pour une session
 */
function generateSessionToken(appId, userId = "default") {
    return jwt.sign(
        { appId, userId, iat: Date.now() },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
    );
}

/**
 * Vérifie le JWT Token
 */
function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return null;
    }
}

/**
 * Récupère une connexion à la base de données
 */
async function getDbConnection() {
    return await pool.getConnection();
}

/**
 * Enregistre une action dans les logs de connexion
 */
async function logConnectionAction(appId, action, oldStatus, newStatus, details, ipAddress) {
    try {
        const connection = await getDbConnection();
        await connection.execute(
            'INSERT INTO whatsapp_connection_logs (app_id, action, old_status, new_status, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [appId, action, oldStatus, newStatus, details, ipAddress]
        );
        connection.release();
    } catch (err) {
        console.error('Erreur enregistrement log:', err);
    }
}

/**
 * Met à jour le statut d'une application WhatsApp
 */
async function updateAppStatus(appId, status, phoneNumber = null, qrCode = null) {
    try {
        const connection = await getDbConnection();
        const updates = [];
        const values = [];

        updates.push('status = ?');
        values.push(status);

        if (phoneNumber) {
            updates.push('phone_number = ?');
            values.push(phoneNumber);
        }

        if (qrCode) {
            updates.push('qr_code = ?');
            values.push(qrCode);
            updates.push('last_qr_generated = NOW()');
        }

        if (status === 'connected') {
            updates.push('connected_at = NOW()');
        } else if (status === 'disconnected') {
            updates.push('disconnected_at = NOW()');
        }

        values.push(appId);

        await connection.execute(
            `UPDATE whatsapp_apps SET ${updates.join(', ')} WHERE id = ?`,
            values
        );
        connection.release();
    } catch (err) {
        console.error('Erreur mise à jour statut:', err);
    }
}

/**
 * Enregistre un message dans la base de données
 */
async function saveMessage(appId, recipientNumber, message, status, apiResponse = null) {
    try {
        const connection = await getDbConnection();
        await connection.execute(
            'INSERT INTO whatsapp_messages (app_id, recipient_number, message, status, api_response) VALUES (?, ?, ?, ?, ?)',
            [appId, recipientNumber, message, status, apiResponse]
        );
        connection.release();
    } catch (err) {
        console.error('Erreur enregistrement message:', err);
    }
}

/**
 * Enregistre les statistiques d'envoi
 */
async function updateStats(appId, messagesSent = 0, messagesFailed = 0) {
    try {
        const connection = await getDbConnection();
        const today = new Date().toISOString().split('T')[0];

        // Vérifier si une entrée existe pour aujourd'hui
        const [rows] = await connection.execute(
            'SELECT id FROM whatsapp_stats WHERE app_id = ? AND date = ?',
            [appId, today]
        );

        if (rows.length > 0) {
            await connection.execute(
                'UPDATE whatsapp_stats SET messages_sent = messages_sent + ?, messages_failed = messages_failed + ? WHERE app_id = ? AND date = ?',
                [messagesSent, messagesFailed, appId, today]
            );
        } else {
            await connection.execute(
                'INSERT INTO whatsapp_stats (app_id, date, messages_sent, messages_failed) VALUES (?, ?, ?, ?)',
                [appId, today, messagesSent, messagesFailed]
            );
        }
        connection.release();
    } catch (err) {
        console.error('Erreur mise à jour stats:', err);
    }
}

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

// ============================================
// MIDDLEWARE D'AUTHENTIFICATION
// ============================================

function verifyMasterApiKey(req, res, next) {
    const apiKey = req.headers["x-api-key"];
    if (apiKey !== API_KEY) {
        return res.status(401).json({ error: "API Key invalide ou manquante" });
    }
    next();
}

function verifyJWTToken(req, res, next) {
    const token = req.headers["authorization"]?.replace("Bearer ", "");
    if (!token) {
        return res.status(401).json({ error: "Token manquant" });
    }

    const decoded = verifyToken(token);
    if (!decoded) {
        return res.status(401).json({ error: "Token invalide ou expiré" });
    }

    req.appId = decoded.appId;
    req.userId = decoded.userId;
    next();
}

// ============================================
// ENDPOINTS DE GESTION DES SESSIONS
// ============================================

/**
 * GET /api/health
 */
app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/**
 * POST /api/sessions/:appId/start
 * Démarre une nouvelle session WhatsApp
 */
app.post("/api/sessions/:appId/start", verifyMasterApiKey, async (req, res) => {
    try {
        const appId = parseInt(req.params.appId);
        const userId = req.body.userId || "default";

        // Récupérer l'app depuis la BD
        const connection = await getDbConnection();
        const [apps] = await connection.execute(
            'SELECT * FROM whatsapp_apps WHERE id = ?',
            [appId]
        );
        connection.release();

        if (apps.length === 0) {
            return res.status(404).json({ error: "Application non trouvée" });
        }

        const app = apps[0];

        // Nettoyage si une session existe déjà
        if (sessions[appId] && sessions[appId].client) {
            console.log(`[App ${appId}] Fermeture de l'ancienne instance...`);
            try {
                await sessions[appId].client.destroy();
            } catch (e) {
                console.error(`[App ${appId}] Erreur destruction:`, e.message);
            }
        }

        sessions[appId] = { client: null, status: "STARTING", qr: null, phoneNumber: null };

        // Génération du JWT Token
        const token = generateSessionToken(appId, userId);
        sessionTokens[appId] = token;

        // Initialisation du client
        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: `app-${appId}`,
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

        // Gestion des événements
        client.on('qr', async (qr) => {
            try {
                const qrCodeBase64 = await qrcode.toDataURL(qr);
                sessions[appId].qr = qrCodeBase64;
                sessions[appId].status = "SCAN_QR";
                
                // Mise à jour BD
                await updateAppStatus(appId, 'qr', null, qrCodeBase64);
                await logConnectionAction(appId, 'qr_generated', 'STARTING', 'SCAN_QR', 'QR code généré', req.ip);
                
                console.log(`[App ${appId}] QR Code généré`);
            } catch (err) {
                console.error(`[App ${appId}] Erreur QR:`, err);
            }
        });

        client.on('ready', async () => {
            try {
                // Récupérer le numéro WhatsApp
                const phoneNumber = client.info.wid.user;
                sessions[appId].status = "WORKING";
                sessions[appId].qr = null;
                sessions[appId].phoneNumber = phoneNumber;

                // Mise à jour BD
                await updateAppStatus(appId, 'connected', phoneNumber);
                await logConnectionAction(appId, 'connect', 'SCAN_QR', 'WORKING', `Connecté avec ${phoneNumber}`, req.ip);
                
                console.log(`[App ${appId}] ✅ Session opérationnelle! Numéro: ${phoneNumber}`);
            } catch (err) {
                console.error(`[App ${appId}] Erreur ready:`, err);
            }
        });

        client.on('authenticated', async () => {
            try {
                await logConnectionAction(appId, 'authenticated', null, 'AUTHENTICATED', 'Authentification réussie', req.ip);
                console.log(`[App ${appId}] 🔓 Authentification réussie`);
            } catch (err) {
                console.error(`[App ${appId}] Erreur authenticated:`, err);
            }
        });

        client.on('auth_failure', async (msg) => {
            try {
                sessions[appId].status = "AUTH_FAILURE";
                await updateAppStatus(appId, 'disconnected');
                await logConnectionAction(appId, 'auth_failure', 'AUTHENTICATED', 'AUTH_FAILURE', msg, req.ip);
                console.error(`[App ${appId}] ❌ Échec auth:`, msg);
            } catch (err) {
                console.error(`[App ${appId}] Erreur auth_failure:`, err);
            }
        });

        client.on('disconnected', async (reason) => {
            try {
                sessions[appId].status = "DISCONNECTED";
                await updateAppStatus(appId, 'disconnected');
                await logConnectionAction(appId, 'disconnect', 'WORKING', 'DISCONNECTED', reason, req.ip);
                console.log(`[App ${appId}] 🔌 Déconnecté:`, reason);
            } catch (err) {
                console.error(`[App ${appId}] Erreur disconnected:`, err);
            }
        });

        sessions[appId].client = client;
        client.initialize().catch(err => {
            console.error(`[App ${appId}] Erreur init:`, err);
            sessions[appId].status = "ERROR";
        });

        res.json({
            ok: true,
            message: "Session initialisée",
            appId: appId,
            token: token,
            expiresIn: JWT_EXPIRY
        });
    } catch (err) {
        console.error('Erreur démarrage session:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/sessions/:appId/qr
 */
app.get("/api/sessions/:appId/qr", verifyMasterApiKey, (req, res) => {
    const appId = parseInt(req.params.appId);
    const session = sessions[appId];
    
    if (!session) return res.status(404).json({ error: "Session non trouvée" });

    if (session.status === "WORKING") {
        return res.json({ 
            status: "WORKING", 
            message: "Déjà connecté",
            phoneNumber: session.phoneNumber 
        });
    }

    if (!session.qr) {
        return res.json({ status: session.status, message: "QR non disponible" });
    }

    res.json({ qr: session.qr, status: session.status });
});

/**
 * GET /api/sessions/:appId/status
 */
app.get("/api/sessions/:appId/status", verifyMasterApiKey, (req, res) => {
    const appId = parseInt(req.params.appId);
    const session = sessions[appId];
    
    if (!session) return res.status(404).json({ error: "Session non trouvée" });
    
    res.json({ 
        status: session.status,
        phoneNumber: session.phoneNumber
    });
});

/**
 * DELETE /api/sessions/:appId
 */
app.delete("/api/sessions/:appId", verifyMasterApiKey, async (req, res) => {
    try {
        const appId = parseInt(req.params.appId);
        const session = sessions[appId];
        
        if (!session) return res.status(404).json({ error: "Session non trouvée" });

        if (session.client) {
            await session.client.destroy();
        }

        // Mise à jour BD
        await updateAppStatus(appId, 'disconnected');
        await logConnectionAction(appId, 'disconnect', session.status, 'DISCONNECTED', 'Déconnexion manuelle', req.ip);

        delete sessions[appId];
        delete sessionTokens[appId];

        res.json({ ok: true, message: "Session détruite" });
    } catch (err) {
        console.error('Erreur suppression session:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// ENDPOINT UNIFIÉ D'ENVOI DE MESSAGES
// ============================================

/**
 * POST /api/messages/send
 * Endpoint unifié pour envoyer tous types de messages
 * 
 * Body:
 * {
 *   "to": "33612345678" ou "120363123456789-1234567890@g.us",
 *   "text": "Bonjour!", (OBLIGATOIRE)
 *   "image": "https://example.com/image.jpg" (optionnel),
 *   "video": "https://example.com/video.mp4" (optionnel),
 *   "audio": "https://example.com/audio.mp3" (optionnel),
 *   "file": "https://example.com/document.pdf" (optionnel),
 *   "fileName": "document.pdf" (requis si file),
 *   "mentions": ["33612345678"] (optionnel),
 *   "buttons": [...] (optionnel, future feature),
 *   "reactions": "👍" (optionnel)
 * }
 */
app.post("/api/messages/send", verifyJWTToken, async (req, res) => {
    try {
        const appId = req.appId;
        const { to, text, image, video, audio, file, fileName, mentions, buttons, reactions } = req.body;

        // Validation
        if (!to || !text) {
            return res.status(400).json({ error: "Paramètres obligatoires manquants: to, text" });
        }

        const session = sessions[appId];
        if (!session || !session.client || session.status !== "WORKING") {
            return res.status(400).json({ error: "Session non connectée" });
        }

        const client = session.client;
        let messageOptions = {};
        let mediaToSend = null;

        // Gestion des mentions
        if (mentions && mentions.length > 0) {
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
                return res.status(400).json({ error: "fileName requis pour les fichiers" });
            }
            const mimeType = getMimeType(file);
            const media = await createMessageMedia(file, mimeType);
            media.filename = fileName;
            mediaToSend = media;
        }

        // Envoi du message
        const messageContent = mediaToSend || text;
        const result = await client.sendMessage(to, messageContent, messageOptions);

        // Enregistrement en BD
        await saveMessage(appId, to, text, 'sent', JSON.stringify(result));
        await updateStats(appId, 1, 0);

        // Gestion des réactions (si spécifié)
        if (reactions) {
            try {
                await client.react(result.id.id, reactions);
            } catch (err) {
                console.warn(`Erreur ajout réaction: ${err.message}`);
            }
        }

        res.json({
            ok: true,
            message: "Message envoyé",
            messageId: result.id.id,
            to: to,
            hasMedia: !!mediaToSend,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error("Erreur envoi message:", err);
        
        // Enregistrement de l'erreur en BD
        try {
            await saveMessage(req.appId, req.body.to, req.body.text, 'failed', err.message);
            await updateStats(req.appId, 0, 1);
        } catch (dbErr) {
            console.error('Erreur enregistrement erreur:', dbErr);
        }

        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/messages/batch
 * Envoyer à plusieurs destinataires
 */
app.post("/api/messages/batch", verifyJWTToken, async (req, res) => {
    try {
        const appId = req.appId;
        const { recipients, text, image, video, audio, file, fileName, mentions } = req.body;

        if (!recipients || !Array.isArray(recipients) || recipients.length === 0 || !text) {
            return res.status(400).json({ error: "Paramètres manquants: recipients (array), text" });
        }

        const session = sessions[appId];
        if (!session || !session.client || session.status !== "WORKING") {
            return res.status(400).json({ error: "Session non connectée" });
        }

        const client = session.client;
        const results = [];
        const errors = [];

        for (const recipient of recipients) {
            try {
                let messageOptions = {};
                let mediaToSend = null;

                if (mentions && mentions.length > 0) {
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

                // Enregistrement en BD
                await saveMessage(appId, recipient, text, 'sent', JSON.stringify(result));

                results.push({
                    recipient,
                    status: "sent",
                    messageId: result.id.id
                });
            } catch (err) {
                errors.push({
                    recipient,
                    status: "failed",
                    error: err.message
                });
                await saveMessage(appId, recipient, text, 'failed', err.message);
            }

            // Délai entre les envois
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Mise à jour des stats
        await updateStats(appId, results.length, errors.length);

        res.json({
            ok: true,
            message: `Messages envoyés: ${results.length}/${recipients.length}`,
            results,
            errors: errors.length > 0 ? errors : undefined,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error("Erreur envoi batch:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// ENDPOINTS DE STATISTIQUES
// ============================================

/**
 * GET /api/stats/:appId
 */
app.get("/api/stats/:appId", verifyMasterApiKey, async (req, res) => {
    try {
        const appId = parseInt(req.params.appId);
        const connection = await getDbConnection();

        const [stats] = await connection.execute(
            'SELECT * FROM whatsapp_stats WHERE app_id = ? ORDER BY date DESC LIMIT 30',
            [appId]
        );

        connection.release();

        res.json({
            ok: true,
            appId: appId,
            stats: stats
        });
    } catch (err) {
        console.error('Erreur récupération stats:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// DÉMARRAGE DU SERVEUR
// ============================================

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`\n🚀 NotifyBridge API FINAL (avec BD persistante) prête sur le port ${port}`);
    console.log(`📍 Base URL: http://localhost:${port}`);
    console.log(`🔐 Authentification: API Key + JWT Token`);
    console.log(`💾 Base de données: ${dbConfig.database}\n`);
});