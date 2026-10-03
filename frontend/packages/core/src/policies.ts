/**
 * Policy catalog: FUNC-001, BOT-001, SC-001 at 0.1.0.
 *
 * `text` is composed verbatim from policies/README.md (see policy-text.ts) and `contentHash = hashText(text)`.
 * `uri` is a deterministic placeholder (`ipfs://pending/<id>@<version>`): the text is pinned to IPFS at
 * launch and the URI replaced in a new catalog release; the content hash does not change when that happens.
 *
 * Note on wording: the hashed policy text is kept verbatim (it contains phrases like "Safe nonce allocation");
 * UI-facing labels/descriptions derived from it follow the spec §8 language rules.
 */
import { hashText } from './hash'
import {
  BOT_001_SECTION,
  COMMON_PUBLICATION_REQUIREMENTS,
  FUNC_001_SECTION,
  POLICY_GOVERNANCE,
  POLICY_PREAMBLE,
  POLICY_SOURCE_STATUS,
  SC_001_SECTION,
} from './policy-text'
import type { PolicyFamily, PolicyFamilyId, PolicyParameterSpec, PolicyVersion } from './types'

export const POLICY_PUBLISHED_AT = '2026-08-01T00:00:00Z'

export const POLICY_FAMILIES: PolicyFamily[] = [
  {
    id: 'FUNC',
    name: 'Functional correctness',
    tagline: 'One feature requirement or claimed bug fix, tested against the pinned commit.',
    description:
      'Verify a specific feature requirement or a claimed bug fix in an application or library: an access rule on named API operations, a parser that must accept or reject a defined class of inputs, or a fix that must eliminate an identified failure. Style, unbounded performance claims and general quality judgements are out of scope.',
  },
  {
    id: 'BOT',
    name: 'Automation and keeper reliability',
    tagline: 'One invariant of a keeper, treasury bot, scheduler or other stateful automation.',
    description:
      'Verify one invariant of a stateful automation system under an explicit fault model: separation of protected fund categories, no duplicate operations during recovery, nonce allocation under concurrency, adherence to route/recipient/spending limits, or defined behavior when inputs go stale. Evidence is a reproducible sequence of states and events; no live transfers or production keys.',
  },
  {
    id: 'SC',
    name: 'Smart-contract invariants',
    tagline: 'One security property of pinned contract code or a precisely specified deployment state.',
    description:
      'Challenge a particular security property of pinned smart-contract code: unauthorized asset movement through identified entry points, an accounting invariant over allowed transaction sequences, or signature replay under published assumptions. Not a full audit. Gated until an approved disclosure process exists, because evidence may expose live vulnerabilities.',
  },
]

export function getPolicyFamily(id: PolicyFamilyId): PolicyFamily | undefined {
  return POLICY_FAMILIES.find((f) => f.id === id)
}

/** "BOT-001@0.1.0" */
export function policyPath(p: Pick<PolicyVersion, 'id' | 'version'>): string {
  return `${p.id}@${p.version}`
}

function composePolicyText(id: string, version: string, title: string, section: string): string {
  return (
    [
      `# ${id}@${version} — ${title}`,
      POLICY_SOURCE_STATUS,
      POLICY_PREAMBLE,
      section,
      COMMON_PUBLICATION_REQUIREMENTS,
      POLICY_GOVERNANCE,
    ].join('\n\n') + '\n'
  )
}

const INVALID_RULE =
  'Native invalid/unanswerable outcomes are handled by the underlying Seer and Reality.eth protocol rules, including their actual payout rules: on invalid, Yes and No tokens pay nothing and only Invalid-result tokens redeem. An invalid result is not a guaranteed refund. "Answered too soon" blocks resolution until the question is reopened.'

const COMMON_EVIDENCE = [
  'Submitted before the absolute UTC evidence deadline through the published evidence mechanism; the submission transaction’s block timestamp is the timeliness proof.',
  'Identifies the pinned repository, commit, environment hash and policy version.',
  'Durable, retrievable evidence reference (content URI with hash).',
]

const COMMON_EXCLUSIONS = [
  'A test that alters the target’s behavior, assumes unavailable privileges, or depends on an excluded environment.',
  'Late submissions: discoveries after the deadline do not reopen a finalized market.',
]

