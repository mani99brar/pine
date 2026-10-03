'use client'

import { Tabs as RTabs } from 'radix-ui'
import { cn } from '@/lib/cn'
import { Kbd } from './kbd'

export const Tabs = RTabs.Root
export const TabsContent = RTabs.Content

export function TabsList({
  tabs,
  className,
  trailing,
}: {
  tabs: { value: string; label: React.ReactNode; count?: number; kbd?: string; alert?: boolean }[]
  className?: string
  trailing?: React.ReactNode
}) {
  return (
    <RTabs.List
      className={cn(
        'scrollbar-thin relative flex items-stretch gap-0 overflow-x-auto border-b border-line',
        // On narrow screens the tab strip scrolls; fade its right edge so the overflow reads as "more tabs".
        'max-md:[mask-image:linear-gradient(to_right,black_calc(100%-40px),transparent)] max-md:pr-8',
        className,
      )}
      aria-label="Sections"
    >
      {tabs.map((t) => (
        <RTabs.Trigger
          key={t.value}
          value={t.value}
          className={cn(
            'group relative flex h-10 shrink-0 items-center gap-2 px-2.5 text-sm text-muted transition-colors hover:text-bark sm:px-3.5',
            'data-[state=active]:text-bark data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:-bottom-px data-[state=active]:after:h-[2px] data-[state=active]:after:bg-needle',
          )}
        >
          <span className="font-medium">{t.label}</span>
          {typeof t.count === 'number' ? (
            <span className="tnum rounded-full bg-sunken px-1.5 text-[11px] text-muted group-data-[state=active]:bg-needle-soft group-data-[state=active]:text-needle">
              {t.count}
            </span>
          ) : null}
          {t.alert ? <span className="size-1.5 rounded-full bg-resin-fill" aria-label="needs attention" /> : null}
          {t.kbd ? <Kbd className="hidden lg:inline-flex">{t.kbd}</Kbd> : null}
        </RTabs.Trigger>
      ))}
      {trailing}
    </RTabs.List>
  )
}
