import type { Metadata } from 'next'
import { readPineEnv } from '@pine/data'
import Link from 'next/link'
import { connection } from 'next/server'
import { POLICIES, POLICY_FAMILIES, shortHash, type PolicyVersion } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { FamilyIcon } from '@/components/icons'
import { Container, PageHeader } from '@/components/ui/primitives'
import { FAMILY_VAR } from '@/lib/crystal'
import { listPoliciesServer } from '@/lib/server/data'

export const metadata: Metadata = {
  title: 'Policies',
  description: 'The reviewed catalog of versioned policies that define what counts as a counterexample. SC-001 is shown but gated.',
  alternates: { types: { 'application/json': readPineEnv().dataSource === 'api' ? '/api/v1/policies' : '/api/agent/v1/policies' } },
}

/** The catalog: the backend's (the digests every claim pins) in `api` mode, read per request; else the bundled one. */
async function catalog(): Promise<PolicyVersion[]> {
  if (readPineEnv().dataSource !== 'api') return POLICIES
  await connection()
  return listPoliciesServer()
}

export default async function PoliciesPage() {
  const policies = await catalog()
  return (
    <Container>
      <PageHeader
        title="Policies"
        lead="A small reviewed catalog. Each policy fixes what counts as a counterexample, and its version and hash are pinned into every claim that uses it. Revisions only affect future claims."
      />
      <ul className="grid gap-5">
        {policies.length === 0 && <li className="text-lumen-2">The policy catalog is unavailable right now. Try again shortly.</li>}
        {policies.map((p) => {
          const fam = POLICY_FAMILIES.find((f) => f.id === p.family)
          const gated = p.status === 'gated' || p.status === 'retired'
          return (
            <li key={p.id}>
              <Link href={`/policies/${p.id}`} className="glass cut-xl group relative grid gap-5 overflow-hidden p-6 transition-colors hover:border-edge-strong sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-start">
                <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: FAMILY_VAR[p.family] }} />
                <span className="cut-md flex h-14 w-14 items-center justify-center border border-edge bg-void" style={{ color: FAMILY_VAR[p.family] }}>
                  <FamilyIcon family={p.family} size={28} />
                </span>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="t-h3">
                      {p.id}@{p.version}
                    </span>
                    {gated ? (
                      <span className="tag border-[rgba(183,154,255,0.45)] text-ca">Gated</span>
                    ) : p.status === 'draft' ? (
                      <span className="tag text-lumen-2">Draft text</span>
                    ) : (
                      <span className="tag text-lumen-2">Enabled</span>
                    )}
                  </p>
                  <p className="mt-1 text-[1rem] font-medium text-lumen">{p.title}</p>
                  <p className="mt-2 max-w-[68ch] text-[0.9375rem] text-lumen-2">{p.summary}</p>
                  {fam && <p className="mt-2 text-[0.84375rem] text-lumen-3">{fam.name}: {fam.tagline}</p>}
                  {gated && <p className="mt-2 text-[0.84375rem] text-ca">{p.gateReason ?? COPY.scGate}</p>}
                </div>
                <span className="t-code text-[0.75rem] text-lumen-3" title={p.contentHash}>
                  {shortHash(p.contentHash)}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
      <p className="mt-8 max-w-[68ch] text-[0.875rem] text-lumen-3">{COPY.notAReview}</p>
    </Container>
  )
}
