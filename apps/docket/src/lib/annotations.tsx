import type { ClaimManifest, EvidenceMechanismId } from '@pine/core'
import { formatDate, formatUtcMinute, shortSha } from '@pine/core'
import type { Annotation } from '@/components/claim/annotated-question'

const MECH_PLAIN: Record<EvidenceMechanismId, string> = {
  'erc1497-arbitrator-proxy':
    'Exhibits go on-chain to the arbitrator proxy. The block timestamp is the proof of filing time, so nobody has to trust Pine’s clock.',
  'commit-reveal':
    'Investigators first file a hash of their exhibit, then reveal it. This protects a counterexample from being copied before it is filed. This mode is a launch gate.',
}

/** Find the substring of `text` that best represents `value`, trying each candidate rendering. */
function pick(text: string, ...candidates: (string | undefined)[]): string | undefined {
  for (const c of candidates) if (c && text.includes(c)) return c
  return candidates.find(Boolean)
}

export function questionAnnotations(m: Pick<ClaimManifest, 'question' | 'claim' | 'source' | 'policy'>): Annotation[] {
  const text = m.question.text
  const c = m.claim
  const sha = m.source.commit.sha
  const env = c.environment?.envHash
  const policyRef = `${m.policy.id}@${m.policy.version}`
  const deadline = c.evidence?.deadline
  return [
    {
      match: pick(text, 'reproducible counterexample'),
      term: 'Reproducible counterexample',
      note: 'A test or demonstration anyone can rerun and get the same failure. Screenshots, logs or opinions alone do not count.',
    },
    {
      match: pick(text, c.violation),
      term: 'The violation',
      note: 'The one thing that must not happen. An exhibit has to demonstrate exactly this. Other bugs, style issues or performance complaints do not qualify.',
    },
    {
      match: pick(text, sha, shortSha(sha)),
      term: `Commit ${shortSha(sha)}`,
      note: `The exact code under examination in ${m.source.owner}/${m.source.repo}. Not the branch, not the pull request, and not later commits. New commits need a new claim.`,
    },
    {
      match: pick(text, env),
      term: 'Environment hash',
      note: 'A fingerprint of the runtime, dependency lockfile, configuration and reproduction command. Exhibits must reproduce under this environment, not a different one.',
    },
    {
      match: pick(text, `${policyRef} (${m.policy.hash})`, policyRef),
      term: `Policy ${policyRef}`,
      note: 'The rulebook: what evidence is admissible and what is excluded. The policy text is hashed, so it cannot be edited after filing.',
    },
    {
      match: pick(text, c.evidence ? mechanismLabelGuess(text, c.evidence.mechanism) : undefined),
      term: 'Where exhibits are filed',
      note: c.evidence ? MECH_PLAIN[c.evidence.mechanism] : 'The evidence channel named in the question.',
    },
    {
      match: deadline ? pick(text, formatUtcMinute(deadline), formatDate(deadline, 'utc'), deadline) : undefined,
      term: 'Absolute UTC deadline',
      note: 'Exhibits filed after this moment are not timely, whatever they show. It is not a trading cutoff: outcome tokens can still trade afterward.',
    },
  ]
}

function mechanismLabelGuess(text: string, id: EvidenceMechanismId): string | undefined {
  const m = text.match(/submitted (?:through|via) (.+?) before /)
  if (m?.[1]) return m[1]
  return id
}
