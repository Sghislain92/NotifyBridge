const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteerExtra.use(StealthPlugin());

const app = express();
app.use(express.json());

// ============================================
// CONFIGURATION CORS
// ============================================
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

const PORT = process.env.PORT || 8080;

// ============================================
// CONFIGURATION PUPPETEER - STABLE & TIMEOUT
// ============================================
const puppeteerConfig = {
    headless: true,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process=false',
        '--disable-web-resources',
        '--disable-default-apps',
        '--disable-preconnect',
        '--disable-component-extensions-with-background-pages',
        '--disable-background-networking',
        '--disable-sync',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-default-browser-check',
        '--no-first-run',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-reading-from-canvas',
        '--disable-renderer-backgrounding',
        '--disable-device-discovery-notifications',
        '--disable-default-apps',
        '--enable-features=NetworkService,NetworkServiceInProcess',
        '--disable-blink-features=AutomationControlled',
        '--disable-accelerated-2d-canvas',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-component-update',
        '--disable-domain-blocking-for-3d-apis',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        '--force-color-profile=srgb',
        '--hide-scrollbars',
        '--ignore-certificate-errors',
        '--metrics-recording-only',
        '--no-zygote'
    ],
    protocolTimeout: 600000,
    timeout: 120000,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
    ignoreHTTPSErrors: true
};

// ============================================
// STOCKAGE DES SESSIONS ET MESSAGES
// ============================================
const sessions = new Map();
const messageTracking = new Map();

