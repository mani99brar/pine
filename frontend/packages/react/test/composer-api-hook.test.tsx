/** useClaimComposer in `api` mode against a fake backend policy catalog (no network). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { rawCidFromSha256, type Hex32 } from '@pine/core/pine-shared'
import { createPineQueryClient, PineProviders } from '../src/providers'
import { useClaimComposer } from '../src/composer/use-claim-composer'
import { useDrafts } from '../src/composer/drafts'
import { PINE } from './api-write-chain'
import { FakePine, json, wrapper } from './api-write-support'

const SHA = `0x${'ab'.repeat(32)}`
const summary = (id: string, version: string, status: string, publishable: boolean) => ({
  id,
  version,
  title: `${id} title`,
  family: id.split('-')[0] ?? id,
  sha256: SHA,
  cid: rawCidFromSha256(SHA as Hex32),
  status,
  publishable,
})
const CATALOG = [summary('BOT-001', '0.1.0', 'draft', true), summary('BOT-001', '0.2.0', 'draft', true), summary('SC-001', '0.1.0', 'disabled', false)]

function catalog(): FakePine {
  return new FakePine()
    .on('GET', /^\/api\/v1\/policies$/, () => json(200, { policies: CATALOG }))
    .on('GET', /^\/api\/v1\/policies\/([A-Z]+-\d{3})\/(\d+\.\d+\.\d+)$/, (_req, m) => {
      const s = CATALOG.find((p) => p.id === m[1] && p.version === m[2])
      return s ? json(200, { ...s, bytes: 10, gate: s.id === 'SC-001' ? 'SC-001 is disabled on this deployment.' : null, mediaType: 'text/markdown; charset=utf-8', text: '## Intended use\n\nKeepers.' }) : json(404, { error: { code: 'NOT_FOUND', message: 'Unknown policy', requestId: 'r' } })
    })
    .on('GET', /^\/api\/v1\/policies\/([A-Z]+-\d{3})\/(\d+\.\d+\.\d+)\/parameters\.schema\.json$/, () =>
      json(200, {
        type: 'object',
        properties: {
          sourceRequirement: { type: 'string', maxLength: 1000 },
          startingStates: { type: 'string', maxLength: 4000 },
          simulatedAdapters: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 20 },
        },
        required: ['sourceRequirement', 'startingStates', 'simulatedAdapters'],
      }),
    )
}

let fake: FakePine

beforeEach(() => {
  localStorage.clear()
  fake = catalog()
  vi.stubGlobal('fetch', fake.fetch)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useClaimComposer in api mode', () => {
  it('reads the chosen policy from the backend catalog and takes its latest version', async () => {
    const { result } = renderHook(() => useClaimComposer('dapihook01', { backendPolicy: true }), { wrapper })
    await waitFor(() => expect(result.current.draft.id).toBe('dapihook01'))
    expect(result.current.api).toBeDefined()
    expect(result.current.question).toBeUndefined()
    act(() => result.current.update({ spec: { policyId: 'BOT-001' } }))
    await waitFor(() => expect(result.current.draft.spec.policyVersion).toBe('0.2.0'))
    await waitFor(() => expect(result.current.policy?.version).toBe('0.2.0'))
    expect(result.current.policy?.status).toBe('draft')
    expect(result.current.api?.policyPublishable).toBe(true)
    expect(result.current.policy?.parameters.map((p) => p.key)).toEqual(['sourceRequirement', 'startingStates', 'simulatedAdapters'])
    expect(result.current.validation.issues.filter((i) => i.path.startsWith('spec.parameters')).map((i) => i.path)).toEqual([
      'spec.parameters.sourceRequirement',
      'spec.parameters.startingStates',
      'spec.parameters.simulatedAdapters',
    ])
    // The backend's default window, not the demo's 72 h.
    const window = result.current.api?.evidenceWindowSeconds ?? 0
    expect(window).toBeGreaterThan(6 * 86_400)
    expect(window).toBeLessThanOrEqual(7 * 86_400 + 3600)
    // Only public catalog reads: nothing is written.
    expect(fake.requests.filter((r) => r.method !== 'GET')).toEqual([])
  })

  it('SEC-CLAIM-06 shows a disabled policy as not publishable, with the backend gate', async () => {
    const { result } = renderHook(() => useClaimComposer('dapihook02', { backendPolicy: true }), { wrapper })
    await waitFor(() => expect(result.current.draft.id).toBe('dapihook02'))
    act(() => result.current.update({ spec: { policyId: 'SC-001', policyVersion: '0.1.0' } }))
    await waitFor(() => expect(result.current.policy?.status).toBe('gated'))
    expect(result.current.api?.policyPublishable).toBe(false)
    expect(result.current.validation.issues.find((i) => i.path === 'spec.policyId')?.message).toBe('SC-001 is disabled on this deployment.')
  })

  it('makes no catalog request unless the composer UI asks for the backend policy', async () => {
    const { result } = renderHook(() => useClaimComposer('dapihook03'), { wrapper })
    await waitFor(() => expect(result.current.draft.id).toBe('dapihook03'))
    act(() => result.current.update({ spec: { policyId: 'BOT-001', policyVersion: '0.2.0' } }))
    await new Promise((r) => setTimeout(r, 20))
    expect(fake.of(/^\/api\/v1\/policies/)).toEqual([])
    expect(result.current.api?.policyPublishable).toBe(false)
  })

  it('deleting a draft also deletes Pine’s copy, but never one with a publication', async () => {
    const BACKEND = '0b6a8f1e-3a55-4c1e-9d55-6f4e1a2b3c4d'
    fake.on('DELETE', /^\/api\/v1\/drafts\/([^/]+)$/, () => new Response(null, { status: 204 }))
    const { result } = renderHook(() => ({ composer: useClaimComposer('dapihook04'), drafts: useDrafts() }), { wrapper })
    await waitFor(() => expect(result.current.composer.draft.id).toBe('dapihook04'))
    act(() => result.current.composer.update((d) => ({ ...d, spec: { ...d.spec, title: 'x' }, publication: { steps: [], backend: { draftId: BACKEND, revision: 2 } } })))
    await act(async () => result.current.composer.saveNow())
    localStorage.setItem('pine:api-preview:dapihook04', '{}')
    await act(async () => result.current.drafts.remove('dapihook04'))
    expect(fake.of(/^\/api\/v1\/drafts\//, 'DELETE').map((r) => r.path)).toEqual([`/api/v1/drafts/${BACKEND}`])
    expect(fake.of(/^\/api\/v1\/drafts\//, 'DELETE')[0]?.headers).toMatchObject({ 'x-pine-csrf': '1' })
    expect(localStorage.getItem('pine:api-preview:dapihook04')).toBeNull()

    const second = renderHook(() => ({ composer: useClaimComposer('dapihook05'), drafts: useDrafts() }), { wrapper })
    await waitFor(() => expect(second.result.current.composer.draft.id).toBe('dapihook05'))
    act(() =>
      second.result.current.composer.update((d) => ({ ...d, spec: { ...d.spec, title: 'y' }, publication: { steps: [], backend: { draftId: BACKEND, revision: 3, publicationId: '5f0c2a8e-1b2c-4d3e-8f90-a1b2c3d4e5f6' } } })),
    )
    await act(async () => second.result.current.composer.saveNow())
    await act(async () => second.result.current.drafts.remove('dapihook05'))
    // Pine keeps a draft that has a publication (it would answer 409): nothing is sent for it.
    expect(fake.of(/^\/api\/v1\/drafts\//, 'DELETE')).toHaveLength(1)
  })

  it('keeps the demo composer unchanged (static catalog, local question, no api state)', async () => {
    function demo({ children }: { children: ReactNode }) {
      return (
        <PineProviders appName="Pine Test" session={null} env={{ dataSource: 'mock', demoWallet: true, deployment: PINE, defaultChainId: 100 }} queryClient={createPineQueryClient()}>
          {children}
        </PineProviders>
      )
    }
    const { result } = renderHook(() => useClaimComposer('ddemo0001', { backendPolicy: true }), { wrapper: demo })
    await waitFor(() => expect(result.current.draft.id).toBe('ddemo0001'))
    act(() => result.current.update({ spec: { policyId: 'BOT-001' } }))
    await waitFor(() => expect(result.current.draft.spec.policyVersion).toBe('0.1.0'))
    expect(result.current.api).toBeUndefined()
    expect(result.current.policy?.status).toBe('enabled')
    expect(fake.of(/^\/api\/v1\//)).toEqual([])
  })
})
