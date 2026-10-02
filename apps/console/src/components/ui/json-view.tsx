'use client'

import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'

type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

function toJson(v: unknown): Json {
  if (v === undefined) return null
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return v.map(toJson)
  if (typeof v === 'object') {
    const out: Record<string, Json> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val !== undefined) out[k] = toJson(val)
    }
    return out
  }
  return String(v)
}

function collectLeaves(v: Json, path: string, out: Map<string, string>) {
  if (v !== null && typeof v === 'object') {
    if (Array.isArray(v)) v.forEach((x, i) => collectLeaves(x, `${path}[${i}]`, out))
    else for (const [k, x] of Object.entries(v)) collectLeaves(x, path ? `${path}.${k}` : k, out)
    if ((Array.isArray(v) ? v.length : Object.keys(v).length) === 0) out.set(path, JSON.stringify(v))
  } else out.set(path, JSON.stringify(v))
}

/**
 * Syntax-colored, collapsible JSON. When `value` changes, leaves whose value changed flash resin.
 * `defaultDepth` controls which nodes start expanded.
 */
export function JsonView({
  value,
  defaultDepth = 2,
  className,
  collapsedPaths,
}: {
  value: unknown
  defaultDepth?: number
  className?: string
  collapsedPaths?: string[]
}) {
  const json = React.useMemo(() => toJson(value), [value])
  const prev = React.useRef<Map<string, string> | null>(null)
  const [changed, setChanged] = React.useState<{ key: number; paths: Set<string> }>({ key: 0, paths: new Set() })

  React.useEffect(() => {
    const leaves = new Map<string, string>()
    collectLeaves(json, '', leaves)
    const before = prev.current
    prev.current = leaves
    if (!before) return
    const paths = new Set<string>()
    for (const [k, v] of leaves) if (before.get(k) !== v) paths.add(k)
    if (paths.size) setChanged({ key: Date.now(), paths })
  }, [json])

  return (
    <div className={cn('mono-cond overflow-x-auto text-[11.5px] leading-[1.6]', className)} role="tree" aria-label="JSON document">
      <Node
        value={json}
        path=""
        depth={0}
        defaultDepth={defaultDepth}
        changed={changed}
        collapsed={collapsedPaths}
        last
      />
    </div>
  )
}

function Scalar({ v }: { v: Exclude<Json, object> }) {
  if (typeof v === 'string')
    return <span className="wrap-anywhere text-[var(--code-string)]">{JSON.stringify(v)}</span>
  if (typeof v === 'number') return <span className="text-[var(--code-number)]">{v}</span>
  if (typeof v === 'boolean') return <span className="text-[var(--code-number)]">{String(v)}</span>
  return <span className="text-faint">null</span>
}

function Node({
  value,
  name,
  path,
  depth,
  defaultDepth,
  changed,
  collapsed,
  last,
}: {
  value: Json
  name?: string
  path: string
  depth: number
  defaultDepth: number
  changed: { key: number; paths: Set<string> }
  collapsed?: string[]
  last?: boolean
}) {
  const isObj = value !== null && typeof value === 'object'
  const [open, setOpen] = React.useState(depth < defaultDepth && !(collapsed ?? []).includes(path))
  const comma = last ? '' : <span className="text-[var(--code-punct)]">,</span>
  const key =
    name !== undefined ? (
      <>
        <span className="text-[var(--code-key)]">{JSON.stringify(name)}</span>
        <span className="text-[var(--code-punct)]">: </span>
      </>
    ) : null

  if (!isObj) {
    const flash = changed.paths.has(path)
    return (
      <div className="pl-[14px]" role="treeitem" aria-selected={false}>
        <span key={flash ? changed.key : undefined} className={cn('rounded-[2px]', flash && 'animate-resin-flash resin-static')}>
          {key}
          <Scalar v={value as Exclude<Json, object>} />
        </span>
        {comma}
      </div>
    )
  }

  const entries: [string | undefined, Json][] = Array.isArray(value)
    ? value.map((v) => [undefined, v])
    : Object.entries(value)
  const [o, c] = Array.isArray(value) ? ['[', ']'] : ['{', '}']
  const childChanged = [...changed.paths].some((p) => p.startsWith(path) && p !== path)

  if (entries.length === 0) {
    return (
      <div className="pl-[14px]" role="treeitem" aria-selected={false}>
        {key}
        <span className="text-[var(--code-punct)]">
          {o}
          {c}
        </span>
        {comma}
      </div>
    )
  }

  return (
    <div role="treeitem" aria-expanded={open} aria-selected={false}>
      <div className="flex items-start">
        <button
          type="button"
          onClick={() => setOpen((x) => !x)}
          className="mt-[3px] flex size-[14px] shrink-0 items-center justify-center rounded-[2px] text-faint hover:bg-sunken hover:text-bark"
          aria-label={open ? `Collapse ${name ?? 'root'}` : `Expand ${name ?? 'root'}`}
        >
          <ChevronRight size={11} className={cn('transition-transform', open && 'rotate-90')} aria-hidden />
        </button>
        <span className="min-w-0">
          {key}
          <span className="text-[var(--code-punct)]">{o}</span>
          {!open ? (
            <>
              <button
                type="button"
                onClick={() => setOpen(true)}
                className={cn(
                  'mx-1 rounded-[3px] bg-sunken px-1 text-[10.5px] text-muted hover:text-bark',
                  childChanged && 'bg-resin-soft text-resin',
                )}
              >
                {entries.length} {Array.isArray(value) ? (entries.length === 1 ? 'item' : 'items') : entries.length === 1 ? 'key' : 'keys'}
              </button>
              <span className="text-[var(--code-punct)]">{c}</span>
              {comma}
            </>
          ) : null}
        </span>
      </div>
      {open ? (
        <>
          <div className="ml-[6px] border-l border-line pl-[8px]" role="group">
            {entries.map(([k, v], i) => (
              <Node
                key={k ?? i}
                name={k}
                value={v}
                path={Array.isArray(value) ? `${path}[${i}]` : path ? `${path}.${k}` : (k as string)}
                depth={depth + 1}
                defaultDepth={defaultDepth}
                changed={changed}
                collapsed={collapsed}
                last={i === entries.length - 1}
              />
            ))}
          </div>
          <div className="pl-[14px]">
            <span className="text-[var(--code-punct)]">{c}</span>
            {comma}
          </div>
        </>
      ) : null}
    </div>
  )
}
