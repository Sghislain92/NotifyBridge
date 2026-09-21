# Audit de sécurité NotifyBridge & correctifs appliqués

Date : 2026-09-21
Périmètre audité : dépôt `Sghislain92/NotifyBridge`, fichier actif `api-legacy-v3.js` (point d'entrée `npm start`), `Dockerfile`, historique Git.

## 1. Constat initial

L'API déployée sur `notifybridge-production.up.railway.app` n'appliquait **aucune authentification**. N'importe qui connaissant (ou devinant) l'URL pouvait :
- créer des sessions WhatsApp (scan de QR code) au nom de l'opérateur ;
- envoyer des messages, images, vidéos, fichiers, contacts, localisations depuis n'importe quel numéro WhatsApp connecté ;
- lire les contacts, discussions, informations de profil d'un compte connecté ;
- créer/modifier des groupes, bloquer des contacts ;
- fermer **toutes** les sessions actives (`/api/sessions/close-all`) — déni de service total sur tous les clients de la plateforme ;
- enregistrer un webhook pointant vers n'importe quelle URL.

## 2. Failles identifiées (avant correctif)

| # | Faille | Sévérité | Détail |
|---|---|---|---|
| 1 | **Absence totale d'authentification** | Critique | Aucun contrôle d'accès sur `api-legacy-v3.js` ; toutes les routes étaient publiques. |
| 2 | **Clé API secrète compromise dans l'historique Git** | Critique | L'ancienne version (`old/api-legacy.js`) contenait une clé API codée en dur (`API_KEY = "BWxD1xkzuPxJ0..."`), présente en clair dans plusieurs commits de l'historique **public**. Cette clé doit être considérée comme définitivement compromise, quel que soit le sort du fichier aujourd'hui. |
| 3 | **Absence d'isolation multi-tenant** | Critique | Le `sessionId` était la seule "frontière" entre clients ; sans authentification ni notion de propriétaire, quiconque connaissant/devinant le `sessionId` d'un client pouvait entièrement piloter son compte WhatsApp (lecture, envoi, blocage, déconnexion). |
| 4 | **SSRF (Server-Side Request Forgery)** | Élevée | `imageUrl`, `videoUrl`, `audioUrl`, `fileUrl`, `stickerUrl` et l'URL de webhook étaient récupérées côté serveur sans aucune validation. Un appelant pouvait forcer le serveur à interroger le réseau interne Railway, le service de métadonnées cloud (`169.254.169.254`), ou tout service local (`127.0.0.1`), et potentiellement exfiltrer la réponse via WhatsApp ou le webhook. |
| 5 | **Traversée de répertoire potentielle via `sessionId`** | Élevée | `LocalAuth({ clientId: sessionId })` dérive un chemin sur disque à partir du `sessionId` fourni par l'appelant, sans validation de format. |
| 6 | **Épuisement de ressources** | Élevée | Aucune limite sur le nombre de sessions WhatsApp créables ; chaque session lance une instance Chrome headless complète (Puppeteer). Un appelant pouvait en créer un nombre illimité et saturer CPU/RAM/disque du conteneur. |
| 7 | **Fuite de données inter-clients** | Élevée | `GET /api/sessions` retournait la liste de **toutes** les sessions (numéros, pseudos, statuts) de **tous** les clients, sans filtrage. |
| 8 | **CORS entièrement ouvert (`*`)** | Moyenne | Combiné à l'absence d'authentification, n'importe quelle page web pouvait piloter l'API depuis le navigateur d'un visiteur. |
| 9 | **Aucun rate limiting** | Moyenne | Aucune protection contre le bruteforce, le spam d'envoi de messages ou les abus en volume. |
| 10 | **Journalisation de données sensibles** | Moyenne | `console.log('Body:', req.body)` journalisait en clair les numéros de téléphone et le contenu des messages envoyés. |
| 11 | **Absence d'en-têtes de sécurité HTTP** | Faible | Pas de `helmet` (X-Content-Type-Options, HSTS, etc.). |
| 12 | **Conteneur Docker exécuté en `root`** | Faible | Pas d'utilisateur dédié — surface d'impact plus large en cas d'exécution de code arbitraire côté Chrome/Puppeteer. |
| 13 | **Messages d'erreur internes exposés** | Faible | `error.message` brut renvoyé au client sur les 500 (fuite d'information mineure sur la lib interne). |

## 3. Correctifs appliqués

### 3.1 Authentification obligatoire par clé API (`lib/apiKeys.js`, `middleware/auth.js`)
- Toute route est désormais protégée, sauf `GET /api/health` (endpoint de supervision, sans donnée sensible).
- Clé envoyée via `x-api-key` ou `Authorization: Bearer`.
- Les clés en clair ne sont **jamais stockées** : seul un hash SHA-256 est conservé (`data/api-keys.json`), comparé en temps constant (`crypto.timingSafeEqual`).
- Deux portées : `admin` (gestion des clés + accès à toutes les sessions) et `standard` (limité à ses propres sessions).
- Bootstrap : `ADMIN_API_KEY` en variable d'environnement (recommandé), ou génération automatique affichée une seule fois au démarrage si absente.
- Gestion des clés via `POST/GET /api/admin/keys` et `DELETE /api/admin/keys/:id` (réservé aux clés `admin`).