// ============================================
// FONCTION DE CRÉATION D'UN CLIENT
// ============================================
async function createClient(sessionId) {
    try {
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: sessionId }),
            puppeteer: puppeteerConfig,
            webVersionCache: {
                type: 'remote',
                remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/index.html'
            }
        });

        client.on('qr', async (qr) => {
            console.log(`[${sessionId}] QR Code généré`);
            const session = sessions.get(sessionId);
            if (session) {
                session.status = 'SCAN_QR';
                try {
                    const qrImage = await qrcode.toDataURL(qr);
                    session.qr = qrImage;
                } catch (e) {
                    console.error(`[${sessionId}] Erreur conversion QR:`, e.message);
                    session.qr = qr;
                }
                session.lastActivity = Date.now();
            }
        });

        client.on('authenticated', () => {
            console.log(`[${sessionId}] 🔓 Authentification réussie`);
            const session = sessions.get(sessionId);
            if (session) {
                session.status = 'AUTHENTICATED';
                session.lastActivity = Date.now();
            }
        });

        client.on('auth_failure', (msg) => {
            console.error(`[${sessionId}] ❌ Échec d'authentification: ${msg}`);
            const session = sessions.get(sessionId);
            if (session) {
                session.status = 'AUTH_FAILURE';
                session.error = msg;
                session.lastActivity = Date.now();
            }
        });

        client.on('ready', async () => {
            console.log(`[${sessionId}] ✅ Client prêt`);
            const session = sessions.get(sessionId);
            if (!session) return;

            session.status = 'WORKING';
            session.lastActivity = Date.now();

            try {
                let phoneNumber = null;
                let pushname = null;
                let wid = null;

                if (client.info && client.info.wid) {
                    wid = client.info.wid;
                    phoneNumber = wid.user;
                }
                if (client.info && client.info.pushname) {
                    pushname = client.info.pushname;
                }

                session.phoneNumber = phoneNumber;

                session.userInfo = {
                    wid: wid ? {
                        serialized: wid._serialized,
                        user: wid.user,
                        server: wid.server
                    } : null,
                    personal: {
                        pushname: pushname,
                        platform: client.info?.platform || null
                    },
                    phone: null,
                    battery: null
                };

                try {
                    if (client.info && client.info.phone) {
                        session.userInfo.phone = {
                            wa_version: client.info.phone.wa_version || null,
                            os_version: client.info.phone.os_version || null,
                            device_manufacturer: client.info.phone.device_manufacturer || null,
                            device_model: client.info.phone.device_model || null,
                            os_build_number: client.info.phone.os_build_number || null
                        };
                    }
                } catch (e) {
                    console.log(`[${sessionId}] Infos téléphone non disponibles`);
                }

                try {
                    const batteryStatus = await client.getBatteryStatus();
                    if (batteryStatus) {
                        session.userInfo.battery = {
                            percentage: batteryStatus.battery,
                            plugged: batteryStatus.plugged
                        };
                    }
                } catch (e) {
                    console.log(`[${sessionId}] Batterie non disponible`);
                }

                if (wid && wid._serialized) {
                    let contact = null;
                    for (let attempt = 0; attempt < 3; attempt++) {
                        try {
                            contact = await client.getContactById(wid._serialized);
                            break;
                        } catch (e) {
                            console.log(`[${sessionId}] Tentative ${attempt + 1} contact échouée`);
                            if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
                        }
                    }

                    if (contact) {
                        session.contactInfo = {
                            id: contact.id?._serialized || null,
                            number: contact.number || phoneNumber,
                            name: contact.name || null,
                            pushname: contact.pushname || pushname,
                            shortName: contact.shortName || null,
                            isMe: contact.isMe || false,
                            isMyContact: contact.isMyContact || false,
                            isUser: contact.isUser || false,
                            isWAContact: contact.isWAContact || false,
                            isBlocked: contact.isBlocked || false,
                            isGroup: contact.isGroup || false,
                            isBusiness: contact.isBusiness || false,
                            isEnterprise: contact.isEnterprise || false,
                            countryCode: null,
                            formattedNumber: null,
                            profilePicUrl: null,
                            about: null,
                            commonGroupsCount: 0
                        };

                        setTimeout(async () => {
                            try {
                                const [countryCode, formattedNumber, profilePicUrl, about] = await Promise.allSettled([
                                    contact.getCountryCode(),
                                    contact.getFormattedNumber(),
                                    contact.getProfilePicUrl(),
                                    contact.getAbout()
                                ]);
                                if (countryCode.value) session.contactInfo.countryCode = countryCode.value;
                                if (formattedNumber.value) session.contactInfo.formattedNumber = formattedNumber.value;
                                if (profilePicUrl.value) session.contactInfo.profilePicUrl = profilePicUrl.value;
                                if (about.value) session.contactInfo.about = about.value;
                            } catch (e) {}
                        }, 0);
                    } else {
                        session.contactInfo = {
                            number: phoneNumber,
                            pushname: pushname,
                            name: null,
                            formattedNumber: null,
                            countryCode: null
                        };
                    }
                }

                console.log(`[${sessionId}] ✅ Session prête - Numéro: ${phoneNumber || 'inconnu'} - Nom: ${pushname || 'Non défini'}`);
            } catch (error) {
                console.error(`[${sessionId}] Erreur récupération infos:`, error.message);
                session.error = error.message;
                if (client.info && client.info.wid) {
                    session.phoneNumber = client.info.wid.user;
                    session.contactInfo = {
                        number: client.info.wid.user,
                        pushname: client.info.pushname || null
                    };
                }
            }
        });

        client.on('disconnected', (reason) => {
            console.log(`[${sessionId}] 🔌 Déconnecté: ${reason}`);
            const session = sessions.get(sessionId);
            if (session) {
                session.status = 'DISCONNECTED';
                session.lastActivity = Date.now();
            }
        });

        client.on('error', (error) => {
            console.error(`[${sessionId}] ⚠️ Erreur client:`, error.message);
            const session = sessions.get(sessionId);
            if (session) {
                session.error = error.message;
                session.lastActivity = Date.now();
            }
        });

        client.on('message_ack', (msg, ack) => {
            const messageId = msg.id.id;
            const ackStatus = ['pending', 'sent', 'delivered', 'read', 'played'][ack] || 'unknown';
            if (messageTracking.has(messageId)) {
                const msgData = messageTracking.get(messageId);
                msgData.status = ackStatus;
                msgData.ack = ack;
                msgData.lastUpdate = new Date().toISOString();
            }
        });

        return client;
    } catch (error) {
        console.error(`[${sessionId}] Erreur création client:`, error.message);
        throw error;
    }
}

// ============================================
// ENDPOINTS SESSIONS
// ============================================

