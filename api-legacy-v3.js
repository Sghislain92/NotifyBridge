const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteerExtra.use(StealthPlugin());

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// ============================================
// CONFIGURATION PUPPETEER - FIX TIMEOUT
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
    '--disable-blink-features=AutomationControlled'
  ],
  protocolTimeout: 300000, // 300 secondes au lieu de 180
  timeout: 60000,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
};

// ============================================
// GESTION DES SESSIONS
// ============================================
const sessions = new Map();
const messageTracking = new Map();

// Fonction pour créer un client WhatsApp avec gestion des erreurs
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

    // ============================================
    // ÉVÉNEMENTS CLIENT
    // ============================================

    client.on('qr', async (qr) => {
      console.log(`[${sessionId}] QR Code généré - En attente de scan...`);
      const session = sessions.get(sessionId);
      if (session) {
        session.status = 'SCAN_QR';
        // Convertir le QR en format data:image/png;base64
        try {
          const qrImage = await qrcode.toDataURL(qr);
          session.qr = qrImage;
        } catch (e) {
          console.error(`[${sessionId}] Erreur conversion QR:`, e.message);
          session.qr = qr; // Fallback
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
      if (session) {
        session.status = 'WORKING';
        session.lastActivity = Date.now();
        
        try {
          // ============================================
          // RÉCUPÉRER TOUTES LES INFORMATIONS
          // ============================================
          
          // 1. Informations de base (synchrones)
          const wid = {
            serialized: client.info.wid._serialized,
            user: client.info.wid.user,
            server: client.info.wid.server
          };
          
          // 2. Informations personnelles
          const personal = {
            pushname: client.info.pushname,
            platform: client.info.platform
          };
          
          // 3. Informations du téléphone
          const phone = {
            wa_version: client.info.phone.wa_version,
            os_version: client.info.phone.os_version,
            device_manufacturer: client.info.phone.device_manufacturer,
            device_model: client.info.phone.device_model,
            os_build_number: client.info.phone.os_build_number
          };
          
          // 4. Batterie du téléphone
          let battery = null;
          try {
            const batteryStatus = await client.getBatteryStatus();
            battery = {
              percentage: batteryStatus.battery,
              plugged: batteryStatus.plugged
            };
          } catch (e) {
            console.log(`[${sessionId}] Batterie non disponible (normal sur Web/Windows)`);
          }
          
          // 5. Récupérer le contact de l'utilisateur connecté
          const contact = await client.getContactById(wid.serialized);
          
          const contactInfo = {
            id: contact.id._serialized,
            number: contact.number,
            name: contact.name,
            pushname: contact.pushname,
            shortName: contact.shortName,
            isMe: contact.isMe,
            isMyContact: contact.isMyContact,
            isUser: contact.isUser,
            isWAContact: contact.isWAContact,
            isBlocked: contact.isBlocked,
            isGroup: contact.isGroup,
            isBusiness: contact.isBusiness,
            isEnterprise: contact.isEnterprise
          };
          
          // 6. Récupérer les informations asynchrones
          let countryCode = null;
          let formattedNumber = null;
          let profilePicUrl = null;
          let about = null;
          let commonGroups = null;
          
          try {
            countryCode = await contact.getCountryCode();
          } catch (e) {
            console.log(`[${sessionId}] Code pays non disponible`);
          }
          
          try {
            formattedNumber = await contact.getFormattedNumber();
          } catch (e) {
            console.log(`[${sessionId}] Numéro formaté non disponible`);
          }
          
          try {
            profilePicUrl = await contact.getProfilePicUrl();
          } catch (e) {
            console.log(`[${sessionId}] Photo de profil non disponible`);
          }
          
          try {
            about = await contact.getAbout();
          } catch (e) {
            console.log(`[${sessionId}] Statut non disponible`);
          }
          
          try {
            commonGroups = await contact.getCommonGroups();
          } catch (e) {
            console.log(`[${sessionId}] Groupes en commun non disponibles`);
          }
          
          // 7. Stocker toutes les informations dans la session
          session.phoneNumber = wid.serialized;
          session.userInfo = {
            wid,
            personal,
            phone,
            battery
          };
          
          session.contactInfo = {
            ...contactInfo,
            countryCode,
            formattedNumber,
            profilePicUrl,
            about,
            commonGroupsCount: commonGroups ? commonGroups.length : 0
          };
          
          console.log(`[${sessionId}] ✅ Toutes les informations récupérées`);
          console.log(`[${sessionId}] Numéro: ${wid.user}`);
          console.log(`[${sessionId}] Nom: ${contact.pushname}`);
          console.log(`[${sessionId}] Plateforme: ${personal.platform}`);
          console.log(`[${sessionId}] Téléphone: ${phone.device_model}`);
          
        } catch (error) {
          console.error(`[${sessionId}] Erreur lors de la récupération des infos:`, error.message);
          session.error = error.message;
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
    console.error(`[${sessionId}] Erreur lors de la création du client:`, error.message);
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
      return res.json({
        ok: true,
        message: 'Session déjà en cours',
        sessionId
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
      error: null
    });

    await client.initialize();

    res.json({
      ok: true,
      message: 'Initialisation de la session WhatsApp lancée en mode Stealth',
      sessionId
    });
  } catch (error) {
    console.error(`[${sessionId}] Erreur:`, error.message);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get('/api/sessions/:sessionId/qr', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({
      ok: false,
      error: 'Session non trouvée'
    });
  }

  if (!session.qr) {
    return res.json({
      status: session.status,
      message: 'QR non encore disponible'
    });
  }

  res.json({
    qr: session.qr,
    status: session.status
  });
});

app.get('/api/sessions/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({
      ok: false,
      error: 'Session non trouvée'
    });
  }

  // Extraire le numéro user (sans le domaine)
  const phoneNumber = session.phoneNumber ? session.phoneNumber.split('@')[0] : null;
  const pushname = session.contactInfo ? session.contactInfo.pushname : null;

  res.json({
    ok: true,
    status: session.status,
    phoneNumber: phoneNumber,
    pushname: pushname,
    error: session.error
  });
});

