'use strict';

// Identifiant de session: alphanumérique + tiret/underscore uniquement, longueur bornée.
// Empêche la traversée de chemin (../..) dans LocalAuth({ clientId: sessionId }) qui
// dérive un dossier sur disque à partir de cette valeur, et limite les abus de nommage.
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId);
}

function validateSessionIdParam(req, res, next) {
  const { sessionId } = req.params;
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({
      ok: false,
      error: "sessionId invalide : uniquement lettres, chiffres, '-' et '_', 64 caractères max",
    });
  }
  next();
}

// Évite de journaliser en clair des données sensibles (numéros, contenu des messages, tokens).
function redactForLog(body) {
  if (!body || typeof body !== 'object') return body;
  const clone = { ...body };
  const sensitiveKeys = [
    'text', 'to', 'caption', 'description', 'contactNumber', 'contactName',
    'imageBase64', 'videoBase64', 'audioBase64', 'fileBase64', 'stickerBase64',
    'url', 'webhook',
  ];
  for (const key of sensitiveKeys) {
    if (key in clone && typeof clone[key] === 'string') {
      clone[key] = clone[key].length > 8 ? `${clone[key].slice(0, 4)}…(${clone[key].length})` : '…';
    }
  }
  return clone;
}

module.exports = { isValidSessionId, validateSessionIdParam, redactForLog, SESSION_ID_RE };
