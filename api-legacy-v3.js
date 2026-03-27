const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const puppeteer = require('puppeteer');
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
    protocolTimeout: 0,
    timeout: 0,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
    ignoreHTTPSErrors: true
};

// ============================================
// STOCKAGE DES SESSIONS ET MESSAGES
// ============================================
const sessions = new Map();
const messageTracking = new Map();

// ============================================
// WEBHOOKS STORAGE (sessionId -> url)
// ============================================
const webhooks = new Map();

// Helper function to send webhook events
async function sendWebhook(sessionId, event, data) {
    const url = webhooks.get(sessionId);
    if (!url) return;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, event, data, timestamp: new Date().toISOString() })
        });
    } catch (e) {
        console.error(`[${sessionId}] Webhook error:`, e.message);
    }
}

// ============================================
// FONCTION DE CRÉATION D'UN CLIENT
// ============================================
async function createClient(sessionId) {
    try {
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: sessionId }),
            puppeteer: {
                ...puppeteerConfig,
                _puppeteer: puppeteerExtra
            },
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
            sendWebhook(sessionId, 'qr', { qr: session?.qr });
        });

        client.on('authenticated', () => {
            console.log(`[${sessionId}] 🔓 Authentification réussie`);
            const session = sessions.get(sessionId);
            if (session) {
                session.status = 'AUTHENTICATED';
                session.lastActivity = Date.now();
            }
            sendWebhook(sessionId, 'authenticated', {});
        });

        client.on('auth_failure', (msg) => {
            console.error(`[${sessionId}] ❌ Échec d'authentification: ${msg}`);
            const session = sessions.get(sessionId);
            if (session) {
                session.status = 'AUTH_FAILURE';
                session.error = msg;
                session.lastActivity = Date.now();
            }
            sendWebhook(sessionId, 'auth_failure', { error: msg });
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
                sendWebhook(sessionId, 'ready', { phoneNumber, pushname });
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
                sendWebhook(sessionId, 'error', { error: error.message });
            }
        });

        client.on('message', async (message) => {
            console.log(`[${sessionId}] 📨 Message reçu de ${message.from}: ${message.body}`);
            const session = sessions.get(sessionId);
            if (session) {
                session.lastActivity = Date.now();
                // Stocker le message entrant dans messageTracking? Optionnel.
            }
            // Envoyer le webhook
            sendWebhook(sessionId, 'message', {
                id: message.id.id,
                from: message.from,
                to: message.to,
                body: message.body,
                type: message.type,
                timestamp: message.timestamp,
                hasMedia: message.hasMedia,
                isGroup: message.isGroup,
                fromMe: message.fromMe
            });
        });

        client.on('message_create', (message) => {
            // Similar to message, but includes messages sent by the client itself
            sendWebhook(sessionId, 'message_create', { id: message.id.id, from: message.from, body: message.body });
        });

        client.on('message_revoke_everyone', (after, before) => {
            sendWebhook(sessionId, 'message_revoke_everyone', { afterId: after.id.id, beforeId: before?.id.id });
        });

        client.on('message_revoke_me', (message) => {
            sendWebhook(sessionId, 'message_revoke_me', { id: message.id.id });
        });

        client.on('message_ack', (msg, ack) => {
            const ackStatus = ['pending', 'sent', 'delivered', 'read', 'played'][ack] || 'unknown';
            sendWebhook(sessionId, 'message_ack', { id: msg.id.id, ack, status: ackStatus });
        });

        client.on('group_join', (notification) => {
            sendWebhook(sessionId, 'group_join', { id: notification.id, chatId: notification.chatId, author: notification.author });
        });

        client.on('group_leave', (notification) => {
            sendWebhook(sessionId, 'group_leave', { id: notification.id, chatId: notification.chatId, author: notification.author });
        });

        client.on('group_update', (notification) => {
            sendWebhook(sessionId, 'group_update', { id: notification.id, chatId: notification.chatId, author: notification.author, body: notification.body });
        });

        client.on('change_state', (state) => {
            sendWebhook(sessionId, 'change_state', { state });
        });

        client.on('disconnected', (reason) => {
            console.log(`[${sessionId}] 🔌 Déconnecté: ${reason}`);
            const session = sessions.get(sessionId);
            if (session) {
                session.status = 'DISCONNECTED';
                session.disconnectReason = reason;
                session.disconnectedAt = new Date().toISOString();
                session.lastActivity = Date.now();
            }
            sendWebhook(sessionId, 'disconnected', { reason });
        });

        client.on('error', (error) => {
            console.error(`[${sessionId}] ⚠️ Erreur client:`, error.message);
            const session = sessions.get(sessionId);
            if (session) {
                session.error = error.message;
                session.lastActivity = Date.now();
            }
            sendWebhook(sessionId, 'error', { error: error.message });
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
            // Also forward via webhook
            sendWebhook(sessionId, 'message_ack', { id: messageId, ack, status: ackStatus });
        });

        return client;
    } catch (error) {
        console.error(`[${sessionId}] Erreur création client:`, error.message);
        throw error;
    }
}

