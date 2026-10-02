import {
  Activity,
  BookOpen,
  Bot,
  FilePenLine,
  GitPullRequest,
  LayoutDashboard,
  Plus,
  Settings,
  Table2,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  /** Key sequence, e.g. "g c" */
  keys?: string
  group: 'work' | 'source' | 'reference' | 'account'
  match?: (pathname: string) => boolean
}

export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, keys: 'g d', group: 'work' },
  {
    href: '/claims',
    label: 'Claims',
    icon: Table2,
    keys: 'g c',
    group: 'work',
    match: (p) => p === '/claims' || (p.startsWith('/claims/') && !p.includes('/evidence')),
  },
  { href: '/new', label: 'New verification', icon: Plus, keys: 'n', group: 'work' },
  { href: '/drafts', label: 'Drafts', icon: FilePenLine, keys: 'g f', group: 'work' },
  { href: '/repos', label: 'Repositories', icon: GitPullRequest, keys: 'g r', group: 'source' },
  { href: '/policies', label: 'Policies', icon: BookOpen, keys: 'g p', group: 'reference' },
  { href: '/agents', label: 'Agents', icon: Bot, keys: 'g a', group: 'reference' },
  { href: '/risks', label: 'Risks & launch gates', icon: TriangleAlert, keys: 'g x', group: 'reference' },
  { href: '/activity', label: 'Activity', icon: Activity, keys: 'g h', group: 'account' },
  { href: '/settings', label: 'Settings', icon: Settings, keys: 'g s', group: 'account' },
]

export const NAV_GROUPS: { id: NavItem['group']; label: string }[] = [
  { id: 'work', label: 'Workbench' },
  { id: 'source', label: 'Source' },
  { id: 'reference', label: 'Reference' },
  { id: 'account', label: 'Account' },
]

export function isActive(item: NavItem, pathname: string) {
  if (item.match) return item.match(pathname)
  return pathname === item.href || pathname.startsWith(item.href + '/')
}

export const SHORTCUTS: { keys: string; label: string; scope: string }[] = [
  { keys: '⌘K', label: 'Open command palette (Ctrl+K on Windows/Linux)', scope: 'Global' },
  { keys: '/', label: 'Search claims', scope: 'Global' },
  { keys: '?', label: 'Show keyboard shortcuts', scope: 'Global' },
  { keys: 'n', label: 'New verification', scope: 'Global' },
  { keys: 'g d', label: 'Go to dashboard', scope: 'Global' },
  { keys: 'g c', label: 'Go to claims', scope: 'Global' },
  { keys: 'g f', label: 'Go to drafts', scope: 'Global' },
  { keys: 'g r', label: 'Go to repositories', scope: 'Global' },
  { keys: 'g p', label: 'Go to policies', scope: 'Global' },
  { keys: 'g a', label: 'Go to agents', scope: 'Global' },
  { keys: 'g h', label: 'Go to activity', scope: 'Global' },
  { keys: 'g s', label: 'Go to settings', scope: 'Global' },
  { keys: 'g x', label: 'Go to risks & launch gates', scope: 'Global' },
  { keys: 't', label: 'Cycle theme (system, light, dark)', scope: 'Global' },
  { keys: 'Esc', label: 'Close palette, dialog or preview', scope: 'Global' },
  { keys: 'j', label: 'Next row', scope: 'Tables' },
  { keys: 'k', label: 'Previous row', scope: 'Tables' },
  { keys: '↵', label: 'Open selected row', scope: 'Tables' },
  { keys: 'Space', label: 'Toggle preview pane', scope: 'Claims' },
  { keys: '1–6', label: 'Switch claim tab', scope: 'Claim' },
  { keys: 'e', label: 'Submit evidence', scope: 'Claim' },
  { keys: 'b', label: 'Copy agent brief', scope: 'Claim' },
  { keys: '⌘↵', label: 'Jump to review / publish', scope: 'Composer' },
  { keys: 'a', label: 'Toggle artifacts pane (mobile)', scope: 'Composer' },
]
