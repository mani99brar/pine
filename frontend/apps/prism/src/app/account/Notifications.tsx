'use client'

import Link from 'next/link'
import { useState } from 'react'
import { formatDate } from '@pine/core'
import { usePineNotifications, type PineNotification } from '@pine/react'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/interactive'
import { EmptyState, ErrorState, LoadingBlock, Panel } from '@/components/ui/primitives'
import { shortAddress } from '@/components/shell/wallet-display'
import { cn } from '@/lib/cn'

const KIND_LABEL = new Map<string, string>([
  ['evidence_closing', 'Evidence window closing'],
  ['reveal_closing', 'Reveal window closing'],
  ['answers_open', 'Oracle open for answers'],
  ['finalization_soon', 'Answer finalizing'],
  ['finalized', 'Oracle answer final'],
  ['resolved', 'Market resolved'],
])

function kindLabel(kind: string): string {
  if (kind.startsWith('arbitration_')) return 'Arbitration update'
  return KIND_LABEL.get(kind) ?? 'Update'
}

const MAX_MESSAGE = 500

function Item({ n, onRead, busy }: { n: PineNotification; onRead: (id: string) => void; busy: boolean }) {
  const unread = n.readAt === null
  const market = n.market.toLowerCase()
  const message = n.message.length > MAX_MESSAGE ? `${n.message.slice(0, MAX_MESSAGE)}…` : n.message
  return (
    <li className="grid gap-1.5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-6">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-[0.9375rem] font-semibold text-lumen">
          {unread && <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-hb shadow-[0_0_8px_rgba(90,216,255,0.8)]" />}
          {kindLabel(n.kind)}
          {unread && <span className="sr-only">(unread)</span>}
        </p>
        {/* Plain text only: notification text is data. */}
        <p className="untrusted mt-1 text-[0.90625rem] text-lumen-2">{message}</p>
        <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-lumen-3">
          <Link href={`/claims/${market}`} className="link">
            Claim <span className="t-code">{shortAddress(market)}</span>
          </Link>
          <span>{formatDate(n.createdAt, 'utc')}</span>
        </p>
      </div>
      <div className="flex items-start sm:justify-end">
        {unread ? (
          <Button size="sm" variant="ghost" onClick={() => onRead(n.id)} loading={busy} aria-label={`Mark "${kindLabel(n.kind)}" as read`}>
            Mark as read
          </Button>
        ) : (
          <span className="text-[0.8125rem] text-lumen-3">Read</span>
        )}
      </div>
    </li>
  )
}

/** `api` mode: notifications for the claims you created or filed evidence on (GET /api/v1/accounts/me/notifications). */
export function Notifications({ className }: { className?: string }) {
  const [filter, setFilter] = useState<'all' | 'unread'>('all')
  const n = usePineNotifications({ unreadOnly: filter === 'unread' })
  const [readError, setReadError] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  const markRead = (id: string) => {
    setReadError(null)
    n.markRead(id).then(
      () => setAnnounce('Marked as read.'),
      (e: unknown) => setReadError(e instanceof Error ? e.message : 'The notification could not be marked as read.'),
    )
  }

  return (
    <Panel className={cn('p-6', className)} aria-labelledby="notifications-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="notifications-title" className="t-h3">
          Notifications
          {n.unread > 0 && <span className="tag ml-2 align-middle text-hb">{n.unread} unread</span>}
        </h2>
        <Segmented
          label="Show notifications"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'unread', label: 'Unread' },
          ]}
        />
      </div>
      <p className="help mt-2 max-w-[70ch]">
        Pine notifies the creator of a claim and everyone who filed evidence on it: closing evidence and reveal windows, oracle answers, arbitration and
        resolution. Checked every minute.
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      {readError && (
        <p className="mt-3 text-[0.84375rem] font-medium text-ha" role="alert">
          {readError}
        </p>
      )}
      <div className="mt-4">
        {n.status === 'loading' ? (
          <LoadingBlock lines={3} label="Loading notifications" />
        ) : n.status === 'error' ? (
          <ErrorState title="Notifications could not be loaded" error={n.error} onRetry={n.refetch} />
        ) : n.items.length === 0 ? (
          <EmptyState title={filter === 'unread' ? 'Nothing unread' : 'No notifications yet'}>
            They appear here when a claim you created or filed evidence on nears a deadline, gets an oracle answer or resolves.
          </EmptyState>
        ) : (
          <>
            <ul className="divide-y divide-[var(--edge)]">
              {n.items.map((item) => (
                <Item key={item.id} n={item} onRead={markRead} busy={n.markingRead === item.id} />
              ))}
            </ul>
            {n.hasMore && (
              <Button variant="glass" size="sm" className="mt-4" onClick={n.loadMore} loading={n.loadingMore}>
                Show older notifications
              </Button>
            )}
          </>
        )}
      </div>
    </Panel>
  )
}
