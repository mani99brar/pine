/**
 * Funding planner. All money math is exact bigint at 18 decimals; native-token costs are converted to
 * collateral units for the spending-limit total using a conservative rate.
 *
 * Decisions (documented for review):
 * - Platform fee: none in this release (line kept at 0 so the UI shows it explicitly).
 * - IPFS pinning: platform-pinned, 0 to the creator.
 * - Oracle bond: `reserved`, payer 'answerer' — someone must post it after the deadline. Counts toward the
 *   limit only when `ctx.selfAnswer` is true (you plan to answer your own claim, so you fund it).
 * - Arbitration fee: `reserved`, payer 'challenger' — whoever requests arbitration pays, in ETH on Ethereum
 *   mainnet (Kleros v1 court) for every Seer chain. Not counted toward the limit unless
 *   `ctx.includeDisputeCosts` is true (opt-in budgeting). ETH is converted at `ctx.ethInCollateral`
 *   (default DEFAULT_ETH_IN_COLLATERAL, deliberately high).
 * - Totals are in collateral units. Native gas is converted at `ctx.nativeInCollateral` (or, when only
 *   `ctx.nativeUsd` is given, assuming collateral ≈ 1 USD), defaulting to the chain's conservative rate
 *   (1 xDAI = 1 sDAI on Gnosis, which overstates gas because sDAI ≥ 1 xDAI).
 * - Steps: `buildPublishSteps` runs only when `ctx.publish` provides the manifest, question, oracle and
 *   creator; otherwise `steps` is []. Invalid input never throws: the plan carries warnings and
 *   `withinLimit: false`, and validateClaimDraft reports the issue.
 */
import { DEFAULT_ETH_IN_COLLATERAL, getChainOrDefault } from './chains'
import { COPY } from './copy'
import { fromScaled, parseDecimalParts, toScaled } from './decimal'
import { formatAmount, formatPrice } from './format'
import { GAS_UNITS, gasCost } from './gas'
import { buildPublishSteps, type ContractOverrides } from './tx'
import type {
  Address,
  ClaimQuestion,
  CostLine,
  DecimalString,
  DepthSnapshot,
  FundingInput,
  FundingPlan,
  Hex,
  OracleParams,
  TxStep,
} from './types'

const SCALE = 18

/** Below this liquidity (collateral units) depth is thin enough to warn. */
export const LOW_LIQUIDITY_THRESHOLD = '25'
/** Price ranges narrower than this (in price units) trigger a warning. */
export const NARROW_RANGE_WIDTH = 0.2
/** Initial Yes prices above this trigger a warning. */
export const HIGH_INITIAL_YES_PRICE = 0.5
/** Initial Yes prices below this trigger a warning. */
export const LOW_INITIAL_YES_PRICE = 0.02

export interface FundingContext {
  gasPriceGwei?: number
  nativeUsd?: number
  /** Additive: native token price in collateral units (overrides nativeUsd) */
  nativeInCollateral?: number
  /** Additive: ETH price in collateral units, for the arbitration fee on non-ETH chains */
  ethInCollateral?: number
  /** Additive: minimum oracle bond to show (defaults to the chain default) */
  minBond?: DecimalString
  /** Additive: arbitration fee estimate in native token (defaults to the chain default) */
  arbitrationFee?: DecimalString
  /** Additive: you intend to post the first oracle answer yourself (bond counts toward your limit) */
  selfAnswer?: boolean
  /** Additive: budget for a possible arbitration fee within your limit */
  includeDisputeCosts?: boolean
  /** Additive: when present, `steps` are built with buildPublishSteps */
  publish?: {
    manifestUri: string
    manifestHash: Hex
    question: ClaimQuestion
    oracle: OracleParams
    creator: Address
    market?: Address
    addresses?: ContractOverrides
    allowPlaceholderAddresses?: boolean
  }
}

function scaled(v: string | number | undefined): bigint | null {
  if (v === undefined || v === null || v === '') return null
  return toScaled(v, SCALE)?.value ?? null
}

function rateScaled(rate: number): bigint {
  if (!Number.isFinite(rate) || rate < 0) return 0n
  return toScaled(rate, SCALE)?.value ?? 0n
}

/** native amount (scaled) × rate (scaled) → collateral (scaled) */
function convert(nativeScaled: bigint, rate: bigint): bigint {
  return (nativeScaled * rate) / 10n ** BigInt(SCALE)
}

