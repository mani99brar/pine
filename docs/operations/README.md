# Operations

Runbooks for the Pine backend (API, native indexer, Postgres, Kubo and pinning). Deployment: `deploy/README.md`.
Security requirements: `docs/security/requirements.md`; decisions and launch gates: `docs/adr/ADR-0001-architecture.md`.

| Runbook | When |
|---|---|
| [indexer-halt.md](indexer-halt.md) | `pine_indexer_halted` = 1, API `/readyz` reports `readModel: "halted"`, plans answer `NOT_READY` |
| [rpc-disagreement.md](rpc-disagreement.md) | a halt with reason `rpc_disagreement`, `log_disagreement`, `header_disagreement`, `finalized_conflict` or `invalid_rpc_data`; RPC errors in the API |
| [pin-failures.md](pin-failures.md) | `pine_content_pin_failed_total` grows, `content_pins` stays `pending`, any `integrity_failed` row |
| [stuck-oracle-steps.md](stuck-oracle-steps.md) | a claim is past its reveal deadline and nobody answers, finalizes, resolves or relays arbitration (due actions) |
| [key-rotation.md](key-rotation.md) | scheduled rotation, staff change, suspected exposure of any secret |
| [incident-response.md](incident-response.md) | any security incident or suspected compromise |
| [evidence-takedown.md](evidence-takedown.md) | a takedown or legal request for a claim, evidence or content (SEC-EVID-12) |
| [release-checklist.md](release-checklist.md) | before the first production release and every release that touches a launch gate |

## Standing facts

- **Pine executes no submitted code in v1.** Evidence, artifacts and repositories are opaque, untrusted bytes: never
  extracted, rendered, run or fetched from a user-supplied URL. Reproducing a counterexample is done by people outside
  Pine, in their own isolated environment. No runbook may "just run the PoC" on Pine infrastructure.
- **Pine holds no wallet keys and never signs.** Every on-chain action is a transaction plan the user's wallet sends.
  The contracts have no owner, admin or pause; there is no emergency stop on chain, only off-chain moderation (hide or
  block) and refusing to build plans.
- **Staging runs on an anvil fork of Gnosis with throwaway keys only.** A fork that keeps chain id 100 accepts the same
  signatures as Gnosis: anything a real key signs on staging could be replayed on mainnet. Testers use freshly generated
  keys with no mainnet funds, and staging never shares secrets with production.
- Health: API `GET /healthz` (alive) and `GET /readyz` (database, migrations, read model fresh and not halted; cached
  5 s). Indexer `http://127.0.0.1:9465/healthz` and `/readyz`. Metrics on the private listeners (`:9464` API, `:9465`
  indexer).
- Logs never contain query strings, cookies, authorization headers, RPC URLs or secrets; error strings are redacted
  before they are logged, stored or returned. Do not paste raw provider dashboards or env files into tickets.
- Owner and on-call: named in the release checklist (launch gate). Every runbook action that changes data is recorded
  in the operations log with who, when, why.
