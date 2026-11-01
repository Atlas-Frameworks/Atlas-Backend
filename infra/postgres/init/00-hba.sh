#!/bin/bash
# Allow streaming (replica) and logical (Debezium) replication connections from the compose network.
# The official image's default pg_hba.conf only covers normal database connections.
set -euo pipefail
echo "host replication all all scram-sha-256" >> "$PGDATA/pg_hba.conf"
