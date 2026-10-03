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
# plus fixé dans le Dockerfile), corrige les permissions des dossiers qui
# peuvent être des volumes montés, puis abandonne les privilèges root pour
# lancer l'application avec l'utilisateur non-root habituel.
set -e

for d in /app/data /app/.wwebjs_auth; do
  mkdir -p "$d"
  chown -R notifybridge:notifybridge "$d" 2>/dev/null || true
  chmod 0700 "$d" 2>/dev/null || true
done

# Abandon des privilèges root : tout le reste (Node, Puppeteer/Chrome)
# s'exécute avec l'utilisateur non privilégié, comme avant.
exec su -s /bin/sh notifybridge -c "exec node api-legacy-v3.js"
