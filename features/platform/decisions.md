# Decisions: platform

Settled by the operator from ADR-0001 (docs/adr/ADR-0001-architecture.md) and the security requirements on 2026-10-02.

## Decisions

- SIWE is EOA-only with server-issued byte-identical messages, `crypto.randomBytes(16)` nonces bound to a pre-session and local signature recovery: smart-contract wallets cannot log in (deferred), and the auth path makes no RPC call.
- Sessions: opaque `pine_s1_` tokens stored as SHA-256 in a `__Host-pine_session` cookie (Secure, HttpOnly, SameSite=Lax, Path=/), idle 24 h, absolute 7 days, rotated on login and GitHub link; admin = configured wallet allowlist re-checked per request plus a signature younger than 300 s.
- CSRF for every unsafe method: exact Origin, `Sec-Fetch-Site` not cross-site, header `x-pine-csrf: 1`, JSON content type (multipart only on flagged routes); the GitHub webhook is the only exempt route.
- GitHub: GitHub App with zero permissions by default, OAuth App with no scopes as configured fallback; PKCE S256; one GitHub id per user; tokens AES-256-GCM encrypted with key rotation; core reads identities only through `GitHubAuthFlow.identityOf`.
- Content: Postgres `bytea` is the source of truth for objects ≤ 262144 bytes; pins go through an outbox to Kubo and a Pinning Service API provider; user content is served only by the separate content server on a different registrable domain.
- Chain gateway: two RPC providers; `finalizedBlock()` requires both to agree on the hash at the finalized number.
- Runtime uses `node --import tsx` (pinned); migrations run only via `src/migrate.ts` with a separate migrator URL; the API verifies migrations at startup and refuses to start otherwise.

## Assumptions

- The API is served same-origin with the web app under `/api` in production (`apiOrigin === publicOrigin`).
- A trusted reverse proxy provides the client IP and the geofence country header only when `trustProxy` hops are configured; otherwise both are ignored (and production compliance for publish/fund fails closed when the country is required).
- Rate-limit and quota windows are fixed windows in Postgres; precision of a few seconds is acceptable.

## Deferred

- The read-model wiring in `src/readmodel.ts`, the full composition end-to-end test and deployment manifests (feature `assembly`).
- Email notifications, smart-contract-wallet login, a hosted sanctions-screening provider (v1 uses a static denylist; provider choice is a launch gate).
