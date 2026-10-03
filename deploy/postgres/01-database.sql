-- Pine database (PRD-06 section 3). Run as a superuser after 00-roles.sql, with psql:
--   psql "$ADMIN_URL" -v pine_db=pine -f deploy/postgres/01-database.sql
-- Statements run one at a time (CREATE DATABASE cannot run inside a transaction block).
-- The database is owned by pine_migrator, so the migrations (run as pine_migrator) own the public and pine_index
-- schemas' tables and their ALTER DEFAULT PRIVILEGES apply to every later table.

CREATE DATABASE :"pine_db" OWNER pine_migrator ENCODING 'UTF8' TEMPLATE template0;
REVOKE ALL ON DATABASE :"pine_db" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"pine_db" TO pine_migrator;
GRANT CONNECT ON DATABASE :"pine_db" TO pine_api, pine_indexer, pine_readonly;
