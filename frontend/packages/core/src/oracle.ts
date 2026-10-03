/**
 * Oracle helpers: defaults that match the official Seer factory, and Reality.eth answer decoding.
 */
import { REALITY_ANSWERS } from './abis/reality'
import { fromScaled, toScaled } from './decimal'
import { DEFAULT_ORACLE_CATEGORY, DEFAULT_ORACLE_LANGUAGE, getChainOrDefault } from './chains'
import type { Hex, IsoDate, OracleParams, Outcome, RealityAnswer } from './types'

/**
 * Oracle parameters for a market on `chainId` whose oracle opens at the evidence deadline.
 * Timeout and arbitrator are fixed by the official Seer MarketFactory and cannot be changed per market.
 */
export function defaultOracleParams(
  chainId: number,
  evidenceDeadline: IsoDate,
  opts: { openingTime?: IsoDate; minBond?: string; category?: string; language?: string } = {},
): OracleParams {
  const chain = getChainOrDefault(chainId)
  return {
    chainId: chain.id,
    openingTime: opts.openingTime ?? evidenceDeadline,
    timeoutSeconds: chain.seerQuestionTimeoutSeconds,
    minBond: opts.minBond ?? chain.defaultMinBond,
    bondToken: chain.nativeSymbol,
    arbitrator: chain.arbitrator,
    arbitratorName: chain.arbitratorName,
    language: opts.language ?? DEFAULT_ORACLE_LANGUAGE,
    category: opts.category ?? DEFAULT_ORACLE_CATEGORY,
  }
}

/**
 * Decode a Reality.eth bytes32 answer for a Yes/No market: 0 → yes, 1 → no, 0xff..ff → invalid,
 * 0xff..fe → too_soon. Any other index (≥ number of outcomes) is treated as invalid, as Seer does.
 */
export function decodeRealityAnswer(answer: Hex): RealityAnswer {
  const a = answer.toLowerCase()
  if (a === REALITY_ANSWERS.too_soon) return 'too_soon'
  if (a === REALITY_ANSWERS.invalid) return 'invalid'
  const n = BigInt(a)
  if (n === 0n) return 'yes'
  if (n === 1n) return 'no'
  return 'invalid'
}

export function encodeRealityAnswer(answer: RealityAnswer): Hex {
  return REALITY_ANSWERS[answer]
}

/** Kleros ruling → Reality answer (ruling − 1; 0 = refuse to arbitrate = invalid). */
export function klerosRulingToAnswer(ruling: number | bigint): RealityAnswer {
  const r = BigInt(ruling)
  if (r === 1n) return 'yes'
  if (r === 2n) return 'no'
  return 'invalid'
}

/** Final outcome for a settled Reality answer; too_soon has no outcome (must be reopened). */
export function outcomeFromAnswer(answer: RealityAnswer | undefined): Outcome | undefined {
  return answer === 'yes' || answer === 'no' || answer === 'invalid' ? answer : undefined
}

/** Minimum bond for the next answer: the min bond when unanswered, else double the current bond (exact decimals). */
export function nextBond(currentBond: string | undefined, minBond: string): string {
  const current = currentBond ? toScaled(currentBond, 18)?.value ?? 0n : 0n
  if (current <= 0n) return minBond
  return fromScaled(current * 2n, 18)
}
