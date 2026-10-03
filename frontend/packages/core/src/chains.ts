/**
 * Chain configuration for Seer / Reality.eth / Kleros deployments.
 *
 * Source: docs/research/seer-integration.md (values collected 2026-10-03). MarketFactory immutables
 * (arbitrator, realitio, collateralToken, conditionalTokens, realityProxy, questionTimeout) were read
 * on-chain; Router/MarketView come from the seer-pm/demo deployment files. `verified: true` means
 * "addresses checked against chain/repo sources on that date" — re-read the factory immutables at launch
 * (research launch note 1). It does NOT mean the Pine question/policy is compatible with Seer's
 * resolution policy (SPEC §10.4) or that evidence is visible to jurors (SPEC §10.5).
 *
 * Only the OFFICIAL Seer MarketFactory is used (fixed 3.5-day Reality timeout). Non-official factories
 * (e.g. the 60 s GitHub-market factory on Gnosis) are flagged by Seer's UI and must not be used.
 *
 * Arbitration for every chain runs on Kleros v1 (KlerosLiquid) on Ethereum mainnet, requested and paid
 * in ETH on the L1 contract; ERC-1497 evidence is submitted to that same L1 contract.
 */
import { zeroAddress } from 'viem'
import type { Address, TokenInfo } from './types'

export interface SeerAddresses {
  /** Official Seer MarketFactory (createCategoricalMarket) */
  marketFactory: Address
  /** Seer Router for split/merge/redeem (GnosisRouter on Gnosis, MainnetRouter on Ethereum) */
  router: Address
  routerKind: 'gnosis' | 'mainnet' | 'generic'
  /** Gnosis Conditional Tokens Framework */
  conditionalTokens: Address
  /** Seer RealityProxy (CTF oracle; resolves markets from Reality.eth answers) */
  realityProxy: Address
  /** Seer MarketView (read helper) */
  marketView?: Address
  /** Market clone implementation */
  marketImplementation?: Address
  /** Wrapped1155Factory used for outcome ERC-20s */
  wrapped1155Factory?: Address
}

export interface ArbitrationConfig {
  /** Chain where arbitration is requested/paid and where ERC-1497 evidence is submitted (always L1) */
  chainId: number
  /** Contract to call requestArbitration / getDisputeFee / submitEvidence on */
  requestContract: Address
  requestContractName: string
  /** Kleros court contract (KlerosLiquid) */
  court: Address
  courtName: string
  jurors: number
  /** Fee estimate (read getDisputeFee live); decimal string in `feeCurrency` */
  feeEstimate: string
  feeCurrency: string
  feeObservedAt: string
  /** Typical days to a first ruling, and per appeal round */
  typicalRulingDays: number
  typicalAppealDays: number
  /** Extra delay before the dispute exists (bridges); 0 when none/unknown */
  bridgeDelayNote?: string
}

export interface ChainConfig {
  id: number
  name: string
  shortName: string
  nativeSymbol: string
  nativeDecimals: number
  /** Market collateral (the factory's collateralToken) */
  collateral: TokenInfo
  /** Block explorer base URL, no trailing slash */
  explorer: string
  /** Seer web app base URL (market pages are `${seerApp}/markets/${chainId}/${address}`) */
  seerApp: string
  /** Reality.eth web app base URL */
  realityApp: string
  /** DEX used for outcome-token liquidity */
  liquidityVenue: string
  /** Deep-link template for adding liquidity; `{token0}` / `{token1}` placeholders */
  liquidityUrlTemplate?: string
  seer: SeerAddresses
  /** Reality.eth v3.0 contract used by Seer markets on this chain (bonds in the native token) */
  reality: Address
  /** Reality template id Seer uses for categorical markets */
  realityTemplateId: number
  /** Arbitrator set in the Reality question (the factory's `arbitrator()`; a home proxy on L2s/Gnosis) */
  arbitrator: Address
  arbitratorName: string
  arbitration: ArbitrationConfig
  /** Default gas price assumption for estimates, in gwei */
  defaultGasPriceGwei: number
  /** Seer UI default minimum oracle bond in the native token (decimal string) */
  defaultMinBond: string
  /** Estimated Kleros arbitration fee (decimal string, in `arbitration.feeCurrency`) */
  defaultArbitrationFee: string
  /** Conservative native-token price in collateral units, used to total gas against the spending limit */
  defaultNativeInCollateral: number
  /** Reality answer timeout fixed by the official Seer MarketFactory (seconds) */
  seerQuestionTimeoutSeconds: number
  testnet: boolean
  /** Addresses checked against chain reads / deployment files (see header) */
  verified: boolean
  verifiedAt?: string
  notes: string[]
}

