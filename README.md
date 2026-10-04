# NotifyBridge API

API WhatsApp multi-sessions destinée aux applications professionnelles, aux équipes et aux intégrations métier.

## Authentification et portée des clés

Toutes les routes, sauf `GET /api/health`, exigent une clé valide dans l’en-tête `x-api-key` (ou `Authorization: Bearer …`).

- **`standard`** est la portée normale d’une application cliente. Elle n’est pas réservée à la démo : elle permet à l’application propriétaire de piloter ses propres sessions, d’envoyer des messages et d’utiliser les routes de contacts, groupes et chats autorisées.
- **`admin`** est réservée à l’exploitation de la plateforme : gestion des clés et accès inter-tenant.
- Le dashboard crée les clés standard via la clé admin et associe explicitement la session à l’identifiant de sa clé. Le propriétaire est persisté dans `API_KEYS_DIR/session-owners.json`.
- Une clé standard ne peut jamais agir sur les sessions d’un autre compte ni sur une session historique sans propriétaire qui ne lui a pas été explicitement attribuée.

Gestion des clés (admin uniquement) :

| Méthode | Route | Usage |
|---|---|---|
| `POST` | `/api/admin/keys` | Créer une clé; le secret clair n’est renvoyé qu’une fois. |
| `GET` | `/api/admin/keys` | Lister les métadonnées (jamais le secret). |
| `DELETE` | `/api/admin/keys/:id` | Révoquer une clé. |
| `POST` | `/api/admin/sessions/:sessionId/owner` | Associer durablement une session à une clé standard. |
| `POST` | `/api/admin/keys/:id/quota` | Définir ou retirer un plafond d’envois pour une clé standard. |

