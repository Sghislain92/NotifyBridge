# NotifyBridge

NotifyBridge est une plateforme SaaS et une API dédiée à la gestion, l'automatisation et la supervision des communications WhatsApp pour les entreprises, développeurs et plateformes digitales. Elle permet de connecter des comptes WhatsApp via QR code, d'envoyer des notifications, d'automatiser des scénarios métier.

## 🔒 Sécurité — authentification obligatoire

**Depuis cette version, toutes les routes de l'API (sauf `/api/health`) exigent une clé API valide.** Sans elle, l'API répond `401 Unauthorized`. Voir [`SECURITY.md`](./SECURITY.md) pour l'audit complet des failles trouvées et corrigées.

### Envoyer la clé

Deux en-têtes sont acceptés (au choix) :

```
x-api-key: nbk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```
ou
```
Authorization: Bearer nbk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Premier démarrage — obtenir une clé admin

Au premier lancement, si aucune clé admin n'est configurée, le serveur **génère une clé admin aléatoire et l'affiche une seule fois dans les logs de démarrage** :

```
🔑 Aucune clé admin configurée (ADMIN_API_KEY) : une clé a été
   générée automatiquement. Notez-la, elle ne sera plus affichée :
   nbk_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

En production (Railway), définissez plutôt la variable d'environnement `ADMIN_API_KEY` avec une valeur forte et stable, générée par exemple avec :

```bash
node -e "console.log('nbk_' + require('crypto').randomBytes(32).toString('base64url'))"
```

### Gérer les clés (portée admin)

| Méthode | Route | Description |
|---|---|---|
| `POST` | `/api/admin/keys` | Crée une clé (`{ "name": "client-x", "scope": "standard" \| "admin" }`). La clé en clair n'est renvoyée **qu'une fois**, dans la réponse. |
| `GET` | `/api/admin/keys` | Liste les clés (métadonnées uniquement, jamais la clé en clair). |
| `DELETE` | `/api/admin/keys/:id` | Révoque une clé immédiatement. |

- **`admin`** : gère les clés, agit sur toutes les sessions WhatsApp de tous les clients (utile pour l'opérateur de la plateforme).
- **`standard`** : ne peut créer/lire/piloter que les sessions WhatsApp qu'elle a elle-même créées — isolation multi-tenant : une clé cliente ne peut jamais lire ou piloter les sessions WhatsApp d'un autre client, même en devinant leur `sessionId`.

## Démarrage

```bash
cp .env.example .env   # renseignez au moins ADMIN_API_KEY
npm install
npm start
```

Variables d'environnement principales (voir `.env.example` pour la liste complète) :

| Variable | Rôle | Défaut |
|---|---|---|
| `ADMIN_API_KEY` | Clé admin stable | (générée aléatoirement si absente) |
| `API_KEYS` | Clés "standard" créées automatiquement au démarrage (séparées par virgules) | — |
| `API_KEYS_DIR` | Dossier de persistance du magasin de clés (montez un volume Railway ici) | `./data` |
| `ALLOWED_ORIGINS` | Origines CORS autorisées, séparées par virgules | toutes (usage serveur-à-serveur) |
| `MAX_SESSIONS_TOTAL` / `MAX_SESSIONS_PER_KEY` | Plafonds anti-épuisement de ressources | `50` / `5` |
| `RATE_LIMIT_MAX` / `START_RATE_LIMIT_MAX` | Limites de requêtes par clé (par minute / par 10 min pour la création de session) | `120` / `5` |

## Déploiement Railway

1. Ajoutez un **volume** monté sur `/app/data` (persistance des clés API) et `/app/.wwebjs_auth` (persistance des sessions WhatsApp).
2. Définissez `ADMIN_API_KEY` dans les variables du service.
3. Déployez — `Dockerfile` installe Chrome et lance l'API sur `$PORT`.
4. Créez vos clés clients via `POST /api/admin/keys` (voir plus haut), puis distribuez-les à vos clients pour qu'ils appellent l'API avec leur propre clé.

## Principaux endpoints

Toutes les routes ci-dessous nécessitent une clé API (sauf `/api/health`).

- `POST /api/sessions/:sessionId/start` — démarre une session WhatsApp (QR code)
- `GET /api/sessions/:sessionId/qr` / `/status` / `/info`
- `POST /api/messages/send`, `/send-image`, `/send-video`, `/send-audio`, `/send-file`, `/send-sticker`, `/send-location`, `/send-contact`
- `GET /api/sessions` — liste **vos** sessions (toutes les sessions si clé `admin`)
- `POST /api/sessions/close-all` / `cleanup-orphans` — agissent sur **vos** sessions (toutes si clé `admin`)
- `GET /api/health` — endpoint public, sans authentification

## Sécurité — ce qui est appliqué

- Authentification obligatoire par clé API sur toute l'API (sauf `/api/health`).
- Isolation multi-tenant : une clé ne voit/pilote que les sessions qu'elle a créées.
- Protection SSRF sur toutes les URLs fournies par l'appelant (webhook, médias) : schéma http/https uniquement, résolution DNS vérifiée contre les plages privées/loopback/link-local/metadata cloud.
- Validation stricte du `sessionId` (empêche la traversée de répertoire dans le stockage de session WhatsApp).
- Limites anti-épuisement de ressources (nombre de sessions Chrome simultanées, global et par clé).
- Rate limiting par IP (avant authentification) et par clé API (après authentification), avec une limite spécifique et plus stricte sur la création de session.
- En-têtes de sécurité HTTP via `helmet`.
- CORS restreignable par variable d'environnement.
- Journaux applicatifs sans contenu sensible en clair (numéros, texte des messages) par défaut.
- Conteneur Docker exécuté avec un utilisateur non-root.

Détails complets, failles trouvées avant correctif, et limites connues : voir [`SECURITY.md`](./SECURITY.md).
