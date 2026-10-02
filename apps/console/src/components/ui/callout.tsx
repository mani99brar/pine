import { Info, TriangleAlert, Lock, Snowflake } from 'lucide-react'
import { cn } from '@/lib/cn'

type Tone = 'info' | 'warning' | 'critical' | 'gate' | 'frozen'

const tones: Record<Tone, { box: string; icon: React.ReactNode }> = {
  info: { box: 'border-line-strong bg-sunken text-bark', icon: <Info size={15} aria-hidden className="text-muted" /> },
  warning: { box: 'border-resin/50 bg-resin-soft text-bark', icon: <TriangleAlert size={15} aria-hidden className="text-resin" /> },
  critical: { box: 'border-flare/50 bg-flare-soft text-bark', icon: <TriangleAlert size={15} aria-hidden className="text-flare" /> },
  gate: { box: 'border-violet/40 bg-violet-soft text-bark', icon: <Lock size={15} aria-hidden className="text-violet" /> },
  frozen: { box: 'border-slate/40 bg-slate-soft text-bark', icon: <Snowflake size={15} aria-hidden className="text-slate" /> },
}

export function Callout({
  tone = 'info',
  title,
  children,
  className,
  action,
}: {
  tone?: Tone
  title?: React.ReactNode
  children?: React.ReactNode
  className?: string
  action?: React.ReactNode
}) {
  const t = tones[tone]
  return (
    <div className={cn('flex gap-2.5 rounded-ctl border px-3 py-2.5 text-[13px] leading-[1.5]', t.box, className)} role={tone === 'critical' ? 'alert' : undefined}>
      <span className="mt-0.5 shrink-0">{t.icon}</span>
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={cn(title && 'mt-0.5', 'text-muted [&_strong]:text-bark')}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  )
}
