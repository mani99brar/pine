'use client'

import type { HTMLAttributes, ReactNode } from 'react'
import { AlertTriangle, CircleAlert, Info, RotateCw } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from './Button'

type Tone = 'info' | 'caution' | 'critical' | 'neutral' | 'boundary'

const toneStyle: Record<Tone, { bar: string; icon: ReactNode; bg: string }> = {
  info: { bar: 'bg-hb', icon: <Info size={16} aria-hidden className="text-hb" />, bg: 'bg-[rgba(90,216,255,0.06)]' },
  caution: { bar: 'bg-na', icon: <AlertTriangle size={16} aria-hidden className="text-na" />, bg: 'bg-[rgba(255,182,72,0.07)]' },
  critical: { bar: 'bg-ha', icon: <CircleAlert size={16} aria-hidden className="text-ha" />, bg: 'bg-[rgba(255,107,131,0.08)]' },
  neutral: { bar: 'bg-moon', icon: <Info size={16} aria-hidden className="text-moon" />, bg: 'bg-[rgba(169,180,193,0.06)]' },
  boundary: { bar: 'bg-lumen-3', icon: <Info size={16} aria-hidden className="text-lumen-2" />, bg: 'bg-[rgba(255,236,220,0.035)]' },
}

/** A short notice: what is true, what to do. Color is never the only signal (icon and title carry it). */
export function Notice({
  tone = 'info',
  title,
  children,
  className,
  role,
  action,
}: {
  tone?: Tone
  title?: ReactNode
  children?: ReactNode
  className?: string
  role?: 'status' | 'alert'
  action?: ReactNode
}) {
  const t = toneStyle[tone]
  return (
    <div className={cn('cut-md relative flex gap-3 overflow-hidden border border-edge py-3 pl-4 pr-4', t.bg, className)} role={role}>
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px]', t.bar)} />
      <span className="mt-[3px] shrink-0">{t.icon}</span>
      <div className="min-w-0 flex-1 text-[0.90625rem] leading-[1.5] text-lumen-2">
        {title && <p className="mb-0.5 font-semibold text-lumen">{title}</p>}
        {children}
        {action && <div className="mt-2.5">{action}</div>}
      </div>
    </div>
  )
}

export function Panel({ className, children, as: As = 'section', cut = 'lg', ...rest }: HTMLAttributes<HTMLElement> & { as?: 'section' | 'div' | 'article' | 'aside'; cut?: 'xl' | 'lg' | 'md' }) {
  return (
    <As className={cn('glass', cut === 'xl' ? 'cut-xl' : cut === 'md' ? 'cut-md' : 'cut-lg', className)} {...rest}>
      {children}
    </As>
  )
}

export function PageHeader({ title, lead, actions, children, className }: { title: ReactNode; lead?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <header className={cn('flex flex-wrap items-end justify-between gap-x-8 gap-y-5 pb-8 pt-10 sm:pt-14', className)}>
      <div className="min-w-0 max-w-[48rem]">
        <h1 className="t-h1 chroma">{title}</h1>
        {lead && <p className="t-lead mt-4 max-w-[62ch]">{lead}</p>}
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
    </header>
  )
}

export function Container({ className, children, wide }: { className?: string; children: ReactNode; wide?: boolean }) {
  return <div className={cn('mx-auto w-full px-4 sm:px-6 lg:px-8', wide ? 'max-w-[1440px]' : 'max-w-[1240px]', className)}>{children}</div>
}

export function SectionTitle({ id, children, aside, className }: { id?: string; children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2', className)}>
      <h2 id={id} className="t-h2">
        {children}
      </h2>
      {aside && <div className="text-[0.875rem] text-lumen-3">{aside}</div>}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn('skeleton block', className)} />
}

export function LoadingBlock({ label = 'Loading', lines = 3, className }: { label?: string; lines?: number; className?: string }) {
  return (
    <div className={cn('grid gap-3', className)} role="status" aria-live="polite">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-5', i === 0 ? 'w-2/3' : i === lines - 1 ? 'w-1/2' : 'w-full')} />
      ))}
    </div>
  )
}

export function EmptyState({ title, children, action, icon, className }: { title: ReactNode; children?: ReactNode; action?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={cn('cut-lg glass-quiet flex flex-col items-start gap-3 px-6 py-8', className)}>
      {icon && <div className="text-lumen-3">{icon}</div>}
      <p className="t-h3">{title}</p>
      {children && <div className="max-w-[60ch] text-lumen-2">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function ErrorState({ title = 'This could not be loaded', error, onRetry, className }: { title?: string; error?: unknown; onRetry?: () => void; className?: string }) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined
  return (
    <div className={cn('cut-lg flex flex-col items-start gap-3 border border-[rgba(255,107,131,0.35)] bg-[rgba(255,107,131,0.06)] px-6 py-6', className)} role="alert">
      <p className="t-h4 flex items-center gap-2">
        <CircleAlert size={18} className="text-ha" aria-hidden /> {title}
      </p>
      {message && <p className="untrusted max-w-[70ch] text-[0.9rem] text-lumen-2">{message}</p>}
      {onRetry && (
        <Button variant="glass" size="sm" onClick={onRetry} icon={<RotateCw size={14} aria-hidden />}>
          Try again
        </Button>
      )}
    </div>
  )
}

/** Definition rows for facts (label column + value). */
export function Facts({ items, className }: { items: { label: ReactNode; value: ReactNode; hint?: ReactNode }[]; className?: string }) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-3 sm:grid-cols-[minmax(9rem,max-content)_1fr]', className)}>
      {items.map((it, i) => (
        <div key={i} className="contents">
          <dt className="pt-0.5 text-[0.84375rem] text-lumen-3">{it.label}</dt>
          <dd className="min-w-0 text-[0.9375rem] text-lumen">
            {it.value}
            {it.hint && <span className="mt-0.5 block text-[0.8125rem] text-lumen-3">{it.hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cn('border-0 border-t border-edge', className)} />
}

/** Accessible text field wrapper. */
export function FormField({
  id,
  label,
  help,
  error,
  children,
  className,
  optional,
}: {
  id: string
  label: ReactNode
  help?: ReactNode
  error?: string
  children: ReactNode
  className?: string
  optional?: boolean
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className="label">
        {label}
        {optional && <span className="ml-1.5 text-[0.8rem] font-normal text-lumen-3">optional</span>}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-[0.8125rem] font-medium text-ha">
          {error}
        </p>
      ) : help ? (
        <p id={`${id}-help`} className="help mt-1.5">
          {help}
        </p>
      ) : null}
    </div>
  )
}
