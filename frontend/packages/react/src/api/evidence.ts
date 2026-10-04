'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Hex } from '@pine/core'
import {
  buildStep,
  computeEvidenceCommitment,
  encodeEvidenceManifest,
  EVIDENCE_MANIFEST_SCHEMA_ID,
  evidenceManifestSchema,
  newPlan,
  planFromWire,
  planToWire,
  PlanVerificationError,
  rawCidFromSha256,
  sha256Hex,
  type Address,
  type DeploymentManifest,
  type EvidenceManifest,
  type Hex32,
  type TxPlan,
  type WireTxPlan,
} from '@pine/core/pine-shared'
import {
  DEFAULT_ARTIFACT_MEDIA_TYPES,
  describeWriteError,
  EVIDENCE_UPLOAD_MAX_BYTES,
  FINAL_PLAN_STATES,
  type RevealCandidate,
  type MarketsPlanResponse,
  type PineWriteApi,
  type RevealTemplateResponse,
  type WriteErrorInfo,
} from '@pine/data'
import { usePine } from '../providers/context'
import { useWallet } from '../wallet'
import { getBrowserStorage, readJson, writeJson, type KeyValueStorage } from '../internal/storage'
import { isoNow } from '../internal/util'
import type { ApiPlanRunner } from './use-plan-runner'
import { verifyWirePlan } from './plans'
import {
  requireWriteApi,
  runnerIsBusy,
  useOnChainClaim,
  usePinnedManifest,
  usePlanAction,
  usePolledStatus,
  useRegistryReader,
  useStoredRecord,
  useWriteApi,
  type OnChainClaim,
} from './publish-plan'

// Evidence against a claim market (api mode), two ways:
// - direct: upload the artifacts and the manifest to Pine, then publish the manifest digest on chain (public at once);
// - sealed: commit keccak256(…, contentSha256, salt) on chain, reveal before the reveal deadline.
// Sealed evidence stays on this device until the reveal (SEC-EVID-13): the manifest and the artifacts are uploaded to
// Pine only in the reveal step, once the commitment is indexed and the reveal template and the reveal plan have been
// checked, right before the reveal transaction; the salt is never sent to Pine at all — it lives only in this browser's
// localStorage (keyed by market, content digest and submitter) and in the reveal transaction itself. The commit plan is
// checked to commit exactly the locally computed commitment; the reveal plan is built and verified locally.

// ---------------------------------------------------------------------------------------------------------------
// Composition and the local manifest
// ---------------------------------------------------------------------------------------------------------------

export interface EvidenceArtifactInput {
  /** The file (from an <input type="file">) or any Blob. Pine stores at most 256 KiB per artifact. */
  file: Blob
  /** Display name without path separators; defaults to the File's name. */
  name?: string
  description?: string
  /** Inert text locators (Pine never fetches them). */
  locators?: string[]
}

export interface EvidenceComposition {
  title: string
  /** Quote of the exact requirement from the claim document that is violated. */
  violatedRequirement: string
  summary: string
  expectedBehavior: string
  actualBehavior: string
  reproduction: { environment: string; setup: string; command: string; initialState?: string; notes?: string }
  artifacts?: EvidenceArtifactInput[]
}

export interface EvidenceFieldError {
  /** Manifest path, e.g. `reproduction.command` or `artifacts.0.mediaType`. */
  field: string
  message: string
}

export interface PreparedEvidence {
  manifest: EvidenceManifest
  /** SHA-256 of the canonical manifest bytes: what is committed, revealed or published. */
  contentSha256: Hex32
  cid: string
  size: number
}

export interface EvidenceContext {
  chainId: number
  market: Address
  submitter: Address
  claim: Pick<OnChainClaim, 'claimDocumentSha256' | 'commit'>
  allowedMediaTypes?: readonly string[]
}

// eslint-disable-next-line no-control-regex -- the class exists to find control characters
const FORBIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩␟﻿]/u
// eslint-disable-next-line no-control-regex -- file names: no separators or control characters
const BAD_NAME = /[/\\\u0000-\u001f]/
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/

/** Artifact bytes of this session, by sha256: kept in memory only (never in storage) until an upload needs them. */
const sessionArtifacts = new Map<string, Uint8Array>()

/** Test helper: forget the in-memory artifacts (simulates a reload). */
export function __clearSessionArtifacts(): void {
  sessionArtifacts.clear()
}

function field(errors: EvidenceFieldError[], name: string, raw: string | undefined, max: number, required: boolean): string {
  const value = (raw ?? '').normalize('NFC').trim()
  if (required && value.length === 0) errors.push({ field: name, message: 'This field is required.' })
  else if (value.length > max) errors.push({ field: name, message: `At most ${max} characters (found ${value.length}).` })
  else if (FORBIDDEN.test(value)) errors.push({ field: name, message: 'Remove the invisible or control characters from this text.' })
  return value
}

/** Normalized media type of a Blob (lowercase, without parameters). */
export function mediaTypeOf(blob: Blob): string {
  return (blob.type || '').toLowerCase().split(';')[0]?.trim() ?? ''
}

/**
 * Builds the evidence manifest locally (no network): reads every artifact, hashes it, and returns the canonical manifest
 * and its digest. Artifact bytes are kept in this session's memory for a later upload.
 */
