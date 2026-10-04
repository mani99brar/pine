// @vitest-environment node
/**
 * Prism shell and list components found broken on a phone and in the claims list by exploratory testing: the mobile
 * drawer's wallet button (connect modal and wallet popover), the wallet's network label, the claims search with filters
 * and the policy page's long URI. The app has no test runner of its own, so its modules are loaded here by path, with
 * the `@/` imports they reach replaced by stubs or by the real files. The file runs in the node environment, where an
 * import vite cannot resolve (the app's `@/` alias) reaches vi.mock instead of failing the client transform, and installs
 * jsdom itself, as the jsdom environment does, before React loads.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { getPolicy } from '@pine/core'
import { createElement, forwardRef, type ComponentType, type ReactElement, type ReactNode } from 'react'

const dom = await vi.hoisted(async () => {
  const { builtinEnvironments } = await import('vitest/runtime')
  return builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: 'http://localhost/claims' } })
})
afterAll(() => dom.teardown(globalThis))

const state = vi.hoisted(() => ({
  wallet: {
    address: undefined as string | undefined,
    chainId: undefined as number | undefined,
    isConnected: false,
    isDemo: false,
    connect: () => {},
    disconnect: () => {},
  },
  params: new URLSearchParams(),
  pathname: '/claims',
  replace: (_url: string, _opts?: unknown) => {},
}))

vi.mock('../src/index', () => ({
  usePine: () => ({ env: { dataSource: 'api', defaultChainId: 100 } }),
  usePineSession: () => ({ status: 'disabled' }),
  useWallet: () => state.wallet,
  useWalletRestoring: () => false,
  useAccount: () => ({ status: 'signed_out' }),
  useInfiniteClaims: () => ({ data: { pages: [{ items: [], total: 0 }] }, isLoading: false, isError: false, hasNextPage: false }),
  useCopy: () => ({ copied: false, copy: () => {} }),
}))
vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ replace: (url: string, opts?: unknown) => state.replace(url, opts) }),
  useSearchParams: () => state.params,
  notFound: () => {
    throw new Error('not found')
  },
}))
vi.mock('next/link', () => ({
  default: forwardRef<HTMLAnchorElement, { href: string; children?: ReactNode }>(function Link({ href, children, ...rest }, ref) {
    return createElement('a', { ...rest, href, ref }, children)
  }),
}))
vi.mock('next/server', () => ({ connection: async () => {} }))
vi.mock('@/lib/hooks', () => ({
  useMounted: () => true,
  useReduceMotion: () => true,
  useMediaQuery: () => false,
  useNowMs: () => 0,
}))
vi.mock('@/lib/cn', () => import(/* @vite-ignore */ new URL('../../../apps/prism/src/lib/cn.ts', import.meta.url).pathname))
vi.mock('@/lib/site', () => import(/* @vite-ignore */ new URL('../../../apps/prism/src/lib/site.ts', import.meta.url).pathname))
vi.mock('@/lib/claims', () => import(/* @vite-ignore */ new URL('../../../apps/prism/src/lib/claims.ts', import.meta.url).pathname))
vi.mock('@/lib/crystal', () => import(/* @vite-ignore */ new URL('../../../apps/prism/src/lib/crystal.ts', import.meta.url).pathname))
vi.mock('@/components/icons', () => ({ PrismMark: () => null, FamilyIcon: () => null }))
vi.mock('@/components/ui/interactive', () => ({
  HashChip: ({ value }: { value: string }) => createElement('span', null, value),
  Segmented: () => null,
}))
vi.mock('@/components/ui/primitives', () => ({
  Container: ({ children }: { children?: ReactNode }) => createElement('main', null, children),
  Notice: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  EmptyState: ({ title }: { title?: ReactNode }) => createElement('p', null, title),
  ErrorState: () => null,
  Skeleton: () => null,
}))
vi.mock('@/components/ui/Button', () => ({ ButtonLink: () => null }))
vi.mock('@/components/ui/SafeMarkdown', () => ({ SafeMarkdown: () => null }))
vi.mock('@/lib/server/data', () => ({ getPolicyServerStrict: async () => null }))
vi.mock('../../../apps/prism/src/components/shell/SessionWalletGuard.tsx', () => ({ SessionWalletGuard: () => null }))
vi.mock('../../../apps/prism/src/components/table/Constellation.tsx', () => ({
  Constellation: () => null,
  ConstellationLegend: () => null,
  nothingPriced: () => true,
}))
vi.mock('../../../apps/prism/src/components/table/ClaimRow.tsx', () => ({ ClaimRow: () => null }))
vi.mock('../../../apps/prism/src/app/policies/[id]/PolicyClaims.tsx', () => ({ PolicyClaims: () => null }))
// Exit animations finish at once: AnimatePresence unmounts on close and motion.* are plain elements.
vi.mock('../../../apps/prism/node_modules/motion/dist/es/react.mjs', () => {
  const MOTION_PROPS = new Set(['initial', 'animate', 'exit', 'transition', 'layoutId'])
  const cache = new Map<string, ComponentType>()
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) => {
        const hit = cache.get(tag)
        if (hit) return hit
        const C = forwardRef<HTMLElement, Record<string, unknown>>(function Motion(props, ref) {
          const rest = Object.fromEntries(Object.entries(props).filter(([k]) => !MOTION_PROPS.has(k)))
          return createElement(tag, { ...rest, ref })
        }) as unknown as ComponentType
        cache.set(tag, C)
        return C
      },
    },
  )
  return { motion, AnimatePresence: ({ children }: { children?: ReactNode }) => children, animate: () => ({ stop: () => {} }) }
})

