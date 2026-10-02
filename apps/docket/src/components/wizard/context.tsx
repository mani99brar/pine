'use client'

import { createContext, useContext } from 'react'
import type { ClaimComposer } from '@pine/react'
import type { WizardStep } from '@/lib/wizard'

export interface WizardIssue {
  path: string
  message: string
  step: WizardStep
}

export interface WizardCtx {
  composer: ClaimComposer
  draftId: string
  step: WizardStep
  goTo(step: WizardStep): void
  /** Issues per step (all of them, whether shown or not) */
  issues: WizardIssue[]
  issuesFor(step: WizardStep): WizardIssue[]
  /** First error message for a path prefix, only once the user tried to continue from that step */
  errorFor(pathPrefix: string): string | undefined
  attempted: Set<WizardStep>
  /** True when the terms are frozen (market created) */
  frozen: boolean
}

export const WizardContext = createContext<WizardCtx | null>(null)

export function useWizard(): WizardCtx {
  const ctx = useContext(WizardContext)
  if (!ctx) throw new Error('useWizard must be used inside the filing wizard')
  return ctx
}
