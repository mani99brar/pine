# Backups and restore (SEC-OPS-11)

What must survive a loss of the host:

| Data | Where | Backup |
|---|---|---|
| Users, sessions, terms acceptances, audit log, moderation, drafts, previews, publications, plans, encrypted GitHub tokens, **content blobs** (claim documents, manifests, artifacts) | Postgres database `pine`, schema `public` | Encrypted base backups + continuous WAL archiving (PITR) |
| Native read model `pine_index` | same database | Included, but rebuildable: an empty `pine_index` re-indexes from `DEPLOYMENT_BLOCK` (finalized chain data) |
| GitHub token encryption keys (`PINE_TOKEN_KEY_CURRENT`, `PINE_TOKEN_KEYS_PREVIOUS`) | secrets manager / `/etc/pine/api.secrets.env` | Stored **separately** from database backups, so a stolen backup has unreadable tokens |
| Kubo repository | `/var/lib/ipfs` | Not backed up: every blob is in Postgres and is re-pinned by the outbox (see below) |

## Database

Use pgBackRest (or WAL-G) with repository encryption, a repository off the database host, and retention matching the
documented data-retention policy (launch gate: retention and GDPR basis):

```ini
# /etc/pgbackrest/pgbackrest.conf (sketch)
[global]
repo1-path=/var/lib/pgbackrest
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=<from the secrets manager, never in git>
repo1-retention-full=4
start-fast=y
[pine]
pg1-path=/var/lib/postgresql/16/main
```

`archive_mode = on`, `archive_command = 'pgbackrest --stanza=pine archive-push %p'`; weekly full, daily differential
(`pgbackrest --stanza=pine --type=full backup`). Alert when the last successful backup or archived WAL is older than 26 h.

## Restore test (quarterly, and after any change to the procedure)

1. Restore the latest backup to a scratch host (`pgbackrest --stanza=pine --delta restore`, optionally
   `--type=time --target=...`).
2. Recreate the roles if the cluster is new: `psql -f deploy/postgres/00-roles.sql` and set passwords (`\password`).
3. Run the migrations against it (`pine-migrate.service` or the two commands in deploy/README.md): they must report
   nothing pending.
4. Start an API on the scratch host against the restored database, **isolated from production's external accounts**.
   The copy holds live, single-use GitHub refresh tokens: a scratch API refreshing one with production credentials
   stores the rotated token only in the scratch database, production's next refresh then fails (`bad_refresh_token`)
   and the user's link is revoked. Likewise the pin outbox would push to production's pin targets. So the drill uses:
   - `PINE_ENVIRONMENT=staging` and its own `/etc/pine/*.env` (never production's files);
   - a **non-production GitHub App** (`PINE_GITHUB_CLIENT_ID`/`PINE_GITHUB_CLIENT_SECRET` of a drill app, its own
     webhook secret): any refresh attempt fails at GitHub instead of consuming a production token; do not use GitHub
     routes (repository browsing, linking) during the drill;
   - **scratch pin targets** (a throwaway Kubo on loopback, no pinning-service token or a separate test account);
   - the production token keys (from the secrets store) only to check that stored tokens still decrypt:
     `SELECT key_id, count(*) FROM github_tokens GROUP BY key_id;` must list only keys you hold;
   - its own RPC providers (read-only) and no public DNS name.
   Then `GET /readyz` is `ready` once a scratch indexer caught up (or `stale` with database and migrations `ok`), open a
   claim, and download a stored manifest from the scratch user-content listener. Destroy the scratch host and its copy of
   the data afterwards.
5. Record the date, the restore duration and the data-loss window in the operations log.

## After a restore

- Sessions restored from the backup may still be valid: delete them (`DELETE FROM sessions;`) so everyone signs in again.
- Re-pin everything (Kubo may have lost blocks): `UPDATE content_pins SET status = 'pending', kubo_done = false,
  service_done = false, next_attempt_at = now() WHERE status <> 'integrity_failed';` and watch the outbox drain.
- `pine_index` behind the chain catches up by itself; if the restore point is older than a known halt resolution,
  re-check docs/operations/indexer-halt.md.
