'use client'

import { useRef, useState } from 'react'
import type { EnvironmentPin, Hex } from '@pine/core'
import { hashText, shortHash } from '@pine/core'
import { FileUp, Plus, X } from 'lucide-react'
import { Field, Input, ListInput, MarginNote, Textarea } from '@/components/ui/field'
import { HashValue } from '@/components/ui/copy'
import { useWizard } from '../context'

const SECRETISH = /(secret|token|password|passwd|private|api[_-]?key|mnemonic|seed)/i

export function EnvironmentStep() {
  const { composer, errorFor } = useWizard()
  const env = (composer.draft.spec.environment ?? {}) as EnvironmentPin
  const set = (patch: Partial<EnvironmentPin>) =>
    composer.update((d) => ({ ...d, spec: { ...d.spec, environment: { ...(d.spec.environment as EnvironmentPin), ...patch } } }))

  return (
    <>
      <div className="grid gap-x-10 gap-y-4 lg:grid-cols-[minmax(0,1fr)_17rem] xl:grid-cols-[minmax(0,1fr)_19rem]">
        <p className="measure text-lg">
          An exhibit only counts if it reproduces under the environment you pin here. Be exact: versions, lockfile and configuration.
          Never include secrets. Everything on this page is published.
        </p>
        <aside>
          <MarginNote title="Why it is hashed">
            <p>
              The environment is fingerprinted into one hash that appears in the question. Anyone can recompute it, so nobody can argue
              later about which setup was meant.
            </p>
          </MarginNote>
        </aside>
      </div>

      <Field
        id="f-runtime"
        label="Runtime"
        hint="Language runtime and exact version."
        error={errorFor('spec.environment.runtime')}
        guidance={<p>For example &ldquo;node 22.14.0&rdquo;, &ldquo;python 3.12.4&rdquo; or &ldquo;rustc 1.81.0&rdquo;. A range like &ldquo;node 22&rdquo; is too loose.</p>}
      >
        <Input id="f-runtime" value={env.runtime ?? ''} onChange={(e) => set({ runtime: e.target.value })} placeholder="e.g. node 22.14.0" mono />
      </Field>

      <Field id="f-pm" label="Package manager" optional guidance={<p>The tool and version that installs dependencies from the lockfile.</p>}>
        <Input id="f-pm" value={env.packageManager ?? ''} onChange={(e) => set({ packageManager: e.target.value || undefined })} placeholder="e.g. pnpm 10.9.2" mono />
      </Field>

      <LockfileField env={env} set={set} error={errorFor('spec.environment.dependencyLock')} />

      <Field
        id="f-image"
        label="Container image"
        optional
        hint="Pinned by digest, if you provide one."
        error={errorFor('spec.environment.containerImage')}
        guidance={<p>Use the immutable form image@sha256:…, not a tag like :latest. Tags can be moved after filing.</p>}
      >
        <Input id="f-image" value={env.containerImage ?? ''} onChange={(e) => set({ containerImage: e.target.value || undefined })} placeholder="e.g. ghcr.io/org/app@sha256:…" mono />
      </Field>

      <Field
        id="f-external"
        label="External state"
        optional
        hint="Snapshots or outside systems the reproduction depends on, or none."
        guidance={<p>For example a chain block number, a database fixture, or &ldquo;none&rdquo;. Investigators must be able to recreate it.</p>}
      >
        <Input id="f-external" value={env.externalState ?? ''} onChange={(e) => set({ externalState: e.target.value || undefined })} placeholder="none, or a pinned snapshot such as a block number" />
      </Field>

      <ConfigField env={env} set={set} error={errorFor('spec.environment.config')} />

      <Field
        id="f-command"
        label="Reproduction command"
        hint="The one command that runs the relevant tests or harness."
        error={errorFor('spec.environment.reproductionCommand')}
        guidance={<p>Investigators run this first. Exhibits should extend it, not replace it with a different harness.</p>}
      >
        <Textarea
          id="f-command"
          mono
          rows={2}
          value={env.reproductionCommand ?? ''}
          onChange={(e) => set({ reproductionCommand: e.target.value })}
          placeholder="e.g. pnpm vitest run test/reporter-funding.spec.ts"
        />
      </Field>

      <Field
        id="f-setup"
        label="Setup steps"
        optional
        hint="In order. Each step on its own line."
        error={errorFor('spec.environment.setupSteps')}
        guidance={<p>Anything that must happen before the command: install, seed fixtures, start a local node.</p>}
      >
        <ListInput id="f-setup" mono value={env.setupSteps ?? []} onChange={(x) => set({ setupSteps: x })} placeholder="e.g. pnpm install --frozen-lockfile" />
      </Field>

      <Field id="f-notes" label="Notes for investigators" optional guidance={<p>Anything else that helps someone reproduce your environment faithfully.</p>}>
        <Textarea id="f-notes" rows={3} value={env.notes ?? ''} onChange={(e) => set({ notes: e.target.value || undefined })} />
      </Field>

      <div className="border-t-2 border-ink pt-5">
        <h3 className="text-xl">Fingerprints</h3>
        <p className="mt-1 text-[15px] text-graphite">Recomputed as you type. The environment hash goes into the question.</p>
        <dl className="mt-3 divide-y divide-rule border-y border-rule text-[15px]">
          <div className="grid gap-1 py-2.5 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <dt className="font-bold text-graphite">Configuration hash</dt>
            <dd className="min-w-0">{env.configHash ? <HashValue value={env.configHash} wrap label="configuration hash" /> : 'Not computed'}</dd>
          </div>
          <div className="grid gap-1 py-2.5 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <dt className="font-bold text-graphite">Environment hash</dt>
            <dd className="min-w-0">{env.envHash ? <HashValue value={env.envHash} wrap label="environment hash" /> : 'Not computed'}</dd>
          </div>
        </dl>
      </div>
    </>
  )
}