// ---------------------------------------------------------------------------
// FUNC-001
// ---------------------------------------------------------------------------

const FUNC_PARAMETERS: PolicyParameterSpec[] = [
  {
    key: 'expectedBehavior',
    label: 'Exact expected behavior',
    help: 'The one behavior the pinned commit must exhibit, stated precisely enough that a failing test settles it.',
    kind: 'longtext',
    required: true,
    maxLength: 2000,
    placeholder: 'GET /v1/files/:id returns 404 unless the caller owns the file or it is shared with them.',
    example: 'GET /v1/files/:id and GET /v1/files/:id/download return 404 for any caller who is neither the owner nor an explicit share recipient.',
  },
  {
    key: 'inputDomain',
    label: 'Allowed input domain',
    help: 'Which inputs a counterexample may use. Inputs outside this domain do not qualify.',
    kind: 'longtext',
    required: true,
    maxLength: 2000,
    placeholder: 'Any authenticated session for a non-admin user; any file id.',
    example: 'Any authenticated non-admin session; any file id; any combination of documented query parameters.',
  },
  {
    key: 'supportedEnvironment',
    label: 'Supported environment',
    help: 'Runtime, platform and versions the claim covers. Unsupported environments are excluded.',
    kind: 'text',
    required: true,
    maxLength: 300,
    placeholder: 'Node 22 on Linux x64, Postgres 16',
    example: 'Node 22.14 on Linux x64 with Postgres 16, using the pinned lockfile.',
  },
  {
    key: 'featureBoundaries',
    label: 'Feature / API boundaries',
    help: 'The named operations, modules or entry points in scope. Anything else is out of scope.',
    kind: 'list',
    required: true,
    placeholder: 'GET /v1/files/:id',
    example: ['GET /v1/files/:id', 'GET /v1/files/:id/download', 'src/auth/acl.ts'],
  },
  {
    key: 'configuration',
    label: 'Relevant configuration',
    help: 'Feature flags and non-secret settings that affect the behavior. Never include secrets; values are hashed into the environment pin.',
    kind: 'longtext',
    required: true,
    maxLength: 2000,
    placeholder: 'SHARING_ENABLED=true; default config otherwise',
    example: 'SHARING_ENABLED=true, ACL_CACHE_TTL=0; all other settings default.',
  },
  {
    key: 'violationScope',
    label: 'Which violations qualify',
    help: 'Whether any violation in the selected commit qualifies, or only a regression introduced relative to the pinned base commit.',
    kind: 'select',
    required: true,
    options: [
      { value: 'any', label: 'Any violation in the selected commit', help: 'Pre-existing failures also qualify.' },
      {
        value: 'regression',
        label: 'Only regressions relative to the base commit',
        help: 'Requires a pinned base commit; the behavior must hold at base and fail at the selected commit.',
      },
    ],
    example: 'any',
  },
]

const FUNC_TEXT = composePolicyText('FUNC-001', '0.1.0', 'Functional Correctness', FUNC_001_SECTION)

