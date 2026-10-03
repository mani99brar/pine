// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { PineProviders } from '../src/providers'
import { useClaims } from '../src/queries'
import { useWallet } from '../src/wallet'
import { useTxRunner } from '../src/tx/use-tx-runner'
import { useClaimComposer } from '../src/composer/use-claim-composer'
import { useNow } from '../src/misc'

function Consumer() {
  const claims = useClaims({ status: 'open' })
  const wallet = useWallet()
  const runner = useTxRunner('ssr', [{ id: 'upload_manifest', label: 'Pin', description: '', kind: 'offchain' }])
  const composer = useClaimComposer('dssr')
  const now = useNow()
  return (
    <div>
      {claims.isLoading ? 'loading' : 'ready'}|{wallet.isConnected ? 'connected' : 'disconnected'}|{runner.state}|
      {composer.draft.spec.oracle?.timeoutSeconds}|{now instanceof Date ? 'date' : ''}
    </div>
  )
}

describe('SSR', () => {
  it('renders PineProviders and hooks on the server without touching window', () => {
    expect(typeof window).toBe('undefined')
    const html = renderToString(
      <PineProviders appName="Pine SSR" session={null} env={{ dataSource: 'mock', demoWallet: true }}>
        <Consumer />
      </PineProviders>,
    )
    expect(html).toContain('disconnected')
    expect(html).toContain('idle')
    expect(html).toContain('302400')
  })
})
