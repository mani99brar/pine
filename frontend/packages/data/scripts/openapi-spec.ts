/**
 * Builds docs/indexer/rest-api.openapi.yaml.
 *
 * Schemas are written by hand; response examples are generated from the demo fixtures through the
 * same domain→wire mappers the RestDataProvider inverts, so examples always match the adapter.
 * Regenerate with:  pnpm --filter @pine/data openapi
 */
import { POLICIES } from '@pine/core'
import { buildDepth, MockDataProvider } from '../src/mock/provider'
import { fixtures } from '../src/mock/fixtures'
import { toSummary } from '../src/mock/provider'
import {
  accountToWire,
  activityToWire,
  claimDetailToWire,
  claimSummaryToWire,
  depthToWire,
  draftToWire,
  evidenceToWire,
  policyToWire,
  portfolioToWire,
  pricesToWire,
  statsToWire,
  walletToWire,
} from '../src/rest/wire'

type Schema = Record<string, unknown>

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` })
const nullable = (s: Schema): Schema => {
  if (typeof s.type === 'string') {
    const out: Schema = { ...s, type: [s.type, 'null'] }
    if (Array.isArray(s.enum)) out.enum = [...s.enum, null]
    return out
  }
  return { anyOf: [s, { type: 'null' }] }
}
const str = (description?: string, extra: Schema = {}): Schema => ({ type: 'string', ...(description ? { description } : {}), ...extra })
const int = (description?: string, extra: Schema = {}): Schema => ({ type: 'integer', ...(description ? { description } : {}), ...extra })
const num = (description?: string, extra: Schema = {}): Schema => ({ type: 'number', ...(description ? { description } : {}), ...extra })
const bool = (description?: string): Schema => ({ type: 'boolean', ...(description ? { description } : {}) })
const arr = (items: Schema, description?: string): Schema => ({ type: 'array', items, ...(description ? { description } : {}) })
const obj = (properties: Record<string, Schema>, required: string[], description?: string, extra: Schema = {}): Schema => ({
  type: 'object',
  ...(description ? { description } : {}),
  required,
  properties,
  ...extra,
})

const json = (schema: Schema, examples?: Record<string, { summary: string; value: unknown } | { $ref: string }>) => ({
  'application/json': { schema, ...(examples ? { examples } : {}) },
})

const errorResponse = (description: string, code: string, message: string) => ({
  description,
  content: json(ref('Error'), { [code]: { summary: description, value: { error: { code, message } } } }),
})

const NOT_FOUND = errorResponse('Not found', 'not_found', 'No claim with id pine-9999')
const MARKET_NOT_FOUND = errorResponse('No Pine claim for this market', 'not_found', 'No Pine claim for market 100:0x0000000000000000000000000000000000000001')
const POLICY_NOT_FOUND = errorResponse('Unknown policy or version', 'not_found', 'No policy BOT-001@9.9.9')
const DRAFT_NOT_FOUND = errorResponse('Unknown draft', 'not_found', 'No draft with id draft-missing')
const ACCOUNT_NOT_FOUND = errorResponse('Unknown account or wallet', 'not_found', 'No account for login octocat')
const BAD_REQUEST = errorResponse('Invalid query parameter', 'bad_response', 'limit must be between 1 and 100')
const BAD_ACTIVITY_REQUEST = errorResponse('Invalid query parameter', 'bad_response', 'limit must be between 1 and 200')
const BAD_BODY = errorResponse('Invalid request body', 'bad_response', 'default_spending_limit must be a decimal string')
const UNAUTHORIZED = errorResponse('Missing or invalid bearer token', 'unauthorized', 'A valid bearer token is required')
const RATE_LIMITED = errorResponse('Too many requests', 'rate_limited', 'Rate limit exceeded; retry after 30 s')

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const schemas: Record<string, Schema> = {
  Hex: str('0x-prefixed lowercase or checksummed hex', { pattern: '^0x[0-9a-fA-F]*$' }),
  Address: str('EVM address', { pattern: '^0x[0-9a-fA-F]{40}$' }),
  Hash32: str('32-byte hash', { pattern: '^0x[0-9a-fA-F]{64}$' }),
  IsoDate: str('ISO-8601 UTC timestamp, e.g. 2026-10-10T18:00:00Z', { format: 'date-time' }),
  Decimal: str('Decimal string in human units (never wei, never float), e.g. "12.5"', { pattern: '^-?\\d+(\\.\\d+)?$' }),
  ClaimStatus: str('Lifecycle phase', {
    enum: ['draft', 'publishing', 'open', 'awaiting_answer', 'answer_proposed', 'disputed', 'arbitration', 'resolved', 'settled', 'failed'],
  }),
  Outcome: str('yes = counterexample demonstrated; no = no qualifying counterexample submitted; invalid = resolved invalid (not a refund)', {
    enum: ['yes', 'no', 'invalid'],
  }),
  RealityAnswer: str('Decoded Reality.eth answer', { enum: ['yes', 'no', 'invalid', 'too_soon'] }),
  PolicyFamily: str(undefined, { enum: ['FUNC', 'BOT', 'SC'] }),
  ClaimSort: str(undefined, { enum: ['newest', 'deadline', 'liquidity', 'volume', 'yes_price', 'activity'] }),
  ActivityType: str(undefined, {
    enum: [
      'market_created', 'manifest_pinned', 'liquidity_added', 'liquidity_removed', 'split', 'merge', 'trade',
      'evidence_submitted', 'answer_posted', 'arbitration_requested', 'ruling', 'finalized', 'redeemed', 'approval',
    ],
  }),
  Error: obj(
    {
      error: obj(
        {
          code: str('Maps to PineDataError codes', { enum: ['network', 'not_found', 'bad_response', 'unauthorized', 'rate_limited', 'unsupported'] }),
          message: str(),
        },
        ['code', 'message'],
      ),
    },
    ['error'],
  ),
  ClaimSummary: obj(
    {
      id: str('Stable Pine claim id, e.g. pine-0042'),
      number: int('Displayed as PINE-0042'),
      title: str(),
      violation: str('Violation phrase inserted in the market question'),
      policy: obj({ id: str(), version: str(), family: ref('PolicyFamily'), title: str() }, ['id', 'version', 'family', 'title']),
      source: obj(
        { owner: str(), repo: str(), commit_sha: str('40-hex commit SHA', { pattern: '^[0-9a-f]{40}$' }), pr_number: nullable(int()), pr_title: nullable(str()) },
        ['owner', 'repo', 'commit_sha'],
      ),
      status: ref('ClaimStatus'),
      outcome: nullable(ref('Outcome')),
      created_at: ref('IsoDate'),
      evidence_deadline: ref('IsoDate'),
      chain_id: int(),
      market_address: nullable(ref('Address')),
      creator: ref('Address'),
      creator_github: nullable(str()),
      yes_price: nullable(num('Market-implied chance a qualifying counterexample is accepted (YES price), [0,1]. Not a probability of bugs.', { minimum: 0, maximum: 1 })),
      yes_price_24h_ago: nullable(num(undefined, { minimum: 0, maximum: 1 })),
      liquidity: ref('Decimal'),
      volume: ref('Decimal'),
      collateral_symbol: str(),
      evidence_count: int(),
      traders: int('Distinct traders; does not prove review depth'),
      sponsored: bool(),
      tags: arr(str()),
    },
    ['id', 'number', 'title', 'violation', 'policy', 'source', 'status', 'created_at', 'evidence_deadline', 'chain_id', 'creator', 'liquidity', 'volume', 'collateral_symbol', 'evidence_count', 'traders', 'sponsored', 'tags'],
    'Claim read model for lists',
  ),
  ClaimPage: obj({ items: arr(ref('ClaimSummary')), next_cursor: nullable(str('Opaque; pass back as `cursor`')), total: nullable(int()) }, ['items']),
  ClaimManifest: obj(
    {
      $schema: str(),
      manifestVersion: str(undefined, { const: '1' }),
      claimId: str(),
      createdAt: ref('IsoDate'),
      creator: ref('Address'),
      source: { type: 'object' },
      policy: { type: 'object' },
      claim: { type: 'object' },
      question: obj({ text: str(), outcomes: arr(str()), hash: ref('Hash32') }, ['text', 'outcomes', 'hash']),
      disclaimers: arr(str()),
    },
    ['$schema', 'manifestVersion', 'claimId', 'createdAt', 'creator', 'source', 'policy', 'claim', 'question', 'disclaimers'],
    'The immutable published manifest, embedded verbatim (camelCase) because manifest_hash = keccak256(canonical JSON of this object). Full JSON Schema: docs/agents/claim-manifest.schema.json.',
    { additionalProperties: true },
  ),
  OutcomeQuote: obj(
    { index: int(), label: str('"Yes" | "No" | "Invalid result"'), token: ref('Address'), price: num(undefined, { minimum: 0, maximum: 1 }), change_24h: nullable(num()) },
    ['index', 'label', 'token', 'price'],
  ),
  Pool: obj({ address: ref('Address'), dex: str(), outcome: str(undefined, { enum: ['yes', 'no'] }), tvl: ref('Decimal'), fee_bps: int() }, ['address', 'dex', 'outcome', 'tvl', 'fee_bps']),
  Market: obj(
    {
      chain_id: int(),
      address: ref('Address'),
      seer_url: str(undefined, { format: 'uri' }),
      condition_id: ref('Hash32'),
      question_id: ref('Hash32'),
      collateral: obj({ address: ref('Address'), symbol: str(), decimals: int(), name: nullable(str()) }, ['address', 'symbol', 'decimals']),
      outcomes: arr(ref('OutcomeQuote')),
      pools: arr(ref('Pool')),
      liquidity: ref('Decimal'),
      volume_24h: ref('Decimal'),
      volume_total: ref('Decimal'),
      traders: int(),
      open_interest: ref('Decimal'),
      created_at: ref('IsoDate'),
      created_tx: ref('Hash32'),
    },
    ['chain_id', 'address', 'seer_url', 'condition_id', 'question_id', 'collateral', 'outcomes', 'pools', 'liquidity', 'volume_24h', 'volume_total', 'traders', 'open_interest', 'created_at', 'created_tx'],
  ),
  OracleAnswer: obj({ answer: ref('RealityAnswer'), bond: ref('Decimal'), answerer: ref('Address'), at: ref('IsoDate'), tx_hash: ref('Hash32') }, ['answer', 'bond', 'answerer', 'at', 'tx_hash']),
  Arbitration: obj(
    {
      requested: bool(),
      requested_at: nullable(ref('IsoDate')),
      requester: nullable(ref('Address')),
      dispute_id: nullable(str()),
      court: nullable(str()),
      cost: ref('Decimal'),
      status: str(undefined, { enum: ['not_requested', 'pending', 'appeal_period', 'ruled'] }),
      ruling: nullable(ref('RealityAnswer')),
      appeal_deadline: nullable(ref('IsoDate')),
      kleros_url: nullable(str(undefined, { format: 'uri' })),
    },
    ['requested', 'cost', 'status'],
    'Kleros arbitration; for Gnosis markets it is requested and paid in ETH on Ethereum',
  ),
  Oracle: obj(
    {
      chain_id: int(),
      reality_question_id: ref('Hash32'),
      reality_url: str(undefined, { format: 'uri' }),
      template_id: int(),
      opening_time: ref('IsoDate'),
      timeout_seconds: int('302400 (3.5 days) for the official Seer factory'),
      min_bond: ref('Decimal'),
      bond_token: str(),
      current_answer: nullable(ref('RealityAnswer')),
      current_bond: nullable(ref('Decimal')),
      finalizes_at: nullable(ref('IsoDate')),
      is_finalized: bool(),
      final_answer: nullable(ref('RealityAnswer')),
      history: arr(ref('OracleAnswer')),
      arbitration: ref('Arbitration'),
    },
    ['chain_id', 'reality_question_id', 'reality_url', 'template_id', 'opening_time', 'timeout_seconds', 'min_bond', 'bond_token', 'is_finalized', 'history', 'arbitration'],
  ),
  Evidence: obj(
    {
      id: str(),
      claim_id: str(),
      kind: str(undefined, { enum: ['counterexample', 'rebuttal', 'clarification', 'commitment'] }),
      title: str('UNTRUSTED user content — render as plain text'),
      summary: str('UNTRUSTED user content — render as plain text or sanitized Markdown only'),
      submitter: ref('Address'),
      submitted_at: ref('IsoDate'),
      block_number: int(),
      tx_hash: ref('Hash32'),
      chain_id: int('Chain of the submission transaction (1 for Gnosis markets: ERC-1497 on the Ethereum foreign proxy)'),
      uri: str(),
      content_hash: ref('Hash32'),
      timely: bool('Block timestamp <= evidence deadline'),
      reproduction: nullable(obj({ command: str(), environment: str(), expected: str(), actual: str(), steps: nullable(arr(str())) }, ['command', 'environment', 'expected', 'actual'])),
      attachments: arr(obj({ name: str(), uri: str(), mime: str(), size: int(), hash: ref('Hash32') }, ['name', 'uri', 'mime', 'size', 'hash'])),
      commitment: nullable(obj({ hash: ref('Hash32'), revealed: bool(), revealed_at: nullable(ref('IsoDate')) }, ['hash', 'revealed'])),
    },
    ['id', 'claim_id', 'kind', 'title', 'summary', 'submitter', 'submitted_at', 'block_number', 'tx_hash', 'chain_id', 'uri', 'content_hash', 'timely', 'attachments'],
  ),
  EvidenceList: obj({ items: arr(ref('Evidence')) }, ['items']),
  TimelineEvent: obj(
    {
      id: str(),
      kind: str(undefined, {
        enum: [
          'drafted', 'manifest_pinned', 'market_created', 'liquidity_added', 'liquidity_removed', 'evidence_submitted', 'evidence_deadline',
          'oracle_opened', 'answer_posted', 'answer_challenged', 'arbitration_requested', 'ruling', 'finalized', 'redeemed',
        ],
      }),
      at: ref('IsoDate'),
      title: str(),
      detail: nullable(str()),
      actor: nullable(ref('Address')),
      tx_hash: nullable(ref('Hash32')),
      scheduled: nullable(bool('true for future scheduled events')),
    },
    ['id', 'kind', 'at', 'title'],
  ),
  PublicationStep: obj(
    {
      id: str(undefined, { enum: ['upload_manifest', 'create_market', 'approve_collateral', 'split_position', 'add_liquidity_yes', 'add_liquidity_no', 'register_claim'] }),
      status: str(undefined, { enum: ['idle', 'awaiting_signature', 'pending', 'confirmed', 'failed', 'skipped'] }),
      tx_hash: nullable(ref('Hash32')),
      error: nullable(str()),
      at: nullable(ref('IsoDate')),
    },
    ['id', 'status'],
  ),
  ClaimDetail: {
    allOf: [
      ref('ClaimSummary'),
      obj(
        {
          manifest: ref('ClaimManifest'),
          manifest_uri: str(),
          manifest_hash: ref('Hash32'),
          market: nullable(ref('Market')),
          oracle: nullable(ref('Oracle')),
          evidence: arr(ref('Evidence')),
          timeline: arr(ref('TimelineEvent')),
          publication: nullable(obj({ steps: arr(ref('PublicationStep')), resumable: bool(), note: nullable(str()) }, ['steps', 'resumable'], 'Present for publishing/failed claims')),
          funding: nullable(obj({ liquidity: ref('Decimal'), spending_limit: ref('Decimal'), withdrawable: bool() }, ['liquidity', 'spending_limit', 'withdrawable'])),
        },
        ['manifest', 'manifest_uri', 'manifest_hash', 'evidence', 'timeline'],
      ),
    ],
  },
  PriceHistory: obj(
    {
      claim_id: str(),
      range: str(undefined, { enum: ['24h', '7d', '30d', 'all'] }),
      points: arr(
        { type: 'array', prefixItems: [int('t, unix ms'), num('yes price'), num('no price'), nullable(num('volume in collateral'))], minItems: 4, maxItems: 4 },
        'Hourly points, oldest first: [t_ms, yes, no, volume]',
      ),
    },
    ['claim_id', 'range', 'points'],
  ),
  Depth: obj(
    {
      claim_id: str(),
      outcome: str(undefined, { enum: ['yes', 'no'] }),
      mid: num(),
      at: ref('IsoDate'),
      bids: arr({ type: 'array', prefixItems: [num('price'), num('cumulative size, outcome tokens')], minItems: 2, maxItems: 2 }, 'Descending price'),
      asks: arr({ type: 'array', prefixItems: [num('price'), num('cumulative size, outcome tokens')], minItems: 2, maxItems: 2 }, 'Ascending price'),
    },
    ['claim_id', 'outcome', 'mid', 'at', 'bids', 'asks'],
  ),
  Activity: obj(
    {
      id: str(),
      type: ref('ActivityType'),
      claim_id: str(),
      claim_number: int(),
      claim_title: str(),
      actor: ref('Address'),
      at: ref('IsoDate'),
      tx_hash: ref('Hash32'),
      chain_id: int(),
      amount: nullable(str('Signed collateral flow from the actor’s perspective (+ in, − out)', { pattern: '^-?\\d+(\\.\\d+)?$' })),
      token: nullable(str()),
      outcome: nullable(ref('Outcome')),
      side: nullable(str(undefined, { enum: ['buy', 'sell'] })),
      summary: str(),
      status: nullable(str(undefined, { enum: ['confirmed', 'pending', 'failed'] })),
    },
    ['id', 'type', 'claim_id', 'claim_number', 'claim_title', 'actor', 'at', 'tx_hash', 'chain_id', 'summary'],
  ),
  ActivityPage: obj({ items: arr(ref('Activity')), next_cursor: nullable(str()), total: nullable(int()) }, ['items']),
  Portfolio: obj(
    {
      address: ref('Address'),
      positions: arr(
        obj(
          {
            claim_id: str(),
            claim_number: int(),
            claim_title: str(),
            status: ref('ClaimStatus'),
            outcome: ref('Outcome'),
            balance: ref('Decimal'),
            avg_price: nullable(num()),
            mark_price: num(),
            value: ref('Decimal'),
            redeemable: bool(),
            redeemable_amount: nullable(ref('Decimal')),
          },
          ['claim_id', 'claim_number', 'claim_title', 'status', 'outcome', 'balance', 'mark_price', 'value', 'redeemable'],
        ),
      ),
      liquidity: arr(
        obj(
          {
            claim_id: str(),
            claim_number: int(),
            claim_title: str(),
            token_id: str(),
            pool: ref('Address'),
            outcome: str(undefined, { enum: ['yes', 'no'] }),
            deposited: ref('Decimal'),
            current_value: ref('Decimal'),
            fees_earned: ref('Decimal'),
            withdrawable: bool('Recoverable by withdrawing; not a guaranteed value'),
            in_range: bool(),
          },
          ['claim_id', 'claim_number', 'claim_title', 'token_id', 'pool', 'outcome', 'deposited', 'current_value', 'fees_earned', 'withdrawable', 'in_range'],
        ),
      ),
      totals: obj(
        {
          positions_value: ref('Decimal'),
          liquidity_value: ref('Decimal'),
          redeemable: ref('Decimal'),
          deposited_all_time: ref('Decimal'),
          withdrawn_all_time: ref('Decimal'),
          fees_paid_all_time: ref('Decimal'),
        },
        ['positions_value', 'liquidity_value', 'redeemable', 'deposited_all_time', 'withdrawn_all_time', 'fees_paid_all_time'],
      ),
    },
    ['address', 'positions', 'liquidity', 'totals'],
  ),
  Policy: obj(
    {
      id: str(),
      family: ref('PolicyFamily'),
      version: str(),
      title: str(),
      summary: str(),
      status: str(undefined, { enum: ['enabled', 'gated', 'draft', 'retired'] }),
      gate_reason: nullable(str()),
      content_hash: ref('Hash32'),
      uri: str(),
      text: str('Full policy text (Markdown); content_hash = keccak256(utf8(text))'),
      intended_use: arr(str()),
      examples: arr(str()),
      claim_classes: arr(obj({ id: str(), label: str(), description: str() }, ['id', 'label', 'description'])),
      parameters: arr({ type: 'object', additionalProperties: true }, 'Verbatim domain PolicyParameterSpec[] (camelCase)'),
      evidence_requirements: arr(str()),
      exclusions: arr(str()),
      outcome_rules: obj({ yes: str(), no: str(), invalid: str() }, ['yes', 'no', 'invalid']),
      published_at: ref('IsoDate'),
      supersedes: nullable(str()),
    },
    ['id', 'family', 'version', 'title', 'summary', 'status', 'content_hash', 'uri', 'text', 'intended_use', 'examples', 'claim_classes', 'parameters', 'evidence_requirements', 'exclusions', 'outcome_rules', 'published_at'],
  ),
  PolicyList: obj({ items: arr(ref('Policy')) }, ['items']),
  Stats: obj(
    {
      open_claims: int(),
      resolved_claims: int(),
      total_liquidity: ref('Decimal'),
      volume_30d: ref('Decimal'),
      evidence_submissions: int(),
      counterexamples_accepted: int('Claims resolved YES'),
      collateral_symbol: str(),
    },
    ['open_claims', 'resolved_claims', 'total_liquidity', 'volume_30d', 'evidence_submissions', 'counterexamples_accepted', 'collateral_symbol'],
  ),
  Draft: obj(
    {
      id: str(),
      owner: str('GitHub login or address'),
      created_at: ref('IsoDate'),
      updated_at: ref('IsoDate'),
      stage: str(undefined, { enum: ['source', 'policy', 'claim', 'deadlines', 'funding', 'review', 'publish'] }),
      source: nullable({ type: 'object', additionalProperties: true, description: 'Verbatim domain SourceRef' }),
      spec: { type: 'object', additionalProperties: true, description: 'Verbatim domain Partial<ClaimSpec> (user-authored; keys preserved)' },
      funding: nullable({ type: 'object', additionalProperties: true, description: 'Verbatim domain Partial<FundingInput>' }),
      publication: nullable({ type: 'object', additionalProperties: true, description: 'Verbatim persisted tx progress for recovery' }),
    },
    ['id', 'owner', 'created_at', 'updated_at', 'stage', 'spec'],
  ),
  DraftList: obj({ items: arr(ref('Draft')) }, ['items']),
  Wallet: obj(
    { address: ref('Address'), chain_id: int(), verified_at: ref('IsoDate'), label: nullable(str()), primary: bool() },
    ['address', 'chain_id', 'verified_at', 'primary'],
    'Wallet linked by SIWE (EIP-4361); verified_at is when the signature was checked',
  ),
  WalletLink: {
    allOf: [
      ref('Wallet'),
      obj({ siwe: nullable(obj({ message: str(), signature: ref('Hex') }, ['message', 'signature'], 'Optional: the API may re-verify the SIWE signature')) }, []),
    ],
  },
  Preferences: obj(
    {
      default_chain_id: int(),
      default_spending_limit: ref('Decimal'),
      notify_on_evidence: bool(),
      notify_on_answer: bool(),
      notify_on_deadline: bool(),
      notification_email: nullable(str(undefined, { format: 'email' })),
      display_currency: str(undefined, { enum: ['collateral', 'usd'] }),
    },
    ['default_chain_id', 'default_spending_limit', 'notify_on_evidence', 'notify_on_answer', 'notify_on_deadline', 'display_currency'],
  ),
  PreferencesPatch: { type: 'object', description: 'Any subset of Preferences', properties: {}, additionalProperties: true },
  Account: obj(
    {
      id: str(),
      github: obj(
        { login: str(), id: int(), name: nullable(str()), avatar_url: str(), html_url: str(), scopes: arr(str('Granted OAuth scopes (Pine requests read:user only)')) },
        ['login', 'id', 'avatar_url', 'html_url', 'scopes'],
      ),
      wallets: arr(ref('Wallet')),
      preferences: ref('Preferences'),
      created_at: ref('IsoDate'),
      demo: bool(),
    },
    ['id', 'github', 'wallets', 'preferences', 'created_at', 'demo'],
  ),
  AccountUpsert: obj(
    {
      github: obj({ login: str(), id: int(), name: nullable(str()), avatar_url: str(), html_url: str(), scopes: arr(str()) }, ['login', 'id', 'avatar_url', 'html_url', 'scopes']),
      demo: bool(),
    },
    ['github', 'demo'],
  ),
  AccountExport: { type: 'object', additionalProperties: true, description: 'Everything stored for the account (GDPR-style export)' },
}

// Make the PreferencesPatch reflect Preferences property schemas (all optional)
;(schemas.PreferencesPatch as Schema).properties = (schemas.Preferences as Schema).properties

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const qp = (name: string, schema: Schema, description: string, extra: Schema = {}) => ({ name, in: 'query', required: false, description, schema, ...extra })
const pp = (name: string, schema: Schema, description: string) => ({ name, in: 'path', required: true, description, schema })

const claimIdParam = pp('id', str(undefined, { example: 'pine-0009' }), 'Pine claim id (pine-0042); `PINE-0042` and `42` are accepted')

// ---------------------------------------------------------------------------
// Examples from fixtures
// ---------------------------------------------------------------------------

const byNumber = (n: number) => {
  const c = fixtures.claims.find((x) => x.number === n)
  if (!c) throw new Error(`fixture claim ${n} missing`)
  return c
}

async function examples() {
  const flagship = byNumber(9)
  const arbitration = byNumber(5)
  const publishing = byNumber(15)
  const resolvedYes = byNumber(2)
  const now = fixtures.anchor
  const openSummaries = fixtures.claims.filter((c) => c.status === 'open').slice(0, 2).map(toSummary)
  const demo = fixtures.demo.wallet
  const portfolio = fixtures.portfolios[demo.toLowerCase()]
  if (!portfolio) throw new Error('demo portfolio missing')
  const account = fixtures.accounts[0]
  const draft = fixtures.drafts[0]
  if (!account || !draft) throw new Error('account/draft fixtures missing')
  const prices = (fixtures.prices[flagship.id] ?? []).slice(-6)
  return {
    claimPage: { value: { items: openSummaries.map(claimSummaryToWire), next_cursor: '2', total: 8 }, summary: 'Open claims, newest first' },
    flagship: { value: claimDetailToWire(flagship), summary: 'Open BOT-001 claim (gateway-balancer keeper)' },
    arbitration: { value: claimDetailToWire(arbitration), summary: 'Claim in Kleros arbitration (appeal period)' },
    publishing: { value: claimDetailToWire(publishing), summary: 'Partially published claim — split rejected, resumable' },
    prices: { value: pricesToWire(flagship.id, '24h', prices), summary: 'Last hours of hourly YES/NO prices' },
    depth: { value: depthToWire(flagship.id, buildDepth(flagship, 'yes', now)), summary: 'YES order-book style depth' },
    evidence: { value: { items: resolvedYes.evidence.map(evidenceToWire) }, summary: 'Evidence of a claim resolved YES' },
    activity: { value: { items: fixtures.activity.filter((a) => a.claimId === arbitration.id).slice(0, 5).map(activityToWire), next_cursor: '5', total: 24 }, summary: 'Recent activity of one claim' },
    portfolio: { value: portfolioToWire(portfolio), summary: 'Demo wallet: positions (one redeemable), LP (one out of range)' },
    policies: { value: { items: POLICIES.map(policyToWire) }, summary: 'Policy catalog (SC-001 gated)' },
    policy: { value: policyToWire(POLICIES.find((p) => p.id === 'BOT-001') ?? (POLICIES[0] as (typeof POLICIES)[number])), summary: 'BOT-001 @ 0.1.0' },
    stats: { value: statsToWire(await new MockDataProvider({ latency: false, persist: false, now: () => now }).getStats()), summary: 'Platform counters' },
    drafts: { value: { items: fixtures.drafts.map(draftToWire) }, summary: 'Drafts owned by mara-okafor' },
    draft: { value: draftToWire(draft), summary: 'One draft at the claim stage' },
    account: { value: accountToWire(account), summary: 'Demo account with two SIWE-linked wallets' },
    wallet: { value: { ...walletToWire(account.wallets[1] ?? (account.wallets[0] as (typeof account.wallets)[number])), siwe: null }, summary: 'Link a SIWE-verified wallet' },
    accountUpsert: {
      value: { github: { login: account.github.login, id: account.github.id, name: account.github.name ?? null, avatar_url: account.github.avatarUrl, html_url: account.github.htmlUrl, scopes: ['read:user'] }, demo: false },
      summary: 'Create or refresh from the GitHub identity',
    },
    preferencesPatch: { value: { default_spending_limit: '250', notify_on_answer: false }, summary: 'Partial update' },
    accountExport: { value: { exported_at: new Date(now).toISOString(), format: 'pine-account-export/v1', account: accountToWire(account), drafts: fixtures.drafts.map(draftToWire) }, summary: 'Full export' },
  }
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export async function buildOpenApi(): Promise<Record<string, unknown>> {
  const ex = await examples()
  const exRef = (k: keyof typeof ex) => ({ $ref: `#/components/examples/${k}` })
  const one = (k: keyof typeof ex) => ({ [k]: exRef(k) })
  const bearer = [{ bearerAuth: [] }]
  const writeErrors = { '401': UNAUTHORIZED, '429': RATE_LIMITED }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Pine REST indexer API',
      version: '1.0.0',
      summary: 'Indexed claim/market/oracle/evidence state plus off-chain drafts and accounts for the Pine frontends.',
      description: [
        'Contract for the REST indexer the Pine frontends read when `NEXT_PUBLIC_PINE_DATA_SOURCE=rest` (base URL in `NEXT_PUBLIC_PINE_API_URL`).',
        'This repository does not implement the server; `@pine/data` RestDataProvider, RestDraftStore and RestAccountStore are the clients.',
        '',
        'Conventions:',
        '- Read-model envelopes are snake_case. Optional values may be `null` (clients treat null and absent the same).',
        '- Embedded documents are verbatim domain JSON (camelCase): `manifest` (hashed — never re-key it), policy `parameters`, and draft `source`/`spec`/`funding`/`publication`.',
        '- Timestamps are ISO-8601 UTC (`2026-10-10T18:00:00Z`). Amounts are decimal strings in human units. Prices are numbers in [0, 1].',
        '- Lists paginate with an opaque `cursor`; responses return `next_cursor` (absent/null on the last page).',
        '- Errors use `{ "error": { "code", "message" } }` where code is one of network, not_found, bad_response, unauthorized, rate_limited, unsupported.',
        '- Reads are public (CORS `*`). Draft and account endpoints require `Authorization: Bearer <token>` issued by the app server after GitHub sign-in.',
        '',
        'Language: YES means a counterexample was demonstrated; NO means no qualifying counterexample was submitted (not a statement that the code is correct). Prices are the market-implied chance a qualifying counterexample is accepted. Liquidity is not a bounty. Invalid is not a refund.',
        '',
        'Examples are generated from the @pine/data demo fixtures (timestamps are relative to generation time).',
      ].join('\n'),
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [
      { url: 'https://api.pine.example/v1', description: 'Production (placeholder)' },
      { url: 'http://localhost:4000/v1', description: 'Local indexer' },
    ],
    tags: [
      { name: 'claims', description: 'Claims with market, oracle and evidence state' },
      { name: 'activity', description: 'Transaction history and reconciliation' },
      { name: 'portfolio', description: 'Positions and liquidity of an address' },
      { name: 'policies', description: 'Versioned policy catalog' },
      { name: 'stats', description: 'Platform counters' },
      { name: 'drafts', description: 'Claim drafts and persisted publication progress (auth)' },
      { name: 'accounts', description: 'GitHub-linked accounts, SIWE wallets and preferences (auth)' },
    ],
    paths: {
      '/claims': {
        get: {
          operationId: 'listClaims',
          tags: ['claims'],
          summary: 'List claims',
          parameters: [
            qp('status', arr(ref('ClaimStatus')), 'Repeat to match any of several statuses (`?status=open&status=disputed`)', { style: 'form', explode: true }),
            qp('outcome', ref('Outcome'), 'Resolved outcome'),
            qp('policy_id', str(undefined, { example: 'BOT-001' }), 'Policy id'),
            qp('family', ref('PolicyFamily'), 'Policy family'),
            qp('repo', str(undefined, { example: 'kleros/gateway-balancer-bot' }), 'owner/name, case-insensitive'),
            qp('creator', ref('Address'), 'Creator address, case-insensitive'),
            qp('chain_id', int(), 'Chain id'),
            qp('search', str(), 'Whitespace-separated terms; every term must match title, violation, requirement, repo, PR, policy or claim number'),
            qp('sort', ref('ClaimSort'), 'Default newest. `deadline`: upcoming deadlines first (soonest), then past ones'),
            qp('cursor', str(), 'Opaque cursor from `next_cursor`'),
            qp('limit', int(undefined, { minimum: 1, maximum: 100, default: 20 }), 'Page size'),
          ],
          responses: { '200': { description: 'A page of claims', content: json(ref('ClaimPage'), one('claimPage')) }, '400': BAD_REQUEST, '429': RATE_LIMITED },
        },
      },
      '/claims/{id}': {
        get: {
          operationId: 'getClaim',
          tags: ['claims'],
          summary: 'Claim detail with manifest, market, oracle, evidence and timeline',
          parameters: [claimIdParam],
          responses: {
            '200': { description: 'The claim', content: json(ref('ClaimDetail'), { flagship: exRef('flagship'), arbitration: exRef('arbitration'), publishing: exRef('publishing') }) },
            '404': NOT_FOUND,
          },
        },
      },
      '/markets/{chain_id}/{address}/claim': {
        get: {
          operationId: 'getClaimByMarket',
          tags: ['claims'],
          summary: 'Claim for a Seer market address',
          parameters: [pp('chain_id', int(), 'Chain id'), pp('address', ref('Address'), 'Seer market address, case-insensitive')],
          responses: { '200': { description: 'The claim', content: json(ref('ClaimDetail'), one('flagship')) }, '404': MARKET_NOT_FOUND },
        },
      },
      '/claims/{id}/prices': {
        get: {
          operationId: 'getPriceHistory',
          tags: ['claims'],
          summary: 'Hourly price history',
          parameters: [claimIdParam, qp('range', str(undefined, { enum: ['24h', '7d', '30d', 'all'], default: '7d' }), 'Time range')],
          responses: { '200': { description: 'Price points', content: json(ref('PriceHistory'), one('prices')) }, '404': NOT_FOUND },
        },
      },
      '/claims/{id}/depth': {
        get: {
          operationId: 'getDepth',
          tags: ['claims'],
          summary: 'Executable depth around the mid price',
          parameters: [claimIdParam, { ...qp('outcome', str(undefined, { enum: ['yes', 'no'] }), 'Outcome side'), required: true }],
          responses: { '200': { description: 'Depth snapshot', content: json(ref('Depth'), one('depth')) }, '404': errorResponse('Unknown claim, or the market has no liquidity', 'not_found', 'No liquidity for pine-0015') },
        },
      },
      '/claims/{id}/evidence': {
        get: {
          operationId: 'listEvidence',
          tags: ['claims'],
          summary: 'Evidence submissions, oldest first (untrusted content)',
          parameters: [claimIdParam],
          responses: { '200': { description: 'Evidence', content: json(ref('EvidenceList'), one('evidence')) }, '404': NOT_FOUND },
        },
      },
      '/activity': {
        get: {
          operationId: 'listActivity',
          tags: ['activity'],
          summary: 'Activity, newest first',
          parameters: [
            qp('claim_id', str(), 'Filter by claim'),
            qp('account', ref('Address'), 'Filter by actor address'),
            qp('types', arr(ref('ActivityType')), 'Repeat for several types', { style: 'form', explode: true }),
            qp('cursor', str(), 'Opaque cursor'),
            qp('limit', int(undefined, { minimum: 1, maximum: 200, default: 25 }), 'Page size'),
          ],
          responses: { '200': { description: 'A page of activity', content: json(ref('ActivityPage'), one('activity')) }, '400': BAD_ACTIVITY_REQUEST },
        },
      },
      '/portfolio/{address}': {
        get: {
          operationId: 'getPortfolio',
          tags: ['portfolio'],
          summary: 'Outcome positions, LP positions and totals of an address (empty for unknown addresses)',
          parameters: [pp('address', ref('Address'), 'Wallet address, case-insensitive')],
          responses: { '200': { description: 'Portfolio', content: json(ref('Portfolio'), one('portfolio')) } },
        },
      },
      '/policies': {
        get: {
          operationId: 'listPolicies',
          tags: ['policies'],
          summary: 'Policy catalog',
          responses: { '200': { description: 'Policies', content: json(ref('PolicyList'), one('policies')) } },
        },
      },
      '/policies/{id}': {
        get: {
          operationId: 'getPolicy',
          tags: ['policies'],
          summary: 'One policy version (latest when version is omitted)',
          parameters: [pp('id', str(undefined, { example: 'BOT-001' }), 'Policy id'), qp('version', str(undefined, { example: '0.1.0' }), 'Semver')],
          responses: { '200': { description: 'Policy', content: json(ref('Policy'), one('policy')) }, '404': POLICY_NOT_FOUND },
        },
      },
      '/stats': {
        get: {
          operationId: 'getStats',
          tags: ['stats'],
          summary: 'Platform counters',
          responses: { '200': { description: 'Stats', content: json(ref('Stats'), one('stats')) } },
        },
      },
      '/drafts': {
        get: {
          operationId: 'listDrafts',
          tags: ['drafts'],
          summary: 'Drafts of an owner, most recently updated first',
          security: bearer,
          parameters: [{ ...qp('owner', str(), 'GitHub login or address'), required: true }],
          responses: { '200': { description: 'Drafts', content: json(ref('DraftList'), one('drafts')) }, ...writeErrors },
        },
      },
      '/drafts/{id}': {
        get: {
          operationId: 'getDraft',
          tags: ['drafts'],
          summary: 'One draft',
          security: bearer,
          parameters: [pp('id', str(), 'Draft id')],
          responses: { '200': { description: 'Draft', content: json(ref('Draft'), one('draft')) }, '404': DRAFT_NOT_FOUND, ...writeErrors },
        },
        put: {
          operationId: 'saveDraft',
          tags: ['drafts'],
          summary: 'Create or replace a draft (the server sets updated_at)',
          security: bearer,
          parameters: [pp('id', str(), 'Draft id')],
          requestBody: { required: true, content: json(ref('Draft'), one('draft')) },
          responses: { '200': { description: 'Saved draft', content: json(ref('Draft'), one('draft')) }, '400': BAD_BODY, ...writeErrors },
        },
        delete: {
          operationId: 'deleteDraft',
          tags: ['drafts'],
          summary: 'Delete a draft',
          security: bearer,
          parameters: [pp('id', str(), 'Draft id')],
          responses: { '204': { description: 'Deleted' }, '404': DRAFT_NOT_FOUND, ...writeErrors },
        },
      },
      '/accounts/{login}': {
        get: {
          operationId: 'getAccount',
          tags: ['accounts'],
          summary: 'Account of a GitHub login',
          security: bearer,
          parameters: [pp('login', str(), 'GitHub login')],
          responses: { '200': { description: 'Account', content: json(ref('Account'), one('account')) }, '404': ACCOUNT_NOT_FOUND, ...writeErrors },
        },
        put: {
          operationId: 'upsertAccount',
          tags: ['accounts'],
          summary: 'Create or refresh an account from the GitHub identity',
          security: bearer,
          parameters: [pp('login', str(), 'GitHub login')],
          requestBody: { required: true, content: json(ref('AccountUpsert'), one('accountUpsert')) },
          responses: { '200': { description: 'Account', content: json(ref('Account'), one('account')) }, ...writeErrors },
        },
        delete: {
          operationId: 'deleteAccount',
          tags: ['accounts'],
          summary: 'Delete the account and its off-chain data (on-chain records are unaffected)',
          security: bearer,
          parameters: [pp('login', str(), 'GitHub login')],
          responses: { '204': { description: 'Deleted' }, ...writeErrors },
        },
      },
      '/accounts/{login}/wallets': {
        post: {
          operationId: 'linkWallet',
          tags: ['accounts'],
          summary: 'Link a SIWE-verified wallet (first wallet becomes primary)',
          security: bearer,
          parameters: [pp('login', str(), 'GitHub login')],
          requestBody: { required: true, content: json(ref('WalletLink'), one('wallet')) },
          responses: { '200': { description: 'Account', content: json(ref('Account'), one('account')) }, '400': BAD_BODY, '404': ACCOUNT_NOT_FOUND, ...writeErrors },
        },
      },
      '/accounts/{login}/wallets/{address}': {
        delete: {
          operationId: 'unlinkWallet',
          tags: ['accounts'],
          summary: 'Unlink a wallet (another wallet becomes primary if needed)',
          security: bearer,
          parameters: [pp('login', str(), 'GitHub login'), pp('address', ref('Address'), 'Wallet address')],
          responses: { '200': { description: 'Account', content: json(ref('Account'), one('account')) }, '404': ACCOUNT_NOT_FOUND, ...writeErrors },
        },
      },
      '/accounts/{login}/wallets/{address}/primary': {
        post: {
          operationId: 'setPrimaryWallet',
          tags: ['accounts'],
          summary: 'Make a linked wallet primary',
          security: bearer,
          parameters: [pp('login', str(), 'GitHub login'), pp('address', ref('Address'), 'Wallet address')],
          responses: { '200': { description: 'Account', content: json(ref('Account'), one('account')) }, '404': ACCOUNT_NOT_FOUND, ...writeErrors },
        },
      },
      '/accounts/{login}/preferences': {
        patch: {
          operationId: 'updatePreferences',
          tags: ['accounts'],
          summary: 'Update preferences (partial)',
          security: bearer,
          parameters: [pp('login', str(), 'GitHub login')],
          requestBody: { required: true, content: json(ref('PreferencesPatch'), one('preferencesPatch')) },
          responses: { '200': { description: 'Account', content: json(ref('Account'), one('account')) }, '400': BAD_BODY, '404': ACCOUNT_NOT_FOUND, ...writeErrors },
        },
      },
      '/accounts/{login}/export': {
        get: {
          operationId: 'exportAccount',
          tags: ['accounts'],
          summary: 'Export all off-chain data of the account',
          security: bearer,
          parameters: [pp('login', str(), 'GitHub login')],
          responses: { '200': { description: 'Export', content: json(ref('AccountExport'), one('accountExport')) }, '404': ACCOUNT_NOT_FOUND, ...writeErrors },
        },
      },
    },
    components: {
      schemas,
      examples: ex,
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Token issued by the app server after GitHub sign-in (JWT or opaque)' },
      },
    },
  }
}