app.get('/api/sessions/:sessionId/info', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({
      ok: false,
      error: 'Session non trouvée'
    });
  }

  if (session.status !== 'WORKING') {
    return res.status(400).json({
      ok: false,
      error: 'Session non connectée',
      status: session.status
    });
  }

  res.json({
    ok: true,
    sessionId,
    status: session.status,
    userInfo: session.userInfo || null,
    contactInfo: session.contactInfo || null,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/sessions/:sessionId/phone-number', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({
      ok: false,
      error: 'Session non trouvée'
    });
  }

  if (session.status !== 'WORKING') {
    return res.status(400).json({
      ok: false,
      error: 'Session non connectée',
      status: session.status
    });
  }

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

  if (!session) {
    return res.status(404).json({
      ok: false,
      error: 'Session non trouvée'
    });
  }

  try {
    await session.client.logout();
    await session.client.destroy();
    sessions.delete(sessionId);

    res.json({
      ok: true,
      message: 'Session détruite'
    });
  } catch (error) {
    console.error(`[${sessionId}] Erreur lors de la suppression:`, error.message);
    sessions.delete(sessionId);
    res.json({
      ok: true,
      message: 'Session détruite (avec erreur)'
    });
  }
});

// ============================================
// ENDPOINTS MESSAGES
// ============================================

