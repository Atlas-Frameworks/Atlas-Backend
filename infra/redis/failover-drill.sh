#!/usr/bin/env bash
# Redis failover drill (task I-02). See infra/redis/README.md.
#
#   infra/redis/failover-drill.sh [seconds-after-failover]   (default 20)
#
# 1. Writes a counter to a fresh stream through the master-only proxy (redis-proxy:6380) every 50 ms.
# 2. Triggers SENTINEL FAILOVER atlas.
# 3. Keeps writing, then reports how long writes failed and whether any acknowledged entry is missing.
#
# Runs inside a throwaway redis container on the compose network, so it needs only Docker and a
# running `npm run infra:up`. Exit status: 0 = no acknowledged entry lost and writes resumed
# within 10 s, 1 = otherwise.
set -euo pipefail

AFTER=${1:-20}
NETWORK=${DRILL_NETWORK:-atlas-realtime_default}
IMAGE=${DRILL_IMAGE:-redis:7.4}

exec docker run --rm -i --network "$NETWORK" -e AFTER="$AFTER" "$IMAGE" bash -s <<'DRILL'
set -uo pipefail
PROXY=(-h redis-proxy -p 6380)
SENTINEL=(-h sentinel-1 -p 26379)
KEY="drill:$(date +%s)"
LOG=/tmp/writes.log
now_ms() { date +%s%3N; }

master() { redis-cli "${SENTINEL[@]}" SENTINEL get-master-addr-by-name atlas | head -1; }
proxy_role() { redis-cli -t 1 "${PROXY[@]}" INFO replication 2>/dev/null | tr -d '\r' | grep '^role:' || echo 'role:unreachable'; }

before_master=$(master)
echo "stream:               $KEY"
echo "master before:        $before_master ($(proxy_role) via proxy)"

# Writer: one XADD per 50 ms, new connection each time (like a client reconnecting after a cut).
(
  i=0
  while [ ! -f /tmp/stop ]; do
    i=$((i + 1)); t=$(now_ms)
    if out=$(redis-cli -e -t 1 "${PROXY[@]}" XADD "$KEY" '*' n "$i" 2>&1) && [[ "$out" == *-* ]]; then
      echo "$t ok $i"
    else
      echo "$t fail $i $(echo "$out" | tr '\n' ' ' | cut -c1-80)"
    fi
    sleep 0.05
  done
) > "$LOG" &
writer=$!

sleep 3
failover_at=$(now_ms)
echo "SENTINEL FAILOVER:    $(redis-cli "${SENTINEL[@]}" SENTINEL FAILOVER atlas)"
sleep "$AFTER"
touch /tmp/stop; wait "$writer"

after_master=$(master)
echo "master after:         $after_master ($(proxy_role) via proxy)"

# ---- outage analysis ----
read -r total acked failed < <(awk '{n++} $2=="ok"{o++} $2=="fail"{f++} END{print n, o+0, f+0}' "$LOG")
first_fail=$(awk -v t="$failover_at" '$1>=t && $2=="fail"{print $1; exit}' "$LOG")
if [ -n "$first_fail" ]; then
  resumed=$(awk -v t="$first_fail" '$1>t && $2=="ok"{print $1; exit}' "$LOG")
  last_fail=$(awk '$2=="fail"{t=$1} END{print t}' "$LOG")
  window=$(( ${resumed:-$(now_ms)} - first_fail ))
  since_cmd=$(( ${resumed:-$(now_ms)} - failover_at ))
  echo "writes failing:       $failed of $total ($(( (last_fail - first_fail) )) ms from first to last failure)"
  echo "outage window:        ${window} ms (first failure -> first acknowledged write after it)"
  echo "resumed after:        ${since_cmd} ms from the FAILOVER command"
  echo "error kinds:          $(awk '$2=="fail"{ $1=$2=$3=""; print}' "$LOG" | sed 's/^ *//' | cut -c1-40 | sort | uniq -c | sort -rn | head -3 | tr -s ' ' | paste -sd ';' -)"
else
  since_cmd=0
  echo "writes failing:       0 of $total"
fi

# ---- loss analysis: every acknowledged n must be in the stream ----
redis-cli "${PROXY[@]}" XRANGE "$KEY" - + | awk 'prev=="n"{print} {prev=$0}' | sort -n > /tmp/present
awk '$2=="ok"{print $3}' "$LOG" | sort -n > /tmp/acked
missing=$(comm -23 /tmp/acked /tmp/present | wc -l | tr -d ' ')
extra=$(comm -13 /tmp/acked /tmp/present | wc -l | tr -d ' ')
echo "acknowledged:         $acked, in stream: $(wc -l < /tmp/present | tr -d ' ')"
echo "acknowledged missing: $missing $( [ "$missing" -gt 0 ] && echo "(n = $(comm -23 /tmp/acked /tmp/present | head -10 | paste -sd, -))" )"
echo "unacknowledged but present: $extra (a write that failed on the client side but was applied)"
redis-cli "${PROXY[@]}" DEL "$KEY" > /dev/null

ok=1
[ "$before_master" = "$after_master" ] && { echo "RESULT: FAIL, master did not change"; ok=0; }
[ "$missing" -gt 0 ] && { echo "RESULT: FAIL, $missing acknowledged entries lost"; ok=0; }
[ "$since_cmd" -gt 10000 ] && { echo "RESULT: FAIL, writes resumed after more than 10 s"; ok=0; }
[ "$ok" = 1 ] && echo "RESULT: PASS"
[ "$ok" = 1 ]
DRILL
