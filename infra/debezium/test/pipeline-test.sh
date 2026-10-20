#!/usr/bin/env bash
# Outbox -> Debezium -> Redis Streams pipeline test (task I-03). See infra/debezium/README.md.
#
#   infra/debezium/test/pipeline-test.sh [options]
#     --rows N            outbox rows to insert (default 10000), spread randomly over 4 entity types
#     --rate N            approximate rows per second (default 1000; 0 = as fast as possible)
#     --kill-debezium     docker kill Debezium halfway through, then start it again
#     --redis-failover    SENTINEL FAILOVER halfway through
#
# Each row is written like the replicator writes it: one transaction per change that takes the next
# gapless typeSeq from entity_type_sequence, INSERTs the outbox row and DELETEs it again. The same
# transaction records the payload in pipeline_test.expected, so "expected" is exactly what committed.
# Then verify-streams.mjs checks every Redis entry against it. Needs `npm run infra:up`.
set -euo pipefail
cd "$(dirname "$0")"
ROWS=10000 RATE=1000 KILL=0 FAILOVER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rows) ROWS=$2; shift ;;
    --rate) RATE=$2; shift ;;
    --kill-debezium) KILL=1 ;;
    --redis-failover) FAILOVER=1 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
COMPOSE=(docker compose -f ../../docker-compose.yml)
psql() { "${COMPOSE[@]}" exec -T postgres-primary psql -U postgres -d atlas -v ON_ERROR_STOP=1 -Atq "$@"; }
RUN="run_$(date +%s)"

psql <<'SQL'
CREATE SCHEMA IF NOT EXISTS pipeline_test;
CREATE TABLE IF NOT EXISTS pipeline_test.expected (
  run text NOT NULL, type text NOT NULL, seq bigint NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY (run, type, seq)
);
SQL

# Rows per batch between sleeps, so the run is paced at about RATE rows/s.
BATCH=100; SLEEP=0
if [ "$RATE" -gt 0 ]; then SLEEP=$(awk -v b=$BATCH -v r="$RATE" 'BEGIN{printf "%.3f", b/r}'); fi

echo "run $RUN: $ROWS rows, ~$RATE rows/s (kill-debezium=$KILL, redis-failover=$FAILOVER)"
start=$(date +%s)
psql <<SQL &
DO \$\$
DECLARE
  types text[] := ARRAY['countries', 'connections', 'airports', 'airplanes'];
  t text; s bigint; oid bigint; p jsonb; eid uuid;
BEGIN
  FOR i IN 1..$ROWS LOOP
    t := types[1 + floor(random() * 4)::int];
    UPDATE entity_type_sequence SET seq = seq + 1 WHERE entity_type = t RETURNING seq INTO s;
    eid := md5(t || ':' || (s % 5000))::uuid;
    p := jsonb_build_object(
      'schema', 1, 'type', t, 'id', eid, 'op', 'upsert', 'version', s, 'typeSeq', s,
      'committedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'map', CASE WHEN t = 'airplanes'
               THEN jsonb_build_object('lat', round((random() * 180 - 90)::numeric, 5), 'lon', round((random() * 360 - 180)::numeric, 5),
                                       'alt', (random() * 12000)::int, 'heading', round((random() * 360)::numeric, 1), 'icon', 3, 'label', 'LY' || (s % 1000))
               END,
      'routing', jsonb_build_object('old', jsonb_build_object('country_id', md5('c' || (s % 7))::uuid),
                                    'new', jsonb_build_object('country_id', md5('c' || (s % 11))::uuid)),
      'affectedRoots', NULL);
    INSERT INTO outbox (aggregatetype, aggregateid, payload) VALUES (t, eid, p) RETURNING id INTO oid;
    DELETE FROM outbox WHERE id = oid;
    INSERT INTO pipeline_test.expected VALUES ('$RUN', t, s, p);
    COMMIT;
    IF $SLEEP > 0 AND i % $BATCH = 0 THEN PERFORM pg_sleep($SLEEP); END IF;
  END LOOP;
END \$\$;
SQL
writer=$!

if [ "$KILL" = 1 ] || [ "$FAILOVER" = 1 ]; then
  # Wait until about half the rows are committed.
  until [ "$(psql -c "SELECT count(*) FROM pipeline_test.expected WHERE run = '$RUN'")" -ge $((ROWS / 2)) ]; do sleep 0.5; done
  if [ "$KILL" = 1 ]; then
    echo "$(date +%T) docker kill debezium at $(psql -c "SELECT count(*) FROM pipeline_test.expected WHERE run = '$RUN'") rows"
    docker kill "$("${COMPOSE[@]}" ps -q debezium)" > /dev/null
    sleep 3
    echo "$(date +%T) starting debezium again"
    "${COMPOSE[@]}" start debezium > /dev/null
  fi
  if [ "$FAILOVER" = 1 ]; then
    echo "$(date +%T) SENTINEL FAILOVER at $(psql -c "SELECT count(*) FROM pipeline_test.expected WHERE run = '$RUN'") rows: $("${COMPOSE[@]}" exec -T sentinel-1 redis-cli -p 26379 SENTINEL FAILOVER atlas)"
  fi
fi
wait $writer
echo "inserted $ROWS rows in $(( $(date +%s) - start )) s; outbox rows left: $(psql -c 'SELECT count(*) FROM outbox')"

exec node verify-streams.mjs "$RUN"
