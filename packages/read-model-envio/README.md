# @pine/read-model-envio

`ReadModel` (`packages/shared/src/read-model.ts`) over the Hasura GraphQL API of the `@pine/indexer-envio` deployment
(PRD-05 section 3.2).

```ts
import { createEnvioReadModel } from "@pine/read-model-envio";

const readModel = createEnvioReadModel({ graphqlUrl }); // chainId 100, 10 s timeout, 8 MiB body cap by default
```

## Configuration rules (PRD-05 section 3a, fail closed with `EnvioReadModelError` code `configuration`)

- `graphqlUrl` must be an `http:` or `https:` URL **without userinfo** (`user:password@` or `user@` is refused; put
  credentials in `adminSecret`, which travels as a header). The URL is never echoed in an error.
- `adminSecret` requires an `https:` URL. `allowInsecureTransport: true` lifts that rule; it exists for in-process tests
  only and is never derived from `NODE_ENV`, `VITEST` or any other environment variable (the package reads no
  environment at all). Without an admin secret, `http:` is accepted (e.g. a private-network endpoint).

## Hasura access for the API (read-only role)

The API must not hold the Hasura admin secret: the admin role can run mutations and metadata changes. Give the API a
select-only role instead (least privilege, SEC-IDX-11 "the API has SELECT only"):

1. In the Envio deployment's Hasura, define a role (e.g. `pine_api_readonly`) with **select** permission on `Claim`,
   `EvidenceSubmission`, `OracleQuestion`, `OracleAnswer`, `Arbitration`, `ArbitrationStage`, `ConditionResolution`,
   `IndexerProgress` and Envio's `_meta`/`chain_metadata`, all columns, no row filter, and **no insert, update or delete
   permission** anywhere. Its row limit must be unset or at least 10,001: a smaller Hasura permission limit silently
   clamps results, which would defeat the 10,000-row check below and truncate pages.
2. Make it the role the API's requests get without an admin secret (Hasura `HASURA_GRAPHQL_UNAUTHORIZED_ROLE`, or a
   JWT/webhook mode that resolves to it), keep the endpoint on a private network, and call
   `createEnvioReadModel({ graphqlUrl })` without `adminSecret`.
3. The admin secret stays with operators (migrations, metadata, `test:live` if the endpoint requires it), over https.

This role setup is documented, not verified here: there is no Hasura in the tests. Checking it (a mutation as the API
role fails, every read-model query succeeds) is part of the Envio launch gate together with `test:live`.

- Queries (`src/queries.ts`): `<Entity>_by_pk`, `<Entity>(where, order_by, limit)` with every value passed as a GraphQL
  variable; numerics as decimal strings. Lists page by keyset (`limit + 1` rows to detect a next page) with opaque
  base64url cursors bound to their order (`src/cursor.ts`); a foreign or tampered cursor throws `InvalidCursorError`.
  `evidence_deadline_asc` breaks ties on the market id, which Postgres orders like the reference because ids are
  fixed-length lowercase hex.
- Responses (`src/responses.ts`): zod-validated; numerics must be decimal strings (Hasura stringified numerics) or
  safe-integer JSON numbers; addresses and hashes must be lowercase hex; anything else is rejected.
- Network: one POST to the configured URL only, `redirect: "error"`, a 10 s timeout that also covers reading the body,
  and the body read as a stream under an 8 MiB **byte** cap (the stream is cancelled as soon as it exceeds the cap, so a
  misbehaving endpoint cannot force unbounded buffering; non-2xx bodies are cancelled unread).
- Lists returned whole (`listClaimsByQuestion`, `listOracleAnswers`, the arbitration history of `getArbitration`) send an
  explicit `limit` of 10,001 and throw `EnvioReadModelError` code `too_many_rows` when more than 10,000 rows come back.
  **Documented divergence from the native backend**, which has no cap: on a question with more than 10,000 answers (or
  claims, or arbitration stages) Envio fails where native answers. No frozen scenario reaches the cap; the behaviour is
  pinned by unit tests in `test/read-model.test.ts`. The byte cap applies too: 10,000 claim rows (~9 MB) exceed the
  default 8 MiB, so such a list fails with `too_large` first. Either way the result is an error, never a truncated list.
- Errors (`EnvioReadModelError`, `src/errors.ts`) carry a code (`configuration`, `network`, `timeout`, `http`,
  `too_large`, `too_many_rows`, `invalid_json`, `graphql`, `invalid_response`), the operation name and safe details (HTTP
  status, error count, failing field path, the cap). They never contain the URL (which may embed credentials), the admin secret, response bodies,
  GraphQL error texts or underlying fetch/zod messages, and never chain a `cause`.
- `status()`: `indexedBlock` from Envio `_meta.progressBlock` (at least the last applied event block),
  `indexedBlockTimestamp` from the `IndexerProgress` singleton the handlers write (the timestamp of the last block that
  carried an event, never newer than the indexed block, so freshness is not overstated), `headBlock` from
  `_meta.sourceBlock`, `finalizedBlock: null`, `halted: false`. The `_meta` field names live only in `src/envio-meta.ts`
  and are **unverified until the live gate**.

## Tests

- `pnpm --filter @pine/read-model-envio test`: the frozen conformance suite (`describeReadModelConformance("envio")`)
  against an in-test Hasura fake (`test/fake-hasura.ts`) that serves the committed entity snapshots produced by the real
  indexer-envio handlers (`test/fixtures/*.entities.json`, bound to the SHA-256 of the scenario's events; the factory
  throws if they differ). The fake's Hasura semantics are tested in `test/fake-hasura.test.ts`; query construction,
  validation failures, cursors, configuration rules, the streamed byte cap, timeouts, the 10,000-row cap and redaction
  in `test/read-model.test.ts`; every row kind's validation (uppercase, non-hex, unsafe, negative, unknown enum, wrong
  type, missing field), forged cursors of every scope, `status()` metadata validation, option and input validation,
  redaction of every error code and the default `globalThis.fetch` path in `test/validation.test.ts`; the queried field
  names against
  `packages/indexer-envio/schema.graphql` in `test/queries.test.ts`.
- `pnpm --filter @pine/read-model-envio test:live` (not part of `test`): smoke checks against a real deployment, given
  `ENVIO_GRAPHQL_URL` (and optionally `ENVIO_GRAPHQL_ADMIN_SECRET`, `ENVIO_CHAIN_ID`). A real deployment never indexed
  the frozen scenarios, so this cannot run the differential suite. It checks that every query the read model issues
  succeeds, that responses validate, that `status()` parses (verifying `src/envio-meta.ts`), and that pagination returns
  ordered, non-overlapping pages. Passing it against the real deployment is a launch gate for choosing the Envio option.
  `test/live-script.test.ts` (part of `test`) runs this exact script in a child process against the fake served over HTTP
  on 127.0.0.1: it passes for every committed snapshot, fails against an endpoint answering GraphQL errors, and refuses
  to run without `ENVIO_GRAPHQL_URL`. That proves the script, not the real deployment's metadata names.
