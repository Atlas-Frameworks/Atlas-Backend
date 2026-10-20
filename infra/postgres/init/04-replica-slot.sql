-- Physical replication slot for the streaming read replica (task I-01).
-- The replica connects with primary_slot_name = 'replica_1', and the primary lists this slot in
-- synchronized_standby_slots, so logical decoding (Debezium) waits for the replica before
-- confirming changes. If the replica is down for long, WAL kept for it is capped by
-- max_slot_wal_keep_size, after which the slot is invalidated and the replica must be re-cloned.
SELECT pg_create_physical_replication_slot('replica_1');