export function estimateFunding(input: FundingInput, ctx: FundingContext = {}): FundingPlan {
  const chain = getChainOrDefault(input?.chainId)
  const collateral = chain.collateral
  const sym = collateral.symbol
  const native = chain.nativeSymbol
  const warnings: string[] = []
  const gasPrice = ctx.gasPriceGwei ?? chain.defaultGasPriceGwei
  const rate = rateScaled(ctx.nativeInCollateral ?? ctx.nativeUsd ?? chain.defaultNativeInCollateral)
  const arbCurrency = chain.arbitration.feeCurrency
  const arbRate =
    arbCurrency === native ? rate : arbCurrency === 'ETH' ? rateScaled(ctx.ethInCollateral ?? DEFAULT_ETH_IN_COLLATERAL) : 0n

  // --- inputs -------------------------------------------------------------
  const liquidityRaw = input?.liquidity ?? ''
  const liquidityParsed = parseDecimalParts(liquidityRaw)
  let liquidity = scaled(liquidityRaw) ?? 0n
  if (!liquidityParsed) {
    warnings.push('Enter a liquidity amount, e.g. 5 or 0.1.')
    liquidity = 0n
  } else if (liquidity <= 0n) {
    warnings.push('Liquidity must be greater than zero.')
    liquidity = 0n
  } else {
    const exact = toScaled(liquidityRaw, collateral.decimals)
    if (exact && !exact.exact) {
      warnings.push(`Liquidity has more than ${collateral.decimals} decimal places and will be rounded.`)
    }
    if (exact && exact.value === 0n) {
      warnings.push(`Liquidity rounds to zero at ${collateral.decimals} decimals.`)
    }
  }

  const limitRaw = input?.spendingLimit ?? ''
  const limitValid = !!parseDecimalParts(limitRaw)
  const limit = limitValid ? (scaled(limitRaw) ?? 0n) : 0n
  if (!limitValid) warnings.push('Set a spending limit.')
  else if (limit <= 0n) warnings.push('The spending limit must be greater than zero.')

  // --- cost lines ---------------------------------------------------------
  const gasLine = (key: CostLine['key'], label: string, units: bigint, note: string): CostLine => ({
    key,
    label,
    amount: gasCost(units, gasPrice, chain.nativeDecimals),
    currency: native,
    kind: 'spent',
    estimate: true,
    payer: 'you',
    note,
    countsTowardLimit: true,
  })

  const minBond = ctx.minBond ?? chain.defaultMinBond
  const arbitrationFee = ctx.arbitrationFee ?? chain.defaultArbitrationFee
  const liquidityText = fromScaled(liquidity, SCALE)
  const sponsored = input?.sponsored === true

  const costs: CostLine[] = [
    gasLine('gas_market_creation', 'Market creation gas', GAS_UNITS.createMarket, `Estimate at ${gasPrice} gwei. Creates the Seer market and its Reality.eth question.`),
    gasLine('gas_approval', 'Collateral approval gas', GAS_UNITS.approve, `Exact-amount ${sym} approval to the Seer Router.`),
    gasLine('gas_split', 'Split gas', GAS_UNITS.split, `Splits ${sym} into Yes, No and Invalid outcome tokens.`),
    gasLine(
      'gas_liquidity',
      'Liquidity gas (2 pools)',
      GAS_UNITS.liquidityPerPool * 2n,
      'Two pool deposits, including pool creation when a pool does not exist yet.',
    ),
    {
      key: 'liquidity_deposit',
      label: 'Liquidity deposit',
      amount: liquidityText,
      currency: sym,
      kind: 'at_risk',
      estimate: false,
      payer: sponsored ? 'sponsor' : 'you',
      note: `Customer capital exposed to loss: its value moves with trading (impermanent loss) and with the final outcome. ${COPY.liquidityIsNotBounty}`,
      countsTowardLimit: true,
    },
    {
      key: 'swap_fee_tier',
      label: 'Pool swap fee',
      amount: '0',
      currency: sym,
      kind: 'spent',
      estimate: true,
      payer: 'you',
      note: 'Pools charge traders a swap fee (dynamic on Swapr/Algebra pools) that accrues to liquidity providers. You pay it only when you trade; LP fee income is not a guaranteed return.',
      countsTowardLimit: false,
    },
    {
      key: 'protocol_fee',
      label: 'Protocol fees',
      amount: '0',
      currency: sym,
      kind: 'spent',
      estimate: false,
      payer: 'you',
      note: 'Seer\u2019s MarketFactory charges no creation fee and the Reality.eth question fee for Seer arbitrators is 0 (read on-chain 2026-10-03; re-check at launch).',
      countsTowardLimit: true,
    },
    {
      key: 'platform_fee',
      label: 'Pine platform fee',
      amount: '0',
      currency: sym,
      kind: 'spent',
      estimate: false,
      payer: 'platform',
      note: 'No platform fee in this release.',
      countsTowardLimit: true,
    },
    {
      key: 'ipfs_pinning',
      label: 'Manifest pinning',
      amount: '0',
      currency: sym,
      kind: 'spent',
      estimate: false,
      payer: 'platform',
      note: 'The manifest is pinned to IPFS by the platform at no cost to you.',
      countsTowardLimit: false,
    },
    {
      key: 'oracle_bond',
      label: 'Oracle answer bond',
      amount: minBond,
      currency: native,
      kind: 'reserved',
      estimate: false,
      payer: ctx.selfAnswer ? 'you' : 'answerer',
      note: ctx.selfAnswer
        ? `You plan to answer your own claim, so you fund this Reality.eth bond in ${native}. Each challenge must double the bond; a bond backing a wrong answer can be lost.`
        : `Someone must post a Reality.eth answer with at least this bond (in ${native}) once the oracle opens. Pine does not answer for you; if you choose to self-answer you fund it. Each challenge must double the bond.`,
      countsTowardLimit: ctx.selfAnswer === true,
    },
    {
      key: 'arbitration_fee',
      label: 'Kleros arbitration fee (if disputed)',
      amount: arbitrationFee,
      currency: arbCurrency,
      kind: 'reserved',
      estimate: true,
      payer: ctx.includeDisputeCosts ? 'you' : 'challenger',
      note:
        (ctx.includeDisputeCosts
          ? 'Budgeted in case you request Kleros arbitration.'
          : 'Paid by whoever requests Kleros arbitration, only if an answer is disputed. Not counted toward your limit unless you opt in.') +
        ` Requested and paid in ${arbCurrency} on the arbitration chain (${chain.arbitration.courtName}, ${chain.arbitration.jurors} jurors; about ${chain.arbitration.feeEstimate} ${arbCurrency} on ${chain.arbitration.feeObservedAt}). The contract quotes the live fee at request time.`,
      countsTowardLimit: ctx.includeDisputeCosts === true,
    },
  ]

  // --- totals (collateral units) ------------------------------------------
  const inCollateral = (line: CostLine): bigint => {
    const v = scaled(line.amount) ?? 0n
    if (line.currency === sym) return v
    if (line.currency === native) return convert(v, rate)
    if (line.currency === arbCurrency) return convert(v, arbRate)
    return v
  }
  let maxSpend = 0n
  let exposed = 0n
  let nonRecoverable = 0n
  let reserved = 0n
  let withdrawable = 0n
  for (const line of costs) {
    const v = inCollateral(line)
    if (line.countsTowardLimit) maxSpend += v
    if (line.kind === 'at_risk') exposed += v
    if (line.kind === 'spent' && line.payer !== 'platform') nonRecoverable += v
    if (line.kind === 'reserved') reserved += v
    if (line.kind === 'withdrawable') withdrawable += v
  }
  // Liquidity is withdrawable by default (value not guaranteed) — reported separately from at-risk.
  withdrawable += liquidity

  const headroom = limit - maxSpend
  const withinLimit = limitValid && limit > 0n && liquidity > 0n && maxSpend <= limit

  // --- warnings ------------------------------------------------------------
  if (limitValid && limit > 0n && maxSpend > limit) {
    warnings.push(
      `Estimated maximum spend ${formatAmount(fromScaled(maxSpend, SCALE), { symbol: sym, maxDecimals: 4 })} exceeds your spending limit ${formatAmount(fromScaled(limit, SCALE), { symbol: sym, maxDecimals: 4 })}. Lower the liquidity or raise the limit.`,
    )
  }
  const lowThreshold = scaled(LOW_LIQUIDITY_THRESHOLD) ?? 0n
  if (liquidity > 0n && liquidity < lowThreshold) {
    warnings.push(
      `Thin depth: with less than ${LOW_LIQUIDITY_THRESHOLD} ${sym} of liquidity, small trades move the price a lot and the price may carry little information.`,
    )
  }
  const p = input?.initialYesPrice
  const [lo, hi] = Array.isArray(input?.priceRange) ? input.priceRange : [Number.NaN, Number.NaN]
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0 || p >= 1) {
    warnings.push('Initial Yes price must be between 0 and 1 (exclusive).')
  } else {
    if (p > HIGH_INITIAL_YES_PRICE) {
      warnings.push(
        `High initial Yes price (${formatPrice(p)}): the market starts by implying a counterexample is more likely than not to be accepted. Investigators buying Yes get less upside.`,
      )
    } else if (p < LOW_INITIAL_YES_PRICE) {
      warnings.push(`Very low initial Yes price (${formatPrice(p)}): your liquidity is concentrated where small Yes purchases move the price sharply.`)
    }
    if (Number.isFinite(lo) && Number.isFinite(hi) && (p < lo || p > hi)) {
      warnings.push('The initial Yes price is outside the liquidity price range; the position would start out of range and provide no depth.')
    }
  }
  if (!(Number.isFinite(lo) && Number.isFinite(hi)) || lo <= 0 || hi >= 1 || lo >= hi) {
    warnings.push('Price range must satisfy 0 < low < high < 1.')
  } else if (hi - lo < NARROW_RANGE_WIDTH) {
    warnings.push(
      `Narrow price range (${formatPrice(lo)}–${formatPrice(hi)}): if the price leaves it, your liquidity stops providing depth and ends up entirely in one outcome.`,
    )
  }
  if (sponsored) {
    warnings.push('Sponsored market: sponsorship funds are accounted separately from customer-funded publishing and reported on their own.')
  }
  if (!chain.verified) warnings.push(COPY.unverifiedChain)

  // --- steps ----------------------------------------------------------------
  let steps: TxStep[] = []
  if (ctx.publish && liquidity > 0n) {
    try {
      steps = buildPublishSteps({
        chainId: chain.id,
        manifestUri: ctx.publish.manifestUri,
        manifestHash: ctx.publish.manifestHash,
        question: ctx.publish.question,
        oracle: ctx.publish.oracle,
        funding: { ...input, liquidity: liquidityText },
        creator: ctx.publish.creator,
        market: ctx.publish.market,
        addresses: ctx.publish.addresses,
        allowPlaceholderAddresses: ctx.publish.allowPlaceholderAddresses,
        gasPriceGwei: gasPrice,
      })
    } catch (e) {
      warnings.push(`Transaction plan unavailable: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    input,
    collateral,
    costs,
    totals: {
      maxSpend: fromScaled(maxSpend, SCALE),
      exposedToLoss: fromScaled(exposed, SCALE),
      nonRecoverable: fromScaled(nonRecoverable, SCALE),
      reservedIfDisputed: fromScaled(reserved, SCALE),
      withdrawable: fromScaled(withdrawable, SCALE),
    },
    withinLimit,
    headroom: fromScaled(headroom, SCALE),
    warnings,
    steps,
  }
}

/**
 * Walk the depth book for a trade of `amountCollateral`.
 * - buy: spend collateral against asks (ascending price).
 * - sell: receive collateral from bids (descending price).
 * `DepthLevel.size` is cumulative outcome tokens up to that price; incremental size per level is derived.
 * Returns avgPrice (collateral per token), impact (relative move vs mid, ≥ 0), filled (collateral that
 * could execute), executable (the whole amount fits in the book). Display analytics only (floats).
 */
export function priceImpact(
  depth: DepthSnapshot,
  side: 'buy' | 'sell',
  amountCollateral: number,
): { avgPrice: number; impact: number; filled: number; executable: boolean; tokens: number; worstPrice: number } {
  const mid = depth?.mid ?? 0
  const empty = { avgPrice: mid, impact: 0, filled: 0, executable: false, tokens: 0, worstPrice: mid }
  if (!depth || !Number.isFinite(amountCollateral) || amountCollateral <= 0) {
    return { ...empty, executable: amountCollateral === 0 }
  }
  const wanted = side === 'buy' ? 'ask' : 'bid'
  const levels = depth.levels
    .filter((l) => l.side === wanted && Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0)
    .sort((a, b) => (side === 'buy' ? a.price - b.price : b.price - a.price))

  let remaining = amountCollateral
  let tokens = 0
  let filled = 0
  let prevCum = 0
  let worst = mid
  for (const level of levels) {
    const available = Math.max(0, level.size - prevCum)
    prevCum = Math.max(prevCum, level.size)
    if (available <= 0) continue
    const levelValue = available * level.price
    const take = Math.min(remaining, levelValue)
    tokens += take / level.price
    filled += take
    remaining -= take
    worst = level.price
    if (remaining <= 1e-12) break
  }
  if (tokens === 0) return empty
  const avgPrice = filled / tokens
  const impact = mid > 0 ? Math.max(0, side === 'buy' ? (avgPrice - mid) / mid : (mid - avgPrice) / mid) : 0
  return { avgPrice, impact, filled, executable: remaining <= 1e-9, tokens, worstPrice: worst }
}