app.post('/api/sessions/:sessionId/start', async (req, res) => {
    const { sessionId } = req.params;
    try {
        if (sessions.has(sessionId)) {
            const session = sessions.get(sessionId);
            return res.json({
                ok: true,
                message: 'Session déjà en cours',
                sessionId,
                phoneNumber: session.phoneNumber || null,
                pushname: session.contactInfo?.pushname || null
            });
        }

        const client = await createClient(sessionId);
        sessions.set(sessionId, {
            client,
            status: 'STARTING',
            qr: null,
            phoneNumber: null,
            createdAt: new Date().toISOString(),
            lastActivity: Date.now(),
            messagesCount: 0,
            error: null,
            userInfo: null,
            contactInfo: null
        });

        await client.initialize();

        res.json({
            ok: true,
            message: 'Initialisation de la session WhatsApp lancée en mode Stealth',
            sessionId,
            phoneNumber: null,
            pushname: null
        });
    } catch (error) {
        console.error(`[${sessionId}] Erreur:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get('/api/sessions/:sessionId/qr', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: 'Session non trouvée' });
    if (!session.qr) return res.json({ status: session.status, message: 'QR non encore disponible' });
    res.json({ qr: session.qr, status: session.status });
});

app.get('/api/sessions/:sessionId/status', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: 'Session non trouvée' });
    res.json({
        ok: true,
        status: session.status,
        phoneNumber: session.phoneNumber || null,
        pushname: session.contactInfo?.pushname || null,
        error: session.error || null
    });
});

app.get('/api/sessions/:sessionId/info', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: 'Session non trouvée' });
    if (session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session non connectée', status: session.status });
    res.json({
        ok: true,
        sessionId,
        status: session.status,
        phoneNumber: session.phoneNumber,
        pushname: session.contactInfo?.pushname,
        userInfo: session.userInfo || null,
        contactInfo: session.contactInfo || null,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/sessions/:sessionId/phone-number', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: 'Session non trouvée' });
    if (session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session non connectée', status: session.status });
    res.json({
        ok: true,
        sessionId,
        phoneNumber: session.phoneNumber,
        contactInfo: session.contactInfo ? {
            number: session.contactInfo.number,
            pushname: session.contactInfo.pushname,
            formattedNumber: session.contactInfo.formattedNumber,
            countryCode: session.contactInfo.countryCode,
            about: session.contactInfo.about,
            profilePicUrl: session.contactInfo.profilePicUrl
        } : null,
        timestamp: new Date().toISOString()
    });
});

app.delete('/api/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: 'Session non trouvée' });
    try {
        await session.client.logout();
        await session.client.destroy();
        sessions.delete(sessionId);
        res.json({ ok: true, message: 'Session détruite' });
    } catch (error) {
        console.error(`[${sessionId}] Erreur suppression:`, error.message);
        sessions.delete(sessionId);
        res.json({ ok: true, message: 'Session détruite (avec erreur)' });
    }
});

// ============================================
// ENDPOINT POUR GARDER LA SESSION ACTIVE (PING)
// ============================================
app.post('/api/sessions/:sessionId/ping', async (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    
    if (!session || session.status !== 'WORKING') {
        return res.json({ ok: false, error: 'Session non active' });
    }
    
    try {
        const status = session.client.info ? 'active' : 'inactive';
        session.lastActivity = Date.now();
        
        res.json({ 
            ok: true, 
            status: 'active',
            lastActivity: session.lastActivity
        });
    } catch (error) {
        res.json({ ok: false, error: error.message });
    }
});

// ============================================
// ENDPOINT POUR DÉCONNECTER UNE SESSION EXISTANTE
// ============================================
app.post('/api/sessions/:sessionId/logout', async (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({ ok: false, error: 'Session non trouvée' });
    }
    
    try {
        await session.client.logout();
        await session.client.destroy();
        sessions.delete(sessionId);
        
        res.json({ 
            ok: true, 
            message: 'Déconnexion réussie. Vous pouvez maintenant reconnecter ce numéro ailleurs.'
        });
    } catch (error) {
        sessions.delete(sessionId);
        res.json({ 
            ok: true, 
            message: 'Session supprimée'
        });
    }
});

// ============================================
// ENVOI DE MESSAGE TEXTE AVEC TIMEOUT AUGMENTÉ À 60s
// ============================================

app.post('/api/messages/send', async (req, res) => {
    const { sessionId, to, text, mentions, reactions } = req.body;

    if (!sessionId || !to || !text) {
        return res.status(400).json({ ok: false, error: 'Paramètres manquants: sessionId, to, text requis' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ ok: false, error: 'Session non trouvée' });
    }
    
    if (session.status !== 'WORKING') {
        return res.status(400).json({ 
            ok: false, 
            error: `Session non prête - Statut: ${session.status}`,
            status: session.status
        });
    }

    if (!session.client || !session.client.info) {
        return res.status(400).json({ ok: false, error: 'Client WhatsApp non connecté' });
    }

    try {
        const sendWithRetry = async (attempt = 1, maxAttempts = 2) => {
            try {
                const sendPromise = session.client.sendMessage(to, text);
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Timeout envoi message (60s)')), 60000)
                );
                return await Promise.race([sendPromise, timeoutPromise]);
            } catch (error) {
                if (attempt < maxAttempts && error.message.includes('Timeout')) {
                    console.log(`[${sessionId}] Tentative ${attempt} échouée, réessai...`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    return sendWithRetry(attempt + 1, maxAttempts);
                }
                throw error;
            }
        };

        const sentMessage = await sendWithRetry();

        const messageId = sentMessage.id.id;
        messageTracking.set(messageId, {
            messageId,
            sessionId,
            to,
            text,
            status: 'sent',
            ack: 1,
            timestamp: new Date().toISOString(),
            lastUpdate: new Date().toISOString(),
            hasMedia: false,
            fromNumber: session.phoneNumber,
            fromPushname: session.contactInfo?.pushname
        });

        session.messagesCount++;

        if (reactions) {
            try { await sentMessage.react(reactions); } catch (e) {}
        }

        res.json({
            ok: true,
            message: 'Message envoyé',
            messageId,
            sessionId,
            to,
            from: {
                number: session.phoneNumber,
                pushname: session.contactInfo?.pushname || null
            },
            status: 'sent',
            hasMedia: false,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error(`[${sessionId}] Erreur envoi message:`, error.message);
        
        if (error.message.includes('closed') || error.message.includes('destroyed')) {
            session.status = 'DISCONNECTED';
            session.error = error.message;
        }
        
        res.status(500).json({ 
            ok: false, 
            error: error.message,
            sessionStatus: session.status
        });
    }
});

// ============================================
// ENVOI D'IMAGE (URL ou Base64) - AFFICHAGE DIRECT
// ============================================

app.post('/api/messages/send-image', async (req, res) => {
    const { sessionId, to, caption, imageUrl, imageBase64 } = req.body;

    if (!sessionId || !to) {
        return res.status(400).json({ ok: false, error: 'Paramètres manquants: sessionId, to requis' });
    }
    if (!imageUrl && !imageBase64) {
        return res.status(400).json({ ok: false, error: 'Paramètres manquants: imageUrl ou imageBase64 requis' });
    }

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') {
        return res.status(400).json({ ok: false, error: 'Session non connectée ou non trouvée' });
    }

    try {
        let mediaBuffer = null;

        if (imageUrl) {
            const fetchPromise = fetch(imageUrl);
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout téléchargement image (15s)')), 15000));
            const response = await Promise.race([fetchPromise, timeoutPromise]);

            if (!response.ok) {
                throw new Error(`Erreur téléchargement image: ${response.status}`);
            }
            mediaBuffer = await response.buffer();
        } else if (imageBase64) {
            let base64Data = imageBase64;
            if (base64Data.includes('base64,')) {
                base64Data = base64Data.split('base64,')[1];
            }
            mediaBuffer = Buffer.from(base64Data, 'base64');
        }

        const messageOptions = {
            caption: caption || '',
            media: mediaBuffer
        };

        const sendPromise = session.client.sendMessage(to, messageOptions);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout envoi image (30s)')), 30000));
        const sentMessage = await Promise.race([sendPromise, timeoutPromise]);

        const messageId = sentMessage.id.id;
        messageTracking.set(messageId, {
            messageId,
            sessionId,
            to,
            text: caption || '',
            status: 'sent',
            ack: 1,
            timestamp: new Date().toISOString(),
            lastUpdate: new Date().toISOString(),
            hasMedia: true,
            mediaType: 'image',
            fromNumber: session.phoneNumber,
            fromPushname: session.contactInfo?.pushname
        });

        session.messagesCount++;

        res.json({
            ok: true,
            message: 'Image envoyée',
            messageId,
            sessionId,
            to,
            from: {
                number: session.phoneNumber,
                pushname: session.contactInfo?.pushname || null
            },
            hasMedia: true,
            mediaType: 'image',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error(`[${sessionId}] Erreur envoi image:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ============================================
// ENDPOINTS SUIVI
// ============================================

app.get('/api/messages/:messageId/status', (req, res) => {
    const { messageId } = req.params;
    const msg = messageTracking.get(messageId);
    if (!msg) return res.status(404).json({ ok: false, error: 'Message non trouvé' });
    res.json({
        ok: true,
        messageId,
        sessionId: msg.sessionId,
        to: msg.to,
        from: {
            number: msg.fromNumber,
            pushname: msg.fromPushname
        },
        status: msg.status,
        ack: msg.ack,
        timestamp: msg.timestamp,
        lastUpdate: msg.lastUpdate,
        hasMedia: msg.hasMedia
    });
});

app.get('/api/sessions/:sessionId/messages', (req, res) => {
    const { sessionId } = req.params;
    const messages = Array.from(messageTracking.values()).filter(m => m.sessionId === sessionId);
    res.json({
        ok: true,
        sessionId,
        from: {
            number: sessions.get(sessionId)?.phoneNumber || null,
            pushname: sessions.get(sessionId)?.contactInfo?.pushname || null
        },
        count: messages.length,
        messages
    });
});

app.get('/api/sessions/:sessionId/messages/status/:status', (req, res) => {
    const { sessionId, status } = req.params;
    const messages = Array.from(messageTracking.values()).filter(m => m.sessionId === sessionId && m.status === status);
    res.json({
        ok: true,
        sessionId,
        from: {
            number: sessions.get(sessionId)?.phoneNumber || null,
            pushname: sessions.get(sessionId)?.contactInfo?.pushname || null
        },
        filter: status,
        count: messages.length,
        messages
    });
});

// ============================================
// STATS & HEALTH
// ============================================

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        activeSessions: sessions.size,
        trackedMessages: messageTracking.size
    });
});

