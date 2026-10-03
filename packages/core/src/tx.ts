/**
 * Transaction plans (viem calldata) for publishing, evidence and redemption.
 * Contract facts: docs/research/seer-integration.md (official Seer MarketFactory only).
 *
 * Safety rules:
 * - Approvals are for the exact liquidity amount, to the Seer Router, never maxUint256.
 * - A transaction `request` is never built against a placeholder (zero) address. Unverified chains get
 *   `request: undefined` plus an explanatory description, unless the caller passes verified `addresses`
 *   overrides or explicitly opts in with `allowPlaceholderAddresses` (demo wallet only — never broadcast).
 * - Steps that need the new market address (split) are built with `request: undefined` until `market`
 *   is supplied; call `buildPublishSteps({ ...input, market })` (or `prepareStepWithMarket`) after
 *   `create_market` confirms (the market address is in the NewMarket event).
 *
 * Market name: Seer's CreateMarketParams has no description field and the contract imposes no length
 * limit, so the on-chain market name is the question text followed by
 * " — Terms: <manifestUri> (manifest keccak256 <hash>)" (see buildMarketName). It is JSON-escaped
 * (Seer SDK `escapeJson`) because the contract pastes it verbatim into Reality template 2, and it must
 * never contain U+241F (validation rejects it in the violation phrase).
 * Liquidity: Seer's own UI sends LPs to the DEX (Swapr/Algebra v1 on Gnosis) and the Algebra MintParams
 * are unverified, so both add-liquidity steps carry no `request` and describe the deep-link path.
 * Evidence: ERC-1497 submitEvidence on the Kleros arbitration contract on the ARBITRATION chain
 * (Ethereum for Gnosis/Ethereum markets), arbitration id = uint256(Reality question id).
 */
import { encodeFunctionData, zeroAddress } from 'viem'
import { arbitratorProxyAbi } from './abis/arbitrator'
import { erc20Abi } from './abis/erc20'
import { marketFactoryAbi, routerAbi } from './abis/seer'
import { getChain, getChainOrDefault, isPlaceholderAddress, type ChainConfig } from './chains'
import { REALITY_SEPARATOR } from './abis/reality'
import { fromScaled, toScaled } from './decimal'
import { formatAmount } from './format'
import { GAS_UNITS, gasCost } from './gas'
import { buildMarketName } from './manifest'
import type { Address, ClaimQuestion, FundingInput, Hex, OracleParams, TxStep } from './types'

export interface ContractOverrides {
  marketFactory?: Address
  router?: Address
  collateral?: Address
  arbitrator?: Address
}

export interface PublishStepsInput {
  chainId: number
  manifestUri: string
  manifestHash: Hex
  question: ClaimQuestion
  oracle: OracleParams
  funding: FundingInput
  creator: Address
  /** Additive: the created market (after create_market confirms) — enables the split request */
  market?: Address
  /** Additive: verified contract addresses (e.g. from env) overriding chains.ts placeholders */
  addresses?: ContractOverrides
  /** Additive: build requests even against placeholder addresses (simulated demo wallet only) */
  allowPlaceholderAddresses?: boolean
  /** Additive: gas price assumption for estimates */
  gasPriceGwei?: number
  /** Additive: token names for the Seer outcome wrappers (default ["YES", "NO"]) */
  tokenNames?: [string, string]
}

const UNVERIFIED = 'Transaction disabled: this chain’s contract address is an unverified placeholder (verify before launch, SPEC §10.3).'

function resolveAddresses(chain: ChainConfig, overrides?: ContractOverrides) {
  return {
    marketFactory: overrides?.marketFactory ?? chain.seer.marketFactory,
    router: overrides?.router ?? chain.seer.router,
    collateral: overrides?.collateral ?? chain.collateral.address,
    arbitrator: overrides?.arbitrator ?? chain.arbitrator,
  }
}

function usable(address: Address | undefined, allowPlaceholder: boolean | undefined): boolean {
  return !!address && (allowPlaceholder === true || !isPlaceholderAddress(address))
}

const UNSUPPORTED = 'Transaction disabled: this chain is not supported by Pine, so its contract addresses are unknown.'

/**
 * Chain config for a tx builder. Unknown chain ids fall back to the default chain for display only:
 * `supported` is false and no transaction request may be built (it would target another chain's contracts).
 */
function txChain(chainId: number | undefined): { chain: ChainConfig; supported: boolean } {
  const known = chainId !== undefined ? getChain(chainId) : undefined
  return { chain: known ?? getChainOrDefault(chainId), supported: Boolean(known) }
}

