-- Pine cluster roles (PRD-06 section 3, SEC-OPS-10, SEC-IDX-11). Run once per PostgreSQL 16 cluster as a superuser
-- (DBA), BEFORE the first migration. Idempotent: re-running only re-asserts the attributes below.
-- Passwords are never stored in this file; set them interactively afterwards (psql: \password pine_api, ...).
--
--   pine_migrator  owns the database and every table; runs both migration commands (DDL), never the API or indexer
--   pine_api       API runtime: DML on platform and module tables (grants and default privileges from API migrations)
--   pine_indexer   native indexer runtime: DML on pine_index only (grants from @pine/indexer-native migrations)
--   pine_readonly  API read model (PINE_READ_MODEL_DATABASE_URL) and analytics: SELECT on pine_index only
--
-- The migrations create pine_api, pine_indexer and pine_readonly as NOLOGIN when missing; pre-creating them here WITH
-- LOGIN is what lets the processes connect. No role is superuser, may create databases or roles, or bypasses RLS.

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['pine_migrator', 'pine_api', 'pine_indexer', 'pine_readonly'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', role_name);
    END IF;
  END LOOP;
END
$$;

ALTER ROLE pine_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE pine_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE pine_indexer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE pine_readonly LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- Runtime roles get timeouts at the role level as well (the API pool also sets them per connection).
ALTER ROLE pine_api SET statement_timeout = '15s';
ALTER ROLE pine_api SET lock_timeout = '5s';
ALTER ROLE pine_api SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE pine_indexer SET statement_timeout = '60s';
ALTER ROLE pine_indexer SET lock_timeout = '5s';
ALTER ROLE pine_readonly SET statement_timeout = '15s';
ALTER ROLE pine_readonly SET default_transaction_read_only = on;
