#!/bin/sh
# ============================================================
# Point d'entrée Docker — corrige les permissions des volumes montés
# ============================================================
#
# Pourquoi ce script existe :
# Railway monte un volume persistant comme un point de montage APPARTENANT
# À ROOT (root:root), quels que soient les droits que l'image Docker avait
# donnés à ce chemin au moment du build (le `chown` fait dans le Dockerfile
# ne "survit" pas au montage, qui le recouvre entièrement). Comme le
# conteneur tourne ensuite avec l'utilisateur non-root "notifybridge" (pour
# des raisons de sécurité), toute tentative d'écriture dans /app/data
# échoue avec EACCES dès que ce dossier est un volume monté — d'où le
# crash en boucle au démarrage.
#
# Ce script tourne encore en ROOT (avant USER notifybridge, qui n'est donc
# plus fixé dans le Dockerfile), corrige les permissions du dossier qui
# peut être un volume monté, puis abandonne les privilèges root pour
# lancer l'application avec l'utilisateur non-root habituel.
#
# Note : /app/data est le SEUL volume à monter sur Railway. Les sessions
# WhatsApp (.wwebjs_auth) sont désormais stockées dans un sous-dossier de
# /app/data (voir api-legacy-v3.js, WWEBJS_AUTH_DIR) pour persister sur ce
# même volume, sans avoir besoin d'un second volume Railway.
set -e

mkdir -p /app/data
chown -R notifybridge:notifybridge /app/data 2>/dev/null || true
chmod 0700 /app/data 2>/dev/null || true

# Abandon des privilèges root : tout le reste (Node, Puppeteer/Chrome)
# s'exécute avec l'utilisateur non privilégié, comme avant.
exec su -s /bin/sh notifybridge -c "exec node api-legacy-v3.js"