const FUNC_001: PolicyVersion = {
  id: 'FUNC-001',
  family: 'FUNC',
  version: '0.1.0',
  title: 'Functional Correctness',
  summary: 'Verify a specific feature requirement or a claimed bug fix in an application or library.',
  status: 'enabled',
  contentHash: hashText(FUNC_TEXT),
  uri: 'ipfs://pending/FUNC-001@0.1.0',
  text: FUNC_TEXT,
  intendedUse: ['Verify a specific feature requirement or a claimed bug fix in an application/library.'],
  examples: [
    'A user cannot access another user’s private resource through named API operations.',
    'A parser accepts/rejects a specified class of inputs according to a frozen format definition.',
    'A stated bug fix eliminates an identified failure under defined conditions.',
  ],
  claimClasses: [
    {
      id: 'access-boundary',
      label: 'Access boundary on named operations',
      description: 'A user cannot access another user’s private resource through named API operations.',
    },
    {
      id: 'format-conformance',
      label: 'Input format conformance',
      description: 'A parser accepts/rejects a specified class of inputs according to a frozen format definition.',
    },
    {
      id: 'bug-fix',
      label: 'Claimed bug fix',
      description: 'A stated bug fix eliminates an identified failure under defined conditions.',
    },
  ],
  parameters: FUNC_PARAMETERS,
  evidenceRequirements: [
    'A repeatable test/demonstration exercising the target code.',
    'The reproduction command.',
    'Fixtures without real customer data.',
    'Actual output.',
    'An explanation of the violated requirement.',
    ...COMMON_EVIDENCE,
  ],
  exclusions: [
    'Style preferences, unbounded performance claims, and general code-quality judgments.',
    'Unsupported environments or configurations outside the published scope.',
    'An intentionally modified target implementation.',
    'A screenshot or assertion without a reproducible behavioral failure.',
    ...COMMON_EXCLUSIONS,
  ],
  outcomeRules: {
    yes: 'YES requires at least one timely qualifying functional counterexample.',
    no: 'NO means none was submitted; it is not a general correctness certification.',
    invalid: INVALID_RULE,
  },
  publishedAt: POLICY_PUBLISHED_AT,
}

// ---------------------------------------------------------------------------
// BOT-001
// ---------------------------------------------------------------------------

const BOT_PARAMETERS: PolicyParameterSpec[] = [
  {
    key: 'invariant',
    label: 'Selected invariant',
    help: 'Exactly one invariant. A family title such as "keeper reliability" is not a resolvable claim.',
    kind: 'longtext',
    required: true,
    maxLength: 2000,
    placeholder: 'Reporter-deposit principal is funded only from eligible bridging/reporter funds…',
    example:
      'For the frozen configuration and allowed states, each reporter-funding deposit’s principal is allocated only from eligible bridging/reporter funds in the specified accounting scope. It never consumes a pair’s arbitration allocation or the operator’s transaction-gas reserve. Paying the reporter transaction’s legitimate gas fee from the operator reserve is permitted.',
  },
  {
    key: 'sourceRequirement',
    label: 'Source requirement',
    help: 'Where the invariant comes from: a spec section, issue or document, ideally pinned by hash.',
    kind: 'text',
    required: true,
    maxLength: 500,
    placeholder: 'docs/gateway-balancer-bot-spec.md §4.2',
    example: 'kleros-v2 docs/gateway-balancer-bot-spec.md §2.2, §4.2; §12 tests 3 and 7',
  },
  {
    key: 'permittedStartingStates',
    label: 'Permitted starting states',
    help: 'Initial states a counterexample may start from.',
    kind: 'longtext',
    required: true,
    maxLength: 2000,
    example:
      'A reporter below its funding threshold; no eligible bridging-fee funds available for its deposit; protected arbitration funds and operator gas reserves present.',
  },
  {
    key: 'reachability',
    label: 'How a failing state is shown reachable',
    help: 'How evidence must establish that the failing state can actually occur. Artificial, unreachable states do not qualify unless their initialization is explicitly allowed.',
    kind: 'longtext',
    required: true,
    maxLength: 2000,
    example:
      'Reach the state by exercising the real planning/accounting code from an allowed initial journal. Fabricating an impossible journal state is not sufficient.',
  },
  {
    key: 'accounts',
    label: 'Accounts in scope',
    help: 'Accounts or wallets whose accounting the claim covers.',
    kind: 'list',
    required: true,
    example: ['Operator EOA', 'Reporter accounts listed in the pinned configuration'],
  },
  {
    key: 'chains',
    label: 'Chains in scope',
    help: 'Chains the automation operates on for this claim.',
    kind: 'list',
    required: true,
    example: ['Chains listed in the pinned configuration'],
  },
  {
    key: 'routes',
    label: 'Routes in scope',
    help: 'Bridge/swap routes or job types in scope. Use "none" when not applicable.',
    kind: 'list',
    required: true,
    example: ['Reporter-funding deposits'],
  },
  {
    key: 'accountingCategories',
    label: 'Accounting categories',
    help: 'The protected fund/accounting categories the invariant separates.',
    kind: 'list',
    required: true,
    example: ['Arbitration allocation (per pair)', 'Eligible bridging/reporter funds', 'Operator transaction-gas reserve'],
  },
  {
    key: 'faultModel',
    label: 'Fault model',
    help: 'Faults a counterexample may inject. Do not silently assume arbitrary database corruption.',
    kind: 'multiselect',
    required: true,
    options: [
      { value: 'process_crash', label: 'Process crash / restart' },
      { value: 'timeout', label: 'Timeout' },
      { value: 'replacement_transaction', label: 'Replacement transaction' },
      { value: 'rpc_error', label: 'RPC error or dropped response' },
      { value: 'concurrent_runs', label: 'Concurrent runs within stated limits' },
      { value: 'none', label: 'No faults (normal operation only)' },
    ],
    example: ['process_crash', 'timeout', 'replacement_transaction'],
  },
  {
    key: 'simulatedAdapters',
    label: 'Adapters that may be simulated',
    help: 'External adapters a reproduction may replace with simulations. Simulation never validates the real integration.',
    kind: 'list',
    required: true,
    example: ['LI.FI bridge/swap adapter (simulation limited to this claim)'],
  },
  {
    key: 'realIntegrationEvidence',
    label: 'What requires real integration validation',
    help: 'Which conclusions simulated evidence cannot establish.',
    kind: 'longtext',
    required: true,
    maxLength: 2000,
    example:
      'Adapter simulation cannot count as validation of actual LI.FI execution; the bot specification’s separate real-integration launch gates remain intact.',
  },
]

