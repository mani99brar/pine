'use client'

import * as React from 'react'
import { Command, defaultFilter } from 'cmdk'
import { useRouter } from 'next/navigation'
import {
  BookOpen,
  Bot,
  ClipboardCopy,
  FileUp,
  GitCommitHorizontal,
  GitPullRequest,
  Keyboard,
  Monitor,
  Plus,
  Search,
  Table2,
  Wallet,
  Zap,
  FolderGit2,
} from 'lucide-react'
import { toast } from 'sonner'
import { POLICIES, STATUS_META, formatClaimNumber, parseGitHubRef, shortSha } from '@pine/core'
import { useClaims, useDemoWallet, useGitHubViewerRepos, useResolveGitHubInput, useWallet } from '@pine/react'
import { NAV } from '@/lib/nav'
import { cn } from '@/lib/cn'
import { Kbd } from '@/components/ui/kbd'
import { StatusDot } from '@/components/claim/status'
import { useWorkbench } from './workbench'

function Item({
  children,
  onSelect,
  value,
  keywords,
  icon,
  hint,
  forceMount,
}: {
  children: React.ReactNode
  onSelect: () => void
  value: string
  keywords?: string[]
  icon?: React.ReactNode
  hint?: React.ReactNode
  forceMount?: boolean
}) {
  return (
    <Command.Item
      value={value}
      keywords={keywords}
      onSelect={onSelect}
      forceMount={forceMount}
      className="group flex min-h-9 cursor-pointer items-center gap-2.5 rounded-ctl px-2.5 py-1.5 text-[13.5px] text-bark data-[selected=true]:bg-needle-soft"
    >
      {icon ? <span className="flex size-5 shrink-0 items-center justify-center text-muted group-data-[selected=true]:text-needle">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className="shrink-0 text-xs text-muted">{hint}</span> : null}
    </Command.Item>
  )
}

/**
 * Substring-first filter. cmdk's default fuzzy score matches scattered letters ("keeper" matched
 * "webhooK rElay dElivers… Per subscribER"), which buries the claim you meant. Every word of the query
 * must appear in the item's text or keywords; items whose title contains the whole phrase rank first.
 * Only when nothing matches that way does a fuzzy score apply, and then at a low weight.
 */
function paletteFilter(value: string, search: string, keywords?: string[]) {
  const q = search.trim().toLowerCase()
  if (!q) return 1
  const hay = `${value} ${(keywords ?? []).join(' ')}`.toLowerCase()
  const words = q.split(/\s+/)
  if (words.every((w) => hay.includes(w))) return value.toLowerCase().includes(q) ? 1 : 0.8
  const fuzzy = defaultFilter ? defaultFilter(value, search, keywords) : 0
  return fuzzy > 0.5 ? fuzzy * 0.1 : 0
}

const groupCls =
  'px-1.5 pb-1 [&_[cmdk-group-heading]]:stretch-cond [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted'

const POLICY_TITLE: Record<string, string> = Object.fromEntries(POLICIES.map((p) => [p.id, p.title]))