/** Minimum Reality.eth bond in wei; throws on anything that is not a positive decimal. */
export function minBondToWei(minBond: string, decimals: number): bigint {
  const r = toScaled(minBond, decimals)
  if (!r || r.value <= 0n) throw new RangeError(`Minimum bond must be a positive decimal amount (got "${minBond}")`)
  return r.value
}

function cost(chain: ChainConfig, units: bigint, gasPriceGwei?: number) {
  return { amount: gasCost(units, gasPriceGwei ?? chain.defaultGasPriceGwei, chain.nativeDecimals), currency: chain.nativeSymbol }
}

/**
 * Escape a string for insertion into a JSON string literal (without surrounding quotes), like the
 * Seer SDK's escapeJson. The Reality separator U+241F is removed (it would split the question fields).
 */
export function escapeJsonString(s: string): string {
  return JSON.stringify(s.split(REALITY_SEPARATOR).join(' ')).slice(1, -1)
}

/** ISO date → uint32 unix seconds (throws on invalid dates). */
export function toUnixSeconds(iso: string): number {
  const ms = new Date(iso).getTime()
  if (Number.isNaN(ms)) throw new RangeError(`Invalid date: ${iso}`)
  return Math.floor(ms / 1000)
}

/** Liquidity amount in collateral base units (exact; rounds half-up beyond the token's decimals). */
export function liquidityToUnits(liquidity: string, decimals: number): bigint {
  const r = toScaled(liquidity, decimals)
  if (!r || r.value <= 0n) throw new RangeError(`Liquidity must be a positive decimal amount (got "${liquidity}")`)
  return r.value
}

/** Calldata for Seer MarketFactory.createCategoricalMarket. */
export function encodeCreateMarket(input: {
  marketName: string
  oracle: OracleParams
  minBondWei: bigint
  tokenNames?: [string, string]
  outcomes?: string[]
}): Hex {
  return encodeFunctionData({
    abi: marketFactoryAbi,
    functionName: 'createCategoricalMarket',
    args: [
      {
        marketName: escapeJsonString(input.marketName),
        outcomes: input.outcomes ?? ['Yes', 'No'],
        questionStart: '',
        questionEnd: '',
        outcomeType: '',
        parentOutcome: 0n,
        parentMarket: zeroAddress,
        // Pasted verbatim into Reality template 2 like the market name: escape so a quote or U+241F
        // cannot add JSON keys (e.g. a second "title") or shift the question fields.
        category: escapeJsonString(input.oracle.category),
        lang: escapeJsonString(input.oracle.language),
        lowerBound: 0n,
        upperBound: 0n,
        minBond: input.minBondWei,
        openingTime: toUnixSeconds(input.oracle.openingTime),
        tokenNames: input.tokenNames ?? ['YES', 'NO'],
      },
    ],
  })
}