export const PLACEHOLDER_ADDRESS: Address = zeroAddress

/** Fixed Reality timeout of every official Seer MarketFactory: 3.5 days. */
export const SEER_QUESTION_TIMEOUT_SECONDS = 302_400

/** Conservative ETH price in collateral units, for converting ETH-denominated costs (arbitration) into totals. */
export const DEFAULT_ETH_IN_COLLATERAL = 5000

/** Seer's Reality category list; Pine defaults to "misc". */
export const SEER_CATEGORIES = ['elections', 'politics', 'business', 'science', 'crypto', 'pop_culture', 'sports', 'doge', 'misc', 'weather'] as const
export const DEFAULT_ORACLE_CATEGORY = 'misc'
export const DEFAULT_ORACLE_LANGUAGE = 'en_US'

const KLEROS_LIQUID_MAINNET: Address = '0x988b3A538b618C7A603e1c11Ab82Cd16dbE28069'
const RESEARCH_NOTE = 'Addresses from docs/research/seer-integration.md (read 2026-10-03). Re-read MarketFactory immutables before launch (SPEC §10.3).'

export const CHAINS: Record<number, ChainConfig> = {
  100: {
    id: 100,
    name: 'Gnosis',
    shortName: 'gno',
    nativeSymbol: 'xDAI',
    nativeDecimals: 18,
    collateral: { address: '0xaf204776c7245bF4147c2612BF6e5972Ee483701', symbol: 'sDAI', decimals: 18, name: 'Savings xDAI' },
    explorer: 'https://gnosisscan.io',
    seerApp: 'https://app.seer.pm',
    realityApp: 'https://reality.eth.limo',
    liquidityVenue: 'Swapr v3 (Algebra v1)',
    liquidityUrlTemplate: 'https://v3.swapr.eth.limo/#/add/{token0}/{token1}/enter-amounts',
    seer: {
      marketFactory: '0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1',
      router: '0xeC9048b59b3467415b1a38F63416407eA0c70fB8',
      routerKind: 'gnosis',
      conditionalTokens: '0xCeAfDD6bc0bEF976fdCd1112955828E00543c0Ce',
      realityProxy: '0xc260ADfAC11f97c001dC143d2a4F45b98e0f2D6C',
      marketView: '0x010Bc82218C4857CBF5639B0046E0E05a678D8D4',
      marketImplementation: '0x8F76bC35F8C72E5e2Ec55ebED785da5efaa9636a',
      wrapped1155Factory: '0xD194319D1804C1051DD21Ba1Dc931cA72410B79f',
    },
    reality: '0xE78996A233895bE74a66F451f1019cA9734205cc',
    realityTemplateId: 2,
    arbitrator: '0x68154EA682f95BF582b80Dd6453FA401737491Dc',
    arbitratorName: 'Kleros (RealitioHomeArbitrationProxy → Ethereum)',
    arbitration: {
      chainId: 1,
      requestContract: '0xFe0eb5fC686f929Eb26D541D75Bb59F816c0Aa68',
      requestContractName: 'RealitioForeignArbitrationProxyWithAppeals (Ethereum)',
      court: KLEROS_LIQUID_MAINNET,
      courtName: 'Kleros General Court',
      jurors: 31,
      feeEstimate: '0.1674',
      feeCurrency: 'ETH',
      feeObservedAt: '2026-10-03',
      typicalRulingDays: 14.5,
      typicalAppealDays: 11,
      bridgeDelayNote: 'Requests are relayed between Ethereum and Gnosis over the AMB bridge; its latency is unverified.',
    },
    defaultGasPriceGwei: 2,
    defaultMinBond: '10',
    defaultArbitrationFee: '0.1674',
    defaultNativeInCollateral: 1,
    seerQuestionTimeoutSeconds: SEER_QUESTION_TIMEOUT_SECONDS,
    testnet: false,
    verified: true,
    verifiedAt: '2026-10-03',
    notes: [
      RESEARCH_NOTE,
      'Default chain. Collateral sDAI; gas and Reality.eth bonds in xDAI.',
      'Arbitration is requested and paid in ETH on Ethereum mainnet; evidence is submitted there too.',
    ],
  },
  1: {
    id: 1,
    name: 'Ethereum',
    shortName: 'eth',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    collateral: { address: '0x83F20F44975D03b1b09e64809B757c47f942BEeA', symbol: 'sDAI', decimals: 18, name: 'Savings Dai' },
    explorer: 'https://etherscan.io',
    seerApp: 'https://app.seer.pm',
    realityApp: 'https://reality.eth.limo',
    liquidityVenue: 'Uniswap v4 via Bunni v2',
    liquidityUrlTemplate: 'https://bunni.pro/add/ethereum?tokenA={token0}&tokenB={token1}&fee=3000',
    seer: {
      marketFactory: '0x1F728c2fD6a3008935c1446a965a313E657b7904',
      router: '0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6',
      routerKind: 'mainnet',
      conditionalTokens: '0xC59b0e4De5F1248C1140964E0fF287B192407E0C',
      realityProxy: '0xC72f738e331b6B7A5d77661277074BB60Ca0Ca9E',
      marketView: '0xcBBbABD15895ae7b2e28BE6f250729098F1c69FA',
      marketImplementation: '0x8bdC504dC3A05310059c1c67E0A2667309D27B93',
      wrapped1155Factory: '0xD194319D1804C1051DD21Ba1Dc931cA72410B79f',
    },
    reality: '0x5b7dD1E86623548AF054A4985F7fc8Ccbb554E2c',
    realityTemplateId: 2,
    arbitrator: '0x2018038203aEE8e7a29dABd73771b0355D4F85ad',
    arbitratorName: 'Kleros (Realitio_v2_1_ArbitratorWithAppeals)',
    arbitration: {
      chainId: 1,
      requestContract: '0x2018038203aEE8e7a29dABd73771b0355D4F85ad',
      requestContractName: 'Realitio_v2_1_ArbitratorWithAppeals (Ethereum)',
      court: KLEROS_LIQUID_MAINNET,
      courtName: 'Kleros General Court',
      jurors: 31,
      feeEstimate: '0.1674',
      feeCurrency: 'ETH',
      feeObservedAt: '2026-10-03',
      typicalRulingDays: 14.5,
      typicalAppealDays: 11,
    },
    defaultGasPriceGwei: 10,
    defaultMinBond: '0.02',
    defaultArbitrationFee: '0.1674',
    defaultNativeInCollateral: DEFAULT_ETH_IN_COLLATERAL,
    seerQuestionTimeoutSeconds: SEER_QUESTION_TIMEOUT_SECONDS,
    testnet: false,
    verified: true,
    verifiedAt: '2026-10-03',
    notes: [
      RESEARCH_NOTE,
      'Gas on Ethereum mainnet is far higher than on Gnosis (market creation ≈ 1.65M gas).',
      'Overpaying requestArbitration on Realitio_v2_1 buys extra jurors and is not refunded.',
    ],
  },
  11155111: {
    id: 11155111,
    name: 'Sepolia',
    shortName: 'sep',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    collateral: { address: '0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357', symbol: 'DAI', decimals: 18, name: 'Test DAI' },
    explorer: 'https://sepolia.etherscan.io',
    seerApp: 'https://app.seer.pm',
    realityApp: 'https://reality.eth.limo',
    liquidityVenue: 'Uniswap v3 (testnet)',
    seer: {
      marketFactory: '0x221456ACFD185EE168052B3DA899939303775C7a',
      router: '0xdEB5dC052e55bf81C6d75CD47C961e0b280B3791',
      routerKind: 'generic',
      conditionalTokens: '0x8bdC504dC3A05310059c1c67E0A2667309D27B93',
      realityProxy: '0xAc9Bf8EbA6Bd31f8E8c76f8E8B2AAd0BD93f98Dc',
      marketView: '0x14662A441C72cBE609155A02A5B433FC0D4C1443',
      marketImplementation: '0xf9369c0F7a84CAC3b7Ef78c837cF7313309D3678',
      wrapped1155Factory: '0xD194319D1804C1051DD21Ba1Dc931cA72410B79f',
    },
    reality: '0xaf33DcB6E8c5c4D9dDF579f53031b514d19449CA',
    realityTemplateId: 2,
    arbitrator: '0xa638F22cDD13013494971b0e1325718AA45280dc',
    arbitratorName: 'Kleros (Sepolia Realitio_v2_1_ArbitratorWithAppeals)',
    arbitration: {
      chainId: 11155111,
      requestContract: '0xa638F22cDD13013494971b0e1325718AA45280dc',
      requestContractName: 'Realitio_v2_1_ArbitratorWithAppeals (Sepolia)',
      court: '0x90992fb4E15ce0C59aEFfb376460Fda4Ee19C879',
      courtName: 'Kleros court 0 (Sepolia)',
      jurors: 31,
      feeEstimate: '0.31',
      feeCurrency: 'SepETH',
      feeObservedAt: '2026-10-03',
      typicalRulingDays: 14.5,
      typicalAppealDays: 11,
    },
    defaultGasPriceGwei: 1,
    defaultMinBond: '0.000001',
    defaultArbitrationFee: '0.31',
    defaultNativeInCollateral: 0,
    seerQuestionTimeoutSeconds: SEER_QUESTION_TIMEOUT_SECONDS,
    testnet: true,
    verified: true,
    verifiedAt: '2026-10-03',
    notes: [
      RESEARCH_NOTE,
      'Testnet: tokens have no value. Not indexed by Seer’s production indexer.',
    ],
  },
}

