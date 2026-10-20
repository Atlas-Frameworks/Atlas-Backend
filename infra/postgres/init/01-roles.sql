-- Roles (task W-01 owns and finalizes this file).
-- replicator      : physical replication for the read replica
-- debezium        : logical replication reader for the outbox only
-- atlas_writer    : the ONLY role allowed to write entity tables (used by the replicator service)
-- atlas_reader    : read-only role used by view-service workers

CREATE ROLE replicator WITH LOGIN REPLICATION PASSWORD 'replicator';
CREATE ROLE debezium WITH LOGIN REPLICATION PASSWORD 'debezium';
CREATE ROLE atlas_writer WITH LOGIN PASSWORD 'atlas_writer';
CREATE ROLE atlas_reader WITH LOGIN PASSWORD 'atlas_reader';

-- Allow the replica to connect for streaming replication.
-- (The official image already allows host connections from the compose network.)
