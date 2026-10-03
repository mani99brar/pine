# Key and secret rotation procedures

Every secret is in `/etc/pine/*.secrets.env` (or the secrets manager that renders them); a rotation is: create the new
secret at its issuer, deploy it (the file keeps mode `0640 root:<unit user>`: `pine-api`, `pine-indexer` or
`pine-migrate`, see `deploy/README.md` section 3), restart, verify, revoke the old one. Pine holds **no wallet keys**: the contracts have
no owner, admin or pause role, the API never signs, and the deployer is a hardware wallet used once (launch gate).
When to rotate (schedule, suspected compromise): docs/operations/key-rotation.md.

| Secret | Procedure |
|---|---|
| GitHub token encryption key | 1. `echo "k$(date +%Y%m):$(openssl rand -base64 32)"`. 2. Set it as `PINE_TOKEN_KEY_CURRENT`; append the old `<id>:<key>` to `PINE_TOKEN_KEYS_PREVIOUS`. 3. Restart `pine-api` (every instance). 4. The `gateways.github-token-reencrypt` job (hourly) re-encrypts stored tokens and logs `GitHub token re-encryption: N re-encrypted, M revoked (undecryptable), R remain under retired keys`. 5. Remove the old key from `PINE_TOKEN_KEYS_PREVIOUS` only when `R` is 0 (or `SELECT count(*) FROM github_tokens WHERE key_id <> '<new id>'` is 0), restart again. |
| GitHub App client secret | Generate a second secret in the GitHub App settings, deploy it as `PINE_GITHUB_CLIENT_SECRET`, restart, verify a GitHub link, delete the old secret in GitHub. |
| GitHub webhook secret | Set the new secret in the App settings and `PINE_GITHUB_WEBHOOK_SECRET` within the same window; deliveries signed with the old one are refused (401) and counted in `pine_github_webhook_rejected_total` until both match. |
| Database passwords | Per role (`pine_api`, `pine_indexer`, `pine_readonly`, `pine_migrator`): `ALTER ROLE <role> PASSWORD '<new>'` as a superuser (psql `\password <role>`), update the matching URL (`PINE_DATABASE_URL`, `DATABASE_URL`, `PINE_READ_MODEL_DATABASE_URL`, `PINE_MIGRATOR_DATABASE_URL`/`MIGRATION_DATABASE_URL`), restart the process that uses it. Existing connections keep working until restart. |
| RPC provider API keys | Create the new key at the provider, update `PINE_RPC_URL_PRIMARY`/`SECONDARY` and `RPC_PRIMARY_URL`/`SECONDARY`, restart API and indexer, revoke the old key. Keep the two providers independent. |
| Pinning service token | Create a new pin-only token, update `PINE_PINNING_SERVICE_TOKEN`, restart, check `content_pins` keeps draining, revoke the old token. |
| Envio Hasura secrets | The API should hold no admin secret (select-only role). If one is configured, rotate `HASURA_GRAPHQL_ADMIN_SECRET` and `PINE_ENVIO_ADMIN_SECRET` together. |
| Sessions | `POST /api/v1/auth/logout {"everywhere": true}` for one user; `DELETE FROM sessions;` logs everyone out (e.g. after a suspected session-store leak). |
| Admin wallets | Edit `PINE_ADMIN_WALLETS`, restart; admin rights are re-evaluated on every request, so a removed wallet loses them immediately after the restart. |
| Terms digest | Publishing new terms is a new `PINE_TERMS_DIGEST`; every user must accept again at the next sign-in (compliance answers `TERMS_REQUIRED` until then). |

After any rotation: `journalctl -u pine-api -u pine-indexer-native --since -10min` shows no startup refusal, `GET /readyz`
is `ready`, and the old secret no longer appears anywhere (`grep -r` over `/etc/pine` and the deployment tooling).
