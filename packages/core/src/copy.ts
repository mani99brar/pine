/**
 * Canonical user-facing language (design spec §8). All three apps import this so every surface
 * says the same thing. Rules this file must follow (enforced by test/copy.test.ts):
 *
 * - Never describe code as safe / secure / certified / audited / verified correct.
 * - YES = "Counterexample demonstrated"; NO = "No qualifying counterexample submitted".
 * - Price = "Market-implied chance a qualifying counterexample is accepted" (not a probability of bugs).
 * - Liquidity is never a bounty, reward or guaranteed payment. Invalid is never a refund.
 * - The evidence deadline is not a trading cutoff.
 */

export interface Disclosure {
  id: string
  title: string
  body: string
}

export interface LaunchGate {
  id: number
  title: string
  body: string
  status: 'open' | 'partially_addressed'
  /** Additive: what this frontend release does about the gate (never implies it is closed). */
  note?: string
}

const outcome = {
  yes: 'Counterexample demonstrated',
  no: 'No qualifying counterexample submitted',
  invalid: 'Resolved invalid',
} as const

const disclosures: Disclosure[] = [
  {
    id: 'capital-at-risk',
    title: 'Your liquidity is capital at risk',
    body:
      'Collateral you deposit as market liquidity is split into Yes, No and Invalid-result outcome tokens and placed in pool positions. Its value moves with trading and with the final outcome, and you can lose part or all of it. Concentrated liquidity can end up held almost entirely in the losing outcome.',
  },
  {
    id: 'not-a-bounty',
    title: 'Liquidity is not a bounty',
    body:
      'Liquidity can subsidize informed trading; it is not a fixed bounty, a reward pool or a guaranteed payment to anyone. LP fee income, investigators’ trading profits and oracle-answer bond rewards are separate mechanisms. There is no promised researcher reward, minimum return, loss reimbursement or guaranteed refund. Submitting evidence alone does not entitle anyone to a payment, and holding a position does not show that its holder did any research.',
  },
  {
    id: 'fees-and-costs',
    title: 'Fees and transaction costs',
    body:
      'Publishing costs network gas for market creation (about 1.65M gas), the collateral approval, splitting collateral into outcome tokens and adding liquidity to each pool. Seer charges no market-creation fee. Pools charge traders a swap fee, and liquidity is added on an external DEX. Gas figures before signing are estimates; your wallet shows the final amount for each transaction. No platform fee is charged in this release.',
  },
  {
    id: 'price-impact-depth',
    title: 'Headline price is not executable depth',
    body:
      'A displayed price is the last or mid price. Larger trades move the price, so the average price you would actually get depends on the depth available at each level. Check price impact and executable depth before trading or judging how informative a price is.',
  },
  {
    id: 'withdrawability',
    title: 'Withdrawing liquidity',
    body:
      'Liquidity positions are ordinary DEX positions that can be withdrawn at any time: nothing in Seer commits them for the investigation period. Withdrawing reduces depth for investigators and returns whatever the position is worth at that moment, which may be less than you deposited. A withdrawable LP position is not a guaranteed future reward for anyone.',
  },
  {
    id: 'oracle-bonds',
    title: 'Oracle answers require bonds',
    body:
      'After the oracle opens, someone must post an answer on Reality.eth with a bond in the chain\u2019s native token (xDAI on Gnosis, ETH elsewhere). Each answer must at least double the previous bond and restarts a fixed 3.5-day timeout. The final correct answerer can claim earlier wrong bonds (2.5% of each is burned); a bond backing a wrong answer can be lost. Pine does not post answers for you. If you choose to answer your own claim, you fund that bond. If nobody answers, the market never resolves.',
  },
  {
    id: 'arbitration-costs',
    title: 'Arbitration costs',
    body:
      'A disputed answer can be escalated to Kleros. For every Seer chain, arbitration runs on the Kleros court on Ethereum mainnet and is requested and paid in ETH there (about 0.17 ETH for 31 General Court jurors as of October 2026; the live fee is quoted at request time). Whoever requests arbitration pays it. A first ruling typically takes about two weeks, plus about 11 days per appeal round, and several relay steps must be called by someone. This cost is not included in your spending limit unless you choose to budget for it.',
  },
  {
    id: 'spending-limit',
    title: 'Your spending limit',
    body:
      'You set a net spending limit before publishing. Pine totals the liquidity deposit and estimated costs against it and blocks any step that would exceed it. Token approvals are for the exact amount needed, never unlimited. Any additional cost, such as an oracle bond or an arbitration fee, requires its own explicit wallet approval.',
  },
  {
    id: 'outcome-semantics',
    title: 'What Yes and No mean',
    body:
      'Yes ("Counterexample demonstrated"): at least one timely, admissible submission demonstrated the specified violation against the pinned commit, environment and policy. No ("No qualifying counterexample submitted"): no timely, admissible submission demonstrated that violation.',
  },
  {
    id: 'no-is-not-correctness',
    title: 'No is not a correctness verdict',
    body:
      'A No outcome means no qualifying counterexample was submitted under the published rules before the deadline. It is not proof that the code is correct, free of defects, production ready or fit for any purpose, and it says nothing about anything outside the single bounded claim.',
  },
  {
    id: 'invalid-not-refund',
    title: 'Invalid is not a refund',
    body:
      'Seer adds an "Invalid result" outcome to every market. If the question resolves invalid (including a Kleros refusal to arbitrate), Yes and No tokens pay nothing; only Invalid-result tokens redeem for collateral. An invalid result is not a refund. If the answer is "answered too soon", the market cannot resolve until the question is reopened and answered again.',
  },
  {
    id: 'price-meaning',
    title: 'What the price measures',
    body:
      'The Yes price is the market-implied chance that a qualifying counterexample is accepted under this claim’s submission and resolution rules. It is not the probability that the software has, or does not have, bugs. Trading volume, wallet counts and collateral do not by themselves prove how deeply or how independently the code was reviewed.',
  },
  {
    id: 'deadline-vs-trading',
    title: 'The evidence deadline is not a trading cutoff',
    body:
      'Evidence must be submitted before the absolute UTC deadline. Outcome tokens may remain tradable and transferable after it; Pine does not promise trading restrictions that the Seer or token contracts do not enforce.',
  },
  {
    id: 'adjudication-timing',
    title: 'Submission and adjudication have separate timing',
    body:
      'A timely submission can still be under adjudication after the evidence deadline. Late discoveries do not reopen a finalized market; they can support a new claim.',
  },
  {
    id: 'frozen-terms',
    title: 'Terms freeze when the market is created',
    body:
      'Once the market is created, its question, policy version, commit and environment cannot change. New commits on the pull request require a new claim and a new market.',
  },
  {
    id: 'no-participation-guarantee',
    title: 'No guaranteed investigation',
    body:
      'Opening a market does not guarantee that anyone investigates, that a full review happens, or that any report is produced. It is adversarial verification of one bounded claim, not a code review, an insurance product or a promise to build software.',
  },
  {
    id: 'no-merge-authority',
    title: 'You decide what to merge',
    body:
      'Pine never merges, deploys or executes anything against your repository or live systems. You alone decide whether to change or merge the code.',
  },
  {
    id: 'untrusted-content',
    title: 'Submitted content is untrusted',
    body:
      'Evidence, repositories, scripts, logs and attachments come from anonymous third parties. Pine shows them as plain text. Reproduce them only in an isolated, resource-limited environment without secrets, production keys or privileged network access. Opening a market authorizes no attack on deployed systems.',
  },
  {
    id: 'unverified-integration',
    title: 'Integration not fully verified',
    body:
      'Contract addresses were read from live deployments in October 2026, but this release has not confirmed that Pine questions are answerable under Seer\u2019s resolution policy, or that Kleros jurors see evidence submitted before a dispute exists. See the launch gates before committing real funds.',
  },
]