const PRISM = '../../../apps/prism/src/'

async function prism<T>(rel: string): Promise<T> {
  return (await import(/* @vite-ignore */ new URL(PRISM + rel, import.meta.url).pathname)) as T
}

const A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

beforeEach(() => {
  vi.useFakeTimers()
  state.wallet = { address: undefined, chainId: undefined, isConnected: false, isDemo: false, connect: () => {}, disconnect: () => {} }
  state.params = new URLSearchParams()
  state.pathname = '/claims'
  state.replace = () => {}
  window.history.replaceState(null, '', '/claims')
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  document.body.innerHTML = ''
  document.body.removeAttribute('style')
})

describe('the wallet network label', () => {
  it('names a configured network and never calls an unsupported one Gnosis', async () => {
    const { walletNetworkName } = await prism<{ walletNetworkName: (chainId: number | undefined) => string }>('components/shell/wallet-display.ts')
    expect(walletNetworkName(100)).toBe('Gnosis')
    expect(walletNetworkName(1)).toBe('Ethereum')
    expect(walletNetworkName(137)).toBe('Unsupported network (chain id 137)')
    expect(walletNetworkName(undefined)).toBe('Unknown network')
  })

  it('the header wallet popover says a Polygon wallet is on an unsupported network', async () => {
    state.wallet = { ...state.wallet, address: A, chainId: 137, isConnected: true }
    const { WalletButton } = await prism<{ WalletButton: ComponentType }>('components/shell/WalletButton.tsx')
    render(<WalletButton />)
    fireEvent.click(screen.getByRole('button', { name: `Wallet ${A}` }))
    expect(screen.getByText('Network: Unsupported network (chain id 137)')).toBeTruthy()
    expect(screen.queryByText(/Gnosis/)).toBeNull()
  })
})

