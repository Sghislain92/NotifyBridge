'use strict';

/**
 * ============================================================
 * Gestion des clés API (authentification obligatoire)
 * ============================================================
 *
 * Les clés API en clair ne sont JAMAIS stockées sur disque : seul un hash
 * SHA-256 est conservé. La clé en clair n'est montrée à l'admin qu'une
 * seule fois, au moment de sa création.
 *
 * Deux portées ("scope") :
 *  - "admin"    : peut créer/lister/révoquer des clés et agir sur TOUTES
 *                 les sessions (tous tenants), y compris /close-all.
 *  - "standard" : ne peut agir que sur les sessions WhatsApp qu'elle a
 *                 elle-même créées (isolation multi-tenant).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.API_KEYS_DIR
  ? path.resolve(process.env.API_KEYS_DIR)
  : path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'api-keys.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
}

function hashKey(plainKey) {
  return crypto.createHash('sha256').update(plainKey, 'utf8').digest('hex');
}

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function generatePlainKey() {
  // 256 bits d'entropie, préfixe pour identification visuelle facile (grep, logs, etc.)
  return 'nbk_' + crypto.randomBytes(32).toString('base64url');
}

class ApiKeyStore {
  constructor() {
    ensureDataDir();
    this.records = this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(STORE_FILE)) return [];
      const raw = fs.readFileSync(STORE_FILE, 'utf8');
      if (!raw.trim()) return [];
      return JSON.parse(raw);
    } catch (e) {
      console.error('[apiKeys] Impossible de lire le magasin de clés, démarrage à vide :', e.message);
      return [];
    }
  }

  _save() {
    ensureDataDir();
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.records, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STORE_FILE);
  }

  /** Crée une nouvelle clé. Retourne { id, plainKey, name, scope, createdAt } — plainKey n'est jamais réaffiché. */
  createKey({ name, scope = 'standard' }) {
    if (scope !== 'admin' && scope !== 'standard') {
      throw new Error('scope invalide (admin|standard)');
    }
    const plainKey = generatePlainKey();
    const record = {
      id: crypto.randomUUID(),
      name: name || 'unnamed',
      scope,
      hash: hashKey(plainKey),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revoked: false,
      revokedAt: null,
    };
    this.records.push(record);
    this._save();
    return { id: record.id, plainKey, name: record.name, scope: record.scope, createdAt: record.createdAt };
  }

  /** Idempotent: garantit qu'une clé en clair donnée (ex: venant d'une variable d'env) existe avec ce scope/nom. */
  ensureKey(plainKey, { name, scope = 'admin' }) {
    const hash = hashKey(plainKey);
    const existing = this.records.find((r) => r.hash === hash);
    if (existing) {
      if (existing.revoked) {
        existing.revoked = false;
        existing.revokedAt = null;
        this._save();
      }
      return existing;
    }
    const record = {
      id: crypto.randomUUID(),
      name: name || 'env-key',
      scope,
      hash,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revoked: false,
      revokedAt: null,
    };
    this.records.push(record);
    this._save();
    return record;
  }

  verifyKey(plainKey) {
    if (!plainKey || typeof plainKey !== 'string') return null;
    const hash = hashKey(plainKey);
    const record = this.records.find((r) => !r.revoked && timingSafeEqualHex(r.hash, hash));
    if (!record) return null;
    record.lastUsedAt = new Date().toISOString();
    this._save();
    return record;
  }

  revokeKey(id) {
    const record = this.records.find((r) => r.id === id);
    if (!record) return false;
    record.revoked = true;
    record.revokedAt = new Date().toISOString();
    this._save();
    return true;
  }

  list() {
    return this.records.map((r) => ({
      id: r.id,
      name: r.name,
      scope: r.scope,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      revoked: r.revoked,
      revokedAt: r.revokedAt,
    }));
  }

  hasAnyAdminKey() {
    return this.records.some((r) => r.scope === 'admin' && !r.revoked);
  }
}

/**
 * Initialise le magasin de clés à partir des variables d'environnement :
 *  - ADMIN_API_KEY        : clé admin fixe (recommandé en production, ex: secret Railway)
 *  - API_KEYS             : liste de clés "standard" séparées par des virgules (bootstrap rapide)
 *  - (rien)               : une clé admin est générée aléatoirement et affichée UNE SEULE FOIS
 *                           dans les logs de démarrage.
 */
function bootstrap(store) {
  let generatedAdminKey = null;

  if (process.env.ADMIN_API_KEY) {
    store.ensureKey(process.env.ADMIN_API_KEY, { name: 'env-admin', scope: 'admin' });
  } else if (!store.hasAnyAdminKey()) {
    const { plainKey } = store.createKey({ name: 'bootstrap-admin', scope: 'admin' });
    generatedAdminKey = plainKey;
  }

  if (process.env.API_KEYS) {
    process.env.API_KEYS.split(',')
      .map((k) => k.trim())
      .filter(Boolean)
      .forEach((k, idx) => store.ensureKey(k, { name: `env-seed-${idx + 1}`, scope: 'standard' }));
  }

  return { generatedAdminKey };
}

module.exports = { ApiKeyStore, bootstrap, hashKey };
