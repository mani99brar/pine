'use client'

import { Dialog as RDialog } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'

export const Dialog = RDialog.Root
export const DialogTrigger = RDialog.Trigger
export const DialogClose = RDialog.Close

export function DialogContent({
  title,
  description,
  children,
  className,
  side,
  hideTitle,
}: {
  title: string
  description?: React.ReactNode
  children: React.ReactNode
  className?: string
  /** "right" renders a drawer, "bottom" a sheet; default is a centered dialog */
  side?: 'right' | 'bottom' | 'left'
  hideTitle?: boolean
}) {
  return (
    <RDialog.Portal>
      <RDialog.Overlay className="animate-fade-in fixed inset-0 z-50 bg-scrim" />
      <RDialog.Content
        className={cn(
          'animate-fade-in fixed z-50 flex flex-col border border-line bg-raised text-bark shadow-float focus:outline-none',
          !side && 'left-1/2 top-[12vh] max-h-[80vh] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 rounded-float',
          side === 'right' && 'inset-y-0 right-0 w-[min(420px,100vw)] border-y-0 border-r-0',
          side === 'left' && 'inset-y-0 left-0 w-[min(300px,88vw)] border-y-0 border-l-0',
          side === 'bottom' && 'inset-x-0 bottom-0 max-h-[85vh] rounded-t-float border-x-0 border-b-0',
          className,
        )}
      >
        <div className={cn('flex items-start gap-3 border-b border-line px-4 py-3', hideTitle && 'sr-only')}>
          <div className="min-w-0 flex-1">
            <RDialog.Title className="text-base font-semibold">{title}</RDialog.Title>
            {description ? <RDialog.Description className="mt-0.5 text-xs text-muted">{description}</RDialog.Description> : null}
          </div>
          <RDialog.Close className="rounded-chip p-1 text-muted hover:bg-sunken hover:text-bark" aria-label="Close">
            <X size={16} aria-hidden />
          </RDialog.Close>
        </div>
        {!description && !hideTitle ? <RDialog.Description className="sr-only">{title}</RDialog.Description> : null}
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
      </RDialog.Content>
    </RDialog.Portal>
  )
}