const launchGates: LaunchGate[] = [
  {
    id: 1,
    title: 'Target PR/commit and selected claim',
    body: 'Actual target PR/commit and selected claim.',
    status: 'open',
    note: 'The keeper-bot example claim is drafted for illustration; no real PR or commit has been selected.',
  },
  {
    id: 2,
    title: 'Budget meaning and minimum viable funding',
    body: 'Meaning of the $5 budget, fee inclusions, and minimum viable market funding.',
    status: 'open',
    note: 'The funding planner shows every cost line against a spending limit, but no minimum viable funding level has been established.',
  },
  {
    id: 3,
    title: 'Chain, collateral, Seer deployment and fees',
    body: 'Supported chain, collateral asset, Seer deployment, and current fee/contract verification.',
    status: 'partially_addressed',
    note: 'Gnosis with sDAI collateral is the default chain, using the official Seer MarketFactory. Addresses were read on-chain on 2026-10-03 and must be re-read at launch; arbitration is paid in ETH on Ethereum.',
  },
  {
    id: 4,
    title: 'Immutable policy representation and resolution compatibility',
    body: 'Final immutable policy representation and compatibility with Seer/Reality/Kleros resolution.',
    status: 'partially_addressed',
    note: 'Policies are hashed and referenced by id, version and hash in the market question and manifest. Pinned policy URIs and review against Seer\u2019s resolution policy (which binds jurors) are pending.',
  },
  {
    id: 5,
    title: 'Submission mechanism and disclosure design',
    body: 'Submission mechanism, timestamp proof, evidence availability, and disclosure/front-running design.',
    status: 'partially_addressed',
    note: 'ERC-1497 evidence on the Kleros arbitration contract on Ethereum (block timestamp as proof) is the default channel. Juror visibility of pre-dispute evidence, commit\u2013reveal and evidence availability remain unresolved.',
  },
  {
    id: 6,
    title: 'Investigation duration',
    body: 'Investigation duration. A 72-hour window was proposed but has not been agreed; arbitration may take longer.',
    status: 'open',
    note: 'The composer enforces an absolute UTC deadline between 24 hours and 180 days out; no default duration is endorsed. The Reality timeout is fixed at 3.5 days per answer, and Kleros rulings take about two weeks.',
  },
  {
    id: 7,
    title: 'Oracle answers, monitoring and escalation funding',
    body: 'Who supplies oracle answers, monitors disputed answers, and funds escalation when necessary.',
    status: 'open',
    note: 'Pine shows who must act and what it costs at each oracle stage, but does not answer, monitor, relay or fund escalation itself. Whether Kleros bots service Seer\u2019s proxies is unverified.',
  },
  {
    id: 8,
    title: 'Liquidity shape, withdrawal constraints and maximum loss',
    body: 'Initial liquidity shape, potential withdrawal constraints, and sponsor/customer maximum loss.',
    status: 'open',
  },
  {
    id: 9,
    title: 'Reproduction environment and fault models',
    body: 'Safe reproduction environment and policy-specific admissible fault models.',
    status: 'open',
    note: 'Claims pin runtime, configuration and a reproduction command; no isolated reproduction service exists.',
  },
  {
    id: 10,
    title: 'Fees, authentication, stack, hosting and ownership',
    body: 'Platform fee/revenue model, authentication choice, stack, hosting, and operational ownership.',
    status: 'partially_addressed',
    note: 'This release charges no platform fee and uses GitHub sign-in with minimal scope; hosting and operational ownership are undecided.',
  },
  {
    id: 11,
    title: 'Enabled policy families and live-security disclosure',
    body: 'First enabled policy families and live-security disclosure restrictions.',
    status: 'partially_addressed',
    note: 'FUNC-001 and BOT-001 can be drafted; SC-001 stays gated pending an approved disclosure process.',
  },
  {
    id: 12,
    title: 'Pilot comparison',
    body: 'Pilot comparison with an equally funded bounty and conventional review, measuring valid findings, noise, latency, and total cost rather than trading activity alone.',
    status: 'open',
  },
]

