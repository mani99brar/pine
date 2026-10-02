/** URL helpers for agent-facing artifacts. All apps serve the same routes (via @pine/server). */

export function trimSite(siteUrl: string): string {
  return (siteUrl || '').replace(/\/+$/, '')
}

export const AGENT_API_PREFIX = '/api/agent/v1'

export function agentUrls(siteUrl: string) {
  const site = trimSite(siteUrl)
  const api = `${site}${AGENT_API_PREFIX}`
  return {
    site,
    api,
    claims: `${api}/claims`,
    openClaims: `${api}/claims?status=open`,
    claim: (id: string) => `${api}/claims/${encodeURIComponent(id)}`,
    claimMarkdown: (id: string) => `${api}/claims/${encodeURIComponent(id)}?format=md`,
    manifest: (id: string) => `${api}/claims/${encodeURIComponent(id)}/manifest.json`,
    policies: `${api}/policies`,
    policy: (id: string, version?: string) =>
      `${api}/policies/${encodeURIComponent(id)}${version ? `?version=${encodeURIComponent(version)}` : ''}`,
    schema: `${api}/schema/claim-manifest.json`,
    openapi: `${api}/openapi.json`,
    feed: `${api}/feed.xml`,
    wellKnown: `${site}/.well-known/pine.json`,
    llms: `${site}/llms.txt`,
    llmsFull: `${site}/llms-full.txt`,
    claimPage: (id: string) => `${site}/claims/${encodeURIComponent(id)}`,
    evidencePage: (id: string) => `${site}/claims/${encodeURIComponent(id)}/evidence`,
    policyPage: (id: string) => `${site}/policies/${encodeURIComponent(id)}`,
    risksPage: `${site}/risks`,
  }
}