function LockfileField({ env, set, error }: { env: EnvironmentPin; set: (p: Partial<EnvironmentPin>) => void; error?: string }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState(false)
  const lock = env.dependencyLock
  return (
    <Field
      id="f-lock"
      label="Dependency lockfile"
      optional
      hint="Its path in the repository, and the hash of its contents at the pinned commit."
      error={error}
      guidance={
        <>
          <p>The lockfile pins every transitive dependency. Choose the file from your checkout and the hash is computed here in your browser.</p>
          <p>Nothing is uploaded.</p>
        </>
      }
    >
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Input
          id="f-lock"
          mono
          placeholder="e.g. pnpm-lock.yaml"
          value={lock?.path ?? ''}
          onChange={(e) => set({ dependencyLock: e.target.value ? { path: e.target.value, hash: (lock?.hash ?? ('0x' + '0'.repeat(64))) as Hex } : undefined })}
        />
        <input
          ref={fileRef}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={async (e) => {
            const f = e.target.files?.[0]
            if (!f) return
            setReading(true)
            try {
              const text = await f.text()
              set({ dependencyLock: { path: lock?.path || f.name, hash: hashText(text) } })
            } finally {
              setReading(false)
              e.target.value = ''
            }
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="inline-flex h-11 items-center gap-2 rounded-sm border border-rule-strong bg-sheet px-3 text-sm font-bold shadow-[0_2px_0_var(--color-rule)] hover:bg-bond"
        >
          <FileUp aria-hidden className="size-4" /> {reading ? 'Hashing…' : 'Hash a file'}
        </button>
      </div>
      {lock?.hash && !/^0x0{64}$/.test(lock.hash) ? (
        <p className="mt-2 text-sm">
          Hash <HashValue value={lock.hash} display={shortHash(lock.hash, 10)} label="lockfile hash" />
        </p>
      ) : lock?.path ? (
        <p className="mt-2 text-sm text-ochre">No hash yet. Choose the file to compute it.</p>
      ) : null}
    </Field>
  )
}

function ConfigField({ env, set, error }: { env: EnvironmentPin; set: (p: Partial<EnvironmentPin>) => void; error?: string }) {
  const entries = Object.entries(env.config ?? {})
  const [k, setK] = useState('')
  const [v, setV] = useState('')
  const add = () => {
    const key = k.trim()
    if (!key) return
    set({ config: { ...(env.config ?? {}), [key]: v } })
    setK('')
    setV('')
  }
  const warn = SECRETISH.test(k)
  return (
    <Field
      id="f-config"
      label="Configuration"
      optional
      hint="Non-secret settings, as key and value."
      error={error}
      guidance={
        <>
          <p>Feature flags, limits and addresses the behavior depends on.</p>
          <p>
            <strong>Never pin secrets.</strong> Keys that look like tokens or passwords are rejected. Use a placeholder and explain how to
            supply a test value.
          </p>
        </>
      }
    >
      {entries.length > 0 ? (
        <ul className="mb-2 divide-y divide-rule border border-rule bg-sheet">
          {entries.map(([key, val]) => (
            <li key={key} className="flex items-center gap-3 px-3 py-2 font-mono text-[14px]">
              <span className="min-w-0 flex-1 break-all">
                {key}={val}
              </span>
              <button
                type="button"
                aria-label={`Remove ${key}`}
                onClick={() => {
                  const next = { ...(env.config ?? {}) }
                  delete next[key]
                  set({ config: next })
                }}
                className="rounded-xs p-1 text-graphite hover:bg-bond hover:text-red"
              >
                <X aria-hidden className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto]">
        <Input id="f-config" mono aria-label="Key" placeholder="RESERVE_FLOOR_XDAI" value={k} onChange={(e) => setK(e.target.value)} />
        <Input
          mono
          aria-label="Value"
          placeholder="25"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <button
          type="button"
          onClick={add}
          disabled={!k.trim()}
          className="inline-flex h-11 items-center justify-center gap-1.5 rounded-sm border border-rule-strong bg-sheet px-3 text-sm font-bold shadow-[0_2px_0_var(--color-rule)] hover:bg-bond disabled:opacity-50"
        >
          <Plus aria-hidden className="size-4" /> Add
        </button>
      </div>
      {warn ? (
        <p className="mt-2 text-sm font-bold text-red" role="alert">
          &ldquo;{k}&rdquo; looks like a secret. The configuration is published with the claim.
        </p>
      ) : null}
    </Field>
  )
}
