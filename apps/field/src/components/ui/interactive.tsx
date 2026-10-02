'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, ExternalLink as ExternalIcon, X } from 'lucide-react'
import { Dialog, Slider as RSlider, Switch as RSwitch, Tabs as RTabs, Tooltip as RTooltip } from 'radix-ui'
import { cn } from '@/lib/cn'

/* ---------------------------------------------------------------- copy */

export function useClipboard(timeout = 1600) {
  const [copied, setCopied] = useState(false)
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(t.current), [])
  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
      }
      setCopied(true)
      clearTimeout(t.current)
      t.current = setTimeout(() => setCopied(false), timeout)
    },
    [timeout],
  )
  return { copy, copied }
}

export function CopyButton({
  text,
  label = 'Copy',
  copiedLabel = 'Copied',
  className,
  variant = 'icon',
}: {
  text: string
  label?: string
  copiedLabel?: string
  className?: string
  variant?: 'icon' | 'button'
}) {
  const { copy, copied } = useClipboard()
  if (variant === 'button') {
    return (
      <button
        type="button"
        onClick={() => copy(text)}
        className={cn(
          'inline-flex h-9 items-center gap-2 rounded-[var(--radius-btn)] border-[1.5px] border-ink px-3 text-[0.88rem] font-[620] hover:bg-ink/[0.06]',
          className,
        )}
      >
        {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
        <span aria-live="polite">{copied ? copiedLabel : label}</span>
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      className={cn('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] text-ink-2 hover:bg-ink/[0.08] hover:text-ink', className)}
      aria-label={copied ? copiedLabel : label}
      title={copied ? copiedLabel : label}
    >
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </button>
  )
}

/** A hash/SHA value: mono, truncated in the middle, with copy. */
export function HashChip({
  value,
  display,
  label,
  className,
  href,
}: {
  value: string
  display?: string
  label?: string
  className?: string
  href?: string
}) {
  const shown = display ?? (value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value)
  return (
    <span className={cn('inline-flex max-w-full items-center gap-0.5 rounded-[3px] bg-fog-2 pl-1.5 align-middle', className)}>
      {label && <span className="mr-1 text-[0.75rem] text-ink-3">{label}</span>}
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="t-code truncate text-[0.8rem] underline-offset-2 hover:underline" title={value}>
          {shown}
        </a>
      ) : (
        <code className="t-code truncate text-[0.8rem]" title={value}>
          {shown}
        </code>
      )}
      <CopyButton text={value} label={`Copy ${label ?? 'value'}`} className="h-6 w-6" />
    </span>
  )
}

export function CodeBlock({ code, label, className }: { code: string; label?: string; className?: string }) {
  return (
    <div className={cn('group relative rounded-[var(--radius-tile)] bg-ink text-on-ink', className)}>
      {label && <div className="border-b border-white/10 px-3 py-1.5 text-[0.75rem] text-on-ink/70">{label}</div>}
      <pre className="t-code relative overflow-x-auto px-3 py-2.5 pr-11 text-[0.8rem] leading-[1.55] whitespace-pre-wrap [overflow-wrap:anywhere]">
        <code>{code}</code>
      </pre>
      <CopyButton
        text={code}
        label={`Copy ${label ?? 'code'}`}
        className="absolute right-1.5 top-1.5 text-on-ink/70 hover:bg-white/10 hover:text-on-ink"
      />
    </div>
  )
}

/* ---------------------------------------------------------------- links */

export function ExternalLink({ href, children, className, icon = true }: { href: string; children: ReactNode; className?: string; icon?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={cn('inline-flex items-center gap-1 underline decoration-line-strong underline-offset-[3px] hover:decoration-ink', className)}
    >
      {children}
      {icon && <ExternalIcon size={12} aria-hidden className="shrink-0 opacity-70" />}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

/* ---------------------------------------------------------------- segmented */

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = 'md',
  className,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode; title?: string }[]
  label: string
  size?: 'sm' | 'md'
  className?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-[var(--radius-btn)] bg-fog-2 p-[3px]', className)}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const idx = options.findIndex((x) => x.value === value)
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault()
                onChange(options[(idx + 1) % options.length]!.value)
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault()
                onChange(options[(idx - 1 + options.length) % options.length]!.value)
              }
            }}
            tabIndex={active ? 0 : -1}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[4px] font-[600] transition-colors',
              size === 'sm' ? 'h-7 px-2.5 text-[0.8rem]' : 'h-8 px-3 text-[0.86rem]',
              active ? 'bg-sheet text-ink shadow-[0_0_0_1px_var(--line-strong)]' : 'text-ink-2 hover:text-ink',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/* ---------------------------------------------------------------- chip */