const BOT_TEXT = composePolicyText('BOT-001', '0.1.0', 'Automation and Keeper Reliability', BOT_001_SECTION)

const BOT_001: PolicyVersion = {
  id: 'BOT-001',
  family: 'BOT',
  version: '0.1.0',
  title: 'Automation and Keeper Reliability',
  summary: 'Verify one invariant of a keeper, treasury bot, scheduler, or other stateful automation system.',
  status: 'enabled',
  contentHash: hashText(BOT_TEXT),
  uri: 'ipfs://pending/BOT-001@0.1.0',
  text: BOT_TEXT,
  intendedUse: ['Verify one invariant of a keeper, treasury bot, scheduler, or other stateful automation system.'],
  examples: [
    'Reporter-deposit principal must not be funded from arbitration allocations or the operator’s transaction-gas reserve.',
    'After a successful bridge followed by swap failure, recovery must not blindly start another bridge for the same operation.',
    'Requotes/retries must not reset an operation’s total permitted pricing-loss budget.',
    'Missing, stale, or excessively disagreeing price observations must prevent the corresponding rate update.',
  ],
  claimClasses: [
    {
      id: 'fund-separation',
      label: 'Fund and accounting separation',
      description: 'Separation of protected fund/accounting categories.',
    },
    {
      id: 'duplicate-operations',
      label: 'No duplicate operations in recovery',
      description: 'Prevention of duplicate operations during specified recovery scenarios.',
    },
    {
      id: 'nonce-allocation',
      label: 'Nonce allocation under concurrency',
      description: 'No conflicting or reused nonce allocation under the specified concurrency.',
    },
    {
      id: 'limits-adherence',
      label: 'Route, recipient, spender and spending limits',
      description: 'Adherence to route, recipient, spender, or spending limits.',
    },
    {
      id: 'stale-inputs',
      label: 'Stale or unavailable inputs',
      description: 'Defined behavior when required inputs become stale or unavailable.',
    },
  ],
  parameters: BOT_PARAMETERS,
  evidenceRequirements: [
    'A reproducible sequence with initial state, allowed events/faults, resulting plans/state transitions, and the violation.',
    'Relevant non-secret journal entries and proposed transaction fields when necessary.',
    'For financial claims, distinguish deposit/transfer principal from legitimate transaction-gas expenditure.',
    'Shared physical custody alone does not prove accounting cross-subsidy.',
    ...COMMON_EVIDENCE,
  ],
  exclusions: [
    'Live transfers, production keys, or attacks on services are neither required nor authorized to prove a claim.',
    'An artificial state not reachable under the agreed model is not a counterexample unless initialization of that state is explicitly allowed.',
    'Simulation/fault-injection evidence cannot establish that a real bridge, swap, price feed, or deployment integration works.',
    'A process-level reliability result is not proof of unattended production readiness.',
    ...COMMON_EXCLUSIONS,
  ],
  outcomeRules: {
    yes: 'YES requires a timely reproducible violation of the selected invariant, not merely an unrelated improvement suggestion.',
    no: 'NO means none was submitted within scope.',
    invalid: INVALID_RULE,
  },
  publishedAt: POLICY_PUBLISHED_AT,
}

