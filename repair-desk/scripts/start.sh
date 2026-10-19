#!/bin/sh
# Start the Repair Desk on Fly.io. The database lives on the mounted volume
# (/data) so it survives deploys, restarts and app updates. On the very first
# start the shop, staff and Keith are set up once; after that this is skipped.
set -e
DB="${DATABASE_PATH:-/data/repair-desk.sqlite}"
if [ ! -f "$DB" ]; then
  echo "[start] first start: setting up ${SHOP_DOMAIN} in ${DB}"
  node --no-warnings scripts/seed-moku.js "$DB" "${SEED_OWNER:-Tom Gleason}" "${SHOP_DOMAIN}"
fi
exec node --no-warnings src/server.js
