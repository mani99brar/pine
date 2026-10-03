# Deploying Pine

Assets for one Linux host (or a small fleet) running the API, the native indexer, PostgreSQL 16, Kubo and an edge
proxy. Production deployment happens only after every launch gate of `docs/operations/release-checklist.md`.

```
deploy/
  postgres/00-roles.sql            cluster roles pine_migrator, pine_api, pine_indexer, pine_readonly (no passwords)
  postgres/01-database.sql         the database, owned by pine_migrator (psql -v pine_db=pine)
  env/api.env                      non-secret API configuration (production rules) -> /etc/pine/api.env
  env/api.secrets.env.example      API secrets, empty               -> /etc/pine/api.secrets.env (0640 root:pine-api)
  env/indexer.env, indexer.secrets.env.example, migrate.secrets.env.example
  systemd/pine-migrate.service     oneshot as user pine-migrate: API migrations, then pine_index's, as pine_migrator
  systemd/pine-api.service         as user pine-api: API + user-content server + private metrics + jobs
  systemd/pine-indexer-native.service  as user pine-indexer
  proxy/nginx-http.conf            http-context part of the nginx example (log format, GeoIP2, per-IP limit zones)
  proxy/nginx.conf, proxy/Caddyfile  edge proxy examples (TLS, same-origin API, user-content domain, per-IP limits)
  ipfs/README.md                   Kubo node and Pinning Service API setup
  procedures/backup.md             encrypted backups, PITR, quarterly restore test (SEC-OPS-11)
  procedures/key-rotation.md       rotation of every secret
```

`packages/api/test/e2e` executes `postgres/00-roles.sql` and `postgres/01-database.sql` on PostgreSQL 16 (one database per
test file), runs both migration commands as `pine_migrator`, connects the API as `pine_api`, the indexer as
`pine_indexer` and the read model as `pine_readonly`, and checks the grants. `deploy-assets.test.ts` loads `env/*.env`
plus filled secret templates through the real configuration loaders under production rules and checks the systemd units
(paths, one OS user per unit, secret-file modes agreeing with this README and the env headers), the proxy examples'
properties and the CI workflow. The proxy examples are checked statically only (no nginx or caddy in CI): run
`nginx -t` / `caddy validate` on the proxy host.

## 1. Host

- Node 24 at `/usr/bin/node` (the units call it directly; adjust `ExecStart` if Node lives elsewhere), corepack with
  pnpm 12.8.1, PostgreSQL 16, Kubo, nginx (or Caddy).