// ---------------------------------------------------------------------------
// SC-001
// ---------------------------------------------------------------------------

const SC_PARAMETERS: PolicyParameterSpec[] = [
  {
    key: 'sourceReferences',
    label: 'Source / bytecode references',
    help: 'Contract source paths and, for deployed code, bytecode or verified-source references.',
    kind: 'list',
    required: true,
    example: ['contracts/Escrow.sol', 'contracts/EscrowFactory.sol'],
  },
  {
    key: 'buildSettings',
    label: 'Compiler / build settings',
    help: 'Compiler version, optimizer settings and build tool configuration.',
    kind: 'text',
    required: true,
    maxLength: 500,
    example: 'solc 0.8.28, optimizer 200 runs, via-IR off; foundry 1.2.3',
  },
  {
    key: 'stateDependent',
    label: 'Depends on deployed state',
    help: 'Whether the claim concerns a specific deployment state rather than code alone.',
    kind: 'boolean',
    required: true,
    example: false,
  },
  {
    key: 'chain',
    label: 'Chain',
    help: 'For state-dependent claims: the chain of the deployment.',
    kind: 'text',
    required: false,
    maxLength: 100,
    example: 'Gnosis (100)',
  },
  {
    key: 'addresses',
    label: 'Contract addresses',
    help: 'For state-dependent claims: deployed addresses in scope.',
    kind: 'list',
    required: false,
    placeholder: '0x…',
  },
  {
    key: 'stateSnapshot',
    label: 'Block / state snapshot',
    help: 'For state-dependent claims: the block number or snapshot the claim is evaluated against.',
    kind: 'text',
    required: false,
    maxLength: 200,
    example: 'Gnosis block 41200000',
  },
  {
    key: 'proxyImplementations',
    label: 'Proxy implementation references',
    help: 'Implementation addresses or source references behind any proxies, as applicable.',
    kind: 'list',
    required: false,
  },
  {
    key: 'attackerPermissions',
    label: 'Attacker permissions',
    help: 'What an attacker may do. Possession of a trusted administrator key is excluded unless stated here.',
    kind: 'longtext',
    required: true,
    maxLength: 2000,
    example: 'Any externally owned account without roles; may deploy helper contracts and call any public function.',
  },
  {
    key: 'initialAssets',
    label: 'Attacker initial assets',
    help: 'Assets the attacker starts with in the reproduction.',
    kind: 'text',
    required: true,
    maxLength: 500,
    example: '1,000 units of the escrow token and 1 native token for gas',
  },
  {
    key: 'trustedRoles',
    label: 'Trusted roles',
    help: 'Roles assumed honest (owner, guardian, oracle…).',
    kind: 'list',
    required: true,
    example: ['Owner multisig', 'Arbitrator'],
  },
  {
    key: 'externalDependencies',
    label: 'External dependency assumptions',
    help: 'Assumptions about tokens, oracles and other contracts the target interacts with.',
    kind: 'longtext',
    required: true,
    maxLength: 2000,
    example: 'Escrow tokens are standard ERC-20 without fee-on-transfer or rebasing behavior.',
  },
  {
    key: 'prohibitedEffect',
    label: 'Exact prohibited effect / invariant',
    help: 'The single effect that must not be achievable.',
    kind: 'longtext',
    required: true,
    maxLength: 2000,
    example: 'An account other than the payer or the ruled recipient transfers escrowed tokens out of an Escrow.',
  },
  {
    key: 'severityThreshold',
    label: 'Severity threshold (optional)',
    help: 'If used, freeze its definitions and exclusions here.',
    kind: 'longtext',
    required: false,
    maxLength: 2000,
  },
  {
    key: 'disclosureProcedure',
    label: 'Approved evidence / disclosure procedure',
    help: 'Required, especially if related deployed systems hold real funds. SC-001 stays gated until this process is approved.',
    kind: 'longtext',
    required: true,
    maxLength: 2000,
  },
]