describe('the mobile navigation drawer', () => {
  async function openDrawer() {
    const { SiteHeader } = await prism<{ SiteHeader: ComponentType }>('components/shell/SiteHeader.tsx')
    render(<SiteHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    // Radix's modal drawer locks pointer events outside itself while it is open.
    expect(document.body.style.pointerEvents).toBe('none')
  }

  it('closes before the connect modal opens, and leaves focus in the modal', async () => {
    let modal: HTMLButtonElement | null = null
    const connect = vi.fn(() => {
      // RainbowKit's modal renders outside the drawer and focuses its first wallet.
      modal = document.createElement('button')
      modal.textContent = 'MetaMask'
      document.body.append(modal)
    })
    state.wallet = { ...state.wallet, connect }
    await openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }))
    expect(connect).toHaveBeenCalledTimes(1)
    // The drawer is gone with its pointer lock, so a tap on the modal reaches the modal, not a drawer link under it.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.style.pointerEvents).not.toBe('none')
    act(() => modal?.focus())
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    // The drawer's close does not pull focus back to its trigger, behind the modal.
    expect(document.activeElement).toBe(modal)
  })

  it('still returns focus to its trigger when it closes on its own', async () => {
    await openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }))
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open navigation' }))
  })

  it('shows the wallet popover above the drawer, and usable', async () => {
    state.wallet = { ...state.wallet, address: A, chainId: 100, isConnected: true }
    await openDrawer()
    const drawer = screen.getByRole('dialog')
    const walletButtons = screen.getAllByRole('button', { name: `Wallet ${A}` })
    const inDrawer = walletButtons.find((b) => drawer.contains(b))
    if (!inDrawer) throw new Error('no wallet button in the drawer')
    fireEvent.click(inDrawer)
    const popover = screen.getByText('Connected wallet').parentElement
    if (!popover) throw new Error('no popover')
    const z = (el: Element) => Number(/(?:^|\s)z-\[(\d+)\]/.exec(el.className)?.[1] ?? Number.NaN)
    expect(z(popover)).toBeGreaterThan(z(drawer))
    // Radix lets pointer events through to a layer opened above the modal drawer.
    expect(popover.style.pointerEvents).toBe('auto')
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy()
  })
})

describe('the claims list search', () => {
  async function renderTable() {
    const { LightTable } = await prism<{ LightTable: ComponentType }>('components/table/LightTable.tsx')
    return render(<LightTable />)
  }
  /** Next applies router.replace after the transition commits: until then the URL and useSearchParams are unchanged. */
  function recordReplaces(): string[] {
    const urls: string[] = []
    state.replace = (url) => urls.push(url)
    return urls
  }
  function navigate(url: string, rerender: (ui: ReactElement) => void, ui: ReactElement) {
    window.history.replaceState(null, '', url)
    const u = new URL(url, 'http://localhost')
    state.pathname = u.pathname
    state.params = new URLSearchParams(u.search)
    rerender(ui)
  }

  it('keeps a typed search when a filter chip is clicked, with or without the blur', async () => {
    const urls = recordReplaces()
    await renderTable()
    const input = screen.getByRole('searchbox', { name: 'Search claims' })
    fireEvent.change(input, { target: { value: 'zzz-nothing' } })
    fireEvent.blur(input)
    fireEvent.click(screen.getByRole('button', { name: /FUNC/ }))
    const last = new URL(urls.at(-1) ?? '', 'http://localhost')
    expect(last.searchParams.get('family')).toBe('FUNC')
    expect(last.searchParams.get('q')).toBe('zzz-nothing')
  })

  it('keeps a typed search when the sort or a status changes', async () => {
    const urls = recordReplaces()
    await renderTable()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search claims' }), { target: { value: 'zzz-nothing' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), { target: { value: 'newest' } })
    expect(new URL(urls.at(-1) ?? '', 'http://localhost').search).toBe('?q=zzz-nothing&sort=newest')
    fireEvent.click(screen.getByRole('button', { name: 'Open for evidence' }))
    expect(new URL(urls.at(-1) ?? '', 'http://localhost').search).toBe('?q=zzz-nothing&status=open')
  })

  it('keeps the other filters already in the URL', async () => {
    const urls = recordReplaces()
    window.history.replaceState(null, '', '/claims?repo=acme%2Fwidgets&family=BOT')
    state.params = new URLSearchParams('repo=acme%2Fwidgets&family=BOT')
    await renderTable()
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), { target: { value: 'newest' } })
    expect(new URL(urls.at(-1) ?? '', 'http://localhost').search).toBe('?repo=acme%2Fwidgets&family=BOT&sort=newest')
  })

  it('empties the input when a link leads to /claims without a search, and tabbing through does not bring it back', async () => {
    const urls = recordReplaces()
    window.history.replaceState(null, '', '/claims?q=zzz-nothing')
    state.params = new URLSearchParams('q=zzz-nothing')
    const { LightTable } = await prism<{ LightTable: ComponentType }>('components/table/LightTable.tsx')
    const view = render(<LightTable />)
    const input = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search claims' })
    expect(input.value).toBe('zzz-nothing')
    navigate('/claims', view.rerender, <LightTable />)
    expect(input.value).toBe('')
    fireEvent.focus(input)
    fireEvent.blur(input)
    expect(urls).toEqual([])
  })
})