Le catalogue exhaustif, extrait des routes réelles du serveur, est publié sur la [référence API NotifyBridge](https://notify-bridge.com/ap.php#catalogue-complet-api).

## Envoyer un message texte

Le champ requis est **`text`**, et non `message` :

```bash
curl -X POST https://notifybridge-production.up.railway.app/api/messages/send \
  -H 'x-api-key: VOTRE_CLE_STANDARD' \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"app-UUID","to":"22890000000","text":"Votre commande est confirmée."}'
```

Le résultat contient `ok`, `messageId`, `sessionId`, `to`, `timestamp` et les informations d’expéditeur. Tous les endpoints d’envoi texte et médias passent par le même contrôle de quota lorsqu’un plafond a été défini pour la clé.

## Forfait de bienvenue

Le dashboard peut poser `maxOutboundMessages: 15` sur la clé unique remise à un nouveau compte après confirmation de son adresse. Le compteur est stocké avec la clé dans le magasin persistant; les requêtes concurrentes réservent leur place avant d’appeler WhatsApp, et une réservation est rendue si l’envoi échoue. Le seizième envoi est refusé avec HTTP `429`, code `WELCOME_QUOTA_REACHED`. Un abonnement payant utilise une nouvelle clé sans ce plafond.

Ce compteur s’applique aux envois **effectués via l’API**. Il ne peut pas empêcher une personne d’envoyer manuellement depuis son application WhatsApp liée.

## États de connexion WhatsApp

Les états typiques sont `STARTING`, `SCAN_QR`, `AUTHENTICATED`, `WORKING`, `DISCONNECTED` ou `AUTH_FAILURE`. `AUTHENTICATED` signifie que le téléphone a accepté le QR; WhatsApp Web peut encore prendre plusieurs minutes pour finaliser l’initialisation avant `WORKING`. Gardez le polling de statut actif et n’affichez plus le QR comme « en attente de scan » dans cette phase.

## Journalisation et boîte de réception du dashboard

Pour alimenter les conversations du dashboard avec les messages envoyés par API et leurs réponses, configurer les variables d’environnement du service API :

- `DASHBOARD_LOG_URL=https://notify-bridge.com/dashboard` (sans slash final; le service ajoute `/api/internal-log.php`).
- `ADMIN_API_KEY` doit être la même valeur que `NOTIFYBRIDGE_ADMIN_KEY` dans le fichier privé du dashboard. Le callback l’envoie dans `X-Internal-Secret`; elle ne doit jamais être mise dans le navigateur.
- `API_KEYS_DIR` doit désigner un volume persistant et accessible en écriture, afin que clés, quotas de bienvenue et propriétaires de sessions survivent aux redémarrages.

Le journal est best-effort et ne bloque pas les échanges WhatsApp. Les événements sortants ouvrent les conversations; les messages entrants ne sont ajoutés qu’à un fil déjà initié par un envoi. Les préférences de rétention/purge sont gérées dans la base du dashboard.

## Configuration et déploiement

Ne créez pas de fichier `.env` pour ce déploiement. Saisissez les variables directement dans l’environnement du service Railway (ou exportez-les dans le shell de développement) :

```bash
export ADMIN_API_KEY='une-cle-admin-forte-et-stable'
export API_KEYS_DIR='/app/data'
export DASHBOARD_LOG_URL='https://notify-bridge.com/dashboard'
npm install
npm start
```

Sur Railway : conserver **un volume persistant monté sur `/app/data`**. Les clés et propriétaires sont stockés directement dans ce dossier; `LocalAuth` utilise le sous-dossier `/app/data/wwebjs_auth` quand `API_KEYS_DIR=/app/data` — il ne faut pas monter un second volume `.wwebjs_auth` pour ce code. Définir les variables dans **Service → Variables**.

**Utiliser une seule réplique API pour les sessions WhatsApp.** Deux processus Chromium ne doivent pas ouvrir simultanément le même profil LocalAuth. Les déploiements concurrents, plusieurs répliques ou un ancien processus toujours actif peuvent produire `The profile appears to be in use by another Google Chrome process`. Après avoir confirmé que l’ancien processus est arrêté, retirer uniquement les fichiers de verrou `SingletonLock`, `SingletonSocket` et `SingletonCookie` du profil concerné si le verrou est resté bloqué; ne pas supprimer le dossier d’authentification WhatsApp. Après une rotation de `ADMIN_API_KEY`, mettre également à jour le fichier privé `.config/notifybridge-dashboard.php` du dashboard et redémarrer les services concernés.

## Routes principales

Toutes les routes listées ci-dessous sont protégées par une clé, sauf `GET /api/health` :

- Sessions : démarrer, lister, lire le QR/statut/infos/numéro, réparer, ping, logout/suppression, webhooks et nettoyage des orphelines.
- Messages : texte, image, vidéo, audio, fichier, sticker, localisation et contact; statut, historique, édition et suppression.
- Conversations : chats, présence/typing/recording, épinglage, archivage et nettoyage d’état.
- Contacts : liste, profil détaillé, blocage/déblocage.
- Groupes : création, profil, participants, sujet et description.
- Administration : clés, propriétaires de session, quota de clé, statistiques globales.

## Variables d’environnement

| Variable | Rôle | Défaut |
|---|---|---|
| `ADMIN_API_KEY` | Clé admin stable et secrète | génération unique au démarrage si absente |
| `API_KEYS` | Clés standard de bootstrap, séparées par virgules | — |
| `API_KEYS_DIR` | Dossier persistant pour le magasin de clés et les propriétaires | `./data` |
| `DASHBOARD_LOG_URL` | URL de base du dashboard recevant les logs/messages | désactivé |
| `ALLOWED_ORIGINS` | Origines CORS autorisées | configuration serveur |
| `MAX_SESSIONS_TOTAL` / `MAX_SESSIONS_PER_KEY` | Limites de ressources globales/par clé | `50` / `5` |
| `RATE_LIMIT_MAX` / `START_RATE_LIMIT_MAX` | Limites de requêtes générales/de démarrage | `120` / `5` |

Pour les limites de sécurité, procédures et risques résiduels, voir [`SECURITY.md`](./SECURITY.md).
