'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { ValidationIssue } from '@pine/core'
import { stageForPath } from '@pine/core'
import { runnerHasSentSteps, useApiPublish, type ApiPublish, type ClaimComposer } from '@pine/react'

// `api` mode: the draft's publication on the Pine backend (backend draft, verified preview, createClaim plan, status),
// shared by every composer stage.

const ApiPublishContext = createContext<ApiPublish | null>(null)

/** The publication of the draft being composed; null outside `api` mode. */
export function useApiPublication(): ApiPublish | null {
  return useContext(ApiPublishContext)
}

/** Terms are locked once a createClaim transaction may land, until Pine reports that the publication failed or expired. */
export function publicationLocked(pub: ApiPublish): boolean {
  const state = pub.publication?.state
  if (state === 'submitted' || state === 'mined' || state === 'confirmed') return true
  if (state === 'failed' || state === 'expired') return false
  return pub.status === 'publishing' || runnerHasSentSteps(pub.runner)
}

/**
 * The composer as the stages see it in api mode: frozen while a publication may land, and with the backend's own
 * refusals (the last save's VALIDATION_FAILED issues, while the draft still has the refused terms: an edit drops them)
 * next to the fields they name. A field that already shows a local issue keeps only that one, so a message never
 * appears twice in slightly different words.
 */
function withPublication(c: ClaimComposer, pub: ApiPublish): ClaimComposer {
  const locked = publicationLocked(pub)
  const paths = new Set(c.validation.issues.map((i) => i.path))
  const extra: ValidationIssue[] = []
  for (const e of pub.fieldErrors) {
    if (paths.has(e.composerPath)) continue
    paths.add(e.composerPath)
    extra.push({ path: e.composerPath, message: e.message, stage: stageForPath(e.composerPath) })
  }
  if (extra.length === 0 && !locked) return c
  const issues = [...c.validation.issues, ...extra]
  return { ...c, frozen: c.frozen || locked, validation: { ok: issues.length === 0, issues }, blockedStages: [...new Set(issues.map((i) => i.stage))] }
}

export function ApiComposerScope({ c, draftId, children }: { c: ClaimComposer; draftId: string; children: (view: ClaimComposer) => ReactNode }) {
  const pub = useApiPublish(draftId)
  return <ApiPublishContext.Provider value={pub}>{children(withPublication(c, pub))}</ApiPublishContext.Provider>
}
