'use strict';

/**
 * ============================================================
 * Protection SSRF (Server-Side Request Forgery)
 * ============================================================
 *
 * NotifyBridge télécharge des fichiers depuis des URLs fournies par
 * l'appelant (webhook, imageUrl, videoUrl, audioUrl, fileUrl, stickerUrl).
 * Sans contrôle, un appelant pourrait forcer le serveur à interroger :
 *   - le réseau interne Railway / le cloud metadata (169.254.169.254, etc.)
 *   - des services internes non exposés publiquement
 *   - localhost / 127.0.0.1 (l'API elle-même, ou une DB locale)
 *
 * assertPublicHttpUrl() valide le schéma, le nom d'hôte ET résout le DNS
 * pour vérifier que l'adresse IP réelle n'est ni privée, ni loopback,
 * ni link-local, avant d'autoriser le téléchargement.
 *
 * Limite connue : comme toute vérification "check-then-use", une attaque
 * de type DNS rebinding entre la vérification et le fetch réel reste
 * théoriquement possible. Pour une garantie totale, épingler l'IP résolue
 * dans l'agent HTTP (voir README section Sécurité).
 */

const dns = require('dns').promises;
const net = require('net');

class SsrfValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrfValidationError';
    this.statusCode = 400;
  }
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.azure.com',
  'metadata',
]);

function ipv4ToLong(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIPv4(ip) {
  const long = ipv4ToLong(ip);
  const ranges = [
    ['0.0.0.0', '0.255.255.255'],
    ['10.0.0.0', '10.255.255.255'],
    ['100.64.0.0', '100.127.255.255'], // CGNAT
    ['127.0.0.0', '127.255.255.255'], // loopback
    ['169.254.0.0', '169.254.255.255'], // link-local / cloud metadata
    ['172.16.0.0', '172.31.255.255'],
    ['192.0.0.0', '192.0.0.255'],
    ['192.168.0.0', '192.168.255.255'],
    ['198.18.0.0', '198.19.255.255'],
    ['224.0.0.0', '255.255.255.255'], // multicast / reserved
  ];
  return ranges.some(([start, end]) => long >= ipv4ToLong(start) && long <= ipv4ToLong(end));
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true; // loopback
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped address, e.g. ::ffff:127.0.0.1
    return isPrivateIPv4(lower.replace('::ffff:', ''));
  }
  if (lower.startsWith('fe80:') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local (ULA)
  if (lower === '::') return true;
  return false;
}

function isPrivateOrReservedIP(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true; // adresse non reconnue -> refuser par prudence
}

/**
 * Valide qu'une URL fournie par un appelant est sûre à récupérer côté serveur.
 * Lève une erreur explicite si elle ne l'est pas.
 */
async function assertPublicHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfValidationError('URL invalide');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfValidationError('Seuls les schémas http/https sont autorisés');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.internal') || hostname.endsWith('.local')) {
    throw new SsrfValidationError(`Hôte non autorisé: ${hostname}`);
  }

  // Si le nom d'hôte est déjà une IP littérale, on la vérifie directement.
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIP(hostname)) {
      throw new SsrfValidationError(`Adresse IP non autorisée: ${hostname}`);
    }
    return;
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SsrfValidationError(`Résolution DNS impossible pour: ${hostname}`);
  }

  if (!addresses.length) {
    throw new SsrfValidationError(`Aucune adresse résolue pour: ${hostname}`);
  }

  for (const { address } of addresses) {
    if (isPrivateOrReservedIP(address)) {
      throw new SsrfValidationError(`L'hôte ${hostname} résout vers une adresse interne non autorisée`);
    }
  }
}

module.exports = { assertPublicHttpUrl, isPrivateOrReservedIP, SsrfValidationError };
