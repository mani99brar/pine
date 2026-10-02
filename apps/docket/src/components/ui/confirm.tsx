'use client'

import { AlertDialog } from 'radix-ui'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/** A confirmation step for destructive actions. Says exactly what will happen. */
export function Confirm({
  trigger,
  title,
  children,
  confirmLabel,
  onConfirm,
  danger = true,
}: {
  trigger: ReactNode
  title: string
  children: ReactNode
  confirmLabel: string
  onConfirm: () => void | Promise<void>
  danger?: boolean
}) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-ink/45" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 border-t-8 border-ink bg-sheet p-6 shadow-[0_16px_48px_rgba(26,29,43,0.25)] focus:outline-none">
          <AlertDialog.Title className="text-xl font-bold">{title}</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 text-[15px] leading-6 text-ink">{children}</div>
          </AlertDialog.Description>
          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <AlertDialog.Cancel className="inline-flex h-11 items-center rounded-sm border border-rule-strong bg-sheet px-4 font-bold shadow-[0_2px_0_var(--color-rule)] hover:bg-bond">
              Keep it
            </AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={() => void onConfirm()}
              className={cn(
                'inline-flex h-11 items-center rounded-sm px-4 font-bold text-white',
                danger ? 'bg-red shadow-[0_2px_0_#7e1810] hover:bg-[#8f1b12]' : 'bg-violet shadow-[0_2px_0_var(--color-violet-deep)]',
              )}
            >
              {confirmLabel}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