export const DEFAULT_CHAIN_ID = 100

export const SUPPORTED_CHAIN_IDS: number[] = [100, 1, 11155111]

export function getChain(chainId: number): ChainConfig | undefined {
  return CHAINS[chainId]
}

/** Chain config or the default chain (Gnosis). */
export function getChainOrDefault(chainId?: number): ChainConfig {
  return (chainId !== undefined ? CHAINS[chainId] : undefined) ?? (CHAINS[DEFAULT_CHAIN_ID] as ChainConfig)
}

export function isPlaceholderAddress(address: string | undefined): boolean {
  return !address || /^0x0{40}$/i.test(address)
}

export function seerMarketUrl(chainId: number, market: Address): string {
  const c = getChainOrDefault(chainId)
  return `${c.seerApp}/markets/${chainId}/${market}`
}

/** Reality.eth question page: https://reality.eth.limo/app/#!/network/{chainId}/question/{reality}-{questionId} */
export function realityQuestionUrl(chainId: number, questionId: string): string {
  const c = getChainOrDefault(chainId)
  return `${c.realityApp}/app/#!/network/${c.id}/question/${c.reality}-${questionId}`
}

/** Kleros case page (disputes always live on the arbitration chain). */
export function klerosCaseUrl(disputeId: string | number, arbitrationChainId = 1): string {
  return `https://resolve.kleros.io/cases/${disputeId}?requiredChainId=${arbitrationChainId}`
}

/** DEX deep link for adding liquidity to an outcome-token/collateral pair, when the chain has one. */
export function liquidityDeepLink(chainId: number, token0: Address, token1: Address): string | undefined {
  const t = getChainOrDefault(chainId).liquidityUrlTemplate
  return t ? t.replace('{token0}', token0).replace('{token1}', token1) : undefined
}
