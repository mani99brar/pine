import { CircleAlert, Info, OctagonAlert, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

type Tone = 'info' | 'warning' | 'critical' | 'neutral'

const tones: Record<Tone, { box: string; icon: typeof Info; iconClass: string }> = {
  info: { box: 'border-violet-line bg-violet-wash', icon: Info, iconClass: 'text-violet' },
  warning: { box: 'border-wheat-line bg-wheat', icon: TriangleAlert, iconClass: 'text-ochre' },
  critical: { box: 'border-red-line bg-red-wash', icon: OctagonAlert, iconClass: 'text-red' },
  neutral: { box: 'border-rule bg-sheet', icon: CircleAlert, iconClass: 'text-graphite' },
}

export function Notice({
  tone = 'info',
  title,
  children,
  className,
  action,
  role,
}: {
  tone?: Tone
  title?: ReactNode
  children?: ReactNode
  className?: string
  action?: ReactNode
  role?: 'status' | 'alert'
}) {
  const t = tones[tone]
  const Icon = t.icon
  return (
    <div role={role} className={cn('flex gap-3 border px-4 py-3', t.box, className)}>
      <Icon aria-hidden className={cn('mt-1 size-5 shrink-0', t.iconClass)} strokeWidth={2.25} />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-bold">{title}</p> : null}
        {children ? <div className={cn('text-[15px] leading-6', title && 'mt-0.5')}>{children}</div> : null}
        {action ? <div className="mt-3 flex flex-wrap gap-3">{action}</div> : null}
      </div>
    </div>
  )
}
