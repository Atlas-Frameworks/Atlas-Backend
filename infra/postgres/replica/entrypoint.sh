#!/bin/bash
# Streaming read replica for the POC (task I-01).
# On first start (empty data directory) it clones the primary with pg_basebackup. -R writes the
# standby settings (standby.signal, primary_conninfo, primary_slot_name). Server settings come
# from the compose `command:` and are passed through to postgres as "$@".
set -euo pipefail

PGDATA=/var/lib/postgresql/data
PRIMARY_HOST=${PRIMARY_HOST:-postgres-primary}
SLOT=${PRIMARY_SLOT_NAME:-replica_1}

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "Cloning primary $PRIMARY_HOST into $PGDATA using slot $SLOT"
  until pg_isready -q -h "$PRIMARY_HOST" -U replicator -d atlas; do sleep 1; done
  mkdir -p "$PGDATA"
  rm -rf "${PGDATA:?}"/*
  # -d with dbname: Postgres 17 writes the database name into primary_conninfo, which slot
  # synchronization (sync_replication_slots) requires.
  pg_basebackup \
    -d "host=$PRIMARY_HOST port=5432 user=replicator dbname=atlas application_name=postgres-replica" \
    -D "$PGDATA" -X stream -S "$SLOT" -R --checkpoint=fast --progress
  chown -R postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  echo "Clone complete. Standby settings:"
  grep -E "primary_conninfo|primary_slot_name" "$PGDATA/postgresql.auto.conf" | sed -E "s/password=[^ ']*/password=***/"
fi

exec gosu postgres postgres -D "$PGDATA" "$@"
