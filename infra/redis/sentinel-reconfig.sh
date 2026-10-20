#!/bin/sh
# Sentinel client-reconfig-script (task I-02). Sentinel calls it when a failover ends:
#   <master-name> <role> <state> <from-ip> <from-port> <to-ip> <to-port>
# The leader immediately points the OLD master at the new one (REPLICAOF). Sentinel does the same
# on its own, but only after its 10 s INFO period plus a grace time; until then two nodes report
# role:master and the new master has no replica, so min-replicas-to-write rejects every write.
# If the old master is unreachable (crashed), this is a no-op and Sentinel converts it on return.
[ "$2" = "leader" ] || exit 0
redis-cli -t 2 -h "$4" -p "$5" REPLICAOF "$6" "$7" >/dev/null 2>&1 || true
exit 0
