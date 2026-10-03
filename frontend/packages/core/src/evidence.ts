/**
 * Evidence submission mechanisms (research §6 "Evidence (ERC-1497)").
 *
 * ERC-1497 evidence is submitted with `submitEvidence(uint256(realityQuestionId), uri)` on the Kleros
 * arbitration contract on the ARBITRATION chain (Ethereum mainnet for Gnosis and Ethereum markets).
 * It is permissionless, has no status check (works before any dispute exists), costs Ethereum gas, and
 * its block timestamp is the timeliness proof. Reality.eth itself has no evidence channel.
 *
 * `EVIDENCE_MECHANISMS` describes each mechanism for markets on the default chain (Gnosis → evidence on
 * chain 1). Use `getEvidenceMechanism(id, marketChainId)` for other market chains.
 */
import { DEFAULT_CHAIN_ID, getChainOrDefault } from './chains'
import type { EvidenceMechanism, EvidenceMechanismId } from './types'

const CHAIN_LABEL: Record<number, string> = { 1: 'Ethereum (chain 1)', 11155111: 'Sepolia (chain 11155111)' }

/** Mechanisms usable for new claims in this release. */
export const ENABLED_EVIDENCE_MECHANISMS: EvidenceMechanismId[] = ['erc1497-arbitrator-proxy']

/**
 * Phrase inserted into the market question ("…submitted through <label> before …"). Chain-specific so the
 * question names the exact contract that timestamps submissions.
 */
export function evidenceMechanismQuestionLabel(id: EvidenceMechanismId, marketChainId: number = DEFAULT_CHAIN_ID): string {
  const chain = getChainOrDefault(marketChainId)
  const arb = chain.arbitration
  const where = `${CHAIN_LABEL[arb.chainId] ?? `chain ${arb.chainId}`} contract ${arb.requestContract}`
  if (id === 'commit-reveal') {
    return `an ERC-1497 evidence commitment on ${where} (evidence group = this question's Reality.eth id), revealed as the manifest specifies`
  }
  return `ERC-1497 evidence on ${where} (evidence group = this question's Reality.eth id)`
}

const PRE_DISPUTE_GATE =
  'Whether Kleros jurors are shown evidence submitted before a dispute exists is unverified, and Reality.eth answerers have no evidence channel; evidence availability and front-running remain open (SPEC §6, §10.5).'

function build(id: EvidenceMechanismId, marketChainId: number): EvidenceMechanism {
  const chain = getChainOrDefault(marketChainId)
  const arb = chain.arbitration
  const network = CHAIN_LABEL[arb.chainId] ?? `chain ${arb.chainId}`
  if (id === 'erc1497-arbitrator-proxy') {
    return {
      id,
      label: 'On-chain evidence (ERC-1497)',
      contract: arb.requestContract,
      chainId: arb.chainId,
      description:
        `Submit an evidence URI with submitEvidence on the Kleros arbitration contract ${arb.requestContract} on ${network}, using this claim's Reality.eth question id as the evidence group. ` +
        `Anyone can submit at any time; the block timestamp of the submission transaction is the timeliness proof. It costs ${network.startsWith('Ethereum') ? 'Ethereum' : 'network'} gas, and the evidence is public as soon as it is submitted.`,
      launchGate: PRE_DISPUTE_GATE,
    }
  }
  return {
    id,
    label: 'Commit–reveal evidence',
    contract: arb.requestContract,
    chainId: arb.chainId,
    description:
      'Submit a hash commitment of the evidence package before the deadline, then reveal the package later. Mitigates front-running of public evidence; the commitment block timestamp is the timeliness proof.',
    launchGate:
      'Not enabled: reveal windows, evidence availability and adjudicator access for committed evidence are unresolved (SPEC §6, §10.5).',
  }
}

export const EVIDENCE_MECHANISMS: Record<EvidenceMechanismId, EvidenceMechanism> = {
  'erc1497-arbitrator-proxy': build('erc1497-arbitrator-proxy', DEFAULT_CHAIN_ID),
  'commit-reveal': build('commit-reveal', DEFAULT_CHAIN_ID),
}

/** The mechanism as it applies to a market on `marketChainId` (evidence chain/contract follow the arbitration chain). */
export function getEvidenceMechanism(id: EvidenceMechanismId, marketChainId: number = DEFAULT_CHAIN_ID): EvidenceMechanism {
  return build(id, marketChainId)
}

/** Whether a mechanism can be used for new claims in this release (commit-reveal is behind a launch gate). */
export function isEvidenceMechanismEnabled(id: EvidenceMechanismId): boolean {
  return ENABLED_EVIDENCE_MECHANISMS.includes(id)
}