export function Chip({
  children,
  active,
  onClick,
  onRemove,
  className,
  icon,
  count,
}: {
  children: ReactNode
  active?: boolean
  onClick?: () => void
  onRemove?: () => void
  className?: string
  icon?: ReactNode
  count?: number
}) {
  return (
    <span
      className={cn(
        'inline-flex h-8 shrink-0 items-center rounded-full border-[1.5px] text-[0.84rem] font-[580] transition-colors',
        active ? 'border-ink bg-ink text-on-ink' : 'border-line-strong bg-sheet text-ink hover:border-ink',
        className,
      )}
    >
      <button type="button" onClick={onClick} aria-pressed={onClick ? !!active : undefined} className="inline-flex h-full items-center gap-1.5 rounded-full pl-3 pr-3 data-[rm=true]:pr-1.5" data-rm={!!onRemove}>
        {icon}
        {children}
        {count !== undefined && <span className={cn('t-figure text-[0.8rem]', active ? 'text-on-ink/75' : 'text-ink-3')}>{count}</span>}
      </button>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove filter ${typeof children === 'string' ? children : ''}`} className="mr-1 inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-white/15">
          <X size={13} aria-hidden />
        </button>
      )}
    </span>
  )
}

/* ---------------------------------------------------------------- tabs */

export const Tabs = RTabs.Root

export function TabList({ children, label, className }: { children: ReactNode; label: string; className?: string }) {
  return (
    <RTabs.List aria-label={label} className={cn('scrollbar-none relative flex gap-1 overflow-x-auto border-b border-line', className)}>
      {children}
    </RTabs.List>
  )
}

export function Tab({ value, children, count }: { value: string; children: ReactNode; count?: number }) {
  return (
    <RTabs.Trigger
      value={value}
      className="relative -mb-px inline-flex h-11 shrink-0 items-center gap-1.5 border-b-[3px] border-transparent px-3 text-[0.94rem] font-[600] text-ink-2 hover:text-ink data-[state=active]:border-ink data-[state=active]:text-ink"
    >
      {children}
      {count !== undefined && <span className="t-figure rounded-full bg-fog-2 px-1.5 py-0.5 text-[0.78rem] text-ink-2">{count}</span>}
    </RTabs.Trigger>
  )
}

export const TabPanel = ({ value, children, className }: { value: string; children: ReactNode; className?: string }) => (
  <RTabs.Content value={value} className={cn('pt-6 focus-visible:outline-none', className)}>
    {children}
  </RTabs.Content>
)

/* ---------------------------------------------------------------- drawer */

export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  side = 'right',
  footer,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  side?: 'right' | 'bottom'
  footer?: ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(14_19_48/0.42)] data-[state=open]:animate-[fade-in_160ms_ease-out]" />
        <Dialog.Content
          className={cn(
            'fixed z-50 flex flex-col bg-sheet text-ink outline-none',
            side === 'right'
              ? 'inset-y-0 right-0 w-full max-w-[34rem] border-l-[3px] border-ink data-[state=open]:animate-[drawer-in_220ms_cubic-bezier(.2,.8,.2,1)]'
              : 'inset-x-0 bottom-0 max-h-[88vh] rounded-t-[10px] border-t-[3px] border-ink data-[state=open]:animate-[sheet-up_220ms_cubic-bezier(.2,.8,.2,1)]',
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="t-h2">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-1 text-[0.9rem] text-ink-2">{description}</Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">Details</Dialog.Description>
              )}
            </div>
            <Dialog.Close className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-btn)] hover:bg-ink/[0.07]" aria-label="Close">
              <X size={18} aria-hidden />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
          {footer && <div className="border-t border-line px-5 py-3">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/* ---------------------------------------------------------------- tooltip */

export function Tip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <RTooltip.Root delayDuration={250}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          className="z-[60] max-w-[18rem] rounded-[4px] bg-ink px-2.5 py-1.5 text-[0.8rem] leading-snug text-on-ink"
        >
          {content}
          <RTooltip.Arrow className="fill-[var(--ink)]" />
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}

export const TipProvider = RTooltip.Provider

/* ---------------------------------------------------------------- slider */

export function Slider({
  value,
  onChange,
  min,
  max,
  step,
  label,
  valueText,
  className,
  tone = 'ink',
}: {
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step: number
  label: string
  valueText?: string
  className?: string
  tone?: 'ink' | 'flare' | 'cobalt'
}) {
  const fill = tone === 'flare' ? 'hatch-yes' : tone === 'cobalt' ? 'bg-cobalt' : 'bg-ink'
  return (
    <RSlider.Root
      className={cn('relative flex h-8 w-full touch-none select-none items-center', className)}
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => onChange(v[0] ?? min)}
      aria-label={label}
    >
      <RSlider.Track className="relative h-[6px] grow rounded-full bg-fog-2 shadow-[inset_0_0_0_1px_var(--line)]">
        <RSlider.Range className={cn('absolute h-full rounded-full', fill)} />
      </RSlider.Track>
      <RSlider.Thumb
        aria-label={label}
        aria-valuetext={valueText}
        className="block h-6 w-3 rounded-[3px] border-2 border-sheet bg-ink shadow-[0_0_0_1.5px_var(--ink)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1.5px_var(--ink),0_0_0_5px_var(--lumen)]"
      />
    </RSlider.Root>
  )
}

/* ---------------------------------------------------------------- switch */

export function Switch({
  checked,
  onChange,
  label,
  description,
  id,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: ReactNode
  description?: ReactNode
  id: string
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block font-[600]">{label}</span>
        {description && <span className="mt-0.5 block text-[0.86rem] text-ink-2">{description}</span>}
      </label>
      <RSwitch.Root
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        className="relative mt-0.5 h-6 w-11 shrink-0 rounded-full border-[1.5px] border-ink bg-sheet transition-colors data-[state=checked]:bg-ink"
      >
        <RSwitch.Thumb className="block h-4 w-4 translate-x-[3px] rounded-full bg-ink transition-transform data-[state=checked]:translate-x-[22px] data-[state=checked]:bg-on-ink" />
      </RSwitch.Root>
    </div>
  )
}
