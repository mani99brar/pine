'use client'

import * as React from 'react'
import { Bot, ClipboardCopy } from 'lucide-react'
import type { ClaimDetail } from '@pine/core'
import { briefToMarkdown, buildClaimJsonLd, toAgentBrief } from '@pine/core/agent'
import { usePine } from '@pine/react'
import { useOrigin } from '@/lib/hooks'
import { Button } from '@/components/ui/button'
import { CodeBlock } from '@/components/ui/code-block'
import { useClipboard } from '@/components/ui/copy-button'
import { ExternalLink } from '@/components/ui/external-link'
import { JsonView } from '@/components/ui/json-view'
import { Pane } from '@/components/ui/pane'

export function useSiteUrl() {
  const { env } = usePine()
  return useOrigin(env.siteUrl.replace(/\/$/, ''))
}

export function useAgentArtifacts(claim: ClaimDetail | undefined) {
  const siteUrl = useSiteUrl()
  return React.useMemo(() => {
    if (!claim) return undefined
    const brief = toAgentBrief(claim, { siteUrl })
    return { brief, markdown: briefToMarkdown(brief), jsonLd: buildClaimJsonLd(claim, { siteUrl }), siteUrl }
  }, [claim, siteUrl])
}

export function AgentTab({ claim }: { claim: ClaimDetail }) {
  const a = useAgentArtifacts(claim)
  const { copy } = useClipboard()
  if (!a) return null
  const base = `${a.siteUrl}/api/agent/v1`
  const curl = [
    `curl -s ${base}/claims/${claim.id}`,
    `curl -s "${base}/claims/${claim.id}?format=md"`,
    `curl -sD - ${base}/claims/${claim.id}/manifest.json -o manifest.json   # x-pine-manifest-hash header`,
    `curl -s "${base}/claims?status=open&policy=${claim.policy.id}"`,
  ].join('\n')
  return (
    <div className="divide-y divide-line">
      <section className="flex flex-wrap items-start gap-4 px-4 py-5 sm:px-6">
        <Bot size={20} aria-hidden className="mt-0.5 shrink-0 text-needle" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold">Brief an investigator</h2>
          <p className="mt-1 max-w-[70ch] text-[13.5px] text-muted">
            Everything an automated or human investigator needs: the pinned target, the one requirement, the reproduction environment,
            the evidence channel and deadline, admissibility rules and disclaimers. The brief is generated from the immutable manifest.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="sm" kbd="b" onClick={() => void copy(a.markdown, 'agent brief')}>
            <ClipboardCopy size={13} aria-hidden /> Copy brief as Markdown
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void copy(JSON.stringify(a.brief, null, 2), 'brief JSON')}>
            Copy JSON
          </Button>
        </div>
      </section>

      <div className="grid xl:grid-cols-2 xl:divide-x xl:divide-line">
        <Pane title="Agent brief (Markdown)" className="border-0" actions={<ExternalLink href={`${base}/claims/${claim.id}?format=md`}>Raw</ExternalLink>}>
          <pre className="mono-cond scrollbar-thin wrap-anywhere max-h-[520px] overflow-auto whitespace-pre-wrap bg-frost px-4 py-3 text-[11.5px] leading-[1.6]">
            {a.markdown}
          </pre>
        </Pane>
        <div className="divide-y divide-line">
          <Pane title="API" className="border-0" description="CORS-enabled GET endpoints, no key needed">
            <div className="space-y-3 p-4">
              <CodeBlock code={curl} label="curl" prompt />
              <p className="text-[12.5px] text-muted">
                Discovery: <ExternalLink href={`${a.siteUrl}/llms.txt`}>/llms.txt</ExternalLink>,{' '}
                <ExternalLink href={`${a.siteUrl}/.well-known/pine.json`}>/.well-known/pine.json</ExternalLink>,{' '}
                <ExternalLink href={`${base}/feed.xml`}>Atom feed</ExternalLink>,{' '}
                <ExternalLink href={`${base}/openapi.json`}>OpenAPI</ExternalLink>.
              </p>
            </div>
          </Pane>
          <Pane title="manifest.json" className="border-0" actions={<ExternalLink href={`${base}/claims/${claim.id}/manifest.json`}>Raw</ExternalLink>}>
            <div className="scrollbar-thin max-h-[420px] overflow-auto px-3 py-3">
              <JsonView value={claim.manifest} defaultDepth={1} />
            </div>
          </Pane>
        </div>
      </div>
      <Pane title="JSON-LD embedded in this page" className="border-0" description="schema.org Question and Dataset">
        <div className="scrollbar-thin max-h-[360px] overflow-auto px-3 py-3">
          <JsonView value={a.jsonLd} defaultDepth={1} />
        </div>
      </Pane>
    </div>
  )
}