### 3.2 Isolation multi-tenant
- Chaque session WhatsApp est associée à la clé API qui l'a créée (`session.ownerKeyId`).
- `app.param('sessionId', ...)` vérifie automatiquement l'appartenance sur toutes les routes utilisant `:sessionId` dans l'URL ; une clé `standard` reçoit `403` si elle tente d'agir sur la session d'un autre client.
- Les routes recevant `sessionId` dans le corps de la requête (`/api/messages/send*`) utilisent le même contrôle via `resolveOwnedSession()`.
- `GET /api/sessions`, `/close-all`, `/cleanup-orphans` filtrent désormais par propriétaire pour une clé `standard` (une clé `admin` continue de voir/agir sur tout).
- Les endpoints `/api/messages/:messageId/edit|delete|status` vérifient que le message appartient à une session possédée par l'appelant.

### 3.3 Protection SSRF (`lib/ssrfGuard.js`)
- `assertPublicHttpUrl()` est appelée avant tout téléchargement d'URL fournie par l'appelant (webhook, `imageUrl`, `videoUrl`, `audioUrl`, `fileUrl`, `stickerUrl`).
- Rejette les schémas autres que `http`/`https`, les noms d'hôte bloqués (`localhost`, `*.internal`, `*.local`), et résout le DNS pour vérifier que l'adresse IP réelle n'est ni privée (RFC1918), ni loopback, ni link-local (dont `169.254.169.254`, le service de métadonnées cloud), ni multicast/réservée — en IPv4 et IPv6.
- **Limite connue** : comme toute vérification "check-then-use", une attaque de type *DNS rebinding* entre la vérification et le téléchargement réel reste théoriquement possible. Pour une garantie totale, il faudrait épingler l'adresse IP résolue dans l'agent HTTP utilisé pour le fetch réel (amélioration possible si le niveau de risque du déploiement le justifie).

### 3.4 Validation stricte du `sessionId` (`lib/security.js`)
- Format imposé : `^[a-zA-Z0-9_-]{1,64}$`, appliqué systématiquement via `app.param` et `resolveOwnedSession()`. Empêche toute traversée de répertoire dans le dossier `.wwebjs_auth`.

### 3.5 Limites anti-épuisement de ressources
- `MAX_SESSIONS_TOTAL` (défaut 50) et `MAX_SESSIONS_PER_KEY` (défaut 5), vérifiés avant toute création de session Chrome/Puppeteer.
- Rate limiting dédié et plus strict sur `POST /api/sessions/:sessionId/start` (`START_RATE_LIMIT_MAX`, défaut 5 / 10 min / clé).

### 3.6 Rate limiting général (`express-rate-limit`)
- Un limiteur par IP, actif **avant** l'authentification (`IP_RATE_LIMIT_MAX`, défaut 300 / 5 min), pour ralentir le bruteforce de clés API.
- Un limiteur par clé API, après authentification (`RATE_LIMIT_MAX`, défaut 120 / min).

### 3.7 CORS restreignable, en-têtes de sécurité HTTP
- `helmet()` appliqué globalement.
- CORS configurable via `ALLOWED_ORIGINS` (liste blanche), `*` par défaut pour compatibilité (usage serveur-à-serveur ; rappel documenté que la clé API ne doit jamais être exposée côté navigateur).

### 3.8 Journalisation
- Le corps de requête complet n'est plus journalisé par défaut. Un mode `DEBUG_LOG_BODIES=true` existe pour le débogage local, avec les champs sensibles tronqués/masqués (`lib/security.js#redactForLog`).

### 3.9 Conteneur Docker
- Utilisateur non-root dédié (`notifybridge`).
- `HEALTHCHECK` basé sur `/api/health`.
- Volume recommandé sur `/app/data` (clés API) et `/app/.wwebjs_auth` (sessions WhatsApp) pour la persistance entre redéploiements Railway.

## 4. Ce qui reste de la responsabilité de l'opérateur

1. **Rotation immédiate** : la clé codée en dur dans l'historique Git (`old/api-legacy.js`) est publique et doit être considérée comme compromise — elle n'est plus utilisée par le code actif, mais si elle a été réutilisée ailleurs (autre service, autre API), changez-la là aussi.
2. **Définir `ADMIN_API_KEY`** en variable d'environnement Railway avant la mise en production (sinon une clé est régénérée à chaque redémarrage sans volume persistant).
3. **Monter un volume persistant** sur `/app/data` pour ne pas perdre les clés clients à chaque redéploiement.
4. Envisager, si le modèle de menace l'exige, l'épinglage DNS pour fermer complètement le résidu de risque SSRF (rebinding), et un store de rate-limit partagé (Redis) si l'API est un jour répartie sur plusieurs instances.
5. Envisager de purger l'historique Git de l'ancienne clé (`git filter-repo`/BFG) — cela ne l'invalide pas rétroactivement sur le web (GitHub garde des caches), mais réduit sa visibilité dans le futur.

## 5. Validation effectuée

- Démarrage du serveur et vérification des logs (aucune erreur, génération de la clé admin).
- `GET /api/health` accessible sans clé (200).
- Toute autre route sans clé → `401`. Avec clé invalide → `401`. Avec clé valide → `200`.
- Création de clé standard via `/api/admin/keys`, refus `403` de cette même clé sur les routes `/api/admin/keys`.
- `sessionId` contenant des caractères de traversée (`..%2f..`) ou invalides → `400` avant tout accès disque.
- Garde SSRF testé unitairement : bloque `169.254.169.254`, `127.0.0.1`, `localhost`, `10.x`, `192.168.x` ; laisse passer des URLs publiques légitimes.
- Révocation d'une clé → usage immédiatement refusé (`401`).
- `Authorization: Bearer` et `x-api-key` tous deux fonctionnels.
- Rate limiting vérifié isolément (3ᵉ requête sur une limite de 2 → `429`).