app.post('/api/messages/send', async (req, res) => {
  const { sessionId, to, text, image, video, audio, file, fileName, mentions, reactions } = req.body;

  if (!sessionId || !to || !text) {
    return res.status(400).json({
      ok: false,
      error: 'Paramètres manquants: sessionId, to, text requis'
    });
  }

  const session = sessions.get(sessionId);
  if (!session || session.status !== 'WORKING') {
    return res.status(400).json({
      ok: false,
      error: 'Session non connectée ou non trouvée'
    });
  }

  try {
    let messageData = { body: text };
    
    if (mentions && mentions.length > 0) {
      messageData.mentions = mentions;
    }

    let sentMessage;

    if (image) {
      sentMessage = await session.client.sendMessage(to, messageData, { media: await fetch(image).then(r => r.buffer()) });
    } else if (video) {
      sentMessage = await session.client.sendMessage(to, messageData, { media: await fetch(video).then(r => r.buffer()) });
    } else if (audio) {
      sentMessage = await session.client.sendMessage(to, messageData, { media: await fetch(audio).then(r => r.buffer()), sendAudioAsVoice: true });
    } else if (file) {
      sentMessage = await session.client.sendMessage(to, messageData, { media: await fetch(file).then(r => r.buffer()), fileName });
    } else {
      sentMessage = await session.client.sendMessage(to, text);
    }

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
      hasMedia: !!(image || video || audio || file)
    });

    session.messagesCount++;

    if (reactions) {
      await sentMessage.react(reactions);
    }

    res.json({
      ok: true,
      message: 'Message envoyé',
      messageId,
      sessionId,
      to,
      status: 'sent',
      hasMedia: !!(image || video || audio || file),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(`[${sessionId}] Erreur envoi message:`, error.message);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post('/api/messages/batch', async (req, res) => {
  const { sessionId, recipients, text, image, video, audio, file, fileName } = req.body;

  if (!sessionId || !recipients || !text) {
    return res.status(400).json({
      ok: false,
      error: 'Paramètres manquants'
    });
  }

  const session = sessions.get(sessionId);
  if (!session || session.status !== 'WORKING') {
    return res.status(400).json({
      ok: false,
      error: 'Session non connectée'
    });
  }

  try {
    const results = [];

    for (const recipient of recipients) {
      try {
        let sentMessage;
        
        if (image) {
          sentMessage = await session.client.sendMessage(recipient, { body: text }, { media: await fetch(image).then(r => r.buffer()) });
        } else if (video) {
          sentMessage = await session.client.sendMessage(recipient, { body: text }, { media: await fetch(video).then(r => r.buffer()) });
        } else if (audio) {
          sentMessage = await session.client.sendMessage(recipient, { body: text }, { media: await fetch(audio).then(r => r.buffer()), sendAudioAsVoice: true });
        } else if (file) {
          sentMessage = await session.client.sendMessage(recipient, { body: text }, { media: await fetch(file).then(r => r.buffer()), fileName });
        } else {
          sentMessage = await session.client.sendMessage(recipient, text);
        }

        const messageId = sentMessage.id.id;
        messageTracking.set(messageId, {
          messageId,
          sessionId,
          to: recipient,
          text,
          status: 'sent',
          ack: 1,
          timestamp: new Date().toISOString(),
          lastUpdate: new Date().toISOString(),
          hasMedia: !!(image || video || audio || file)
        });

        results.push({
          recipient,
          status: 'sent',
          messageId
        });

        session.messagesCount++;
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        results.push({
          recipient,
          status: 'error',
          error: error.message
        });
      }
    }

    res.json({
      ok: true,
      message: `Messages envoyés: ${results.filter(r => r.status === 'sent').length}/${recipients.length}`,
      sessionId,
      results,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(`[${sessionId}] Erreur batch:`, error.message);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ============================================
// ENDPOINTS SUIVI
// ============================================

app.get('/api/messages/:messageId/status', (req, res) => {
  const { messageId } = req.params;
  const msg = messageTracking.get(messageId);

  if (!msg) {
    return res.status(404).json({
      ok: false,
      error: 'Message non trouvé'
    });
  }

  res.json({
    ok: true,
    messageId,
    sessionId: msg.sessionId,
    to: msg.to,
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
    count: messages.length,
    messages
  });
});

app.get('/api/sessions/:sessionId/messages/status/:status', (req, res) => {
  const { sessionId, status } = req.params;
  const messages = Array.from(messageTracking.values())
    .filter(m => m.sessionId === sessionId && m.status === status);

  res.json({
    ok: true,
    sessionId,
    filter: status,
    count: messages.length,
    messages
  });
});

// ============================================
// ENDPOINTS STATS
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
    messagesByStatus: {
      pending: 0,
      sent: 0,
      delivered: 0,
      read: 0,
      played: 0
    },
    sessions: []
  };

  messageTracking.forEach(msg => {
    stats.messagesByStatus[msg.status]++;
  });

  sessions.forEach((session, sessionId) => {
    stats.sessions.push({
      sessionId,
      status: session.status,
      phoneNumber: session.phoneNumber,
      messagesCount: session.messagesCount
    });
  });

  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    stats
  });
});

// ============================================
// DÉMARRAGE DU SERVEUR
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 NotifyBridge Stealth API FINAL prête sur le port ${PORT}`);
  console.log(`📍 Endpoint de démarrage : POST http://localhost:${PORT}/api/sessions/VOTRE_ID/start`);
  console.log(`📍 Récupérer QR : GET http://localhost:${PORT}/api/sessions/VOTRE_ID/qr`);
  console.log(`📍 Vérifier statut : GET http://localhost:${PORT}/api/sessions/VOTRE_ID/status`);
  console.log(`📍 Envoyer message : POST http://localhost:${PORT}/api/messages/send`);
  console.log(`📍 Suivi message : GET http://localhost:${PORT}/api/messages/MESSAGE_ID/status`);
  console.log(`\n`);
});

// Gestion des erreurs non attrapées
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});