// ============================================
// ENDPOINTS SESSIONS (déjà existants)
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
            contactInfo: null,
            disconnectReason: null,
            disconnectedAt: null
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
        webhooks.delete(sessionId);
        res.json({ ok: true, message: 'Session détruite' });
    } catch (error) {
        console.error(`[${sessionId}] Erreur suppression:`, error.message);
        sessions.delete(sessionId);
        webhooks.delete(sessionId);
        res.json({ ok: true, message: 'Session détruite (avec erreur)' });
    }
});

// ============================================
// ENDPOINTS WEBHOOK
// ============================================

app.post('/api/sessions/:sessionId/webhook', (req, res) => {
    const { sessionId } = req.params;
    const { url } = req.body;
    if (!url) return res.status(400).json({ ok: false, error: 'url required' });
    webhooks.set(sessionId, url);
    res.json({ ok: true, message: 'Webhook configured', url });
});

app.delete('/api/sessions/:sessionId/webhook', (req, res) => {
    const { sessionId } = req.params;
    webhooks.delete(sessionId);
    res.json({ ok: true, message: 'Webhook removed' });
});

// ============================================
// ENVOI DE MÉDIAS (nouveaux endpoints)
// ============================================

// Helper to fetch media buffer with timeout
async function fetchMedia(url, timeout = 15000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
    } catch (err) {
        clearTimeout(timeoutId);
        throw err;
    }
}