export async function prepareEvidence(input: EvidenceComposition, ctx: EvidenceContext): Promise<{ ok: true; prepared: PreparedEvidence } | { ok: false; errors: EvidenceFieldError[] }> {
  const errors: EvidenceFieldError[] = []
  const allowed = (ctx.allowedMediaTypes ?? DEFAULT_ARTIFACT_MEDIA_TYPES).map((t) => t.toLowerCase())
  const inputs = input.artifacts ?? []
  if (inputs.length > 16) errors.push({ field: 'artifacts', message: `At most 16 artifacts (found ${inputs.length}).` })
  const artifacts: EvidenceManifest['artifacts'] = []
  const bytesBySha = new Map<string, Uint8Array>()
  for (const [i, a] of inputs.slice(0, 16).entries()) {
    const fileName = (a.name ?? (a.file as Blob & { name?: string }).name ?? '').normalize('NFC').trim()
    if (fileName.length === 0 || fileName.length > 200 || BAD_NAME.test(fileName)) {
      errors.push({ field: `artifacts.${i}.name`, message: 'Give the file a plain name (1–200 characters, no slashes or control characters).' })
    }
    const mediaType = mediaTypeOf(a.file)
    if (!MEDIA_TYPE.test(mediaType) || !allowed.includes(mediaType)) {
      errors.push({ field: `artifacts.${i}.mediaType`, message: `Pine accepts ${allowed.join(', ')} files${mediaType ? `, not ${mediaType}` : ''}.` })
    }
    if (a.file.size > EVIDENCE_UPLOAD_MAX_BYTES) {
      errors.push({ field: `artifacts.${i}.size`, message: `Each file can be at most 256 KiB (this one is ${Math.ceil(a.file.size / 1024)} KiB).` })
      continue
    }
    // Pine refuses empty uploads, so an empty file committed now could never be revealed.
    if (a.file.size === 0) {
      errors.push({ field: `artifacts.${i}.size`, message: 'This file is empty: Pine does not store empty files.' })
      continue
    }
    const description = field(errors, `artifacts.${i}.description`, a.description, 2_000, false)
    const locators = (a.locators ?? []).map((l) => l.trim()).filter((l) => l.length > 0)
    if (locators.length > 4 || locators.some((l) => l.length > 512)) errors.push({ field: `artifacts.${i}.locators`, message: 'At most 4 locators of up to 512 characters.' })
    const bytes = new Uint8Array(await a.file.arrayBuffer())
    const sha256 = sha256Hex(bytes)
    bytesBySha.set(sha256, bytes)
    artifacts.push({ name: fileName, sha256, size: bytes.byteLength, mediaType, locators, description })
  }
  const r = input.reproduction
  const manifest: EvidenceManifest = {
    schema: EVIDENCE_MANIFEST_SCHEMA_ID,
    submitter: ctx.submitter.toLowerCase() as Address,
    claim: {
      chainId: ctx.chainId,
      market: ctx.market.toLowerCase() as Address,
      claimDocumentSha256: ctx.claim.claimDocumentSha256.toLowerCase() as Hex32,
      commit: ctx.claim.commit.toLowerCase(),
    },
    title: field(errors, 'title', input.title, 200, true),
    violatedRequirement: field(errors, 'violatedRequirement', input.violatedRequirement, 4_000, true),
    summary: field(errors, 'summary', input.summary, 10_000, true),
    expectedBehavior: field(errors, 'expectedBehavior', input.expectedBehavior, 4_000, true),
    actualBehavior: field(errors, 'actualBehavior', input.actualBehavior, 4_000, true),
    reproduction: {
      environment: field(errors, 'reproduction.environment', r.environment, 4_000, true),
      setup: field(errors, 'reproduction.setup', r.setup, 10_000, true),
      command: field(errors, 'reproduction.command', r.command, 2_000, true),
      initialState: field(errors, 'reproduction.initialState', r.initialState, 10_000, false),
      notes: field(errors, 'reproduction.notes', r.notes, 10_000, false),
    },
    artifacts,
  }
  if (errors.length > 0) return { ok: false, errors }
  const parsed = evidenceManifestSchema.safeParse(manifest)
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => ({ field: i.path.map(String).join('.'), message: i.message })) }
  let encoded: { bytes: Uint8Array; sha256: Hex32 }
  try {
    encoded = encodeEvidenceManifest(parsed.data)
  } catch {
    return { ok: false, errors: [{ field: 'summary', message: 'The evidence text is too long: the manifest is limited to 256 KiB.' }] }
  }
  for (const [sha, bytes] of bytesBySha) sessionArtifacts.set(sha, bytes)
  return { ok: true, prepared: { manifest: parsed.data, contentSha256: encoded.sha256, cid: rawCidFromSha256(encoded.sha256), size: encoded.bytes.byteLength } }
}

// ---------------------------------------------------------------------------------------------------------------
// Seals: the salt and everything needed to reveal, in this browser only
// ---------------------------------------------------------------------------------------------------------------

export interface EvidenceSeal {
  v: 1
  chainId: number
  registry: Address
  market: Address
  submitter: Address
  contentSha256: Hex32
  /** Secret until the reveal transaction. Never sent to Pine. */
  salt: Hex32
  commitment: Hex32
  /** The manifest to upload in the reveal step. */
  manifest: EvidenceManifest
  createdAt: string
  commitPlanId?: string
  commitTxHash?: Hex
  /** Set when the commit transaction was mined. */
  committedAt?: string
  submissionId?: string
  revealTxHash?: Hex
  /** Set when the reveal transaction was mined. */
  revealedAt?: string
}

const SEAL_PREFIX = 'pine:evidence-seal:'
const SEAL_INDEX_PREFIX = 'pine:evidence-seals:'
const HEX32 = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/

export function sealStorageKey(market: Address, contentSha256: Hex32, submitter: Address): string {
  return `${SEAL_PREFIX}${market.toLowerCase()}:${contentSha256.toLowerCase()}:${submitter.toLowerCase()}`
}

