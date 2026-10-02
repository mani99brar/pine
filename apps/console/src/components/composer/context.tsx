'use client'

import * as React from 'react'
import type { ClaimSpec, ComposerStage } from '@pine/core'
import type { ClaimComposer } from '@pine/react'

export type SectionId = 'source' | 'policy' | 'claim' | 'environment' | 'deadlines' | 'funding' | 'review'

export const SECTIONS: { id: SectionId; label: string; stage: ComposerStage }[] = [
  { id: 'source', label: 'Source', stage: 'source' },
  { id: 'policy', label: 'Policy', stage: 'policy' },
  { id: 'claim', label: 'Claim', stage: 'claim' },
  { id: 'environment', label: 'Environment', stage: 'claim' },
  { id: 'deadlines', label: 'Deadlines & oracle', stage: 'deadlines' },
  { id: 'funding', label: 'Funding', stage: 'funding' },
  { id: 'review', label: 'Review & publish', stage: 'review' },
]

/** Which section an issue path belongs to (environment is split out of the "claim" stage). */
export function sectionForPath(path: string): SectionId {
  if (path.startsWith('spec.environment')) return 'environment'
  if (path.startsWith('source')) return 'source'
  if (path.startsWith('spec.policy')) return 'policy'
  if (path.startsWith('spec.evidence') || path.startsWith('spec.oracle')) return 'deadlines'
  if (path.startsWith('funding')) return 'funding'
  if (path.startsWith('spec.')) return 'claim'
  return 'review'
}

export function fieldId(path: string) {
  return `f-${path.replace(/[.[\]]+/g, '-').replace(/-$/, '')}`
}

interface Ctx {
  c: ClaimComposer
  touched: Set<string>
  touch: (path: string) => void
  showAll: boolean
  setShowAll: (v: boolean) => void
  /** First issue message for this exact path or a child path, when it should be visible */
  err: (path: string) => string | undefined
  /** All issues under a path regardless of visibility */
  issuesUnder: (path: string) => { path: string; message: string }[]
  disabled: boolean
  updateSpec: (fn: (s: Partial<ClaimSpec>) => Partial<ClaimSpec>) => void
}

const ComposerCtx = React.createContext<Ctx | null>(null)

export function useComposerCtx() {
  const v = React.useContext(ComposerCtx)
  if (!v) throw new Error('useComposerCtx outside provider')
  return v
}

export function ComposerProvider({ c, children }: { c: ClaimComposer; children: React.ReactNode }) {
  const [touched, setTouched] = React.useState<Set<string>>(() => new Set())
  const [showAll, setShowAll] = React.useState(false)
  const touch = React.useCallback((p: string) => setTouched((t) => (t.has(p) ? t : new Set(t).add(p))), [])
  const issues = c.validation.issues
  const under = React.useCallback(
    (path: string) => issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`) || i.path.startsWith(`${path}[`)),
    [issues],
  )
  const err = React.useCallback(
    (path: string) => {
      if (!showAll && !touched.has(path)) return undefined
      return under(path)[0]?.message
    },
    [showAll, touched, under],
  )
  const updateSpec = React.useCallback(
    (fn: (s: Partial<ClaimSpec>) => Partial<ClaimSpec>) => c.update((d) => ({ ...d, spec: fn(d.spec) })),
    [c],
  )
  const value = React.useMemo<Ctx>(
    () => ({ c, touched, touch, showAll, setShowAll, err, issuesUnder: under, disabled: c.frozen, updateSpec }),
    [c, touched, touch, showAll, err, under, updateSpec],
  )
  return <ComposerCtx.Provider value={value}>{children}</ComposerCtx.Provider>
}
