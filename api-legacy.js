const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const app = express();
app.use(express.json());
const sessions = {};
const API_KEY = "BWxD1xkzuPxJ0luWnsaECtn3CVZkYG6dtNUxnwUsBWWwYwvkKYl1ZZWnDuP6M";

app.use((req, res, next) => {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Auth failed" });
  next();
});

app.post("/api/sessions/:sessionId/start", async (req, res) => {
  const sessionId = req.params.sessionId;
  sessions[sessionId] = { client: null, status: "STARTING", qr: null };
  
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId }),
    webVersionCache: { type: 'remote', remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1035691214-alpha.html' },
    puppeteer: {
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
             '--disable-accelerated-2d-canvas','--no-first-run','--no-zygote',
             '--single-process','--disable-gpu']
    }
  });

  client.on('qr', async (qr) => {
    const qrCode = await qrcode.toDataURL(qr);
    sessions[sessionId].qr = qrCode;
    sessions[sessionId].status = "SCAN_QR";
  });

  client.on('ready', () => { 
    sessions[sessionId].status = "WORKING"; 
    sessions[sessionId].qr = null; 
  });

  sessions[sessionId].client = client;
  client.initialize();
  res.json({ ok: true, message: "Legacy WhatsApp session started" });
});

app.get("/api/sessions/:sessionId/qr", (req, res) => {
  const session = sessions[req.params.sessionId];
  if (!session) return res.json({ error: "Session not found" });
  if (!session.qr) return res.json({ error: "No QR yet", status: session.status });
  res.json({ qr: session.qr, status: session.status });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("🚀 Legacy API ready on port " + port));