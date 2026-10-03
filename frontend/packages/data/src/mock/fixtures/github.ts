import type { CommitSummary, GitHubUser, PullState, PullSummary, RepoSummary } from '@pine/core'
import { DEMO_GITHUB_USER } from '../../demo'
import { fakeSha, hoursFromNow } from '../../internal/util'

// ---------------------------------------------------------------------------
// Users (humans and agent bots)
// ---------------------------------------------------------------------------

const human = (login: string, id: number, name: string): GitHubUser => ({
  login,
  id,
  name,
  avatarUrl: `https://avatars.githubusercontent.com/u/${id}?v=4`,
  htmlUrl: `https://github.com/${login}`,
})

const bot = (login: string, id: number, app: string, appId: number): GitHubUser => ({
  login,
  id,
  name: null,
  avatarUrl: `https://avatars.githubusercontent.com/in/${appId}?v=4`,
  htmlUrl: `https://github.com/apps/${app}`,
})

export const users: Record<string, GitHubUser> = {
  'mara-okafor': DEMO_GITHUB_USER,
  'tomas-reyes': human('tomas-reyes', 31877412, 'Tomás Reyes'),
  'priya-natarajan': human('priya-natarajan', 22910455, 'Priya Natarajan'),
  'jonas-weber': human('jonas-weber', 15520981, 'Jonas Weber'),
  'akosua-mensah': human('akosua-mensah', 60411823, 'Akosua Mensah'),
  'li-wei-dev': human('li-wei-dev', 38820194, 'Li Wei'),
  'sofia-marchetti': human('sofia-marchetti', 27719306, 'Sofia Marchetti'),
  'diego-alvarez': human('diego-alvarez', 44102877, 'Diego Álvarez'),
  'hana-kobayashi': human('hana-kobayashi', 51983020, 'Hana Kobayashi'),
  'ines-duarte': human('ines-duarte', 66019432, 'Inês Duarte'),
  'devin-ai-integration[bot]': bot('devin-ai-integration[bot]', 158243242, 'devin-ai-integration', 811515),
  'copilot-swe-agent[bot]': bot('copilot-swe-agent[bot]', 198982749, 'copilot-swe-agent', 1143301),
  'claude[bot]': bot('claude[bot]', 209825114, 'claude', 1236702),
  'lumen-patchbot[bot]': bot('lumen-patchbot[bot]', 170044551, 'lumen-patchbot', 902114),
}