app.post('/api/messages/send-video', async (req, res) => {
    const { sessionId, to, caption, videoUrl, videoBase64 } = req.body;
    if (!sessionId || !to) return res.status(400).json({ ok: false, error: 'sessionId and to required' });
    if (!videoUrl && !videoBase64) return res.status(400).json({ ok: false, error: 'videoUrl or videoBase64 required' });

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        let mediaBuffer;
        if (videoUrl) {
            mediaBuffer = await fetchMedia(videoUrl, 30000);
        } else {
            let base64Data = videoBase64;
            if (base64Data.includes('base64,')) base64Data = base64Data.split('base64,')[1];
            mediaBuffer = Buffer.from(base64Data, 'base64');
        }
        const media = new MessageMedia('video/mp4', mediaBuffer.toString('base64'), 'video.mp4');
        const sentMessage = await session.client.sendMessage(to, media, { caption: caption || '' });
        const messageId = sentMessage.id.id;
        messageTracking.set(messageId, {
            messageId, sessionId, to, text: caption || '', status: 'sent', ack: 1,
            timestamp: new Date().toISOString(), lastUpdate: new Date().toISOString(),
            hasMedia: true, mediaType: 'video',
            fromNumber: session.phoneNumber, fromPushname: session.contactInfo?.pushname
        });
        session.messagesCount++;
        res.json({ ok: true, message: 'Video envoyée', messageId, sessionId, to, from: { number: session.phoneNumber, pushname: session.contactInfo?.pushname }, hasMedia: true, mediaType: 'video', timestamp: new Date().toISOString() });
    } catch (error) {
        console.error(`[${sessionId}] Erreur envoi vidéo:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post('/api/messages/send-audio', async (req, res) => {
    const { sessionId, to, audioUrl, audioBase64, asVoice = true } = req.body;
    if (!sessionId || !to) return res.status(400).json({ ok: false, error: 'sessionId and to required' });
    if (!audioUrl && !audioBase64) return res.status(400).json({ ok: false, error: 'audioUrl or audioBase64 required' });

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        let mediaBuffer;
        if (audioUrl) {
            mediaBuffer = await fetchMedia(audioUrl, 30000);
        } else {
            let base64Data = audioBase64;
            if (base64Data.includes('base64,')) base64Data = base64Data.split('base64,')[1];
            mediaBuffer = Buffer.from(base64Data, 'base64');
        }
        const media = new MessageMedia('audio/mpeg', mediaBuffer.toString('base64'), 'audio.mp3');
        const sentMessage = await session.client.sendMessage(to, media, { sendAudioAsVoice: asVoice });
        const messageId = sentMessage.id.id;
        messageTracking.set(messageId, {
            messageId, sessionId, to, text: '', status: 'sent', ack: 1,
            timestamp: new Date().toISOString(), lastUpdate: new Date().toISOString(),
            hasMedia: true, mediaType: asVoice ? 'voice' : 'audio',
            fromNumber: session.phoneNumber, fromPushname: session.contactInfo?.pushname
        });
        session.messagesCount++;
        res.json({ ok: true, message: asVoice ? 'Message vocal envoyé' : 'Audio envoyé', messageId, sessionId, to, from: { number: session.phoneNumber, pushname: session.contactInfo?.pushname }, hasMedia: true, mediaType: asVoice ? 'voice' : 'audio', timestamp: new Date().toISOString() });
    } catch (error) {
        console.error(`[${sessionId}] Erreur envoi audio:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post('/api/messages/send-file', async (req, res) => {
    const { sessionId, to, caption, fileUrl, fileBase64, fileName } = req.body;
    if (!sessionId || !to) return res.status(400).json({ ok: false, error: 'sessionId and to required' });
    if (!fileUrl && !fileBase64) return res.status(400).json({ ok: false, error: 'fileUrl or fileBase64 required' });

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        let mediaBuffer;
        if (fileUrl) {
            mediaBuffer = await fetchMedia(fileUrl, 60000);
        } else {
            let base64Data = fileBase64;
            if (base64Data.includes('base64,')) base64Data = base64Data.split('base64,')[1];
            mediaBuffer = Buffer.from(base64Data, 'base64');
        }
        const media = new MessageMedia('application/octet-stream', mediaBuffer.toString('base64'), fileName || 'file');
        const sentMessage = await session.client.sendMessage(to, media, { caption: caption || '' });
        const messageId = sentMessage.id.id;
        messageTracking.set(messageId, {
            messageId, sessionId, to, text: caption || '', status: 'sent', ack: 1,
            timestamp: new Date().toISOString(), lastUpdate: new Date().toISOString(),
            hasMedia: true, mediaType: 'file', fileName: fileName || 'file',
            fromNumber: session.phoneNumber, fromPushname: session.contactInfo?.pushname
        });
        session.messagesCount++;
        res.json({ ok: true, message: 'Fichier envoyé', messageId, sessionId, to, from: { number: session.phoneNumber, pushname: session.contactInfo?.pushname }, hasMedia: true, mediaType: 'file', timestamp: new Date().toISOString() });
    } catch (error) {
        console.error(`[${sessionId}] Erreur envoi fichier:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post('/api/messages/send-sticker', async (req, res) => {
    const { sessionId, to, stickerUrl, stickerBase64 } = req.body;
    if (!sessionId || !to) return res.status(400).json({ ok: false, error: 'sessionId and to required' });
    if (!stickerUrl && !stickerBase64) return res.status(400).json({ ok: false, error: 'stickerUrl or stickerBase64 required' });

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        let mediaBuffer;
        if (stickerUrl) {
            mediaBuffer = await fetchMedia(stickerUrl, 15000);
        } else {
            let base64Data = stickerBase64;
            if (base64Data.includes('base64,')) base64Data = base64Data.split('base64,')[1];
            mediaBuffer = Buffer.from(base64Data, 'base64');
        }
        const media = new MessageMedia('image/webp', mediaBuffer.toString('base64'), 'sticker.webp');
        const sentMessage = await session.client.sendMessage(to, media, { sendMediaAsSticker: true });
        const messageId = sentMessage.id.id;
        messageTracking.set(messageId, {
            messageId, sessionId, to, text: '', status: 'sent', ack: 1,
            timestamp: new Date().toISOString(), lastUpdate: new Date().toISOString(),
            hasMedia: true, mediaType: 'sticker',
            fromNumber: session.phoneNumber, fromPushname: session.contactInfo?.pushname
        });
        session.messagesCount++;
        res.json({ ok: true, message: 'Sticker envoyé', messageId, sessionId, to, from: { number: session.phoneNumber, pushname: session.contactInfo?.pushname }, hasMedia: true, mediaType: 'sticker', timestamp: new Date().toISOString() });
    } catch (error) {
        console.error(`[${sessionId}] Erreur envoi sticker:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post('/api/messages/send-location', async (req, res) => {
    const { sessionId, to, latitude, longitude, description } = req.body;
    if (!sessionId || !to || latitude === undefined || longitude === undefined) return res.status(400).json({ ok: false, error: 'sessionId, to, latitude, longitude required' });

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const sentMessage = await session.client.sendMessage(to, new MessageMedia.Location(latitude, longitude, description || 'Location'));
        const messageId = sentMessage.id.id;
        messageTracking.set(messageId, {
            messageId, sessionId, to, text: description || '', status: 'sent', ack: 1,
            timestamp: new Date().toISOString(), lastUpdate: new Date().toISOString(),
            hasMedia: true, mediaType: 'location',
            fromNumber: session.phoneNumber, fromPushname: session.contactInfo?.pushname
        });
        session.messagesCount++;
        res.json({ ok: true, message: 'Location envoyée', messageId, sessionId, to, from: { number: session.phoneNumber, pushname: session.contactInfo?.pushname }, hasMedia: true, mediaType: 'location', timestamp: new Date().toISOString() });
    } catch (error) {
        console.error(`[${sessionId}] Erreur envoi location:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post('/api/messages/send-contact', async (req, res) => {
    const { sessionId, to, contactName, contactNumber } = req.body;
    if (!sessionId || !to || !contactName || !contactNumber) return res.status(400).json({ ok: false, error: 'sessionId, to, contactName, contactNumber required' });

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const vCard = `BEGIN:VCARD\nVERSION:3.0\nFN:${contactName}\nTEL;type=CELL:${contactNumber}\nEND:VCARD`;
        const media = new MessageMedia('text/vcard', Buffer.from(vCard).toString('base64'), 'contact.vcf');
        const sentMessage = await session.client.sendMessage(to, media);
        const messageId = sentMessage.id.id;
        messageTracking.set(messageId, {
            messageId, sessionId, to, text: contactName, status: 'sent', ack: 1,
            timestamp: new Date().toISOString(), lastUpdate: new Date().toISOString(),
            hasMedia: true, mediaType: 'contact',
            fromNumber: session.phoneNumber, fromPushname: session.contactInfo?.pushname
        });
        session.messagesCount++;
        res.json({ ok: true, message: 'Contact envoyé', messageId, sessionId, to, from: { number: session.phoneNumber, pushname: session.contactInfo?.pushname }, hasMedia: true, mediaType: 'contact', timestamp: new Date().toISOString() });
    } catch (error) {
        console.error(`[${sessionId}] Erreur envoi contact:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ============================================
// GROUPES
// ============================================

app.post('/api/sessions/:sessionId/groups', async (req, res) => {
    const { sessionId } = req.params;
    const { name, participants } = req.body;
    if (!name || !participants || !Array.isArray(participants)) return res.status(400).json({ ok: false, error: 'name and participants array required' });

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const group = await session.client.createGroup(name, participants);
        res.json({ ok: true, groupId: group.gid._serialized, participants: group.participants });
    } catch (error) {
        console.error(`[${sessionId}] Erreur création groupe:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get('/api/sessions/:sessionId/groups/:groupId', async (req, res) => {
    const { sessionId, groupId } = req.params;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const chat = await session.client.getChatById(groupId);
        if (!chat.isGroup) return res.status(400).json({ ok: false, error: 'Not a group' });
        const groupMetadata = await chat.getGroupMetadata();
        res.json({ ok: true, group: { id: groupId, name: chat.name, description: chat.description, participants: groupMetadata.participants, owner: groupMetadata.owner } });
    } catch (error) {
        console.error(`[${sessionId}] Erreur récupération groupe:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post('/api/sessions/:sessionId/groups/:groupId/participants', async (req, res) => {
    const { sessionId, groupId } = req.params;
    const { add, remove } = req.body;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const chat = await session.client.getChatById(groupId);
        if (!chat.isGroup) return res.status(400).json({ ok: false, error: 'Not a group' });
        if (add && add.length) await chat.addParticipants(add);
        if (remove && remove.length) await chat.removeParticipants(remove);
        res.json({ ok: true, message: 'Participants updated' });
    } catch (error) {
        console.error(`[${sessionId}] Erreur modification participants:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.put('/api/sessions/:sessionId/groups/:groupId/subject', async (req, res) => {
    const { sessionId, groupId } = req.params;
    const { subject } = req.body;
    if (!subject) return res.status(400).json({ ok: false, error: 'subject required' });

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const chat = await session.client.getChatById(groupId);
        if (!chat.isGroup) return res.status(400).json({ ok: false, error: 'Not a group' });
        await chat.setSubject(subject);
        res.json({ ok: true, message: 'Subject updated' });
    } catch (error) {
        console.error(`[${sessionId}] Erreur modification sujet:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.put('/api/sessions/:sessionId/groups/:groupId/description', async (req, res) => {
    const { sessionId, groupId } = req.params;
    const { description } = req.body;
    if (description === undefined) return res.status(400).json({ ok: false, error: 'description required' });

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const chat = await session.client.getChatById(groupId);
        if (!chat.isGroup) return res.status(400).json({ ok: false, error: 'Not a group' });
        await chat.setDescription(description);
        res.json({ ok: true, message: 'Description updated' });
    } catch (error) {
        console.error(`[${sessionId}] Erreur modification description:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ============================================
// CONTACTS
// ============================================

app.get('/api/sessions/:sessionId/contacts', async (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const contacts = await session.client.getContacts();
        const simple = contacts.map(c => ({ id: c.id._serialized, number: c.number, name: c.name, pushname: c.pushname, isMe: c.isMe, isGroup: c.isGroup, isBusiness: c.isBusiness }));
        res.json({ ok: true, contacts: simple });
    } catch (error) {
        console.error(`[${sessionId}] Erreur récupération contacts:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get('/api/sessions/:sessionId/contacts/:contactId', async (req, res) => {
    const { sessionId, contactId } = req.params;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const contact = await session.client.getContactById(contactId);
        const info = {
            id: contact.id._serialized,
            number: contact.number,
            name: contact.name,
            pushname: contact.pushname,
            shortName: contact.shortName,
            isMe: contact.isMe,
            isMyContact: contact.isMyContact,
            isBlocked: contact.isBlocked,
            isBusiness: contact.isBusiness,
            profilePicUrl: await contact.getProfilePicUrl(),
            about: await contact.getAbout(),
            countryCode: await contact.getCountryCode(),
            formattedNumber: await contact.getFormattedNumber()
        };
        res.json({ ok: true, contact: info });
    } catch (error) {
        console.error(`[${sessionId}] Erreur récupération contact:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post('/api/sessions/:sessionId/contacts/:contactId/block', async (req, res) => {
    const { sessionId, contactId } = req.params;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const contact = await session.client.getContactById(contactId);
        await contact.block();
        res.json({ ok: true, message: 'Contact bloqué' });
    } catch (error) {
        console.error(`[${sessionId}] Erreur blocage contact:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post('/api/sessions/:sessionId/contacts/:contactId/unblock', async (req, res) => {
    const { sessionId, contactId } = req.params;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const contact = await session.client.getContactById(contactId);
        await contact.unblock();
        res.json({ ok: true, message: 'Contact débloqué' });
    } catch (error) {
        console.error(`[${sessionId}] Erreur déblocage contact:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ============================================
// PRÉSENCE / TYPING
// ============================================

app.post('/api/sessions/:sessionId/chats/:chatId/typing', async (req, res) => {
    const { sessionId, chatId } = req.params;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const chat = await session.client.getChatById(chatId);
        await chat.sendStateTyping();
        res.json({ ok: true, message: 'Typing started' });
    } catch (error) {
        console.error(`[${sessionId}] Erreur démarrage typing:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post('/api/sessions/:sessionId/chats/:chatId/recording', async (req, res) => {
    const { sessionId, chatId } = req.params;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const chat = await session.client.getChatById(chatId);
        await chat.sendStateRecording();
        res.json({ ok: true, message: 'Recording started' });
    } catch (error) {
        console.error(`[${sessionId}] Erreur démarrage recording:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post('/api/sessions/:sessionId/chats/:chatId/clear-state', async (req, res) => {
    const { sessionId, chatId } = req.params;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const chat = await session.client.getChatById(chatId);
        await chat.clearState();
        res.json({ ok: true, message: 'State cleared' });
    } catch (error) {
        console.error(`[${sessionId}] Erreur effacement state:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get('/api/sessions/:sessionId/chats/:chatId/presence', async (req, res) => {
    const { sessionId, chatId } = req.params;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const presence = await session.client.getPresence(chatId);
        res.json({ ok: true, presence });
    } catch (error) {
        console.error(`[${sessionId}] Erreur récupération présence:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ============================================
// GESTION DES MESSAGES (modification/suppression)
// ============================================

app.post('/api/messages/:messageId/edit', async (req, res) => {
    const { messageId } = req.params;
    const { newText } = req.body;
    if (!newText) return res.status(400).json({ ok: false, error: 'newText required' });

    // Find session and message
    let session = null;
    let msg = null;
    for (const [sid, s] of sessions) {
        const m = messageTracking.get(messageId);
        if (m && m.sessionId === sid) {
            session = s;
            msg = m;
            break;
        }
    }
    if (!session || !msg) return res.status(404).json({ ok: false, error: 'Message not found' });

    try {
        const chat = await session.client.getChatById(msg.to);
        const message = await chat.fetchMessage(messageId);
        if (!message) return res.status(404).json({ ok: false, error: 'Message not found in chat' });
        await message.edit(newText);
        // Update tracking
        msg.text = newText;
        msg.lastUpdate = new Date().toISOString();
        res.json({ ok: true, message: 'Message edited' });
    } catch (error) {
        console.error(`[${msg.sessionId}] Erreur édition message:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post('/api/messages/:messageId/delete', async (req, res) => {
    const { messageId } = req.params;
    const { everyone = false } = req.body;

    // Find session and message
    let session = null;
    let msg = null;
    for (const [sid, s] of sessions) {
        const m = messageTracking.get(messageId);
        if (m && m.sessionId === sid) {
            session = s;
            msg = m;
            break;
        }
    }
    if (!session || !msg) return res.status(404).json({ ok: false, error: 'Message not found' });

    try {
        const chat = await session.client.getChatById(msg.to);
        const message = await chat.fetchMessage(messageId);
        if (!message) return res.status(404).json({ ok: false, error: 'Message not found in chat' });
        if (everyone) {
            await message.delete(true);
        } else {
            await message.delete(false);
        }
        // Update tracking
        msg.status = 'deleted';
        msg.lastUpdate = new Date().toISOString();
        res.json({ ok: true, message: 'Message deleted' });
    } catch (error) {
        console.error(`[${msg.sessionId}] Erreur suppression message:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ============================================
// GESTION DES CHATS (archive, pin, etc.)
// ============================================

app.post('/api/sessions/:sessionId/chats/:chatId/archive', async (req, res) => {
    const { sessionId, chatId } = req.params;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const chat = await session.client.getChatById(chatId);
        await chat.archive();
        res.json({ ok: true, message: 'Chat archived' });
    } catch (error) {
        console.error(`[${sessionId}] Erreur archivage chat:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post('/api/sessions/:sessionId/chats/:chatId/unarchive', async (req, res) => {
    const { sessionId, chatId } = req.params;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const chat = await session.client.getChatById(chatId);
        await chat.unarchive();
        res.json({ ok: true, message: 'Chat unarchived' });
    } catch (error) {
        console.error(`[${sessionId}] Erreur désarchivage chat:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post('/api/sessions/:sessionId/chats/:chatId/pin', async (req, res) => {
    const { sessionId, chatId } = req.params;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const chat = await session.client.getChatById(chatId);
        await chat.pin();
        res.json({ ok: true, message: 'Chat pinned' });
    } catch (error) {
        console.error(`[${sessionId}] Erreur épinglage chat:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post('/api/sessions/:sessionId/chats/:chatId/unpin', async (req, res) => {
    const { sessionId, chatId } = req.params;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const chat = await session.client.getChatById(chatId);
        await chat.unpin();
        res.json({ ok: true, message: 'Chat unpinned' });
    } catch (error) {
        console.error(`[${sessionId}] Erreur désépinglage chat:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get('/api/sessions/:sessionId/chats', async (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'WORKING') return res.status(400).json({ ok: false, error: 'Session not working' });

    try {
        const chats = await session.client.getChats();
        const simple = chats.map(c => ({
            id: c.id._serialized,
            name: c.name,
            isGroup: c.isGroup,
            unreadCount: c.unreadCount,
            timestamp: c.timestamp,
            archived: c.archived,
            pinned: c.pinned
        }));
        res.json({ ok: true, chats: simple });
    } catch (error) {
        console.error(`[${sessionId}] Erreur récupération chats:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ============================================
// ENDPOINTS EXISTANTS (PING, LOGOUT, CLOSE-ALL, etc.)
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
        res.json({ ok: true, status: 'active', lastActivity: session.lastActivity });
    } catch (error) {
        res.json({ ok: false, error: error.message });
    }
});

app.post('/api/sessions/:sessionId/logout', async (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: 'Session non trouvée' });
    try {
        await session.client.logout();
        await session.client.destroy();
        sessions.delete(sessionId);
        webhooks.delete(sessionId);
        res.json({ ok: true, message: 'Déconnexion réussie. Vous pouvez maintenant reconnecter ce numéro ailleurs.' });
    } catch (error) {
        sessions.delete(sessionId);
        webhooks.delete(sessionId);
        res.json({ ok: true, message: 'Session supprimée' });
    }
});

app.post('/api/sessions/close-all', async (req, res) => {
    const closedSessions = [];
    const errors = [];
    console.log(`🧹 Fermeture de toutes les sessions (${sessions.size} actives)...`);
    for (const [sessionId, session] of sessions) {
        try {
            console.log(`🗑️ Fermeture de la session: ${sessionId} (${session.status})`);
            if (session.client) {
                try { await session.client.logout(); } catch (e) { console.log(`Erreur logout pour ${sessionId}: ${e.message}`); }
                try { await session.client.destroy(); } catch (e) { console.log(`Erreur destroy pour ${sessionId}: ${e.message}`); }
            }
            sessions.delete(sessionId);
            webhooks.delete(sessionId);
            closedSessions.push({ sessionId, previousStatus: session.status, phoneNumber: session.phoneNumber, disconnectReason: session.disconnectReason, disconnectedAt: session.disconnectedAt });
        } catch (error) {
            console.error(`Erreur fermeture session ${sessionId}:`, error.message);
            errors.push({ sessionId, error: error.message });
            sessions.delete(sessionId);
            webhooks.delete(sessionId);
        }
    }
    console.log(`✅ ${closedSessions.length} sessions fermées, ${errors.length} erreurs`);
    res.json({ ok: true, message: `${closedSessions.length} sessions fermées`, closedSessions, errors, remainingSessions: sessions.size });
});

app.post('/api/sessions/cleanup-orphans', async (req, res) => {
    const cleaned = [];
    const toDelete = [];
    for (const [sessionId, session] of sessions) {
        if (session.status === 'STARTING' && session.createdAt) {
            const age = Date.now() - new Date(session.createdAt).getTime();
            if (age > 120000) toDelete.push({ sessionId, reason: 'STARTING timeout', age });
        }
        if (session.status === 'SCAN_QR' && session.lastActivity) {
            const idle = Date.now() - session.lastActivity;
            if (idle > 180000) toDelete.push({ sessionId, reason: 'SCAN_QR idle', idle });
        }
        if (session.status === 'DISCONNECTED') toDelete.push({ sessionId, reason: 'DISCONNECTED' });
    }
    for (const { sessionId, reason } of toDelete) {
        const session = sessions.get(sessionId);
        try {
            if (session && session.client) {
                try { await session.client.logout(); } catch (e) {}
                try { await session.client.destroy(); } catch (e) {}
            }
            sessions.delete(sessionId);
            webhooks.delete(sessionId);
            cleaned.push({ sessionId, reason, disconnectReason: session?.disconnectReason || null, disconnectedAt: session?.disconnectedAt || null });
            console.log(`🗑️ Session orpheline supprimée: ${sessionId} (${reason})`);
        } catch (e) {
            sessions.delete(sessionId);
            webhooks.delete(sessionId);
            cleaned.push({ sessionId, reason, error: e.message });
        }
    }
    res.json({ ok: true, message: `${cleaned.length} sessions orphelines nettoyées`, cleaned, remainingSessions: sessions.size });
});

app.get('/api/sessions', (req, res) => {
    const sessionList = [];
    sessions.forEach((session, sessionId) => {
        sessionList.push({
            sessionId,
            status: session.status,
            phoneNumber: session.phoneNumber,
            pushname: session.contactInfo?.pushname,
            messagesCount: session.messagesCount,
            lastActivity: session.lastActivity,
            hasClient: !!session.client,
            hasInfo: !!(session.client && session.client.info),
            qr: !!session.qr,
            disconnectReason: session.disconnectReason || null,
            disconnectedAt: session.disconnectedAt || null
        });
    });
    res.json({ ok: true, activeSessions: sessions.size, sessions: sessionList });
});

app.get('/api/sessions/:sessionId/disconnect-info', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: 'Session non trouvée' });
    let message = 'Session active ou raison inconnue';
    if (session.disconnectReason === 'LOGOUT') message = 'L\'utilisateur s\'est déconnecté volontairement depuis son téléphone';
    else if (session.disconnectReason === 'REMOTE_LOGOUT') message = 'WhatsApp a déconnecté cet appareil à distance (suppression de l\'appareil)';
    else if (session.disconnectReason === 'ACCOUNT_REMOVED') message = 'Le compte WhatsApp a été supprimé';
    else if (session.disconnectReason === 'SESSION_REMOVED') message = 'La session WhatsApp a été supprimée';
    else if (session.disconnectReason) message = `Déconnecté pour raison: ${session.disconnectReason}`;
    res.json({ ok: true, sessionId, status: session.status, disconnectReason: session.disconnectReason || null, disconnectedAt: session.disconnectedAt || null, message });
});

app.post('/api/sessions/:sessionId/repair', async (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: 'Session non trouvée' });
    try {
        console.log(`[${sessionId}] 🔧 Tentative de réparation de la session`);
        let state = null;
        try { state = await session.client.getState(); console.log(`[${sessionId}] État actuel: ${state}`); } catch (e) { console.log(`[${sessionId}] Impossible de récupérer l'état: ${e.message}`); }
        if (state === 'CONNECTED') return res.json({ ok: true, status: 'already_connected', state, message: 'Session déjà connectée' });
        try { await session.client.logout(); await session.client.destroy(); } catch (e) { console.log(`[${sessionId}] Erreur lors du nettoyage: ${e.message}`); }
        console.log(`[${sessionId}] Création d'un nouveau client...`);
        const newClient = await createClient(sessionId);
        session.client = newClient;
        session.status = 'STARTING';
        session.qr = null;
        session.error = null;
        session.lastActivity = Date.now();
        session.disconnectReason = null;
        session.disconnectedAt = null;
        await newClient.initialize();
        console.log(`[${sessionId}] ✅ Réparation initiée, attendez le QR code`);
        res.json({ ok: true, message: 'Session recréée, veuillez scanner le QR code', status: 'repairing', sessionId });
    } catch (error) {
        console.error(`[${sessionId}] ❌ Erreur réparation:`, error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ============================================
// ENVOI DE MESSAGE TEXTE (déjà existant)
// ============================================

app.post('/api/messages/send', async (req, res) => {
    console.log('=== REQUETE RECUE ===');
    console.log('Body:', req.body);
    console.log('====================');
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

    if (!session.client) {
        return res.status(400).json({ ok: false, error: 'Client WhatsApp non initialisé' });
    }

    // === VÉRIFICATION DE L'ÉTAT RÉEL AVANT ENVOI ===
    let isActuallyConnected = false;
    let state = null;
    try {
        state = await session.client.getState().catch(() => null);
        isActuallyConnected = state === 'CONNECTED';
        console.log(`[${sessionId}] 📊 État réel du client: ${state || 'inconnu'}`);
        
        if (!isActuallyConnected) {
            console.log(`[${sessionId}] ⚠️ Client marqué WORKING mais état réel = ${state}`);
            session.status = 'DISCONNECTED';
            session.error = `Client déconnecté (état: ${state})`;
            return res.status(400).json({ 
                ok: false, 
                error: `Session déconnectée (état: ${state}). Veuillez utiliser /repair pour reconnecter.`,
                status: session.status,
                needsRepair: true
            });
        }
    } catch (e) {
        console.log(`[${sessionId}] ❌ Impossible de vérifier l'état: ${e.message}`);
        session.status = 'DISCONNECTED';
        session.error = e.message;
        return res.status(400).json({ 
            ok: false, 
            error: 'Session déconnectée. Veuillez utiliser /repair pour reconnecter.',
            status: 'DISCONNECTED',
            needsRepair: true
        });
    }
    // === FIN VÉRIFICATION ===

    try {
        console.log(`[${sessionId}] 📤 Envoi du message vers ${to}...`);
        
        const sendWithRetry = async (attempt = 1, maxAttempts = 2) => {
            try {
                const sendPromise = session.client.sendMessage(to, text);
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Timeout envoi message (60s)')), 60000)
                );
                const result = await Promise.race([sendPromise, timeoutPromise]);
                console.log(`[${sessionId}] ✅ Message envoyé (tentative ${attempt})`);
                return result;
            } catch (error) {
                console.log(`[${sessionId}] ❌ Échec tentative ${attempt}: ${error.message}`);
                if (attempt < maxAttempts && error.message.includes('Timeout')) {
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
        console.error(`[${sessionId}] 💥 Erreur envoi message:`, error.message);
        
        if (error.message.includes('closed') || error.message.includes('destroyed') || error.message.includes('Timeout')) {
            session.status = 'DISCONNECTED';
            session.error = error.message;
            console.log(`[${sessionId}] ⚠️ Session marquée comme DISCONNECTED`);
        }
        
        res.status(500).json({ 
            ok: false, 
            error: error.message,
            sessionStatus: session.status,
            needsRepair: true
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
// ENDPOINTS SUIVI (déjà existants)
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
            messagesCount: session.messagesCount,
            disconnectReason: session.disconnectReason || null,
            disconnectedAt: session.disconnectedAt || null
        });
    });
    res.json({ ok: true, timestamp: new Date().toISOString(), stats });
});

// ============================================
// SURVEILLANCE ET RÉPARATION AUTOMATIQUE DES SESSIONS
// ============================================
setInterval(async () => {
    for (const [sessionId, session] of sessions) {
        if (session.status === 'WORKING' && session.client) {
            try {
                const state = await session.client.getState().catch(() => null);
                console.log(`[${sessionId}] 🏓 Vérification état: ${state || 'inconnu'}`);
                
                if (state !== 'CONNECTED') {
                    console.log(`[${sessionId}] ⚠️ État anormal: ${state}, tentative de reconnexion...`);
                    
                    try {
                        await session.client.destroy();
                    } catch (e) {}
                    
                    const newClient = await createClient(sessionId);
                    session.client = newClient;
                    session.status = 'STARTING';
                    session.qr = null;
                    session.error = null;
                    session.disconnectReason = null;
                    session.disconnectedAt = null;
                    await newClient.initialize();
                    
                    console.log(`[${sessionId}] 🔄 Reconnexion initiée`);
                } else {
                    session.lastActivity = Date.now();
                }
            } catch (e) {
                console.log(`[${sessionId}] ❌ Erreur vérification: ${e.message}`);
                session.status = 'DISCONNECTED';
                session.error = e.message;
            }
        }
    }
}, 30000);

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
    console.log(`📍 POST   /api/messages/send-video    (vidéo)`);
    console.log(`📍 POST   /api/messages/send-audio    (audio / message vocal)`);
    console.log(`📍 POST   /api/messages/send-file     (document)`);
    console.log(`📍 POST   /api/messages/send-sticker  (sticker)`);
    console.log(`📍 POST   /api/messages/send-location (localisation)`);
    console.log(`📍 POST   /api/messages/send-contact  (contact vCard)`);
    console.log(`📍 POST   /api/messages/:messageId/edit`);
    console.log(`📍 POST   /api/messages/:messageId/delete`);
    console.log(`📍 GET    /api/sessions/:sessionId/contacts`);
    console.log(`📍 GET    /api/sessions/:sessionId/contacts/:contactId`);
    console.log(`📍 POST   /api/sessions/:sessionId/contacts/:contactId/block`);
    console.log(`📍 POST   /api/sessions/:sessionId/contacts/:contactId/unblock`);
    console.log(`📍 POST   /api/sessions/:sessionId/groups`);
    console.log(`📍 GET    /api/sessions/:sessionId/groups/:groupId`);
    console.log(`📍 POST   /api/sessions/:sessionId/groups/:groupId/participants`);
    console.log(`📍 PUT    /api/sessions/:sessionId/groups/:groupId/subject`);
    console.log(`📍 PUT    /api/sessions/:sessionId/groups/:groupId/description`);
    console.log(`📍 POST   /api/sessions/:sessionId/chats/:chatId/typing`);
    console.log(`📍 POST   /api/sessions/:sessionId/chats/:chatId/recording`);
    console.log(`📍 POST   /api/sessions/:sessionId/chats/:chatId/clear-state`);
    console.log(`📍 GET    /api/sessions/:sessionId/chats/:chatId/presence`);
    console.log(`📍 POST   /api/sessions/:sessionId/chats/:chatId/archive`);
    console.log(`📍 POST   /api/sessions/:sessionId/chats/:chatId/unarchive`);
    console.log(`📍 POST   /api/sessions/:sessionId/chats/:chatId/pin`);
    console.log(`📍 POST   /api/sessions/:sessionId/chats/:chatId/unpin`);
    console.log(`📍 GET    /api/sessions/:sessionId/chats`);
    console.log(`📍 POST   /api/sessions/:sessionId/ping`);
    console.log(`📍 POST   /api/sessions/:sessionId/logout`);
    console.log(`📍 POST   /api/sessions/close-all`);
    console.log(`📍 POST   /api/sessions/cleanup-orphans`);
    console.log(`📍 POST   /api/sessions/:sessionId/repair`);
    console.log(`📍 GET    /api/sessions`);
    console.log(`📍 GET    /api/sessions/:sessionId/disconnect-info`);
    console.log(`📍 POST   /api/sessions/:sessionId/webhook`);
    console.log(`📍 DELETE /api/sessions/:sessionId/webhook`);
    console.log(`📍 GET    /api/messages/:messageId/status`);
    console.log(`📍 GET    /api/health`);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});