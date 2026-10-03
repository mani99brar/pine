/**
 * Shows a machine-readable endpoint (`/llms.txt`, `/.well-known/pine.json`, `/api/agent/v1/...`) inside
 * the app. On a deployment these are plain HTTP responses; in the static preview the same @pine/server
 * handlers answer in the browser, and links to them open here instead of leaving the artifact.
 */
import { useEffect, useState } from 'react'
import Link from '../shims/next-link'
import { CopyButton } from '@/components/ui/interactive'
import { Container, Notice, PageHeader, Skeleton } from '@/components/ui/primitives'

interface Loaded {
  path: string
  status: number
  type: string
  body: string
}

function pretty(body: string, type: string): string {
  if (!/json/i.test(type)) return body
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

export function EndpointView({ path }: { path: string }) {
  const [res, setRes] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch(path, { headers: { accept: path.includes('format=md') ? 'text/markdown' : '*/*' } })
      .then(async (r) => {
        const type = r.headers.get('content-type') ?? ''
        const body = pretty(await r.text(), type)
        if (alive) setRes({ path, status: r.status, type, body })
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [path])

  const current = res?.path === path ? res : null

  return (
    <Container>
      <Link href="/agents" className="mt-6 inline-flex text-[0.875rem] text-lumen-3 hover:text-lumen">
        For agents
      </Link>
      <PageHeader
        className="pt-6 sm:pt-8"
        title={<span className="t-code break-all text-[clamp(1.4rem,3vw,2.2rem)]">{path}</span>}
        lead="A machine-readable endpoint. On a deployment it is a plain HTTP response; in this static preview the same handler answers inside your browser."
      />
      {error && (
        <Notice tone="critical" title="The endpoint failed">
          {error}
        </Notice>
      )}
      {!current && !error && <Skeleton className="h-72 w-full" />}
      {current && (
        <div className="cut-xl well overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-edge px-4 py-2.5">
            <p className="t-code text-[0.78rem] text-lumen-3">
              {current.status} · {current.type || 'unknown type'}
            </p>
            <CopyButton text={current.body} label="Copy response" size="xs" variant="ghost" />
          </div>
          <pre className="t-code max-h-[70vh] overflow-auto whitespace-pre-wrap break-words px-4 py-4 text-[0.78rem] text-lumen-2">{current.body}</pre>
        </div>
      )}
    </Container>
  )
}
