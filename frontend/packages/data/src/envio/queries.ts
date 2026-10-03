/**
 * Hasura-style queries against docs/indexer/envio/schema.graphql.
 * BigInt / BigDecimal variables and results are strings. Every paginated order_by ends with a unique
 * key (`id`) so offset pages never skip or duplicate rows.
 */

export const CLAIM_SUMMARY_FIELDS = /* GraphQL */ `
  id
  chainId
  claimId
  number
  title
  violation
  policyId
  policyVersion
  policyFamily
  policyTitle
  repoOwner
  repoName
  commitSha
  prNumber
  prTitle
  evidenceDeadlineTs
  creator
  sponsored
  phase
  currentAnswer
  finalizeTs
  outcome
  yesPrice
  noPrice
  invalidPrice
  yesPrice24hAgo
  liquidity
  volume
  volume24h
  openInterest
  traders
  evidenceCount
  createdAt
  lastActivityAt
  createdTx
  manifestUri
  manifestHash
  market { address collateralSymbol }
`

export const EVIDENCE_FIELDS = /* GraphQL */ `
  id
  questionId
  chainId
  party
  uri
  blockNumber
  timestamp
  txHash
  timely
  hydrated
  kind
  title
  summary
  contentHash
  reproduction
  attachments
  commitment
`

export const LIST_CLAIMS = /* GraphQL */ `
  query ListClaims($where: Claim_bool_exp!, $orderBy: [Claim_order_by!], $limit: Int!, $offset: Int!) {
    Claim(where: $where, order_by: $orderBy, limit: $limit, offset: $offset) {
      ${CLAIM_SUMMARY_FIELDS}
    }
  }
`

export const CLAIM_DETAIL = /* GraphQL */ `
  query ClaimDetail($where: Claim_bool_exp!) {
    Claim(where: $where, order_by: [{ createdAt: asc }], limit: 1) {
      ${CLAIM_SUMMARY_FIELDS}
      manifestValid
      manifest
      market {
        id
        chainId
        address
        collateralToken
        collateralSymbol
        conditionId
        questionId
        realityQuestionId
        templateId
        openingTs
        payoutReported
        payoutNumerators
        blockTimestamp
        txHash
        outcomes(order_by: [{ index: asc }]) { index label token price change24h }
        pools { address dex outcomeIndex feeBps tvlCollateral }
      }
      question {
        questionId
        templateId
        openingTs
        timeout
        minBond
        finalizeTs
        isPendingArbitration
        bestAnswer
        bond
        finalizedByArbitrator
        answers(order_by: [{ timestamp: asc }]) { answer bond user timestamp txHash }
        arbitration { requester requestedAt disputeId court cost status ruling rulingAt appealPeriodEnd }
      }
      activity(
        where: { type: { _in: ["liquidity_added", "liquidity_removed", "finalized", "redeemed"] } }
        order_by: [{ timestamp: asc }]
        limit: 100
      ) { id type actor timestamp txHash summary amount token }
    }
  }
`

export const EVIDENCE_BY_QUESTION = /* GraphQL */ `
  query EvidenceByQuestion($questionId: String!) {
    Evidence(where: { questionId: { _eq: $questionId } }, order_by: [{ timestamp: asc }], limit: 500) {
      ${EVIDENCE_FIELDS}
    }
  }
`

export const CLAIM_REF = /* GraphQL */ `
  query ClaimRef($where: Claim_bool_exp!) {
    Claim(where: $where, order_by: [{ createdAt: asc }], limit: 1) {
      id
      claimId
      evidenceDeadlineTs
      market { realityQuestionId }
    }
  }
`

export const PRICE_CANDLES = /* GraphQL */ `
  query PriceCandles($claim: String!, $from: numeric!) {
    PriceCandle(
      where: { claim_id: { _eq: $claim }, periodStart: { _gte: $from } }
      order_by: [{ periodStart: desc }]
      limit: 5000
    ) { periodStart yesClose noClose volume }
  }
`

export const POOL_FOR_DEPTH = /* GraphQL */ `
  query PoolForDepth($claim: String!, $outcomeIndex: Int!) {
    Pool(where: { claim_id: { _eq: $claim }, outcomeIndex: { _eq: $outcomeIndex } }, order_by: [{ tvlCollateral: desc }], limit: 1) {
      address
      sqrtPriceX96
      liquidity
      outcomeIsToken0
      price
      tvlCollateral
    }
  }
`

export const LIST_ACTIVITY = /* GraphQL */ `
  query ListActivity($where: ActivityEvent_bool_exp!, $limit: Int!, $offset: Int!) {
    ActivityEvent(where: $where, order_by: [{ timestamp: desc }, { id: asc }], limit: $limit, offset: $offset) {
      id
      type
      claimNumber
      claimTitle
      actor
      timestamp
      txHash
      chainId
      amount
      token
      outcome
      side
      summary
      claim { claimId }
    }
  }
`

export const PORTFOLIO = /* GraphQL */ `
  query Portfolio($id: String!) {
    Account_by_pk(id: $id) {
      id
      depositedAllTime
      withdrawnAllTime
      feesPaidAllTime
      positions(where: { balance: { _gt: "0" } }) {
        outcomeIndex
        balance
        avgPrice
        claim { claimId number title phase finalizeTs currentAnswer outcome evidenceDeadlineTs yesPrice noPrice invalidPrice }
      }
      liquidityPositions(where: { closed: { _eq: false } }) {
        tokenId
        outcomeIndex
        depositedCollateral
        currentValue
        feesEarned
        inRange
        pool { address }
        claim { claimId number title }
      }
    }
  }
`

export const STATS = /* GraphQL */ `
  query Stats($since: numeric!, $openWhere: Claim_bool_exp!) {
    PlatformStats_by_pk(id: "global") {
      claimCount
      resolvedClaims
      counterexamplesAccepted
      evidenceSubmissions
      totalLiquidity
      volumeTotal
      collateralSymbol
    }
    DailyStats(where: { dayStart: { _gte: $since } }, order_by: [{ dayStart: desc }], limit: 31) { dayStart volume }
    open: Claim(where: $openWhere, limit: 1000) { id }
  }
`
