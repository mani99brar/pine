import type { ComposerStage } from '@pine/core'

export type WizardStep = 'source' | 'policy' | 'claim' | 'environment' | 'deadlines' | 'funding' | 'review' | 'publish'

export const WIZARD_STEPS: { id: WizardStep; title: string; purpose: string; stage: ComposerStage }[] = [
  { id: 'source', title: 'Source', purpose: 'Pin the exact commit the claim is about.', stage: 'source' },
  { id: 'policy', title: 'Policy', purpose: 'Choose the rulebook that decides what evidence counts.', stage: 'policy' },
  { id: 'claim', title: 'Claim', purpose: 'State the one requirement and the violation that would break it.', stage: 'claim' },
  { id: 'environment', title: 'Environment', purpose: 'Pin how to reproduce: runtime, dependencies, configuration.', stage: 'claim' },
  { id: 'deadlines', title: 'Deadlines and oracle', purpose: 'Set the absolute UTC deadline and how the question is answered.', stage: 'deadlines' },
  { id: 'funding', title: 'Funding', purpose: 'Decide how much to put in, and see every cost line.', stage: 'funding' },
  { id: 'review', title: 'Review', purpose: 'Read the claim as an investigator would, and acknowledge the risks.', stage: 'review' },
  { id: 'publish', title: 'Publish', purpose: 'Sign the transactions that put the claim on the record.', stage: 'publish' },
]

export function isWizardStep(s: string | null | undefined): s is WizardStep {
  return !!s && WIZARD_STEPS.some((w) => w.id === s)
}

export function stepIndex(s: WizardStep) {
  return WIZARD_STEPS.findIndex((w) => w.id === s)
}

/** Route a validation issue path to the wizard step that owns the field. */
export function stepForIssue(path: string, stage: ComposerStage): WizardStep {
  if (path.startsWith('spec.environment')) return 'environment'
  if (path.startsWith('spec.parameters') || path.startsWith('spec.claimClass')) return 'policy'
  if (path === 'spec.regressionOnly' || path.startsWith('source')) return 'source'
  if (path.startsWith('funding')) return 'funding'
  if (stage === 'deadlines') return 'deadlines'
  if (stage === 'publish') return 'publish'
  return stage as WizardStep
}

/** DOM id for the field that owns a validation path, so error summaries can link to it. */
export function fieldIdForPath(path: string): string {
  const map: [RegExp, string][] = [
    [/^source\.baseCommit/, 'f-base'],
    [/^source/, 'f-source'],
    [/^spec\.regressionOnly/, 'f-regression'],
    [/^spec\.policy/, 'f-policy'],
    [/^spec\.claimClass/, 'f-claimclass'],
    [/^spec\.parameters\.([\w-]+)/, 'f-param-$1'],
    [/^spec\.title/, 'f-title'],
    [/^spec\.requirement/, 'f-requirement'],
    [/^spec\.violation/, 'f-violation'],
    [/^spec\.scope\.inScope/, 'f-inscope'],
    [/^spec\.scope\.outOfScope/, 'f-outscope'],
    [/^spec\.scope/, 'f-inscope'],
    [/^spec\.faultModel/, 'f-fault'],
    [/^spec\.allowedInputs/, 'f-inputs'],
    [/^spec\.assumptions/, 'f-assumptions'],
    [/^spec\.exclusions/, 'f-exclusions'],
    [/^spec\.specReference/, 'f-specref'],
    [/^spec\.environment\.runtime/, 'f-runtime'],
    [/^spec\.environment\.reproductionCommand/, 'f-command'],
    [/^spec\.environment\.config/, 'f-config'],
    [/^spec\.environment\.dependencyLock/, 'f-lock'],
    [/^spec\.environment\.containerImage/, 'f-image'],
    [/^spec\.environment/, 'f-runtime'],
    [/^spec\.evidence\.deadline/, 'f-deadline-date'],
    [/^spec\.evidence/, 'f-mechanism'],
    [/^spec\.oracle\.openingTime/, 'f-opening-date'],
    [/^spec\.oracle\.minBond/, 'f-minbond'],
    [/^spec\.oracle/, 'f-opening-date'],
    [/^funding\.liquidity/, 'f-liquidity'],
    [/^funding\.spendingLimit/, 'f-limit'],
    [/^funding\.initialYesPrice/, 'f-price'],
    [/^funding\.priceRange/, 'f-range-lo'],
    [/^funding/, 'f-liquidity'],
  ]
  for (const [re, id] of map) {
    const m = path.match(re)
    if (m) return id.replace('$1', m[1] ?? '')
  }
  return 'step-heading'
}
