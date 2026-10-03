/**
 * Market question text (SPEC §5) and environment hashing.
 *
 * Question template (exact):
 *   Was a reproducible counterexample demonstrating ${violation} against commit ${sha}, under
 *   configuration/environment ${envHash} and policy ${policyId}@${version} (${policyHash}), submitted
 *   through ${mechanismLabel} before ${YYYY-MM-DD HH:mm UTC}?
 */
import { evidenceMechanismQuestionLabel } from './evidence'
import { formatUtcMinute } from './format'
import { hashJson, hashText } from './hash'
import type { ClaimQuestion, ClaimSpec, EnvironmentPin, Hex, PolicyVersion, SourceRef } from './types'

/** Outcomes passed to Seer. Seer adds "Invalid result" natively. */
export const QUESTION_OUTCOMES = ['Yes', 'No'] as const

/**
 * Normalize the violation phrase for insertion: collapse whitespace, trim, and drop trailing
 * sentence punctuation so the template never produces "..?" or ".,".
 */
export function normalizeViolation(violation: string): string {
  return (violation ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.;:,!?]+$/u, '')
}

/** keccak256(canonicalJson(config)). Keys sorted; values are strings. */
export function computeConfigHash(config: Record<string, string>): Hex {
  return hashJson(config ?? {})
}

/** keccak256(canonicalJson(pin without envHash)). Any `envHash` present on the input is ignored. */
export function computeEnvHash(env: Omit<EnvironmentPin, 'envHash'>): Hex {
  const { envHash: _ignored, ...rest } = env as EnvironmentPin
  return hashJson(rest)
}

/**
 * Additive helper: complete an environment pin by computing configHash (from config) and envHash.
 * Use this whenever the composer changes any environment field.
 */
export function pinEnvironment(env: Omit<EnvironmentPin, 'envHash' | 'configHash'> & { configHash?: Hex }): EnvironmentPin {
  const withConfig = { ...env, config: env.config ?? {}, configHash: computeConfigHash(env.config ?? {}) }
  return { ...withConfig, envHash: computeEnvHash(withConfig) }
}

export function buildQuestion(input: { spec: ClaimSpec; source: SourceRef; policy: PolicyVersion }): ClaimQuestion {
  const { spec, source, policy } = input
  const violation = normalizeViolation(spec.violation)
  const sha = (source.commit?.sha ?? '').trim().toLowerCase()
  const envHash = spec.environment?.envHash
  const mechanismLabel = evidenceMechanismQuestionLabel(spec.evidence.mechanism, spec.oracle?.chainId)
  const deadline = formatUtcMinute(spec.evidence.deadline)
  const text =
    `Was a reproducible counterexample demonstrating ${violation} against commit ${sha}, ` +
    `under configuration/environment ${envHash} and policy ${policy.id}@${policy.version} (${policy.contentHash}), ` +
    `submitted through ${mechanismLabel} before ${deadline}?`
  return { text, outcomes: [...QUESTION_OUTCOMES], hash: hashText(text) }
}
