'use strict';

/**
 * Authentification obligatoire par clé API.
 *
 * La clé peut être envoyée via l'en-tête `x-api-key` (compatibilité avec
 * l'usage existant) ou `Authorization: Bearer <clé>`.
 */
function createAuthMiddleware(apiKeyStore) {
  return function authenticate(req, res, next) {
    const header = req.headers['x-api-key'] || '';
    const authHeader = req.headers['authorization'] || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const plainKey = header || bearer;

    if (!plainKey) {
      return res.status(401).json({
        ok: false,
        error: "Authentification requise : fournissez une clé API valide via l'en-tête 'x-api-key'.",
      });
    }

    const record = apiKeyStore.verifyKey(plainKey);
    if (!record) {
      return res.status(401).json({ ok: false, error: 'Clé API invalide ou révoquée.' });
    }

    req.apiKey = { id: record.id, name: record.name, scope: record.scope };
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!req.apiKey || req.apiKey.scope !== 'admin') {
    return res.status(403).json({ ok: false, error: "Cette opération requiert une clé API de portée 'admin'." });
  }
  next();
}

/**
 * Isolation multi-tenant : une clé "standard" ne peut agir que sur les
 * sessions WhatsApp qu'elle a elle-même créées (session.ownerKeyId).
 * Une clé "admin" peut agir sur toutes les sessions.
 * Si la session n'existe pas encore, on laisse passer (le handler renverra 404).
 */
function requireSessionOwnership(sessions) {
  return function (req, res, next) {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (!session) return next();
    if (req.apiKey.scope === 'admin') return next();
    if (session.ownerKeyId && session.ownerKeyId !== req.apiKey.id) {
      return res.status(403).json({ ok: false, error: 'Cette session appartient à une autre clé API.' });
    }
    next();
  };
}

module.exports = { createAuthMiddleware, requireAdmin, requireSessionOwnership };
