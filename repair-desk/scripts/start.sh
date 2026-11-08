#!/bin/sh
# Start the Repair Desk on Fly.io. The database lives on the mounted volume
# (/data) so it survives deploys, restarts and app updates.
#
# With a backup bucket attached (BUCKET_NAME, production): if the volume is
# empty the database is first restored from the backup, then the server runs
# under Litestream, which copies every change off the machine as it happens.
# REQUIRE_BACKUP=1 refuses to start without a bucket, so production can never
# run unprotected by mistake.
#
# On the very first start (no database and no backup) the shop, staff and
# Keith are set up once; after that this is skipped.
set -e
DB="${DATABASE_PATH:-/data/repair-desk.sqlite}"
export DATABASE_PATH="$DB"
CONFIG=/app/litestream.yml

if [ -n "$BUCKET_NAME" ]; then
  if [ ! -f "$DB" ]; then
    echo "[start] no database on the volume: restoring from backup if one exists"
    litestream restore -config "$CONFIG" -if-db-not-exists -if-replica-exists "$DB"
  fi
elif [ "$REQUIRE_BACKUP" = "1" ]; then
  echo "[start] REQUIRE_BACKUP=1 but no backup bucket is attached (run: fly storage create). Not starting."
  exit 1
fi

if [ ! -f "$DB" ]; then
  echo "[start] first start: setting up ${SHOP_DOMAIN} in ${DB}"
  node --no-warnings scripts/seed-moku.js "$DB" "${SEED_OWNER:-Tom Gleason}" "${SHOP_DOMAIN}"
fi

if [ -n "$BUCKET_NAME" ]; then
  echo "[start] backup on: replicating ${DB} to ${BUCKET_NAME}"
  exec litestream replicate -config "$CONFIG" -exec "node --no-warnings src/server.js"
fi
exec node --no-warnings src/server.js