- One system user per unit, without a login shell (SEC-OPS-10: a compromised indexer cannot read the API's secrets, and
  neither runtime can read the migrator's DDL credentials):
  ```sh
  for user in pine-api pine-indexer pine-migrate; do useradd --system --home /nonexistent --no-create-home --shell /usr/sbin/nologin "$user"; done
  ```
- The release in `/opt/pine/releases/<git sha>`, symlinked as `/opt/pine/current`, owned by root and world-readable (it
  holds no secrets; the service users only read it):
  ```sh
  git clone --depth 1 --branch <release tag> <repo> /opt/pine/releases/<sha>
  cd /opt/pine/releases/<sha> && corepack enable && pnpm install --frozen-lockfile
  ln -sfn /opt/pine/releases/<sha> /opt/pine/current
  ```
  The services run the TypeScript sources through `tsx` (a dependency of `@pine/api` and `@pine/indexer-native`).

## 2. PostgreSQL

```sh
psql "$ADMIN_URL" -f deploy/postgres/00-roles.sql
psql "$ADMIN_URL" -v pine_db=pine -f deploy/postgres/01-database.sql
psql "$ADMIN_URL" -c '\password pine_migrator'    # and pine_api, pine_indexer, pine_readonly
```

Require TLS for these roles in `pg_hba.conf` (`hostssl pine pine_api 10.0.0.0/8 scram-sha-256`, ...) and use
`sslmode=verify-full` in every URL. The API connects as `pine_api` (DML only, INSERT/SELECT on `audit_log`, SELECT on the
ledger), the indexer as `pine_indexer` (DML on `pine_index` only), the API read model as `pine_readonly` (SELECT on
`pine_index`, read-only transactions). Only `pine_migrator` owns objects.

## 3. Configuration

Each file is readable only by root and the user of the unit that reads it (`0640 root:<user>`); the API reads
`sanctions-denylist.json` at runtime, so it belongs to `pine-api` too.

```sh
install -d -m 0755 -o root -g root /etc/pine
install -m 0640 -o root -g pine-api deploy/env/api.env /etc/pine/api.env
install -m 0640 -o root -g pine-api deploy/env/api.secrets.env.example /etc/pine/api.secrets.env
install -m 0640 -o root -g pine-api /path/to/sanctions-denylist.json /etc/pine/sanctions-denylist.json
install -m 0640 -o root -g pine-indexer deploy/env/indexer.env /etc/pine/indexer.env
install -m 0640 -o root -g pine-indexer deploy/env/indexer.secrets.env.example /etc/pine/indexer.secrets.env
install -m 0640 -o root -g pine-migrate deploy/env/migrate.secrets.env.example /etc/pine/migrate.secrets.env
```

Fill every empty value; replace the placeholders (`app.pine.example`, `pine-usercontent.example`, contract addresses and
deployment block from the forge deployment record, the GitHub App client id, admin wallets, the terms digest). Every
variable is documented in `packages/api/.env.example` and `packages/indexer-native/README.md`; a wrong or missing value
stops the process with one JSON line naming the variable (never its value).

## 4. Services

```sh
install -m 0644 deploy/systemd/*.service /etc/systemd/system/ && systemctl daemon-reload
systemctl start pine-migrate.service            # prints the applied migration ids; fails on any error
systemctl enable --now pine-indexer-native.service pine-api.service
```

Every deploy: switch `/opt/pine/current`, then `systemctl start pine-migrate.service && systemctl restart
pine-indexer-native.service pine-api.service`. Both processes refuse to start while a migration is pending, modified or
unknown. The same commands without systemd (from the repository root):

```sh
PINE_MIGRATOR_DATABASE_URL=... pnpm --filter @pine/api migrate
MIGRATION_DATABASE_URL=...      pnpm --filter @pine/indexer-native migrate
pnpm --filter @pine/indexer-native start          # with /etc/pine/indexer*.env exported
pnpm --filter @pine/api start                     # with /etc/pine/api*.env exported
```

## 5. Edge proxy, Kubo, pinning

- nginx: two files, both included from the `http {}` block of `/etc/nginx/nginx.conf`, in this order (`log_format`,
  `geoip2` and the limit zones are http-context directives, which nginx refuses inside a `server {}` block):
  ```nginx
  http {
      # ...
      include /etc/nginx/pine/nginx-http.conf;   # deploy/proxy/nginx-http.conf: log format, GeoIP2, per-IP limit zones
      include /etc/nginx/pine/nginx.conf;        # deploy/proxy/nginx.conf: upstreams and the three servers
  }
  ```
  Then `nginx -t && systemctl reload nginx`.
- `deploy/proxy/nginx.conf` (reference): TLS, the web app and `/api` on one origin, the user-content server on its own
  registrable domain with per-IP limits and no cookies, `X-Forwarded-For` replaced (one hop: `PINE_TRUST_PROXY_HOPS=1`),
  the country header set from the proxy's GeoIP lookup (`PINE_COMPLIANCE_COUNTRY_HEADER=X-Pine-Country`), access logs
  without query strings. Metrics listeners stay private.
- `deploy/ipfs/README.md`: Kubo on loopback, the Pinning Service API token (pin-only).

## 6. Checks after a deploy

- `curl -fsS https://app.pine.example/readyz` -> `{"status":"ready",...}`; `curl -fsS http://127.0.0.1:9465/readyz` on the
  indexer host.
- `journalctl -u pine-api --since -5min` shows `api listening`, no `startup refused`.
- Alerts: see the release checklist; runbooks: `docs/operations/`.
- Backups and key rotation: `deploy/procedures/`.