function sealIndexKey(market: Address, submitter: Address): string {
  return `${SEAL_INDEX_PREFIX}${market.toLowerCase()}:${submitter.toLowerCase()}`
}

/** Reads a seal and checks it is intact (its commitment recomputes from its own fields). */
export function readSeal(storage: KeyValueStorage, market: Address, contentSha256: Hex32, submitter: Address): EvidenceSeal | null {
  const raw = readJson<EvidenceSeal>(storage, sealStorageKey(market, contentSha256, submitter))
  if (!raw || raw.v !== 1 || !HEX32.test(raw.salt) || /^0x0{64}$/.test(raw.salt) || !HEX32.test(raw.commitment) || !ADDRESS.test(raw.registry)) return null
  if (raw.market !== market.toLowerCase() || raw.contentSha256 !== contentSha256.toLowerCase() || raw.submitter !== submitter.toLowerCase()) return null
  if (!evidenceManifestSchema.safeParse(raw.manifest).success) return null
  try {
    const commitment = computeEvidenceCommitment({ chainId: raw.chainId, registry: raw.registry, market: raw.market, submitter: raw.submitter, contentSha256: raw.contentSha256, salt: raw.salt })
    if (commitment !== raw.commitment) return null
    if (encodeEvidenceManifest(raw.manifest).sha256 !== raw.contentSha256) return null
  } catch {
    return null
  }
  return raw
}

export function writeSeal(storage: KeyValueStorage, seal: EvidenceSeal): void {
  writeJson(storage, sealStorageKey(seal.market, seal.contentSha256, seal.submitter), seal)
  const indexKey = sealIndexKey(seal.market, seal.submitter)
  const index = readJson<string[]>(storage, indexKey) ?? []
  if (!index.includes(seal.contentSha256)) writeJson(storage, indexKey, [...index.filter((s) => HEX32.test(s)), seal.contentSha256])
}

export function listSeals(storage: KeyValueStorage, market: Address, submitter: Address): EvidenceSeal[] {
  const index = readJson<string[]>(storage, sealIndexKey(market, submitter)) ?? []
  return index
    .filter((s) => HEX32.test(s))
    .map((s) => readSeal(storage, market, s as Hex32, submitter))
    .filter((s): s is EvidenceSeal => s !== null)
}