function u(login: string): GitHubUser {
  const found = users[login]
  if (!found) throw new Error(`fixture user missing: ${login}`)
  return found
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

type FileSeed = [filename: string, status: 'added' | 'modified' | 'removed' | 'renamed', additions: number, deletions: number]

interface CommitSeed {
  msg: string
  by: string
  h: number
  files: FileSeed[]
}

interface PullSeed {
  number: number
  title: string
  state: PullState
  draft?: boolean
  by: string
  createdH: number
  updatedH: number
  labels: string[]
  body: string
  headRef: string
  commits: CommitSeed[]
  /** index into the repo's default-branch history used as the base commit (default: last) */
  baseIndex?: number
}

interface RepoSeed {
  id: number
  owner: string
  name: string
  description: string | null
  private?: boolean
  defaultBranch?: string
  language: string | null
  stars: number
  forks: number
  license: string | null
  topics: string[]
  updatedH: number
  history: CommitSeed[]
  pulls: PullSeed[]
}

const REPO_SEEDS: RepoSeed[] = [
  {
    id: 812004417,
    owner: 'kleros',
    name: 'gateway-balancer-bot',
    description:
      'Keeper that rebalances Kleros gateway funds across chains, keeping arbitration allocations, reporter deposits and operator gas in separate accounting categories.',
    language: 'TypeScript',
    stars: 38,
    forks: 9,
    license: 'MIT',
    topics: ['keeper', 'gnosis', 'arbitrum', 'bridging', 'accounting'],
    updatedH: -4,
    history: [
      { msg: 'chore: scaffold keeper with pnpm workspaces and vitest', by: 'tomas-reyes', h: -960, files: [['package.json', 'added', 42, 0], ['pnpm-lock.yaml', 'added', 2114, 0], ['src/index.ts', 'added', 31, 0], ['vitest.config.ts', 'added', 12, 0]] },
      { msg: 'feat(journal): append-only operation journal with crash recovery', by: 'tomas-reyes', h: -770, files: [['src/journal/journal.ts', 'added', 188, 0], ['src/journal/recover.ts', 'added', 97, 0], ['test/journal.spec.ts', 'added', 143, 0]] },
      { msg: 'feat(accounting): category ledger for arbitration, bridging and operator gas', by: 'mara-okafor', h: -580, files: [['src/accounting/ledger.ts', 'added', 236, 0], ['src/accounting/categories.ts', 'added', 54, 0], ['test/ledger.spec.ts', 'added', 167, 0]] },
      { msg: 'docs: link gateway-balancer-bot-spec v0.4 sections 2.2 and 4.2', by: 'mara-okafor', h: -480, files: [['README.md', 'modified', 38, 6], ['docs/accounting.md', 'added', 91, 0]] },
      { msg: 'feat(bridge): LI.FI quote adapter behind a simulation flag (#44)', by: 'akosua-mensah', h: -330, files: [['src/bridge/lifi.ts', 'added', 164, 0], ['src/bridge/simulated.ts', 'added', 77, 0], ['src/config.ts', 'modified', 18, 2]] },
      { msg: 'test: accounting separation scenarios from spec §12 tests 3 and 7', by: 'mara-okafor', h: -214, files: [['test/accounting-separation.spec.ts', 'added', 208, 0], ['test/fixtures/journal-states.ts', 'added', 119, 0]] },
    ],
    pulls: [
      {
        number: 47,
        title: 'feat(funding): reporter top-up planner with category reservations',
        state: 'open',
        by: 'tomas-reyes',
        createdH: -96,
        updatedH: -50,
        labels: ['accounting', 'needs-verification', 'keeper'],
        headRef: 'feat/reporter-topup-planner',
        body:
          'Implements reporter funding from spec §4.2.\n\n' +
          '- Reporter top-ups are planned only from eligible bridging-fee allocations.\n' +
          '- Operator gas is reserved separately; the gas fee of the top-up transaction itself may be paid from the operator reserve.\n' +
          '- If no eligible bridging funds exist, the planner skips the top-up and emits `reporter.underfunded` instead of borrowing.\n\n' +
          'Covers spec §12 tests 3 and 7. We plan to publish a BOT-001 claim on the head commit before merging.',
        commits: [
          { msg: 'feat(funding): plan reporter top-ups from eligible bridging-fee allocations', by: 'tomas-reyes', h: -96, files: [['src/funding/reporter-planner.ts', 'added', 214, 0], ['src/accounting/reservations.ts', 'modified', 88, 12]] },
          { msg: 'feat(funding): reserve operator gas separately from deposit principal', by: 'tomas-reyes', h: -80, files: [['src/accounting/gas-reserve.ts', 'modified', 61, 7], ['src/funding/reporter-planner.ts', 'modified', 23, 9]] },
          { msg: 'test(funding): reporter below threshold with no eligible bridging funds', by: 'mara-okafor', h: -71, files: [['test/reporter-funding.spec.ts', 'added', 176, 0], ['test/fixtures/journal-states.ts', 'modified', 34, 2]] },
          { msg: 'fix(funding): skip top-up instead of borrowing from the arbitration allocation', by: 'tomas-reyes', h: -52, files: [['src/funding/reporter-planner.ts', 'modified', 14, 31], ['test/reporter-funding.spec.ts', 'modified', 42, 3]] },
        ],
      },
      {
        number: 52,
        title: 'fix(recovery): resume bridge-then-swap operations without re-bridging',
        state: 'open',
        by: 'claude[bot]',
        createdH: -30,
        updatedH: -6,
        labels: ['recovery', 'agent-authored', 'keeper'],
        headRef: 'claude/resume-without-rebridge',
        body:
          'When the keeper crashes after a bridge receipt is journaled but before the destination swap settles, ' +
          'recovery now resumes the swap leg for the same operation id instead of planning a new bridge.\n\n' +
          'Opened by an agent at the request of @mara-okafor. Human review required before merge.',
        commits: [
          { msg: 'fix(recovery): resume swap leg from journaled bridge receipt', by: 'claude[bot]', h: -30, files: [['src/journal/recover.ts', 'modified', 72, 18], ['src/bridge/operation.ts', 'modified', 29, 4]] },
          { msg: 'test(recovery): crash after bridge receipt, before swap settlement', by: 'claude[bot]', h: -9, files: [['test/recovery.spec.ts', 'added', 131, 0]] },
        ],
      },
      {
        number: 44,
        title: 'feat(bridge): LI.FI quote adapter behind a simulation flag',
        state: 'merged',
        by: 'akosua-mensah',
        createdH: -390,
        updatedH: -330,
        labels: ['bridge'],
        headRef: 'feat/lifi-adapter',
        baseIndex: 3,
        body: 'Adds a quote adapter for LI.FI routes. Real execution stays disabled; `BRIDGE_ADAPTER=simulated` is the default for tests.',
        commits: [
          { msg: 'feat(bridge): LI.FI quote adapter behind a simulation flag', by: 'akosua-mensah', h: -390, files: [['src/bridge/lifi.ts', 'added', 164, 0], ['src/bridge/simulated.ts', 'added', 77, 0], ['src/config.ts', 'modified', 18, 2]] },
        ],
      },
    ],
  },
  {
    id: 402118876,
    owner: 'acme-labs',
    name: 'fastparse',
    description: 'Zero-dependency JSON/JSON5 parser with a strict mode for config files and wire formats.',
    language: 'TypeScript',
    stars: 1840,
    forks: 112,
    license: 'MIT',
    topics: ['parser', 'json', 'json5', 'typescript'],
    updatedH: -2,
    history: [
      { msg: 'feat: JSON5 tokenizer with source positions', by: 'li-wei-dev', h: -1900, files: [['src/tokenizer.ts', 'added', 402, 0], ['test/tokenizer.test.ts', 'added', 288, 0]] },
      { msg: 'feat(strict): strict mode option for RFC 8259 inputs', by: 'li-wei-dev', h: -1400, files: [['src/parse.ts', 'modified', 96, 14], ['src/options.ts', 'added', 41, 0]] },
      { msg: 'fix: surrogate pairs in escaped strings', by: 'hana-kobayashi', h: -1010, files: [['src/strings.ts', 'modified', 22, 9], ['test/strings.test.ts', 'modified', 37, 0]] },
      { msg: 'strict: reject leading zeros in numeric literals (#212)', by: 'li-wei-dev', h: -760, files: [['src/numbers.ts', 'modified', 31, 6], ['test/strict-numbers.test.ts', 'added', 88, 0]] },
      { msg: 'strict: reject "-00" prefixes found by PINE-0002 (#219)', by: 'li-wei-dev', h: -410, files: [['src/numbers.ts', 'modified', 12, 3], ['test/strict-numbers.test.ts', 'modified', 19, 0]] },
      { msg: 'chore: release 3.4.0', by: 'hana-kobayashi', h: -120, files: [['package.json', 'modified', 1, 1], ['CHANGELOG.md', 'modified', 14, 0]] },
    ],
    pulls: [
      {
        number: 231,
        title: 'strict: reject duplicate object keys at any nesting depth',
        state: 'open',
        by: 'devin-ai-integration[bot]',
        createdH: -60,
        updatedH: -2,
        labels: ['strict-mode', 'agent-authored'],
        headRef: 'devin/strict-duplicate-keys',
        body:
          'Strict mode previously only rejected duplicate keys at the top level. This tracks a key set per object frame so duplicates are rejected at any depth.\n\n' +
          '> Generated by Devin. Requested by @hana-kobayashi.',
        commits: [
          { msg: 'strict: track key sets per object frame', by: 'devin-ai-integration[bot]', h: -60, files: [['src/parse.ts', 'modified', 47, 11], ['src/frames.ts', 'added', 38, 0]] },
          { msg: 'test(strict): nested duplicate keys, escaped key equivalence', by: 'devin-ai-integration[bot]', h: -58, files: [['test/strict-duplicates.test.ts', 'added', 112, 0]] },
          { msg: 'strict: compare keys after escape decoding', by: 'devin-ai-integration[bot]', h: -40, files: [['src/parse.ts', 'modified', 9, 3], ['test/strict-duplicates.test.ts', 'modified', 21, 0]] },
        ],
      },
      {
        number: 212,
        title: 'strict: reject leading zeros in numeric literals',
        state: 'merged',
        by: 'li-wei-dev',
        createdH: -790,
        updatedH: -760,
        labels: ['strict-mode', 'bug'],
        headRef: 'fix/strict-leading-zeros',
        baseIndex: 2,
        body: 'Closes #208. In strict mode, `01` and `-01` are rejected per RFC 8259 §6.',
        commits: [
          { msg: 'strict: reject leading zeros in integer part', by: 'li-wei-dev', h: -790, files: [['src/numbers.ts', 'modified', 31, 6], ['test/strict-numbers.test.ts', 'added', 88, 0]] },
        ],
      },
      {
        number: 229,
        title: 'perf: avoid re-scanning whitespace in the tokenizer',
        state: 'open',
        draft: true,
        by: 'hana-kobayashi',
        createdH: -140,
        updatedH: -100,
        labels: ['performance'],
        headRef: 'perf/whitespace-scan',
        body: 'Work in progress. Benchmarks in `bench/` show 7–11% faster tokenizing on large configs.',
        commits: [
          { msg: 'perf: single-pass whitespace skipping', by: 'hana-kobayashi', h: -140, files: [['src/tokenizer.ts', 'modified', 28, 19], ['bench/tokenize.bench.ts', 'added', 44, 0]] },
        ],
      },
    ],
  },
  {
    id: 559201733,
    owner: 'northwind',
    name: 'auth-gateway',
    description: 'Multi-tenant authorization gateway: OAuth sessions, document ACLs and export jobs.',
    language: 'Go',
    stars: 412,
    forks: 37,
    license: 'Apache-2.0',
    topics: ['authorization', 'multi-tenant', 'oauth', 'go'],
    updatedH: -11,
    history: [
      { msg: 'feat(acl): per-document owner and share lists', by: 'sofia-marchetti', h: -2200, files: [['internal/acl/acl.go', 'added', 211, 0], ['internal/acl/acl_test.go', 'added', 164, 0]] },
      { msg: 'feat(export): async export jobs for documents', by: 'ines-duarte', h: -1500, files: [['internal/export/jobs.go', 'added', 287, 0], ['api/v2/export.go', 'added', 96, 0]] },
      { msg: 'feat(search): full-text search over documents', by: 'ines-duarte', h: -900, files: [['internal/search/index.go', 'added', 340, 0], ['api/v2/search.go', 'added', 88, 0]] },
      { msg: 'fix(session): rotate refresh tokens on reuse detection', by: 'sofia-marchetti', h: -520, files: [['internal/session/refresh.go', 'modified', 44, 12]] },
      { msg: 'chore(deps): bump golang.org/x/net to 0.38.0', by: 'ines-duarte', h: -300, files: [['go.mod', 'modified', 1, 1], ['go.sum', 'modified', 2, 2]] },
    ],
    pulls: [
      {
        number: 388,
        title: 'authz: enforce owner check on document export jobs',
        state: 'open',
        by: 'sofia-marchetti',
        createdH: -640,
        updatedH: -540,
        labels: ['security', 'authz', 'needs-verification'],
        headRef: 'fix/export-owner-check',
        body:
          'Export jobs were authorized at job creation only. This re-checks document ACLs when the job runs and when the export artifact is downloaded.\n\n' +
          'Named operations in scope: `GET /v2/documents/{id}`, `POST /v2/exports`, `GET /v2/exports/{jobId}/download`.',
        commits: [
          { msg: 'authz: re-check ACL when export job executes', by: 'sofia-marchetti', h: -640, files: [['internal/export/jobs.go', 'modified', 38, 9], ['internal/acl/acl.go', 'modified', 12, 2]] },
          { msg: 'authz: check ACL on export download', by: 'sofia-marchetti', h: -610, files: [['api/v2/export.go', 'modified', 27, 4]] },
          { msg: 'test: cross-tenant and revoked-share export scenarios', by: 'ines-duarte', h: -560, files: [['internal/export/jobs_test.go', 'added', 196, 0]] },
        ],
      },
      {
        number: 402,
        title: "search: scope full-text results to the caller's tenant",
        state: 'open',
        by: 'devin-ai-integration[bot]',
        createdH: -70,
        updatedH: -11,
        labels: ['authz', 'agent-authored', 'search'],
        headRef: 'devin/search-tenant-scope',
        body:
          'Adds a mandatory tenant filter to every search query plan and removes the legacy `scope=all` parameter for non-admin callers.\n\n> Generated by Devin. Reviewed by @ines-duarte.',
        commits: [
          { msg: 'search: inject tenant filter into query planner', by: 'devin-ai-integration[bot]', h: -70, files: [['internal/search/planner.go', 'modified', 54, 8], ['internal/search/index.go', 'modified', 11, 3]] },
          { msg: 'search: drop scope=all for non-admin callers', by: 'devin-ai-integration[bot]', h: -66, files: [['api/v2/search.go', 'modified', 19, 22]] },
          { msg: 'test(search): tenant isolation table tests', by: 'devin-ai-integration[bot]', h: -48, files: [['internal/search/planner_test.go', 'added', 141, 0]] },
        ],
      },
    ],
  },
  {
    id: 671330928,
    owner: 'tidewater',
    name: 'payroll-scheduler',
    description: 'Turns approved payroll batches into bank and on-chain payouts with a durable run journal.',
    language: 'Python',
    stars: 96,
    forks: 11,
    license: 'BSD-3-Clause',
    topics: ['payroll', 'scheduler', 'idempotency', 'automation'],
    updatedH: -20,
    history: [
      { msg: 'feat: run journal backed by SQLite WAL', by: 'jonas-weber', h: -1300, files: [['scheduler/journal.py', 'added', 230, 0], ['tests/test_journal.py', 'added', 140, 0]] },
      { msg: 'feat: dispatcher for bank and on-chain payout adapters', by: 'jonas-weber', h: -980, files: [['scheduler/dispatch.py', 'added', 199, 0], ['scheduler/adapters/onchain.py', 'added', 121, 0]] },
      { msg: 'fix: retry backoff caps at 15 minutes', by: 'diego-alvarez', h: -610, files: [['scheduler/retry.py', 'modified', 9, 4]] },
      { msg: 'docs: operator runbook for crash recovery', by: 'jonas-weber', h: -400, files: [['docs/recovery.md', 'added', 77, 0]] },
    ],
    pulls: [
      {
        number: 91,
        title: 'crash-safe dispatch with idempotency keys',
        state: 'open',
        by: 'jonas-weber',
        createdH: -260,
        updatedH: -170,
        labels: ['reliability', 'needs-verification'],
        headRef: 'feat/idempotent-dispatch',
        body:
          'Each payout gets an idempotency key derived from (batch id, employee id, period). The journal records `intent` before dispatch and `sent` after the adapter acknowledges. Recovery re-sends only intents without a matching adapter receipt.',
        commits: [
          { msg: 'journal: intent/sent records with idempotency keys', by: 'jonas-weber', h: -260, files: [['scheduler/journal.py', 'modified', 66, 14]] },
          { msg: 'dispatch: consult adapter receipts during recovery', by: 'jonas-weber', h: -240, files: [['scheduler/dispatch.py', 'modified', 58, 21], ['scheduler/recover.py', 'added', 84, 0]] },
          { msg: 'tests: kill -9 between journal write and dispatch', by: 'diego-alvarez', h: -190, files: [['tests/test_crash_recovery.py', 'added', 173, 0]] },
        ],
      },
      {
        number: 97,
        title: 'payouts: enforce recipient allowlist and per-run cap',
        state: 'open',
        by: 'copilot-swe-agent[bot]',
        createdH: -50,
        updatedH: -26,
        labels: ['limits', 'agent-authored'],
        headRef: 'copilot/recipient-allowlist',
        body:
          'Adds `PAYOUT_ALLOWLIST_PATH` and `MAX_RUN_TOTAL` checks before any adapter call. Payouts to recipients not on the allowlist are rejected and journaled as `blocked`.\n\nCo-authored with @jonas-weber.',
        commits: [
          { msg: 'payouts: allowlist and per-run cap checks before dispatch', by: 'copilot-swe-agent[bot]', h: -50, files: [['scheduler/limits.py', 'added', 92, 0], ['scheduler/dispatch.py', 'modified', 17, 3]] },
          { msg: 'tests: blocked recipients and cap boundary', by: 'copilot-swe-agent[bot]', h: -44, files: [['tests/test_limits.py', 'added', 128, 0]] },
        ],
      },
    ],
  },
  {
    id: 671331540,
    owner: 'tidewater',
    name: 'ledger-sync',
    description: 'Syncs internal ledger FX rates from multiple price feeds with staleness and disagreement guards.',
    language: 'TypeScript',
    stars: 54,
    forks: 6,
    license: 'MIT',
    topics: ['fx', 'price-feeds', 'keeper'],
    updatedH: -30,
    history: [
      { msg: 'feat: poll Chainlink and Pyth adapters for EUR/USD and GBP/USD', by: 'diego-alvarez', h: -1100, files: [['src/feeds/chainlink.ts', 'added', 88, 0], ['src/feeds/pyth.ts', 'added', 93, 0]] },
      { msg: 'feat: write rate updates to the ledger API', by: 'diego-alvarez', h: -700, files: [['src/ledger.ts', 'added', 74, 0]] },
      { msg: 'chore: pin node 22 and pnpm 10', by: 'jonas-weber', h: -500, files: [['package.json', 'modified', 3, 1], ['.nvmrc', 'added', 1, 0]] },
    ],
    pulls: [
      {
        number: 29,
        title: 'rates: refuse updates on stale or disagreeing observations',
        state: 'open',
        by: 'diego-alvarez',
        createdH: -100,
        updatedH: -30,
        labels: ['keeper', 'needs-verification'],
        headRef: 'feat/stale-guard',
        body: 'A rate update requires ≥2 observations younger than `MAX_AGE_SECONDS` that agree within `MAX_DEVIATION_BPS`. Otherwise the previous rate stays and an alert is raised.',
        commits: [
          { msg: 'rates: freshness and quorum guard', by: 'diego-alvarez', h: -100, files: [['src/guard.ts', 'added', 81, 0], ['src/sync.ts', 'modified', 22, 9]] },
          { msg: 'test: stale, missing and disagreeing feed matrix', by: 'diego-alvarez', h: -76, files: [['test/guard.test.ts', 'added', 154, 0]] },
        ],
      },
    ],
  },
  {
    id: 733902117,
    owner: 'lumen-ai',
    name: 'agent-patchbot',
    description: 'An autonomous agent that proposes minimal patches for failing tests. Every PR it opens is labeled agent-authored.',
    language: 'TypeScript',
    stars: 2210,
    forks: 186,
    license: 'Apache-2.0',
    topics: ['ai-agents', 'code-repair', 'diff'],
    updatedH: -7,
    history: [
      { msg: 'feat(diff): unified diff writer with hunk coalescing', by: 'hana-kobayashi', h: -2000, files: [['src/diff/unified.ts', 'added', 266, 0]] },
      { msg: 'feat(agent): minimal-patch search with test oracle', by: 'priya-natarajan', h: -1600, files: [['src/agent/search.ts', 'added', 410, 0]] },
      { msg: 'fix(diff): CRLF preservation in context lines (#1377)', by: 'lumen-patchbot[bot]', h: -600, files: [['src/diff/unified.ts', 'modified', 14, 6]] },
      { msg: 'chore: release 0.19.0', by: 'priya-natarajan', h: -240, files: [['package.json', 'modified', 1, 1]] },
    ],
    pulls: [
      {
        number: 1408,
        title: 'Fix off-by-one in hunk header line counts when the patch lacks a trailing newline',
        state: 'open',
        by: 'lumen-patchbot[bot]',
        createdH: -230,
        updatedH: -150,
        labels: ['agent-authored', 'bug', 'diff'],
        headRef: 'patchbot/hunk-count-no-eol',
        body:
          'Fixes #1399. When the last line of a file has no trailing newline, the old-side count in the `@@` header was one too high, so `git apply` rejected the patch.\n\n' +
          'This PR was generated autonomously by lumen-patchbot. Failing test → patch → test passes. A maintainer must review before merge.',
        commits: [
          { msg: 'fix(diff): count final line without EOL once in hunk headers', by: 'lumen-patchbot[bot]', h: -230, files: [['src/diff/unified.ts', 'modified', 11, 4]] },
          { msg: 'test(diff): no-EOL fixtures for add, delete and modify', by: 'lumen-patchbot[bot]', h: -229, files: [['test/diff/no-eol.test.ts', 'added', 96, 0], ['test/fixtures/no-eol/a.txt', 'added', 3, 0]] },
        ],
      },
    ],
  },
  {
    id: 488712903,
    owner: 'orbit-dao',
    name: 'nonce-manager',
    description: 'Nonce leasing service for multi-worker transaction senders on EVM chains.',
    language: 'TypeScript',
    stars: 287,
    forks: 24,
    license: 'MIT',
    topics: ['ethereum', 'nonce', 'redis', 'concurrency'],
    updatedH: -140,
    history: [
      { msg: 'feat: single-worker nonce tracker', by: 'priya-natarajan', h: -1800, files: [['src/tracker.ts', 'added', 120, 0]] },
      { msg: 'feat: Redis-backed nonce store', by: 'priya-natarajan', h: -1200, files: [['src/store/redis.ts', 'added', 145, 0]] },
      { msg: 'fix: reconcile with pending nonce on startup', by: 'li-wei-dev', h: -800, files: [['src/reconcile.ts', 'added', 66, 0]] },
    ],
    pulls: [
      {
        number: 63,
        title: 'concurrent nonce leasing with Redis fencing tokens',
        state: 'open',
        by: 'priya-natarajan',
        createdH: -380,
        updatedH: -140,
        labels: ['concurrency', 'needs-verification'],
        headRef: 'feat/fenced-leases',
        body:
          'Workers lease nonces with a fencing token. A lease expires after `LEASE_TTL_MS`; a worker must present a current token to sign. Expired leases are returned to the pool only after the chain confirms the nonce is unused.',
        commits: [
          { msg: 'lease: fencing tokens and TTL', by: 'priya-natarajan', h: -380, files: [['src/lease.ts', 'added', 132, 0], ['src/store/redis.ts', 'modified', 41, 12]] },
          { msg: 'lease: return expired nonces only after chain check', by: 'priya-natarajan', h: -350, files: [['src/lease.ts', 'modified', 37, 8], ['src/reconcile.ts', 'modified', 22, 5]] },
          { msg: 'test: 8 workers, RPC timeouts, worker restarts', by: 'li-wei-dev', h: -320, files: [['test/concurrency.test.ts', 'added', 210, 0]] },
        ],
      },
    ],
  },
  {
    id: 301228745,
    owner: 'quarry',
    name: 'csv-kit',
    description: 'Fast, streaming CSV reader/writer for Rust with RFC 4180 conformance tests.',
    language: 'Rust',
    stars: 3105,
    forks: 201,
    license: 'MIT',
    topics: ['csv', 'rust', 'parser', 'streaming'],
    updatedH: -15,
    history: [
      { msg: 'reader: batch reader with byte-record API', by: 'hana-kobayashi', h: -3000, files: [['src/reader.rs', 'added', 512, 0]] },
      { msg: 'reader: RFC 4180 quoted-field edge cases (#140)', by: 'hana-kobayashi', h: -1010, files: [['src/reader.rs', 'modified', 61, 22], ['tests/rfc4180.rs', 'added', 233, 0]] },
      { msg: 'stream: incremental reader over AsyncRead', by: 'li-wei-dev', h: -700, files: [['src/stream.rs', 'added', 388, 0]] },
      { msg: 'chore: release 1.8.0', by: 'hana-kobayashi', h: -350, files: [['Cargo.toml', 'modified', 1, 1], ['CHANGELOG.md', 'modified', 22, 0]] },
    ],
    pulls: [
      {
        number: 158,
        title: 'streaming reader: CRLF/LF parity with the batch reader',
        state: 'open',
        by: 'copilot-swe-agent[bot]',
        createdH: -90,
        updatedH: -15,
        labels: ['streaming', 'agent-authored'],
        headRef: 'copilot/crlf-parity',
        body:
          'The streaming reader split records differently from the batch reader when a CR fell on a buffer boundary. This makes the line-terminator state machine carry across chunks.\n\nDifferential test: `cargo test --test parity` compares both readers over 50k generated inputs.',
        commits: [
          { msg: 'stream: carry CR state across chunk boundaries', by: 'copilot-swe-agent[bot]', h: -90, files: [['src/stream.rs', 'modified', 46, 17]] },
          { msg: 'tests: differential parity harness (batch vs stream)', by: 'copilot-swe-agent[bot]', h: -88, files: [['tests/parity.rs', 'added', 174, 0], ['tests/gen/mod.rs', 'added', 81, 0]] },
        ],
      },
      {
        number: 140,
        title: 'reader: RFC 4180 quoted-field edge cases',
        state: 'merged',
        by: 'hana-kobayashi',
        createdH: -1060,
        updatedH: -1010,
        labels: ['rfc4180'],
        headRef: 'fix/rfc4180-quotes',
        baseIndex: 0,
        body: 'Escaped quotes at field end, CRLF inside quoted fields, and a trailing empty field after a quoted field.',
        commits: [
          { msg: 'reader: handle escaped quote at field end', by: 'hana-kobayashi', h: -1060, files: [['src/reader.rs', 'modified', 38, 15]] },
          { msg: 'tests: RFC 4180 conformance suite', by: 'hana-kobayashi', h: -1040, files: [['tests/rfc4180.rs', 'added', 233, 0], ['src/reader.rs', 'modified', 23, 7]] },
        ],
      },
    ],
  },
  {
    id: 377410266,
    owner: 'harbor',
    name: 'rate-limiter',
    description: 'Distributed rate limiting for Go services: sliding-window log and token bucket backends (Redis, in-memory).',
    language: 'Go',
    stars: 905,
    forks: 63,
    license: 'BSD-3-Clause',
    topics: ['rate-limiting', 'redis', 'go'],
    updatedH: -60,
    history: [
      { msg: 'feat: sliding-window log backend', by: 'jonas-weber', h: -2400, files: [['window/log.go', 'added', 177, 0]] },
      { msg: 'feat: token bucket backend', by: 'jonas-weber', h: -1900, files: [['bucket/bucket.go', 'added', 140, 0]] },
      { msg: 'sliding window: use monotonic clock for window boundaries (#77)', by: 'jonas-weber', h: -700, files: [['window/log.go', 'modified', 33, 19], ['window/clock.go', 'added', 28, 0]] },
      { msg: 'docs: document clock assumptions', by: 'mara-okafor', h: -500, files: [['README.md', 'modified', 24, 3]] },
    ],
    pulls: [
      {
        number: 85,
        title: 'token bucket: clamp refill at burst capacity',
        state: 'open',
        by: 'mara-okafor',
        createdH: -300,
        updatedH: -60,
        labels: ['bug', 'needs-verification'],
        headRef: 'fix/bucket-clamp',
        body: 'Refill could exceed `Burst` when a long idle period overflowed the elapsed-time multiplication. Refill is now computed in saturating arithmetic and clamped.',
        commits: [
          { msg: 'bucket: saturating refill arithmetic', by: 'mara-okafor', h: -300, files: [['bucket/bucket.go', 'modified', 19, 7]] },
          { msg: 'bucket: property tests for refill <= burst', by: 'mara-okafor', h: -290, files: [['bucket/bucket_prop_test.go', 'added', 88, 0]] },
        ],
      },
      {
        number: 77,
        title: 'sliding window: use monotonic clock for window boundaries',
        state: 'merged',
        by: 'jonas-weber',
        createdH: -720,
        updatedH: -700,
        labels: ['bug'],
        headRef: 'fix/monotonic-window',
        baseIndex: 1,
        body: 'Wall-clock jumps could admit a burst at window boundaries. Boundaries now use `time.Now()` monotonic readings only.',
        commits: [
          { msg: 'window: monotonic boundaries', by: 'jonas-weber', h: -720, files: [['window/log.go', 'modified', 33, 19], ['window/clock.go', 'added', 28, 0]] },
          { msg: 'window: concurrency test with 64 goroutines', by: 'jonas-weber', h: -710, files: [['window/log_test.go', 'modified', 72, 4]] },
        ],
      },
    ],
  },
  {
    id: 690118254,
    owner: 'meshwire',
    name: 'webhook-relay',
    description: 'Durable webhook fan-out with retries, signing and per-subscriber delivery ledgers.',
    language: 'TypeScript',
    stars: 640,
    forks: 48,
    license: 'MIT',
    topics: ['webhooks', 'delivery', 'idempotency'],
    updatedH: -36,
    history: [
      { msg: 'feat: subscriber registry and HMAC signing', by: 'akosua-mensah', h: -1700, files: [['src/registry.ts', 'added', 133, 0], ['src/sign.ts', 'added', 41, 0]] },
      { msg: 'feat: retry queue with exponential backoff', by: 'akosua-mensah', h: -1200, files: [['src/retry.ts', 'added', 117, 0]] },
      { msg: 'delivery: at-most-once mode with a dedupe ledger (#301)', by: 'akosua-mensah', h: -760, files: [['src/ledger.ts', 'added', 102, 0], ['src/deliver.ts', 'modified', 46, 12]] },
      { msg: 'docs: delivery modes', by: 'ines-duarte', h: -330, files: [['docs/delivery-modes.md', 'added', 58, 0]] },
    ],
    pulls: [
      {
        number: 318,
        title: 'dedupe ledger: honor DELIVERY_MODE=at_most_once on retry',
        state: 'open',
        by: 'akosua-mensah',
        createdH: -80,
        updatedH: -36,
        labels: ['delivery', 'needs-verification'],
        headRef: 'fix/at-most-once-retry',
        body:
          'Follow-up to PINE-0004, which resolved invalid because the pinned configuration enabled at-least-once retries. With `DELIVERY_MODE=at_most_once`, retries now consult the dedupe ledger before every attempt, and the ledger write happens before the HTTP request.',
        commits: [
          { msg: 'ledger: reserve event id before the HTTP attempt', by: 'akosua-mensah', h: -80, files: [['src/ledger.ts', 'modified', 28, 9], ['src/deliver.ts', 'modified', 19, 11]] },
          { msg: 'retry: skip events already reserved in at_most_once mode', by: 'akosua-mensah', h: -72, files: [['src/retry.ts', 'modified', 16, 4]] },
          { msg: 'test: crash between reserve and send; duplicate enqueue', by: 'ines-duarte', h: -40, files: [['test/at-most-once.test.ts', 'added', 133, 0]] },
        ],
      },
      {
        number: 301,
        title: 'delivery: at-most-once mode with a dedupe ledger',
        state: 'merged',
        by: 'akosua-mensah',
        createdH: -800,
        updatedH: -760,
        labels: ['delivery'],
        headRef: 'feat/at-most-once',
        baseIndex: 1,
        body: 'Adds `DELIVERY_MODE` (`at_least_once` default, `at_most_once`). The dedupe ledger records delivered event ids per subscriber.',
        commits: [
          { msg: 'delivery: dedupe ledger and DELIVERY_MODE', by: 'akosua-mensah', h: -800, files: [['src/ledger.ts', 'added', 102, 0], ['src/deliver.ts', 'modified', 46, 12]] },
        ],
      },
    ],
  },
  {
    id: 745520019,
    owner: 'fernhill',
    name: 'i18n-plurals',
    description: 'Tiny CLDR plural-rule engine with generated rules and exhaustive tests.',
    language: 'TypeScript',
    stars: 133,
    forks: 15,
    license: 'MIT',
    topics: ['i18n', 'cldr', 'plural-rules'],
    updatedH: -18,
    history: [
      { msg: 'feat: rule compiler for CLDR plural syntax', by: 'ines-duarte', h: -1500, files: [['src/compile.ts', 'added', 210, 0]] },
      { msg: 'feat: generated rules for 40 locales (CLDR 45)', by: 'ines-duarte', h: -900, files: [['src/rules.generated.ts', 'added', 1180, 0]] },
      { msg: 'chore: CLDR 46 data import', by: 'ines-duarte', h: -200, files: [['data/cldr-46/plurals.json', 'added', 2210, 0]] },
    ],
    pulls: [
      {
        number: 66,
        title: 'Arabic plural categories per CLDR 46',
        state: 'open',
        by: 'claude[bot]',
        createdH: -46,
        updatedH: -18,
        labels: ['agent-authored', 'locale:ar'],
        headRef: 'claude/ar-cldr46',
        body:
          'Regenerates the `ar` rule from CLDR 46 data. `few` is n % 100 = 3..10, `many` is n % 100 = 11..99. Adds an exhaustive table test for 0–10,000.\n\nAuthored by Claude at the request of @ines-duarte; maintainers review before merge.',
        commits: [
          { msg: 'rules(ar): regenerate from CLDR 46', by: 'claude[bot]', h: -46, files: [['src/rules.generated.ts', 'modified', 18, 14]] },
          { msg: 'test(ar): exhaustive 0..10000 table against CLDR sample data', by: 'claude[bot]', h: -45, files: [['test/ar.test.ts', 'added', 64, 0], ['test/fixtures/ar-cldr46.json', 'added', 10002, 0]] },
        ],
      },
    ],
  },
  {
    id: 802211659,
    owner: 'mara-okafor',
    name: 'reporter-sim',
    description: 'Simulator for reporter deposit flows used in keeper tests. No pull requests yet.',
    language: 'TypeScript',
    stars: 4,
    forks: 0,
    license: 'MIT',
    topics: ['simulation'],
    updatedH: -300,
    history: [
      { msg: 'init: reporter deposit simulator', by: 'mara-okafor', h: -700, files: [['src/sim.ts', 'added', 140, 0]] },
      { msg: 'feat: seedable journal states', by: 'mara-okafor', h: -300, files: [['src/states.ts', 'added', 66, 0]] },
    ],
    pulls: [],
  },
  {
    id: 801992344,
    owner: 'mara-okafor',
    name: 'ops-runbooks',
    description: 'Private on-call runbooks.',
    private: true,
    language: 'Shell',
    stars: 0,
    forks: 0,
    license: null,
    topics: [],
    updatedH: -26,
    history: [{ msg: 'runbook: keeper restart procedure', by: 'mara-okafor', h: -26, files: [['keeper/restart.md', 'added', 40, 0]] }],
    pulls: [],
  },
]

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function toCommit(fullName: string, sha: string, parents: string[], seed: CommitSeed): CommitSummary {
  const author = u(seed.by)
  const additions = seed.files.reduce((a, f) => a + f[2], 0)
  const deletions = seed.files.reduce((a, f) => a + f[3], 0)
  return {
    sha,
    message: seed.msg,
    author: { name: author.name ?? author.login, login: author.login, avatarUrl: author.avatarUrl, date: hoursFromNow(seed.h) },
    htmlUrl: `https://github.com/${fullName}/commit/${sha}`,
    parents,
    verified: !author.login.endsWith('[bot]') ? seed.h % 3 !== 0 : true,
    stats: { additions, deletions, total: additions + deletions },
    files: seed.files.map(([filename, status, a, d]) => ({ filename, status, additions: a, deletions: d })),
  }
}

export interface GitHubFixtures {
  repos: RepoSummary[]
  /** Pull requests keyed by `owner/repo`, newest first. */
  pulls: Record<string, PullSummary[]>
  /** Default-branch history keyed by `owner/repo`, newest first. */
  commits: Record<string, CommitSummary[]>
  /** Commits of each pull request keyed by `owner/repo#number`, oldest first (GitHub order). */
  pullCommits: Record<string, CommitSummary[]>
  /** Every fixture commit by full SHA. */
  commitsBySha: Record<string, CommitSummary & { repo: string }>
}

/** Builds repos/PRs/commits with dates relative to the current fixture anchor (see withAnchor). */
export function buildGitHubFixtures(): GitHubFixtures {
  const repos: RepoSummary[] = []
  const pulls: Record<string, PullSummary[]> = {}
  const commits: Record<string, CommitSummary[]> = {}
  const pullCommits: Record<string, CommitSummary[]> = {}
  const commitsBySha: Record<string, CommitSummary & { repo: string }> = {}

  for (const seed of REPO_SEEDS) {
    const fullName = `${seed.owner}/${seed.name}`
    const branch = seed.defaultBranch ?? 'main'
    const history: CommitSummary[] = []
    let parent: string | undefined
    seed.history.forEach((c, i) => {
      const sha = fakeSha(`${fullName}:${branch}:${i}`)
      const commit = toCommit(fullName, sha, parent ? [parent] : [], c)
      history.push(commit)
      commitsBySha[sha] = { ...commit, repo: fullName }
      parent = sha
    })
    commits[fullName] = [...history].reverse()

    const prs: PullSummary[] = []
    for (const p of seed.pulls) {
      const base = history[p.baseIndex ?? history.length - 1]
      if (!base) throw new Error(`fixture base missing for ${fullName}#${p.number}`)
      let prev = base.sha
      const list: CommitSummary[] = p.commits.map((c, i) => {
        const sha = fakeSha(`${fullName}#${p.number}:${i}`)
        const commit = toCommit(fullName, sha, [prev], c)
        commitsBySha[sha] = { ...commit, repo: fullName }
        prev = sha
        return commit
      })
      pullCommits[`${fullName}#${p.number}`] = list
      const head = list[list.length - 1] ?? base
      const files = new Set(list.flatMap((c) => (c.files ?? []).map((f) => f.filename)))
      prs.push({
        number: p.number,
        title: p.title,
        state: p.state,
        draft: p.draft ?? false,
        author: u(p.by),
        htmlUrl: `https://github.com/${fullName}/pull/${p.number}`,
        headSha: head.sha,
        headRef: p.headRef,
        baseSha: base.sha,
        baseRef: branch,
        createdAt: hoursFromNow(p.createdH),
        updatedAt: hoursFromNow(p.updatedH),
        commits: list.length,
        additions: list.reduce((a, c) => a + (c.stats?.additions ?? 0), 0),
        deletions: list.reduce((a, c) => a + (c.stats?.deletions ?? 0), 0),
        changedFiles: files.size,
        labels: p.labels,
        body: p.body,
      })
    }
    prs.sort((a, b) => b.number - a.number)
    pulls[fullName] = prs

    repos.push({
      id: seed.id,
      owner: seed.owner,
      name: seed.name,
      fullName,
      description: seed.description,
      private: seed.private ?? false,
      defaultBranch: branch,
      language: seed.language,
      stars: seed.stars,
      forks: seed.forks,
      openPullRequests: prs.filter((p) => p.state === 'open').length,
      license: seed.license,
      htmlUrl: `https://github.com/${fullName}`,
      updatedAt: hoursFromNow(seed.updatedH),
      topics: seed.topics,
    })
  }

  return { repos, pulls, commits, pullCommits, commitsBySha }
}

/** Repositories the demo user can see in "your repositories" (includes one private repo, flagged). */
export const viewerRepoNames = [
  'kleros/gateway-balancer-bot',
  'harbor/rate-limiter',
  'quarry/csv-kit',
  'mara-okafor/reporter-sim',
  'mara-okafor/ops-runbooks',
]

export function findRepo(gh: GitHubFixtures, fullName: string): RepoSummary | undefined {
  const key = fullName.toLowerCase()
  return gh.repos.find((r) => r.fullName.toLowerCase() === key)
}

export function findPull(gh: GitHubFixtures, fullName: string, number: number): PullSummary | undefined {
  const key = Object.keys(gh.pulls).find((k) => k.toLowerCase() === fullName.toLowerCase())
  return key ? gh.pulls[key]?.find((p) => p.number === number) : undefined
}
