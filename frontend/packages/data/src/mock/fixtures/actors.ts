import type { Address } from '@pine/core'
import { DEMO_WALLET_ADDRESS } from '../../demo'
import { fakeAddress } from '../../internal/util'

/** Wallets of GitHub users who create claims in the fixtures. */
export const wallets = {
  mara: DEMO_WALLET_ADDRESS,
  tomas: fakeAddress('wallet:tomas-reyes'),
  priya: fakeAddress('wallet:priya-natarajan'),
  jonas: fakeAddress('wallet:jonas-weber'),
  akosua: fakeAddress('wallet:akosua-mensah'),
  li: fakeAddress('wallet:li-wei-dev'),
  sofia: fakeAddress('wallet:sofia-marchetti'),
  diego: fakeAddress('wallet:diego-alvarez'),
  hana: fakeAddress('wallet:hana-kobayashi'),
  ines: fakeAddress('wallet:ines-duarte'),
} satisfies Record<string, Address>

export const githubByWallet: Record<string, string> = {
  [wallets.mara.toLowerCase()]: 'mara-okafor',
  [wallets.tomas.toLowerCase()]: 'tomas-reyes',
  [wallets.priya.toLowerCase()]: 'priya-natarajan',
  [wallets.jonas.toLowerCase()]: 'jonas-weber',
  [wallets.akosua.toLowerCase()]: 'akosua-mensah',
  [wallets.li.toLowerCase()]: 'li-wei-dev',
  [wallets.sofia.toLowerCase()]: 'sofia-marchetti',
  [wallets.diego.toLowerCase()]: 'diego-alvarez',
  [wallets.hana.toLowerCase()]: 'hana-kobayashi',
  [wallets.ines.toLowerCase()]: 'ines-duarte',
}

/**
 * Independent participants: investigators (human and agent operators), traders, answerers.
 * Labels are for fixture readability only; the UI shows addresses.
 */
export const actors = {
  /** agent operator running fuzzers against open FUNC claims */
  fuzzwright: fakeAddress('actor:fuzzwright'),
  /** human investigator focused on keepers */
  kestrel: fakeAddress('actor:kestrel'),
  /** agent operator, differential testing */
  diffbot: fakeAddress('actor:diffbot-operator'),
  /** human investigator, auth/security background */
  marlow: fakeAddress('actor:marlow'),
  /** market maker / trader */
  tidewatch: fakeAddress('actor:tidewatch-mm'),
  /** trader */
  quill: fakeAddress('actor:quill'),
  /** trader */
  basalt: fakeAddress('actor:basalt'),
  /** professional answerer that posts Reality answers */
  answerDesk: fakeAddress('actor:answer-desk'),
  /** another answerer */
  heron: fakeAddress('actor:heron'),
  /** anonymous submitter of the hostile evidence item */
  anon: fakeAddress('actor:anon-0x41'),
  /** keeper that calls finalize/resolve */
  resolver: fakeAddress('actor:resolver-keeper'),
  /** Pine sponsorship program wallet (fixture) */
  sponsor: fakeAddress('actor:pine-sponsorship'),
} satisfies Record<string, Address>

/**
 * Contract addresses used by fixtures. These are the real Seer/Reality/Kleros deployments from
 * docs/research/seer-integration.md (read on-chain 2026-10-03); market, token and pool addresses in
 * fixtures are fake. Re-verify before launch.
 */
export const contracts = {
  /** Savings xDAI (sDAI) on Gnosis — Seer collateral */
  sDAI: '0xaf204776c7245bF4147c2612BF6e5972Ee483701' as Address,
  /** Reality.eth v3.0 on Gnosis (bonds in xDAI) */
  reality: '0xE78996A233895bE74a66F451f1019cA9734205cc' as Address,
  /** RealitioHomeArbitrationProxy on Gnosis — the arbitrator in the Reality question */
  arbitrator: '0x68154EA682f95BF582b80Dd6453FA401737491Dc' as Address,
  /** RealitioForeignArbitrationProxyWithAppeals on Ethereum — arbitration requests and ERC-1497 evidence */
  foreignProxy: '0xFe0eb5fC686f929Eb26D541D75Bb59F816c0Aa68' as Address,
  /** KlerosLiquid (Kleros v1 court) on Ethereum */
  klerosLiquid: '0x988b3A538b618C7A603e1c11Ab82Cd16dbE28069' as Address,
  /** Seer GnosisRouter */
  router: '0xeC9048b59b3467415b1a38F63416407eA0c70fB8' as Address,
  /** Seer official MarketFactory on Gnosis */
  marketFactory: '0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1' as Address,
  /** Gnosis ConditionalTokens */
  conditionalTokens: '0xCeAfDD6bc0bEF976fdCd1112955828E00543c0Ce' as Address,
}

/** Traders who appear in generated activity (excluding the demo wallet, which is scripted). */
export const traderPool: Address[] = [
  actors.fuzzwright,
  actors.kestrel,
  actors.diffbot,
  actors.marlow,
  actors.tidewatch,
  actors.quill,
  actors.basalt,
  actors.heron,
]