app.get('/api/stats', (req, res) => {
    const stats = {
        activeSessions: sessions.size,
        trackedMessages: messageTracking.size,
        messagesByStatus: { pending: 0, sent: 0, delivered: 0, read: 0, played: 0 },
        sessions: []
    };
    messageTracking.forEach(msg => stats.messagesByStatus[msg.status]++);
    sessions.forEach((session, sessionId) => {
        stats.sessions.push({
            sessionId,
            status: session.status,
            phoneNumber: session.phoneNumber,
            pushname: session.contactInfo?.pushname,
            messagesCount: session.messagesCount
        });
    });
    res.json({ ok: true, timestamp: new Date().toISOString(), stats });
});

// ============================================
// DÉMARRAGE
// ============================================
app.listen(PORT, () => {
    console.log(`🚀 NotifyBridge Stealth API FINAL prête sur le port ${PORT}`);
    console.log(`📍 POST   /api/sessions/:sessionId/start`);
    console.log(`📍 GET    /api/sessions/:sessionId/qr`);
    console.log(`📍 GET    /api/sessions/:sessionId/status`);
    console.log(`📍 GET    /api/sessions/:sessionId/info`);
    console.log(`📍 GET    /api/sessions/:sessionId/phone-number`);
    console.log(`📍 POST   /api/messages/send          (texte avec timeout 60s et retry)`);
    console.log(`📍 POST   /api/messages/send-image    (image depuis URL ou base64)`);
    console.log(`📍 POST   /api/sessions/:sessionId/ping      (garder session active)`);
    console.log(`📍 POST   /api/sessions/:sessionId/logout    (déconnexion forcée)`);
    console.log(`📍 GET    /api/messages/:messageId/status`);
    console.log(`📍 GET    /api/health`);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});
