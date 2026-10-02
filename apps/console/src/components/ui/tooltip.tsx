'use client'

import { Tooltip as RT } from 'radix-ui'

export const TooltipProvider = RT.Provider

export function Tooltip({ content, children, side = 'top' }: { content: React.ReactNode; children: React.ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <RT.Root delayDuration={250}>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          side={side}
          sideOffset={6}
          className="animate-fade-in z-[60] max-w-[280px] rounded-ctl border border-line bg-raised px-2.5 py-1.5 text-xs leading-[1.45] text-bark shadow-float"
        >
          {content}
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  )
}