export const COPY = {
  productName: 'Pine',
  tagline: 'Pin a commit. Publish one bounded claim. Let anyone try to break it.',
  outcome,
  outcomeLong: {
    yes: 'At least one timely, admissible submission demonstrated the specified violation.',
    no: 'No timely, admissible submission demonstrated the specified violation. This is not a statement that the code is correct.',
    invalid:
      'The oracle resolved the question as invalid. Under Seer\u2019s native rules Yes and No tokens pay nothing and only Invalid-result tokens redeem; this is not a refund.',
  },
  priceLabel: 'Market-implied chance a qualifying counterexample is accepted',
  priceLabelShort: 'Implied chance of accepted counterexample',
  priceCaveat:
    'This price refers to the defined submission-and-resolution event. It is not the probability that the software has or lacks bugs, and thin markets can be far from informed.',
  volumeCaveat:
    'Volume, trader counts and collateral do not by themselves prove review depth or reviewer independence.',
  liquidityIsNotBounty:
    'Liquidity is not a bounty or reward. It can subsidize informed trading, but nobody is promised a payment, a minimum return or reimbursement of losses.',
  evidenceIsNotPayment:
    'Submitting evidence does not by itself earn a payment. Only the market’s native payout rules govern traders.',
  invalidIsNotRefund:
    'An invalid result is not a refund. Under Seer\u2019s native rules, Yes and No tokens pay nothing on invalid; only Invalid-result tokens redeem for collateral.',
  answeredTooSoon:
    '"Answered too soon" blocks resolution until someone reopens the Reality.eth question and the new question finalizes.',
  unanswered: 'If nobody answers on Reality.eth, the market never resolves. Full sets of outcome tokens can still be merged back into collateral.',
  noIsNotSafety:
    'No means no qualifying counterexample was submitted before the deadline under the published rules. It is not proof that the code is correct or fit for production.',
  deadlineIsNotTradingCutoff:
    'The evidence deadline is not a trading cutoff. Outcome tokens may remain tradable and transferable after it.',
  lateEvidence:
    'Late discoveries do not reopen a finalized market. They can support a new claim.',
  frozenTerms:
    'After the market is created, the question, policy, commit and environment are frozen. A new commit needs a new claim.',
  noMergeAuthority:
    'Pine never merges, deploys or runs anything against your repository or live systems. You decide what to merge.',
  untrustedContent:
    'Untrusted third-party content. Shown as plain text. Reproduce only in an isolated environment without secrets or production keys.',
  noAttackAuthorization:
    'Opening a market does not authorize attacks on deployed systems or spending real target-system funds.',
  spendingLimit:
    'Every step is checked against your spending limit, and approvals are for the exact amount only, never unlimited.',
  exactApproval: 'Approves exactly this amount of collateral for this market. Pine never requests unlimited allowance.',
  scGate:
    'Requires approved disclosure process. SC-001 claims may expose live vulnerabilities, so they stay disabled until evidence access, responsible disclosure and adjudicator review are resolved.',
  notAReview:
    'Adversarial verification of one bounded claim. Not a code review, audit report, insurance or general quality judgement.',
  boundedClaim:
    'Claims must name one exact, bounded violation. Blanket statements about the whole codebase cannot be resolved.',
  oracleActors:
    'Anyone can post a Reality.eth answer with a bond, and anyone can challenge it by doubling the bond; each answer restarts a fixed 3.5-day timeout. Kleros arbitration is requested and paid in ETH on Ethereum by whoever requests it.',
  arbitrationOnEthereum:
    'Arbitration for every Seer chain runs on the Kleros court on Ethereum mainnet and is paid in ETH there.',
  fixedTimeout: 'Seer\u2019s official market factory fixes the answer timeout at 3.5 days (302,400 seconds); it cannot be changed per market.',
  unverifiedChain:
    'Contract addresses and fees for this chain are unverified. Verify before launch.',
  demoMode:
    'Demo mode: sample data and a simulated wallet. Nothing is published on-chain and no real funds move.',
  disclosures,
  launchGates,
} as const

export type Copy = typeof COPY
