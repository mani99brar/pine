'use client'

import { useMemo } from 'react'
import type { ClaimDetail } from '@pine/core'
import { shortHash } from '@pine/core'
import { briefToMarkdown, toAgentBrief } from '@pine/core/agent'
import { Braces, FileText, Terminal } from 'lucide-react'
import { useClipboard } from '@/components/ui/copy'
import { HashValue } from '@/components/ui/copy'
import { MarginNote } from '@/components/ui/field'
import { useOrigin } from '@/lib/use-origin'

function CopyAction({ value, label, done, icon }: { value: string; label: string; done: string; icon: React.ReactNode }) {
  const { copy, copied } = useClipboard()
  return (
    <button
      type="button"
      onClick={() => void copy(value)}
      className="inline-flex h-10 items-center gap-2 rounded-sm border border-rule-strong bg-sheet px-3 text-sm font-bold shadow-[0_2px_0_var(--color-rule)] hover:bg-bond"
    >
      {icon}
      <span aria-live="polite">{copied ? done : label}</span>
    </button>
  )
}

export function AgentBriefSection({ claim }: { claim: ClaimDetail }) {
  const origin = useOrigin()
  const brief = useMemo(() => {
    try {
      return toAgentBrief(claim, { siteUrl: origin })
    } catch {
      return null
    }
  }, [claim, origin])
  const md = useMemo(() => (brief ? briefToMarkdown(brief) : ''), [brief])
  const jsonUrl = `${origin}/api/agent/v1/claims/${claim.id}`
  const curl = `curl -s ${jsonUrl}`

  return (
    <div className="grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_17rem] xl:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="min-w-0">
        <p className="measure">
          The same claim, as a machine-readable brief for AI agents and scripts: target, requirement, environment pins, reproduction
          command, evidence channel, deadline and admissibility rules.
        </p>
        <div className="mt-4 flex flex-wrap gap-2 print:hidden">
          <CopyAction value={md} label="Copy brief as Markdown" done="Markdown copied" icon={<FileText aria-hidden className="size-4" />} />
          <CopyAction value={curl} label="Copy curl command" done="Command copied" icon={<Terminal aria-hidden className="size-4" />} />
          <a
            href={`/api/agent/v1/claims/${claim.id}`}
            className="inline-flex h-10 items-center gap-2 rounded-sm border border-rule-strong bg-sheet px-3 text-sm font-bold no-underline shadow-[0_2px_0_var(--color-rule)] hover:bg-bond"
          >
            <Braces aria-hidden className="size-4" /> Open JSON
          </a>
        </div>
        <dl className="mt-5 space-y-2 text-[15px]">
          <div className="flex flex-wrap gap-x-3">
            <dt className="font-bold text-graphite">Brief</dt>
            <dd className="min-w-0 font-mono text-[13.5px] break-all">{jsonUrl}</dd>
          </div>
          <div className="flex flex-wrap gap-x-3">
            <dt className="font-bold text-graphite">Manifest</dt>
            <dd className="min-w-0 font-mono text-[13.5px] break-all">
              {origin}/api/agent/v1/claims/{claim.id}/manifest.json
            </dd>
          </div>
          <div className="flex flex-wrap items-center gap-x-3">
            <dt className="font-bold text-graphite">Manifest hash</dt>
            <dd className="min-w-0">
              <HashValue value={claim.manifestHash} display={shortHash(claim.manifestHash, 10)} label="manifest hash" />
            </dd>
          </div>
        </dl>
        {md ? (
          <details className="mt-4">
            <summary className="text-sm font-bold text-violet underline underline-offset-4">Preview the Markdown brief</summary>
            <pre tabIndex={0} aria-label="Agent brief in Markdown" className="mt-2 max-h-96 overflow-auto border border-rule bg-bond p-4 font-mono text-[13px] leading-6 whitespace-pre-wrap">
              {md}
            </pre>
          </details>
        ) : null}
      </div>
      <aside>
        <MarginNote title="Why this exists">
          <p>
            Investigators include AI agents. Giving them the exact pins means their exhibits reproduce against the right commit and
            environment, instead of whatever is on the default branch today.
          </p>
          <p>
            See the <a className="link" href="/agents">agent API guide</a> for the full list of endpoints.
          </p>
        </MarginNote>
      </aside>
    </div>
  )
}