/** 32 random bytes from the platform CSPRNG, never zero. */
export function newEvidenceSalt(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): Hex32 {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = random(new Uint8Array(32))
    if (bytes.length !== 32) break
    if (bytes.some((b) => b !== 0)) return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}` as Hex32
  }
  throw new Error('The browser could not generate a random salt.')
}

// ---------------------------------------------------------------------------------------------------------------
// Plan checks (before any wallet prompt)
// ---------------------------------------------------------------------------------------------------------------

function singleStep(wire: unknown, account: Address, allowlistId: string): { plan: TxPlan; args: readonly unknown[] } {
  const plan = planFromWire(wire)
  if (plan.account !== account.toLowerCase()) throw new PlanVerificationError(null, 'the plan was built for another wallet')
  const step = plan.steps[0]
  if (plan.steps.length !== 1 || !step || step.allowlistId !== allowlistId) throw new PlanVerificationError(step?.id ?? null, `expected exactly one ${allowlistId} step`)
  if (step.value !== 0n) throw new PlanVerificationError(step.id, 'evidence calls carry no value')
  return { plan, args: step.args }
}

/** The commit plan must commit exactly the locally computed commitment for this market. */
export function checkCommitPlan(wire: unknown, ctx: { market: Address; commitment: Hex32; account: Address }): TxPlan {
  const { plan, args } = singleStep(wire, ctx.account, 'evidenceRegistry.commitEvidence')
  if (String(args[0]).toLowerCase() !== ctx.market.toLowerCase()) throw new PlanVerificationError('commit', 'the commit is for another market')
  if (String(args[1]).toLowerCase() !== ctx.commitment.toLowerCase()) throw new PlanVerificationError('commit', 'the commitment differs from the one computed in this browser')
  return plan
}

/** The publish plan must publish exactly this manifest digest for this market. */
export function checkPublishEvidencePlan(wire: unknown, ctx: { market: Address; contentSha256: Hex32; account: Address }): TxPlan {
  const { plan, args } = singleStep(wire, ctx.account, 'evidenceRegistry.publishEvidence')
  if (String(args[0]).toLowerCase() !== ctx.market.toLowerCase()) throw new PlanVerificationError('publish', 'the evidence is published for another market')
  if (String(args[1]).toLowerCase() !== ctx.contentSha256.toLowerCase()) throw new PlanVerificationError('publish', 'the published digest differs from your manifest')
  return plan
}

/** The reveal template must describe this seal: same commitment (recomputed with the local salt), registry and wallet. */
export function checkRevealTemplate(t: RevealTemplateResponse, ctx: { seal: EvidenceSeal; submissionId: string; manifest: DeploymentManifest; account: Address }): void {
  const s = ctx.seal
  const local = computeEvidenceCommitment({ chainId: s.chainId, registry: ctx.manifest.pine.evidenceRegistry, market: s.market, submitter: ctx.account.toLowerCase() as Address, contentSha256: s.contentSha256, salt: s.salt })
  const tt = t.template
  const mismatch =
    tt.commitment.toLowerCase() !== local ||
    local !== s.commitment ||
    tt.registry.toLowerCase() !== ctx.manifest.pine.evidenceRegistry ||
    tt.market.toLowerCase() !== s.market ||
    tt.account.toLowerCase() !== ctx.account.toLowerCase() ||
    tt.chainId !== s.chainId ||
    tt.submissionId !== ctx.submissionId ||
    tt.contentSha256.toLowerCase() !== s.contentSha256
  if (mismatch) throw new PlanVerificationError('reveal', 'the reveal template does not match your sealed evidence; the reveal would revert')
}

/** The reveal transaction, built and later verified in this browser (Pine issues no reveal plan). */
export function buildRevealWire(manifest: DeploymentManifest, account: Address, submissionId: string, seal: EvidenceSeal): WireTxPlan {
  const step = buildStep(manifest, { id: 'reveal', allowlistId: 'evidenceRegistry.revealEvidence', args: [BigInt(submissionId), seal.contentSha256, seal.salt] })
  return planToWire(newPlan(manifest, `reveal-${submissionId}`, account, [step]))
}

/** The caller's indexed, not yet revealed submission with this commitment. */
export async function findCommittedSubmission(api: PineWriteApi, market: Address, submitter: Address, commitment: Hex32, maxPages = 10): Promise<RevealCandidate | null> {
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page += 1) {
    const res = await api.evidence(market, { status: 'committed', cursor })
    const found = res.items.find((i) => i.submitter.toLowerCase() === submitter.toLowerCase() && i.commitment?.toLowerCase() === commitment.toLowerCase())
    if (found) return found
    if (!res.nextCursor) return null
    cursor = res.nextCursor
  }
  return null
}

/**
 * The indexed submission of a seal whose commit confirmation this browser did not record (the page was reloaded or
 * closed while the wallet prompt was open or the transaction pending): the caller's commitment, in the seal's registry.
 */
export async function findSealSubmission(api: PineWriteApi, seal: EvidenceSeal): Promise<RevealCandidate | null> {
  const found = await findCommittedSubmission(api, seal.market, seal.submitter, seal.commitment)
  return found && found.registry.toLowerCase() === seal.registry ? found : null
}

/** Pine refuses empty uploads: an empty artifact (only an earlier seal can hold one) can never be uploaded. */
function unavailable(a: EvidenceManifest['artifacts'][number]): boolean {
  return a.size === 0 || !sessionArtifacts.has(a.sha256)
}

/** Uploads the artifacts (from this session's memory) and the manifest; checks every digest Pine reports. */
export async function uploadEvidence(client: PineWriteApi, manifestBody: EvidenceManifest, contentSha256: Hex32): Promise<void> {
  for (const a of manifestBody.artifacts) {
    if (a.size === 0) throw new Error(`“${a.name}” is empty, and Pine does not store empty files.`)
    const bytes = sessionArtifacts.get(a.sha256)
    if (!bytes) throw new Error(`Attach “${a.name}” again: its bytes are no longer in this browser session.`)
    const stored = await client.uploadArtifact(bytes, { mediaType: a.mediaType, expectedSha256: a.sha256 })
    if (stored.sha256.toLowerCase() !== a.sha256 || stored.size !== a.size) throw new Error(`Pine stored different bytes for “${a.name}”.`)
  }
  const stored = await client.storeManifest(manifestBody)
  if (stored.sha256.toLowerCase() !== contentSha256) throw new Error('Pine stored a different manifest than the one you prepared.')
}

// ---------------------------------------------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------------------------------------------

export type EvidenceActionKind = 'commit' | 'publish' | 'reveal'

interface StoredEvidenceAction {
  v: 1
  kind: EvidenceActionKind
  contentSha256: Hex32
  /** Direct publication: the manifest to upload (public evidence). */
  manifest?: EvidenceManifest
  planId?: string
  submissionId?: string
}

function isStoredEvidenceAction(value: unknown): value is StoredEvidenceAction {
  const v = value as Partial<StoredEvidenceAction> | null
  return Boolean(v && v.v === 1 && (v.kind === 'commit' || v.kind === 'publish' || v.kind === 'reveal') && typeof v.contentSha256 === 'string' && HEX32.test(v.contentSha256))
}

export interface SealedEvidenceView {
  contentSha256: Hex32
  commitment: Hex32
  /** The submitter's own title (plain text). */
  title: string
  state: 'sealed' | 'committing' | 'committed' | 'revealing' | 'revealed'
  commitTxHash?: Hex
  revealTxHash?: Hex
  submissionId?: string
  /** Reveal while block.timestamp < revealDeadline (unix seconds, from ClaimRegistry). */
  revealDeadline: number | null
  /** Pine stops preparing reveals 60 s before the deadline. */
  revealOpen: boolean
  /** Artifacts whose bytes are not in this session: attach them again to reveal. */
  missingArtifacts: { name: string; sha256: Hex32; size: number }[]
}

export interface UseApiEvidenceOptions {
  /** Accepted artifact media types (default: the backend's default list). */
  allowedMediaTypes?: readonly string[]
  pollIntervalMs?: number
  now?: () => Date
  sleep?(ms: number): Promise<void>
}

export interface ApiEvidence {
  /** ClaimRegistry's view of the market (deadlines, claim digest, commit); null while loading or unregistered. */
  claim: OnChainClaim | null
  prepared: PreparedEvidence | null
  fieldErrors: EvidenceFieldError[]
  /** Builds the manifest locally (hashing the files). Nothing leaves the browser. */
  prepare(input: EvidenceComposition): Promise<PreparedEvidence | null>
  /** Direct: uploads the artifacts and manifest, then publishes the digest on chain. */
  publish(): Promise<void>
  /** Sealed: stores a fresh salt locally, then commits the commitment on chain. Uploads nothing. */
  commit(): Promise<void>
  /** Uploads the sealed evidence and reveals it on chain. Pass the files again after a reload. */
  reveal(contentSha256: Hex32, opts?: { files?: Blob[]; acknowledgeUnavailableContent?: boolean }): Promise<void>
  seals: SealedEvidenceView[]
  /** The action shown by `runner`. */
  action: { kind: EvidenceActionKind; contentSha256: Hex32 } | null
  runner: ApiPlanRunner
  /** Pine's view of the commit/publish plan after it was sent. */
  planState: MarketsPlanResponse['planState'] | null
  /** Platform warnings of the last reveal template (plain text). */
  revealWarnings: { code: string; text: string }[]
  /**
   * What the user last started on this page: new evidence (prepare, commit, publish) or a reveal. `error` belongs to
   * it, including a reveal that failed before its plan (when `action` still names the earlier commit). Null until then.
   */
  attempt: 'submit' | 'reveal' | null
  /** The seal whose reveal is being checked, uploaded or sent (from the click until the run stops). */
  revealing: Hex32 | null
  error: WriteErrorInfo | null
  /** An evidence action is being prepared or sent (a reveal included, from its first check on). */
  busy: boolean
  /** Forgets the current action when nothing of it is pending (a failed or never-sent run). */
  abandon(): void
}

const EVIDENCE_LIMITS = { maxTotalValueWei: 0n, maxApprovalAmount: 0n } as const
/** The backend stops offering evidence plans this long before a deadline (SUBMISSION_MARGIN_SECONDS). */
const SUBMISSION_MARGIN_SECONDS = 60

export function useApiEvidence(market: Address, options: UseApiEvidenceOptions = {}): ApiEvidence {
  const { env } = usePine()
  const api = useWriteApi()
  const wallet = useWallet()
  const manifest = usePinnedManifest()
  const reader = useRegistryReader()
  const { claim } = useOnChainClaim(market)
  const m = market.toLowerCase() as Address
  const account = wallet.address?.toLowerCase() as Address | undefined
  const storage = getBrowserStorage()
  const clockRef = useRef(options.now)
  useEffect(() => {
    clockRef.current = options.now
  })
  const nowMs = useCallback(() => (clockRef.current?.() ?? new Date()).getTime(), [])
  const nowSec = useCallback(() => Math.floor(nowMs() / 1000), [nowMs])

  const [prepared, setPrepared] = useState<PreparedEvidence | null>(null)
  const [fieldErrors, setFieldErrors] = useState<EvidenceFieldError[]>([])
  const [error, setError] = useState<WriteErrorInfo | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [sealVersion, setSealVersion] = useState(0)
  const [revealWarnings, setRevealWarnings] = useState<{ code: string; text: string }[]>([])
  const [attempt, setAttempt] = useState<'submit' | 'reveal' | null>(null)
  const [revealing, setRevealing] = useState<Hex32 | null>(null)
  const revealingRef = useRef<Hex32 | null>(null)
  const [action, setAction] = useStoredRecord<StoredEvidenceAction>(account ? `pine:api-evidence-action:${m}:${account}` : null, isStoredEvidenceAction)

  const latest = useRef({ action, account, claim, manifest, prepared, reader })
  useEffect(() => {
    latest.current = { action, account, claim, manifest, prepared, reader }
  })

  /** Updates the seal of `submitter` (always named: a run may finish after the wallet switched). */
  const updateSeal = useCallback(
    (submitter: Address, contentSha256: Hex32, patch: Partial<EvidenceSeal>) => {
      const seal = readSeal(storage, m, contentSha256, submitter)
      if (!seal) return
      writeSeal(storage, { ...seal, ...patch })
      setSealVersion((v) => v + 1)
    },
    [storage, m],
  )

  // Seals written by another tab of this browser (a commit or a reveal there) show here too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key.startsWith(SEAL_PREFIX) || e.key.startsWith(SEAL_INDEX_PREFIX)) setSealVersion((v) => v + 1)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const recordPlan = useCallback(
    (planId: string) => {
      const current = latest.current.action
      if (current) setAction({ ...current, planId })
    },
    [setAction],
  )

  // The submitter is part of the key: another wallet's commit of the same content is a different transaction, and the
  // runner's persisted progress is keyed by it.
  const keyOf = useCallback((a: StoredEvidenceAction | null) => (a && account ? `api-evidence:${a.kind}:${m}:${account}:${a.contentSha256}` : null), [account, m])
  const plan = usePlanAction({
    key: keyOf(action),
    idleKey: `api-evidence-idle:${m}:${account ?? 'none'}`,
    markets: [m],
    limits: EVIDENCE_LIMITS,
    sleep: options.sleep,
    now: nowMs,
    async create(idempotencyKey) {
      const client = requireWriteApi(api)
      const { action: act, account: acct, manifest: pinned, claim: c } = latest.current
      if (!act || !acct || !pinned) throw new Error('Connect the wallet you signed in with.')
      if (act.kind === 'commit') {
        const seal = readSeal(storage, m, act.contentSha256, acct)
        if (!seal) throw new Error('The sealed evidence was not found in this browser.')
        const res = await client.commitPlan({ market: m, commitment: seal.commitment }, idempotencyKey)
        if (res.planState.offerExpired) throw new Error('This commit offer expired; the evidence window is closing.')
        checkCommitPlan(res.plan, { market: m, commitment: seal.commitment, account: acct })
        updateSeal(acct, act.contentSha256, { commitPlanId: res.planState.id })
        recordPlan(res.planState.id)
        return { wire: res.plan, planId: res.planState.id, expiresAt: res.planState.expiresAt * 1000 }
      }
      if (act.kind === 'publish') {
        const manifestBody = act.manifest
        if (!manifestBody) throw new Error('Prepare the evidence again.')
        await uploadEvidence(client, manifestBody, act.contentSha256)
        const res = await client.publishEvidencePlan({ market: m, contentSha256: act.contentSha256 }, idempotencyKey)
        if (res.planState.offerExpired) throw new Error('This publish offer expired; the evidence window is closing.')
        checkPublishEvidencePlan(res.plan, { market: m, contentSha256: act.contentSha256, account: acct })
        recordPlan(res.planState.id)
        return { wire: res.plan, planId: res.planState.id, expiresAt: res.planState.expiresAt * 1000 }
      }
      // Reveal: built locally from the seal; Pine sees neither the plan nor the salt before the transaction. It is
      // offered until Pine's margin before the on-chain reveal deadline.
      const seal = readSeal(storage, m, act.contentSha256, acct)
      const submissionId = act.submissionId ?? seal?.submissionId
      if (!seal || !submissionId) throw new Error('Start the reveal again.')
      if (!c) throw new Error('The claim is not loaded from the chain yet.')
      return { wire: buildRevealWire(pinned, acct, submissionId, seal), planId: `reveal-${submissionId}`, expiresAt: (c.revealDeadline - SUBMISSION_MARGIN_SECONDS) * 1000 }
    },
    // This render's action and wallet: a run that finishes after the hook moved on records its own seal.
    async submitted(planId, stepId, txHash) {
      if (!action || !account) return
      if (action.kind === 'reveal') {
        // No backend report for reveals: the read model sees the EvidenceRevealed event.
        updateSeal(account, action.contentSha256, { revealTxHash: txHash.toLowerCase() as Hex })
        return
      }
      if (action.kind === 'commit') updateSeal(account, action.contentSha256, { commitTxHash: txHash.toLowerCase() as Hex })
      await requireWriteApi(api).reportMarketsPlanTx(planId, stepId, txHash)
    },
    onDone() {
      if (!action || !account) return
      if (action.kind === 'commit') updateSeal(account, action.contentSha256, { committedAt: isoNow() })
      if (action.kind === 'reveal') updateSeal(account, action.contentSha256, { revealedAt: isoNow() })
    },
  })
  const { runner } = plan

  const followPlanId = action && action.kind !== 'reveal' && runner.runner.state === 'done' ? action.planId : undefined
  const polled = usePolledStatus<MarketsPlanResponse>({
    key: followPlanId ? `markets-plan:${followPlanId}` : null,
    load: () => requireWriteApi(api).getMarketsPlan(followPlanId ?? ''),
    done: (v) => FINAL_PLAN_STATES.includes(v.planState.state),
    intervalMs: options.pollIntervalMs ?? 10_000,
    sleep: options.sleep ? (ms) => options.sleep?.(ms) ?? Promise.resolve() : undefined,
  })

  /** An action whose transactions may still land cannot be replaced. */
  const inFlight = useCallback(() => runnerIsBusy(runner) || runner.runner.steps.some((s) => s.status === 'pending' || s.status === 'awaiting_signature'), [runner])

  /**
   * Records the indexed submission of a seal as its commit. When the stored action is that commit and nothing of it is
   * in flight here, its stale progress is dropped, so it can never be sent again.
   */
  const adoptSubmission = useCallback(
    (submitter: Address, seal: EvidenceSeal, submission: RevealCandidate) => {
      updateSeal(submitter, seal.contentSha256, {
        committedAt: new Date(submission.committedAt * 1000).toISOString(),
        submissionId: submission.submissionId,
        commitTxHash: seal.commitTxHash ?? (submission.committedTxHash.toLowerCase() as Hex),
      })
      const current = latest.current.action
      if (current?.kind === 'commit' && current.contentSha256 === seal.contentSha256 && !inFlight()) {
        runner.discard()
        setAction(null)
      }
    },
    [updateSeal, inFlight, runner, setAction],
  )

  const start = useCallback(
    async (next: StoredEvidenceAction) => {
      if (inFlight()) {
        setError({ code: 'UNKNOWN', action: 'none', message: 'Another evidence transaction is in progress. Wait for it to finish.' })
        return
      }
      setError(null)
      setAction(next)
      await plan.runWhenReady(keyOf(next))
    },
    [inFlight, setAction, plan, keyOf],
  )

  const prepare = useCallback(
    async (input: EvidenceComposition): Promise<PreparedEvidence | null> => {
      setAttempt('submit')
      setError(null)
      setFieldErrors([])
      const { account: acct, claim: c } = latest.current
      if (!acct) {
        setError({ code: 'UNKNOWN', action: 'none', message: 'Connect your wallet: the evidence names its submitter.' })
        return null
      }
      if (!c) {
        setError({ code: 'UNKNOWN', action: 'retry_later', message: 'The claim is not loaded from the chain yet.' })
        return null
      }
      setPreparing(true)
      try {
        const result = await prepareEvidence(input, { chainId: env.defaultChainId, market: m, submitter: acct, claim: c, allowedMediaTypes: options.allowedMediaTypes })
        if (!result.ok) {
          setFieldErrors(result.errors)
          setPrepared(null)
          return null
        }
        setPrepared(result.prepared)
        return result.prepared
      } finally {
        setPreparing(false)
      }
    },
    [env.defaultChainId, m, options.allowedMediaTypes],
  )

  const checkOpen = useCallback((deadline: number | undefined, what: string): boolean => {
    if (deadline === undefined) {
      setError({ code: 'UNKNOWN', action: 'retry_later', message: 'The claim is not loaded from the chain yet.' })
      return false
    }
    if (nowSec() >= deadline - SUBMISSION_MARGIN_SECONDS) {
      setError({ code: 'UNKNOWN', action: 'none', message: `The ${what} window has closed.` })
      return false
    }
    return true
  }, [nowSec])

  const publish = useCallback(async () => {
    setAttempt('submit')
    const { prepared: p, claim: c } = latest.current
    if (!p) {
      setError({ code: 'UNKNOWN', action: 'fix_input', message: 'Prepare the evidence first.' })
      return
    }
    if (!checkOpen(c?.evidenceDeadline, 'evidence')) return
    await start({ v: 1, kind: 'publish', contentSha256: p.contentSha256, manifest: p.manifest })
  }, [checkOpen, start])

  const commit = useCallback(async () => {
    setAttempt('submit')
    const { prepared: p, claim: c, account: acct, manifest: pinned } = latest.current
    if (!p || !acct || !pinned) {
      setError({ code: 'UNKNOWN', action: 'fix_input', message: p ? 'Connect the wallet you signed in with.' : 'Prepare the evidence first.' })
      return
    }
    if (!checkOpen(c?.evidenceDeadline, 'evidence')) return
    const existing = readSeal(storage, m, p.contentSha256, acct)
    if (existing?.committedAt) {
      setError({ code: 'UNKNOWN', action: 'none', message: 'This evidence is already committed. Reveal it before the reveal deadline.' })
      return
    }
    if (existing && api && (existing.commitPlanId || existing.commitTxHash)) {
      // A commit of this seal was started before and its progress may be lost (a reload while the wallet prompt was
      // open): when Pine indexed its commitment, adopt that submission instead of sending a second commit.
      let submission: RevealCandidate | null
      try {
        submission = await findSealSubmission(api, existing)
      } catch (e) {
        setError(describeWriteError(e))
        return
      }
      if (submission) {
        adoptSubmission(acct, existing, submission)
        setError({ code: 'UNKNOWN', action: 'none', message: 'This evidence is already committed on chain. Reveal it before the reveal deadline.' })
        return
      }
    }
    if (!existing) {
      // The salt is stored before any request, so a crash never leaves a commitment without its salt.
      const salt = newEvidenceSalt()
      const registry = pinned.pine.evidenceRegistry
      const commitment = computeEvidenceCommitment({ chainId: env.defaultChainId, registry, market: m, submitter: acct, contentSha256: p.contentSha256, salt })
      writeSeal(storage, { v: 1, chainId: env.defaultChainId, registry, market: m, submitter: acct, contentSha256: p.contentSha256, salt, commitment, manifest: p.manifest, createdAt: isoNow() })
      setSealVersion((v) => v + 1)
    }
    await start({ v: 1, kind: 'commit', contentSha256: p.contentSha256 })
  }, [checkOpen, storage, m, env.defaultChainId, api, adoptSubmission, start])

  const reveal = useCallback(
    async (contentSha256: Hex32, opts: { files?: Blob[]; acknowledgeUnavailableContent?: boolean } = {}) => {
      // One reveal at a time. It is busy, and owns `error`, from its first check until its run stops: a reveal that
      // fails before its plan starts leaves `action` on the earlier commit, so `attempt` says where the error belongs.
      if (revealingRef.current) return
      const sha = contentSha256.toLowerCase() as Hex32
      revealingRef.current = sha
      setRevealing(sha)
      setAttempt('reveal')
      setError(null)
      setRevealWarnings([])
      try {
        const { account: acct, claim: c, manifest: pinned, reader: rpc } = latest.current
        const client = api
        if (!acct || !pinned || !client) {
          setError({ code: 'UNKNOWN', action: 'none', message: 'Connect the wallet that committed this evidence.' })
          return
        }
        if (inFlight()) {
          setError({ code: 'UNKNOWN', action: 'none', message: 'Another evidence transaction is in progress. Wait for it to finish.' })
          return
        }
        const seal = readSeal(storage, m, sha, acct)
        if (!seal) {
          setError({ code: 'UNKNOWN', action: 'none', message: 'This browser has no salt for that evidence, so it cannot reveal it.' })
          return
        }
        if (seal.revealedAt) {
          setError({ code: 'UNKNOWN', action: 'none', message: 'This evidence is already revealed.' })
          return
        }
        if (!checkOpen(c?.revealDeadline, 'reveal')) return
        // Re-attached files are matched to the manifest by digest.
        for (const file of opts.files ?? []) {
          if (file.size > EVIDENCE_UPLOAD_MAX_BYTES) continue
          const bytes = new Uint8Array(await file.arrayBuffer())
          const digest = sha256Hex(bytes)
          if (seal.manifest.artifacts.some((a) => a.sha256 === digest)) sessionArtifacts.set(digest, bytes)
        }
        const missing = seal.manifest.artifacts.filter(unavailable)
        if (missing.length > 0 && opts.acknowledgeUnavailableContent !== true) {
          setError({
            code: 'UNKNOWN',
            action: 'fix_input',
            message: missing.every((a) => a.size === 0)
              ? `Pine does not store empty files, so ${missing.map((a) => a.name).join(', ')} cannot be uploaded: this evidence can only be revealed without its files.`
              : `Attach the committed files again to reveal: ${missing.filter((a) => a.size > 0).map((a) => a.name).join(', ')}. Pine stores your evidence (the written report and its files) only when every committed file is attached.`,
          })
          return
        }
        // SEC-EVID-13: nothing of the sealed evidence reaches Pine unless the reveal can go ahead now: the commitment is
        // indexed, the reveal template describes this seal, and the reveal plan verifies. Only then is it uploaded,
        // right before the reveal transaction. With a file missing nothing is uploaded at all: Pine stores a manifest
        // only once every artifact it lists is stored.
        const submission = seal.submissionId ? { submissionId: seal.submissionId } : await findCommittedSubmission(client, m, acct, seal.commitment)
        if (!submission) {
          setError({ code: 'NOT_READY', action: 'retry_later', message: 'Pine has not indexed your commitment yet. Try again in a minute.' })
          return
        }
        // Nothing is uploaded yet, so the template is requested without stored content.
        const template = await client.revealTemplate({ submissionId: submission.submissionId, contentSha256: seal.contentSha256, unavailableContentAcknowledged: true })
        checkRevealTemplate(template, { seal, submissionId: submission.submissionId, manifest: pinned, account: acct })
        if (!rpc) throw new Error(`No RPC is configured for chain ${env.defaultChainId}, so the reveal cannot be checked.`)
        await verifyWirePlan(buildRevealWire(pinned, acct, submission.submissionId, seal), { manifest: pinned, account: acct, reader: rpc, markets: [m], limits: EVIDENCE_LIMITS })
        if (missing.length === 0) await uploadEvidence(client, seal.manifest, seal.contentSha256)
        // The "manifest unavailable" warning answered the pre-upload request; it holds only when nothing was uploaded.
        setRevealWarnings(missing.length === 0 ? template.warnings.filter((w) => w.code !== 'manifest_unavailable') : template.warnings)
        updateSeal(acct, seal.contentSha256, { submissionId: submission.submissionId })
        await start({ v: 1, kind: 'reveal', contentSha256: seal.contentSha256, submissionId: submission.submissionId })
      } catch (e) {
        setError(describeWriteError(e))
      } finally {
        revealingRef.current = null
        setRevealing(null)
      }
    },
    [api, env.defaultChainId, inFlight, storage, m, checkOpen, updateSeal, start],
  )

  const abandon = useCallback(() => {
    if (inFlight()) return
    runner.discard()
    setAction(null)
  }, [inFlight, runner, setAction])

  const stored = useMemo<EvidenceSeal[]>(() => {
    void sealVersion
    return account ? listSeals(storage, m, account) : []
  }, [sealVersion, account, storage, m])

  // Commits started here whose confirmation this browser did not record are followed in Pine's read model by their
  // commitment, except the commit this browser is sending now or that its wallet refused (nothing was sent).
  const ownCommit = action?.kind === 'commit' && (runnerIsBusy(runner) || runner.runner.steps.some((s) => s.status === 'failed' && !s.txHash)) ? action.contentSha256 : null
  const unconfirmed = stored.filter((s) => !s.committedAt && !s.revealTxHash && (s.commitPlanId || s.commitTxHash) && s.contentSha256 !== ownCommit)
  usePolledStatus<{ seal: EvidenceSeal; submission: RevealCandidate | null }[]>({
    key: account && api && unconfirmed.length > 0 ? `evidence-seals:${m}:${account}:${unconfirmed.map((s) => s.commitment).join(',')}` : null,
    load: async () => {
      const client = requireWriteApi(api)
      const found: { seal: EvidenceSeal; submission: RevealCandidate | null }[] = []
      for (const seal of unconfirmed) found.push({ seal, submission: await findSealSubmission(client, seal) })
      return found
    },
    done: (v) => v.every((f) => f.submission !== null),
    onValue: (v) => {
      for (const { seal, submission } of v) if (submission) adoptSubmission(seal.submitter, seal, submission)
    },
    intervalMs: options.pollIntervalMs ?? 10_000,
    sleep: options.sleep ? (ms) => options.sleep?.(ms) ?? Promise.resolve() : undefined,
  })

  const seals = useMemo<SealedEvidenceView[]>(() => {
    const revealDeadline = claim?.revealDeadline ?? null
    const now = nowSec()
    return stored.map((s) => {
      const state: SealedEvidenceView['state'] = s.revealedAt ? 'revealed' : s.revealTxHash ? 'revealing' : s.committedAt ? 'committed' : s.commitTxHash || s.commitPlanId ? 'committing' : 'sealed'
      return {
        contentSha256: s.contentSha256,
        commitment: s.commitment,
        title: s.manifest.title,
        state,
        commitTxHash: s.commitTxHash,
        revealTxHash: s.revealTxHash,
        submissionId: s.submissionId,
        revealDeadline,
        revealOpen: state === 'committed' && revealDeadline !== null && now < revealDeadline - SUBMISSION_MARGIN_SECONDS,
        missingArtifacts: s.manifest.artifacts.filter(unavailable).map((a) => ({ name: a.name, sha256: a.sha256 as Hex32, size: a.size })),
      }
    })
  }, [stored, claim?.revealDeadline, nowSec, runner.runner.state])

  return {
    claim,
    prepared,
    fieldErrors,
    prepare,
    publish,
    commit,
    reveal,
    seals,
    action: action ? { kind: action.kind, contentSha256: action.contentSha256 } : null,
    runner,
    planState: polled.value?.planState ?? null,
    revealWarnings,
    attempt,
    revealing,
    error: error ?? plan.lastError ?? (runner.error ? { code: 'UNKNOWN', action: 'none', message: runner.error } : null),
    busy: preparing || revealing !== null || runnerIsBusy(runner),
    abandon,
  }
}
