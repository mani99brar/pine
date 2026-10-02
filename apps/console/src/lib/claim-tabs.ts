export const CLAIM_TABS = ['overview', 'market', 'evidence', 'oracle', 'agent', 'activity'] as const
export type ClaimTab = (typeof CLAIM_TABS)[number]