export function buildPublishSteps(input: PublishStepsInput): TxStep[] {
  const { chain, supported } = txChain(input.chainId)
  const addr = resolveAddresses(chain, input.addresses)
  const allow = input.allowPlaceholderAddresses
  const decimals = chain.collateral.decimals
  const sym = chain.collateral.symbol
  const amount = liquidityToUnits(input.funding.liquidity, decimals)
  const amountText = `${formatAmount(fromScaled(amount, decimals), { maxDecimals: 6 })} ${sym}`
  const marketName = buildMarketName(input.question.text, input.manifestUri, input.manifestHash)
  const minBondWei = minBondToWei(input.oracle.minBond, chain.nativeDecimals)
  const gp = input.gasPriceGwei

  const steps: TxStep[] = []

  steps.push({
    id: 'upload_manifest',
    label: 'Pin the claim manifest',
    description: `Upload the canonical manifest JSON to IPFS. Its keccak256 hash ${input.manifestHash} is written into the market name, so anyone can check the published terms.`,
    kind: 'offchain',
    estimatedCost: { amount: '0', currency: sym },
  })

  const createOk = supported && usable(addr.marketFactory, allow)
  steps.push({
    id: 'create_market',
    label: 'Create the Seer market',
    description:
      `Creates a Yes/No market (Seer adds an Invalid-result outcome) through the official Seer factory on ${chain.name}. Its Reality.eth question is the claim question, opening for answers at ${input.oracle.openingTime}, with a fixed ${chain.seerQuestionTimeoutSeconds / 86400}-day answer timeout. ` +
      'After this transaction confirms, the claim terms are frozen.' +
      (createOk ? '' : ` ${supported ? UNVERIFIED : UNSUPPORTED}`),
    kind: 'transaction',
    request: createOk
      ? {
          chainId: chain.id,
          to: addr.marketFactory,
          data: encodeCreateMarket({ marketName, oracle: input.oracle, minBondWei, tokenNames: input.tokenNames }),
          value: '0',
        }
      : undefined,
    estimatedCost: cost(chain, GAS_UNITS.createMarket, gp),
    freezesTerms: true,
  })

  const approveOk = supported && usable(addr.collateral, allow) && usable(addr.router, allow)
  steps.push({
    id: 'approve_collateral',
    label: `Approve exactly ${amountText}`,
    description:
      `Allows the Seer Router to move exactly ${amountText} for this market's liquidity. Never an unlimited allowance.` +
      (approveOk ? '' : ` ${supported ? UNVERIFIED : UNSUPPORTED}`),
    kind: 'transaction',
    request: approveOk
      ? {
          chainId: chain.id,
          to: addr.collateral,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [addr.router, amount] }),
          value: '0',
        }
      : undefined,
    estimatedCost: cost(chain, GAS_UNITS.approve, gp),
  })

  steps.push(buildSplitStep({ chain, supported, router: addr.router, collateral: addr.collateral, market: input.market, amount, amountText, allow, gasPriceGwei: gp }))

  const [lo, hi] = input.funding.priceRange
  const range = `${Math.round(lo * 1000) / 10}%–${Math.round(hi * 1000) / 10}%`
  const venue = chain.liquidityVenue
  steps.push({
    id: 'add_liquidity_yes',
    label: 'Add Yes liquidity',
    description:
      `Deposit Yes tokens and ${sym} as concentrated liquidity in the Yes/${sym} pool on ${venue} between ${range}, starting near ${Math.round(input.funding.initialYesPrice * 1000) / 10}%. You set the price and range in the DEX and approve each token there. ` +
      'Open the exchange from this step, add the position there, then mark the step done.',
    kind: 'transaction',
    request: undefined,
    estimatedCost: cost(chain, GAS_UNITS.liquidityPerPool, gp),
  })
  steps.push({
    id: 'add_liquidity_no',
    label: 'Add No liquidity',
    description:
      `Deposit No tokens and ${sym} as concentrated liquidity in the No/${sym} pool on ${venue} over the mirrored price range. Liquidity only provides depth while the price stays inside its range, and it can be withdrawn at any time. ` +
      'Open the exchange from this step, add the position there, then mark the step done.',
    kind: 'transaction',
    request: undefined,
    estimatedCost: cost(chain, GAS_UNITS.liquidityPerPool, gp),
    optional: true,
  })

  return steps
}

function buildSplitStep(args: {
  chain: ChainConfig
  supported: boolean
  router: Address
  collateral: Address
  market?: Address
  amount: bigint
  amountText: string
  allow?: boolean
  gasPriceGwei?: number
}): TxStep {
  const { chain, supported, router, collateral, market, amount, amountText, allow } = args
  const ok = supported && !!market && !isPlaceholderAddress(market) && usable(router, allow) && usable(collateral, allow)
  return {
    id: 'split_position',
    label: `Split ${amountText} into outcome tokens`,
    description:
      `Converts ${amountText} into ${amountText.split(' ')[0]} each of Yes, No and Invalid-result outcome tokens for this market. Invalid-result tokens stay in your wallet; they pay only if the market resolves invalid. ` +
      (market ? '' : 'Prepared once the market is created (needs the new market address). ') +
      (!supported ? UNSUPPORTED : usable(router, allow) && usable(collateral, allow) ? '' : UNVERIFIED),
    kind: 'transaction',
    request: ok
      ? {
          chainId: chain.id,
          to: router,
          data: encodeFunctionData({ abi: routerAbi, functionName: 'splitPosition', args: [collateral, market as Address, amount] }),
          value: '0',
        }
      : undefined,
    estimatedCost: cost(chain, GAS_UNITS.split, args.gasPriceGwei),
    collateralCost: { amount: fromScaled(amount, chain.collateral.decimals), currency: chain.collateral.symbol },
  }
}

/**
 * Re-prepare a publication step once the market address is known (for tx-runner `prepare` hooks).
 * Returns the step unchanged when it does not depend on the market.
 */
export function prepareStepWithMarket(step: TxStep, input: PublishStepsInput & { market: Address }): TxStep {
  if (step.id !== 'split_position' && step.id !== 'add_liquidity_yes' && step.id !== 'add_liquidity_no') return step
  const rebuilt = buildPublishSteps(input).find((s) => s.id === step.id)
  return rebuilt ?? step
}