const SC_TEXT = composePolicyText(
  'SC-001',
  '0.1.0',
  'Smart-Contract Invariant and Security Verification',
  SC_001_SECTION,
)

export const SC_GATE_REASON =
  'Requires approved disclosure process. Do not enable claims that may expose live vulnerabilities until evidence access, responsible disclosure, and the adjudicator’s ability to examine evidence have been resolved. Keeping exploit evidence confidential while retaining a credible open market is an unresolved design requirement, not an assumed feature.'

const SC_001: PolicyVersion = {
  id: 'SC-001',
  family: 'SC',
  version: '0.1.0',
  title: 'Smart-Contract Invariant and Security Verification',
  summary:
    'Challenge a particular security property of pinned smart-contract code or a precisely specified deployment state. Not a full audit.',
  status: 'gated',
  gateReason: SC_GATE_REASON,
  contentHash: hashText(SC_TEXT),
  uri: 'ipfs://pending/SC-001@0.1.0',
  text: SC_TEXT,
  intendedUse: [
    'Challenge a particular security property of pinned smart-contract code or a precisely specified deployment state.',
    'This is not a full audit or a guarantee of zero vulnerabilities.',
  ],
  examples: [
    'An unauthorized caller cannot transfer protected assets through identified entry points.',
    'A specified accounting invariant holds over an allowed sequence of transactions.',
    'A defined signature cannot be replayed under the published domain/nonce assumptions.',
  ],
  claimClasses: [
    {
      id: 'unauthorized-transfer',
      label: 'Unauthorized asset transfer',
      description: 'An unauthorized caller cannot transfer protected assets through identified entry points.',
    },
    {
      id: 'accounting-invariant',
      label: 'Accounting invariant',
      description: 'A specified accounting invariant holds over an allowed sequence of transactions.',
    },
    {
      id: 'signature-replay',
      label: 'Signature replay',
      description: 'A defined signature cannot be replayed under the published domain/nonce assumptions.',
    },
  ],
  parameters: SC_PARAMETERS,
  evidenceRequirements: [
    'A local test or isolated fork reproduction that demonstrates the prohibited effect.',
    'Setup, transaction sequence, assertions, and impact explanation.',
    'Simulated/fork execution must not broadcast live transactions.',
    ...COMMON_EVIDENCE,
  ],
  exclusions: [
    'Possession of a trusted administrator key unless that capability is expressly within the threat model.',
    'Profit or damage assumptions that cannot occur under the pinned state and allowed actions.',
    'Speculative findings without a demonstrated qualifying violation.',
    'Live exploitation, unauthorized access, or moving other parties’ assets.',
    'Deployment-readiness or real-route claims inferred solely from local tests.',
    ...COMMON_EXCLUSIONS,
  ],
  outcomeRules: {
    yes: 'YES requires a timely qualifying demonstration of the defined security violation.',
    no: 'NO means no such evidence was submitted under these rules; it is not a verdict on the contract as a whole.',
    invalid: INVALID_RULE,
  },
  publishedAt: POLICY_PUBLISHED_AT,
}

export const POLICIES: PolicyVersion[] = [FUNC_001, BOT_001, SC_001]

/** Latest version when `version` is omitted. */
export function getPolicy(id: string, version?: string): PolicyVersion | undefined {
  const normalized = (id ?? '').trim().toUpperCase()
  const matches = POLICIES.filter((p) => p.id === normalized && (version === undefined || p.version === version))
  if (matches.length === 0) return undefined
  return matches.reduce((a, b) => (compareSemver(b.version, a.version) > 0 ? b : a))
}

/** Parse "BOT-001@0.1.0" or "BOT-001". */
export function getPolicyByPath(path: string): PolicyVersion | undefined {
  const [id, version] = path.split('@')
  return id ? getPolicy(id, version || undefined) : undefined
}

export function isPolicyEnabled(p: PolicyVersion | undefined): boolean {
  return !!p && p.status === 'enabled'
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