export function CommandPalette() {
  const router = useRouter()
  const { paletteOpen, setPaletteOpen, paletteQuery, claim, cycleTheme, setShortcutsOpen } = useWorkbench()
  const [query, setQuery] = React.useState('')
  const wallet = useWallet()
  const demo = useDemoWallet()

  // Seed the query each time the palette opens (render-time transition, no effect).
  const [wasOpen, setWasOpen] = React.useState(paletteOpen)
  if (paletteOpen !== wasOpen) {
    setWasOpen(paletteOpen)
    if (paletteOpen) setQuery(paletteQuery)
  }

  const trimmed = query.trim()
  const ref = React.useMemo(() => (trimmed.length > 3 ? parseGitHubRef(trimmed) : null), [trimmed])
  const resolved = useResolveGitHubInput(ref ? trimmed : '')
  const claims = useClaims(paletteOpen ? { limit: 100, sort: 'newest' } : undefined)
  const repos = useGitHubViewerRepos({ limit: 30 })
  const evidenceIntent = /evid|submit|counterex/i.test(trimmed)

  const go = (href: string) => {
    setPaletteOpen(false)
    router.push(href)
  }
  const run = (fn: () => void) => {
    setPaletteOpen(false)
    fn()
  }

  const r = resolved
  const refLabel = ref
    ? ref.kind === 'pull'
      ? `${ref.owner}/${ref.repo} pull request #${ref.number}`
      : ref.kind === 'commit'
        ? `${ref.owner}/${ref.repo}@${shortSha(ref.sha)}`
        : ref.kind === 'pull_commit'
          ? `${ref.owner}/${ref.repo}#${ref.number} at ${shortSha(ref.sha)}`
          : `${ref.owner}/${ref.repo}`
    : ''

  return (
    <Command.Dialog
      open={paletteOpen}
      onOpenChange={setPaletteOpen}
      label="Command palette"
      loop
      filter={paletteFilter}
      overlayClassName="fixed inset-0 z-50 bg-scrim animate-fade-in"
      contentClassName="fixed left-1/2 top-[10vh] z-50 w-[min(640px,calc(100vw-20px))] -translate-x-1/2 overflow-hidden rounded-float border border-line bg-raised shadow-float animate-fade-in"
    >
      <div className="flex items-center gap-2.5 border-b border-line px-3.5">
        <Search size={16} aria-hidden className="shrink-0 text-muted" />
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder="Search claims, run a command, or paste a GitHub PR or commit URL"
          className="h-12 min-w-0 flex-1 bg-transparent text-[15px] text-bark outline-none placeholder:text-faint"
        />
        <Kbd>esc</Kbd>
      </div>
      <Command.List className="scrollbar-thin max-h-[min(60vh,460px)] overflow-y-auto overscroll-contain py-1">
        {!ref ? (
          <Command.Empty className="px-4 py-8 text-center text-sm text-muted">
            Nothing matches “{trimmed}”. Paste a GitHub URL such as github.com/owner/repo/pull/12 to start a claim.
          </Command.Empty>
        ) : null}

        {ref ? (
          <Command.Group heading="Start from GitHub" className={groupCls} forceMount>
            <Command.Item
              forceMount
              value={`gh-verify ${trimmed}`}
              onSelect={() => go(`/new?source=${encodeURIComponent(trimmed)}`)}
              className="group flex cursor-pointer items-start gap-3 rounded-ctl border border-transparent px-2.5 py-2.5 data-[selected=true]:border-needle/40 data-[selected=true]:bg-needle-soft"
            >
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-ctl bg-needle text-needle-ink">
                {ref.kind === 'repo' ? <FolderGit2 size={15} aria-hidden /> : ref.kind === 'pull' ? <GitPullRequest size={15} aria-hidden /> : <GitCommitHorizontal size={15} aria-hidden />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold text-bark">
                  {ref.kind === 'pull' ? 'Verify the head commit of this pull request' : ref.kind === 'repo' ? 'Verify a commit in this repository' : 'Verify this exact commit'}
                </span>
                <span className="mono-cond block truncate text-[12px] text-muted">{refLabel}</span>
                <span className="mt-0.5 block truncate text-[12.5px] text-muted">
                  {resolved.isLoading ? (
                    'Resolving on GitHub…'
                  ) : resolved.reason && resolved.status !== 'resolved' ? (
                    <span className="text-flare">{resolved.reason}</span>
                  ) : (
                    <>
                      {r.pull ? <span className="text-bark">{r.pull.title}</span> : r.commit ? <span className="text-bark">{r.commit.message.split('\n')[0]}</span> : null}
                      {r.commit ? (
                        <span className="ml-2">
                          pins <span className="mono-cond text-[11.5px] text-bark">{shortSha(r.commit.sha)}</span>
                        </span>
                      ) : null}
                    </>
                  )}
                </span>
              </span>
              <Kbd className="mt-1">↵</Kbd>
            </Command.Item>
            <Item
              forceMount
              value={`gh-browse ${trimmed}`}
              icon={<FolderGit2 size={15} />}
              onSelect={() =>
                go(
                  ref.kind === 'pull' || ref.kind === 'pull_commit'
                    ? `/repos/${ref.owner}/${ref.repo}/pull/${ref.number}`
                    : `/repos/${ref.owner}/${ref.repo}`,
                )
              }
            >
              Browse <span className="mono-cond text-[12.5px]">{ref.owner}/{ref.repo}</span> in the repository browser
            </Item>
          </Command.Group>
        ) : null}

        {claim ? (
          <Command.Group heading={`Current claim ${formatClaimNumber(claim.number)}`} className={groupCls}>
            <Item value={`ctx-evidence ${claim.number}`} keywords={['evidence', 'submit', 'counterexample']} icon={<FileUp size={15} />} onSelect={() => go(`/claims/${claim.id}/evidence/new`)} hint={<Kbd>e</Kbd>}>
              Submit evidence for {formatClaimNumber(claim.number)}
            </Item>
            <Item
              value={`ctx-brief ${claim.number}`}
              keywords={['agent', 'brief', 'copy', 'markdown']}
              icon={<ClipboardCopy size={15} />}
              onSelect={() =>
                run(() => {
                  window.dispatchEvent(new CustomEvent('pine:copy-brief'))
                })
              }
              hint={<Kbd>b</Kbd>}
            >
              Copy agent brief for {formatClaimNumber(claim.number)}
            </Item>
            {(['overview', 'market', 'evidence', 'oracle', 'agent', 'activity'] as const).map((t, i) => (
              <Item key={t} value={`ctx-tab ${t}`} keywords={[t]} icon={<span className="mono-cond text-[11px]">{i + 1}</span>} onSelect={() => go(`/claims/${claim.id}?tab=${t}`)}>
                Open {t} tab
              </Item>
            ))}
          </Command.Group>
        ) : null}

        <Command.Group heading="Actions" className={groupCls}>
          <Item value="action new verification" keywords={['create', 'claim', 'publish', 'market']} icon={<Plus size={15} />} onSelect={() => go('/new')} hint={<Kbd>n</Kbd>}>
            New verification
          </Item>
          {!wallet.isConnected ? (
            <Item value="action connect wallet" icon={<Wallet size={15} />} onSelect={() => run(() => wallet.connect())}>
              {demo.enabled ? 'Connect simulated wallet' : 'Connect wallet'}
            </Item>
          ) : (
            <Item value="action disconnect wallet" icon={<Wallet size={15} />} onSelect={() => run(() => wallet.disconnect())}>
              Disconnect wallet
            </Item>
          )}
          {demo.enabled ? (
            <Item
              value="action simulate failure next transaction"
              keywords={['demo', 'fail', 'error', 'recovery']}
              icon={<Zap size={15} />}
              onSelect={() =>
                run(() => {
                  demo.failNext()
                  toast('The next simulated transaction will fail')
                })
              }
            >
              Simulate failure on next transaction
            </Item>
          ) : null}
          <Item value="action cycle theme" keywords={['dark', 'light', 'appearance']} icon={<Monitor size={15} />} onSelect={() => run(cycleTheme)} hint={<Kbd>t</Kbd>}>
            Cycle theme
          </Item>
          <Item value="action keyboard shortcuts" keywords={['help', 'keys']} icon={<Keyboard size={15} />} onSelect={() => run(() => setShortcutsOpen(true))} hint={<Kbd>?</Kbd>}>
            Show keyboard shortcuts
          </Item>
        </Command.Group>

        <Command.Group heading="Go to" className={groupCls}>
          {NAV.map((n) => {
            const Icon = n.icon
            return (
              <Item key={n.href} value={`nav ${n.label}`} icon={<Icon size={15} />} onSelect={() => go(n.href)} hint={n.keys ? <Kbd>{n.keys}</Kbd> : undefined}>
                {n.label}
              </Item>
            )
          })}
        </Command.Group>

        {evidenceIntent && claims.data ? (
          <Command.Group heading="Submit evidence" className={groupCls}>
            {claims.data.items
              .filter((c) => c.status === 'open')
              .map((c) => (
                <Item
                  key={`ev-${c.id}`}
                  value={`submit evidence ${formatClaimNumber(c.number)} ${c.title}`}
                  icon={<FileUp size={15} />}
                  onSelect={() => go(`/claims/${c.id}/evidence/new`)}
                >
                  Submit evidence for {formatClaimNumber(c.number)} <span className="text-muted">{c.title}</span>
                </Item>
              ))}
          </Command.Group>
        ) : null}

        <Command.Group heading="Claims" className={groupCls}>
          {claims.isLoading ? (
            <div className="px-3 py-2 text-xs text-muted">Loading claims…</div>
          ) : (
            claims.data?.items.map((c) => (
              <Item
                key={c.id}
                value={`claim ${formatClaimNumber(c.number)} ${c.title}`}
                keywords={[
                  c.source.owner,
                  c.source.repo,
                  c.policy.id,
                  POLICY_TITLE[c.policy.id] ?? '',
                  STATUS_META[c.status].label,
                  c.source.commitSha.slice(0, 7),
                  c.source.prNumber ? `#${c.source.prNumber} ${c.source.prTitle ?? ''}` : '',
                ]}
                icon={<StatusDot status={c.status} outcome={c.outcome} />}
                onSelect={() => go(`/claims/${c.id}`)}
                hint={<span className="mono-cond text-[11px]">{c.source.repo}@{shortSha(c.source.commitSha)}</span>}
              >
                <span className="mono-cond mr-2 text-[12px] text-muted">{formatClaimNumber(c.number)}</span>
                {c.title}
              </Item>
            ))
          )}
        </Command.Group>

        <Command.Group heading="Policies" className={groupCls}>
          {POLICIES.map((p) => (
            <Item key={p.id} value={`policy ${p.id} ${p.title}`} keywords={[p.family]} icon={<BookOpen size={15} />} onSelect={() => go(`/policies/${p.id}`)} hint={p.status === 'gated' ? 'gated' : `v${p.version}`}>
              <span className="mono-cond mr-2 text-[12px] text-muted">{p.id}</span>
              {p.title}
            </Item>
          ))}
        </Command.Group>

        {repos.data?.items.length ? (
          <Command.Group heading="Repositories" className={groupCls}>
            {repos.data.items.filter((rp) => !rp.private).map((rp) => (
              <Item
                key={rp.id}
                value={`repo ${rp.fullName}`}
                keywords={[rp.owner, rp.name, ...(rp.topics ?? [])]}
                icon={<FolderGit2 size={15} />}
                onSelect={() => go(`/repos/${rp.owner}/${rp.name}`)}
                hint={typeof rp.openPullRequests === 'number' ? `${rp.openPullRequests} open PRs` : undefined}
              >
                <span className="mono-cond text-[12.5px]">{rp.fullName}</span>
              </Item>
            ))}
          </Command.Group>
        ) : null}

        <Command.Group heading="For agents" className={groupCls}>
          <Item value="agents api docs" keywords={['llms', 'json', 'api', 'feed']} icon={<Bot size={15} />} onSelect={() => go('/agents')}>
            Agent API and machine-readable feeds
          </Item>
          <Item value="explore open claims" keywords={['table', 'browse']} icon={<Table2 size={15} />} onSelect={() => go('/claims?view=open')}>
            Open claims accepting evidence
          </Item>
        </Command.Group>
      </Command.List>
      <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-sunken px-3.5 py-2 text-[11.5px] text-muted')}>
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> run
        </span>
        <span className="ml-auto hidden sm:inline">Paste a PR or commit URL to start a claim from it</span>
      </div>
    </Command.Dialog>
  )
}