/**
 * ERC-1497 evidence submission. `chainId` is the MARKET chain; the transaction targets the arbitration
 * chain (Ethereum mainnet for Gnosis and Ethereum markets). `questionId` is the Reality.eth question id
 * (OracleState.realityQuestionId), not Seer's CTF questionId.
 */
export function buildEvidenceTx(input: {
  chainId: number
  questionId: Hex
  evidenceUri: string
  /** Additive: verified arbitration-contract override */
  arbitrator?: Address
  allowPlaceholderAddresses?: boolean
}): TxStep {
  const { chain, supported } = txChain(input.chainId)
  const arbChain = getChainOrDefault(chain.arbitration.chainId)
  const contract = input.arbitrator ?? chain.arbitration.requestContract
  const ok = supported && usable(contract, input.allowPlaceholderAddresses)
  return {
    id: 'submit_evidence',
    label: `Submit evidence on ${arbChain.name}`,
    description:
      `Calls submitEvidence on the Kleros arbitration contract on ${arbChain.name} with your evidence URI (evidence group = the Reality.eth question id). ` +
      `The block timestamp of this transaction is the timeliness proof; it costs ${arbChain.nativeSymbol} gas and the content becomes public. Switch your wallet to ${arbChain.name} first.` +
      (ok ? '' : ` ${supported ? UNVERIFIED : UNSUPPORTED}`),
    kind: 'transaction',
    request: ok
      ? {
          chainId: arbChain.id,
          to: contract,
          data: encodeFunctionData({
            abi: arbitratorProxyAbi,
            functionName: 'submitEvidence',
            args: [BigInt(input.questionId), input.evidenceUri],
          }),
          value: '0',
        }
      : undefined,
    estimatedCost: cost(arbChain, GAS_UNITS.submitEvidence),
  }
}

export function buildRedeemTx(input: {
  chainId: number
  market: Address
  outcomeIndexes: number[]
  amounts: bigint[]
  /** Additive: verified overrides */
  router?: Address
  collateral?: Address
  allowPlaceholderAddresses?: boolean
}): TxStep {
  if (input.outcomeIndexes.length !== input.amounts.length) {
    throw new RangeError('outcomeIndexes and amounts must have the same length')
  }
  const { chain, supported } = txChain(input.chainId)
  const router = input.router ?? chain.seer.router
  const collateral = input.collateral ?? chain.collateral.address
  const ok =
    supported &&
    !isPlaceholderAddress(input.market) &&
    usable(router, input.allowPlaceholderAddresses) &&
    usable(collateral, input.allowPlaceholderAddresses)
  return {
    id: 'redeem_positions',
    label: 'Redeem positions',
    description:
      'Redeems your outcome tokens for collateral according to the final payout of this market. Payouts follow Seer\u2019s native rules: on invalid, only Invalid-result tokens pay. Losing tokens redeem for 0. Each redeemed token must first be approved to the Router (exact amount).' +
      (ok ? '' : ` ${supported ? UNVERIFIED : UNSUPPORTED}`),
    kind: 'transaction',
    request: ok
      ? {
          chainId: chain.id,
          to: router,
          data: encodeFunctionData({
            abi: routerAbi,
            functionName: 'redeemPositions',
            args: [collateral, input.market, input.outcomeIndexes.map((i) => BigInt(i)), input.amounts],
          }),
          value: '0',
        }
      : undefined,
    estimatedCost: cost(chain, GAS_UNITS.redeem),
  }
}

/**
 * Exact-amount approval of an outcome token (wrapped ERC-20) to the Seer Router, needed before
 * redeemPositions / mergePositions.
 */
export function buildOutcomeApprovalTx(input: {
  chainId: number
  token: Address
  amount: bigint
  label?: string
  router?: Address
  allowPlaceholderAddresses?: boolean
}): TxStep {
  const { chain, supported } = txChain(input.chainId)
  const router = input.router ?? chain.seer.router
  const ok = supported && usable(router, input.allowPlaceholderAddresses) && usable(input.token, input.allowPlaceholderAddresses)
  if (input.amount <= 0n) throw new RangeError('Approval amount must be positive')
  return {
    id: 'approve_outcome_tokens',
    label: input.label ?? 'Approve outcome tokens',
    description:
      'Allows the Seer Router to move exactly this amount of the outcome token. Never an unlimited allowance.' +
      (ok ? '' : ` ${supported ? UNVERIFIED : UNSUPPORTED}`),
    kind: 'transaction',
    request: ok
      ? {
          chainId: chain.id,
          to: input.token,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [router, input.amount] }),
          value: '0',
        }
      : undefined,
    estimatedCost: cost(chain, GAS_UNITS.approve),
  }
}
