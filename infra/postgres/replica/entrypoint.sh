#!/bin/bash
# Streaming read replica for the POC (task I-01).
# On first start it clones the primary with pg_basebackup and writes standby settings (-R).
set -euo pipefail

PGDATA=/var/lib/postgresql/data

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "Cloning primary into $PGDATA"
  until pg_isready -h postgres-primary -U replicator -d atlas; do sleep 1; done
  rm -rf "${PGDATA:?}"/*
  pg_basebackup -h postgres-primary -U replicator -D "$PGDATA" -X stream -R -P
  # Postgres 17 failover slots: lets this standby keep a synchronized copy of Debezium's slot.
  # The database name in primary_conninfo is required for slot synchronization.
  {
    echo "primary_conninfo = 'host=postgres-primary user=replicator password=replicator dbname=atlas'"
    echo "hot_standby_feedback = on"
    echo "sync_replication_slots = on"
  } >> "$PGDATA/postgresql.auto.conf"
  chown -R postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
fi

exec gosu postgres postgres -D "$PGDATA"
