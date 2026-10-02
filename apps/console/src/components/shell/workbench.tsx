'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { applyTheme, type ThemePref } from '@/lib/theme'
import { dialogOpen, isTypingTarget } from '@/lib/use-keys'
import { NAV } from '@/lib/nav'

export interface ClaimContext {
  id: string
  number: number
  title: string
  status: string
}

interface WorkbenchState {
  paletteOpen: boolean
  paletteQuery: string
  openPalette: (query?: string) => void
  setPaletteOpen: (open: boolean) => void
  shortcutsOpen: boolean
  setShortcutsOpen: (open: boolean) => void
  mobileNavOpen: boolean
  setMobileNavOpen: (open: boolean) => void
  claim: ClaimContext | null
  setClaim: (c: ClaimContext | null) => void
  theme: ThemePref
  setTheme: (t: ThemePref) => void
  cycleTheme: () => void
}

const Ctx = React.createContext<WorkbenchState | null>(null)

export function useWorkbench() {
  const v = React.useContext(Ctx)
  if (!v) throw new Error('useWorkbench must be used inside <WorkbenchProvider>')
  return v
}

/** Registers the current claim with the workbench so the palette can offer claim actions. */
export function useClaimContext(c: ClaimContext | null) {
  const { setClaim } = useWorkbench()
  const key = c ? `${c.id}:${c.status}` : ''
  React.useEffect(() => {
    setClaim(c)
    return () => setClaim(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setClaim])
}

const SEQUENCES: Record<string, string> = Object.fromEntries(
  NAV.filter((n) => n.keys?.startsWith('g ')).map((n) => [n.keys!.slice(2), n.href]),
)

export function WorkbenchProvider({ children, initialTheme = 'system' }: { children: React.ReactNode; initialTheme?: ThemePref }) {
  const router = useRouter()
  const [paletteOpen, setPaletteOpenState] = React.useState(false)
  const [paletteQuery, setPaletteQuery] = React.useState('')
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false)
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false)
  const [claim, setClaim] = React.useState<ClaimContext | null>(null)
  const [theme, setThemeState] = React.useState<ThemePref>(initialTheme)

  const setTheme = React.useCallback((t: ThemePref) => {
    applyTheme(t)
    setThemeState(t)
  }, [])
  const cycleTheme = React.useCallback(() => {
    setThemeState((cur) => {
      const next: ThemePref = cur === 'system' ? 'light' : cur === 'light' ? 'dark' : 'system'
      applyTheme(next)
      return next
    })
  }, [])

  const openPalette = React.useCallback((query?: string) => {
    setPaletteQuery(query ?? '')
    setPaletteOpenState(true)
  }, [])
  const setPaletteOpen = React.useCallback((open: boolean) => {
    setPaletteOpenState(open)
    if (!open) setPaletteQuery('')
  }, [])

  // Global keys: ⌘K, ?, n, t, / and "g <key>" sequences.
  React.useEffect(() => {
    let pendingG = 0
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpenState((o) => !o)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target) || dialogOpen()) return
      const now = Date.now()
      if (pendingG && now - pendingG < 1200) {
        pendingG = 0
        const href = SEQUENCES[e.key]
        if (href) {
          e.preventDefault()
          router.push(href)
        }
        return
      }
      switch (e.key) {
        case 'g':
          pendingG = now
          return
        case '?':
          e.preventDefault()
          setShortcutsOpen(true)
          return
        case 'n':
          e.preventDefault()
          router.push('/new')
          return
        case 't':
          e.preventDefault()
          cycleTheme()
          return
        case '/': {
          e.preventDefault()
          const target = document.querySelector<HTMLElement>('[data-slash-focus]')
          if (target) {
            target.focus()
            return
          }
          setPaletteQuery('')
          setPaletteOpenState(true)
          return
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [router, cycleTheme])

  const value = React.useMemo<WorkbenchState>(
    () => ({
      paletteOpen,
      paletteQuery,
      openPalette,
      setPaletteOpen,
      shortcutsOpen,
      setShortcutsOpen,
      mobileNavOpen,
      setMobileNavOpen,
      claim,
      setClaim,
      theme,
      setTheme,
      cycleTheme,
    }),
    [paletteOpen, paletteQuery, openPalette, setPaletteOpen, shortcutsOpen, mobileNavOpen, claim, theme, setTheme, cycleTheme],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
