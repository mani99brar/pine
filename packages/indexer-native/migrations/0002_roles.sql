-- Roles (SEC-IDX-11), created idempotently as NOLOGIN; production pre-creates them WITH LOGIN.
--   pine_indexer:  USAGE on pine_index, DML on its data tables and sequences, SELECT on the migration ledger, never DDL.
--   pine_readonly: USAGE and SELECT only (the API's read-model connection).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pine_indexer') THEN
    CREATE ROLE pine_indexer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pine_readonly') THEN
    CREATE ROLE pine_readonly NOLOGIN;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA pine_index FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA pine_index FROM PUBLIC;
GRANT USAGE ON SCHEMA pine_index TO pine_indexer, pine_readonly;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  pine_index.cursor,
  pine_index.halts,
  pine_index.applied_events,
  pine_index.blocks,
  pine_index.claims,
  pine_index.evidence,
  pine_index.questions,
  pine_index.question_markets,
  pine_index.answers,
  pine_index.arbitrations,
  pine_index.arbitration_history,
  pine_index.tracked_conditions,
  pine_index.condition_resolutions,
  pine_index.condition_payouts
TO pine_indexer;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE pine_index.halts_id_seq TO pine_indexer;
GRANT SELECT ON pine_index.schema_migrations TO pine_indexer;

GRANT SELECT ON ALL TABLES IN SCHEMA pine_index TO pine_readonly;

ALTER DEFAULT PRIVILEGES IN SCHEMA pine_index GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pine_indexer;
ALTER DEFAULT PRIVILEGES IN SCHEMA pine_index GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO pine_indexer;
ALTER DEFAULT PRIVILEGES IN SCHEMA pine_index GRANT SELECT ON TABLES TO pine_readonly;
