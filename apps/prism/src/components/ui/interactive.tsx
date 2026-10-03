'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { animate, AnimatePresence, motion } from 'motion/react'
import { Dialog as RDialog, Tooltip as RTooltip } from 'radix-ui'
import { Check, Copy, X } from 'lucide-react'
import { useCopy } from '@pine/react'
import { cn } from '@/lib/cn'
import { useReduceMotion } from '@/lib/hooks'

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export function CopyButton({ text, label = 'Copy', className, size = 'sm', variant = 'glass' }: { text: string; label?: string; className?: string; size?: 'sm' | 'xs'; variant?: 'glass' | 'ghost' }) {
  const { copy, copied } = useCopy()
  return (
    <button
      type="button"
      onClick={() => void copy(text)}
      className={cn(
        'btn',
        variant === 'glass' ? 'btn-glass' : 'btn-ghost',
        size === 'xs' ? 'h-7 gap-1.5 px-2 text-[0.78rem]' : 'btn-sm',
        className,
      )}
      aria-label={copied ? `${label}: copied` : label}
    >
      <span className="relative inline-flex h-3.5 w-3.5 items-center justify-center">
        <AnimatePresence initial={false} mode="popLayout">
          {copied ? (
            <motion.span key="ok" initial={{ scale: 0.4, opacity: 0, rotate: -30 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} exit={{ scale: 0.4, opacity: 0 }}>
              <Check size={14} aria-hidden className="text-hb" />
            </motion.span>
          ) : (
            <motion.span key="copy" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }}>
              <Copy size={14} aria-hidden />
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      <span>{copied ? 'Copied' : label}</span>
    </button>
  )
}

/** An immutable reference (hash, SHA, address) with its label and a copy action. */
export function HashChip({ value, label, display, className, href }: { value: string; label?: string; display?: string; className?: string; href?: string }) {
  const { copy, copied } = useCopy()
  const short = display ?? (value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value)
  return (
    <span className={cn('cut-sm inline-flex max-w-full items-center gap-2 border border-edge bg-void py-1 pl-2.5 pr-1', className)}>
      {label && <span className="shrink-0 text-[0.78rem] text-lumen-3">{label}</span>}
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="t-code link truncate text-lumen" title={value}>
          {short}
        </a>
      ) : (
        <span className="t-code truncate text-lumen" title={value}>
          {short}
        </span>
      )}
      <button
        type="button"
        onClick={() => void copy(value)}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[3px] text-lumen-3 transition-colors hover:bg-smoke-3 hover:text-lumen"
        aria-label={copied ? `${label ?? 'Value'} copied` : `Copy ${label ?? 'value'}`}
      >
        {copied ? <Check size={13} aria-hidden className="text-hb" /> : <Copy size={13} aria-hidden />}
      </button>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Animated number: rolls to new values; instant with reduced motion.
// ---------------------------------------------------------------------------

export function AnimatedNumber({ value, format, className, duration = 0.9 }: { value: number; format: (n: number) => string; className?: string; duration?: number }) {
  const reduce = useReduceMotion()
  const ref = useRef<HTMLSpanElement | null>(null)
  const last = useRef<number | null>(null)
  const formatRef = useRef(format)
  useEffect(() => {
    formatRef.current = format
  })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const from = last.current ?? (reduce ? value : value * 0.6)
    last.current = value
    if (reduce || from === value) {
      el.textContent = formatRef.current(value)
      return
    }
    const controls = animate(from, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => {
        el.textContent = formatRef.current(v)
      },
    })
    return () => controls.stop()
  }, [value, reduce, duration])
  return (
    <span ref={ref} className={cn('tnum', className)}>
      {format(value)}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

export function Tip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <RTooltip.Provider delayDuration={250}>
      <RTooltip.Root>
        <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
        <RTooltip.Portal>
          <RTooltip.Content side={side} sideOffset={6} className="glass-float cut-md z-[80] max-w-[18rem] px-3 py-2 text-[0.8125rem] leading-[1.45] text-lumen-2">
            {content}
          </RTooltip.Content>
        </RTooltip.Portal>
      </RTooltip.Root>
    </RTooltip.Provider>
  )
}

// ---------------------------------------------------------------------------
// Segmented control (radio group semantics)
// ---------------------------------------------------------------------------

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  size = 'md',
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode; title?: string }[]
  label: string
  className?: string
  size?: 'sm' | 'md'
}) {
  const id = useId()
  const reduce = useReduceMotion()
  return (
    <div role="radiogroup" aria-label={label} className={cn('cut-md inline-flex items-center gap-0.5 border border-edge bg-void p-0.5', className)}>
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
              const i = options.findIndex((x) => x.value === value)
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault()
                onChange(options[(i + 1) % options.length]!.value)
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault()
                onChange(options[(i - 1 + options.length) % options.length]!.value)
              }
            }}
            tabIndex={active ? 0 : -1}
            className={cn(
              'relative isolate inline-flex items-center gap-1.5 rounded-[5px] font-semibold transition-colors',
              size === 'sm' ? 'h-7 px-2.5 text-[0.8rem]' : 'h-8 px-3 text-[0.84375rem]',
              active ? 'text-umbra' : 'text-lumen-2 hover:text-lumen',
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 -z-10 rounded-[5px] bg-lumen"
                transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 36 }}
              />
            )}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-[85] bg-[rgba(8,6,5,0.72)] backdrop-blur-[2px] data-[state=open]:animate-[rise_200ms_ease-out]" />
        <RDialog.Content
          className={cn(
            'glass-float cut-xl fixed left-1/2 top-1/2 z-[86] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 p-6 focus:outline-none',
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <RDialog.Title className="t-h3">{title}</RDialog.Title>
            <RDialog.Close className="-mr-2 -mt-1 inline-flex h-8 w-8 items-center justify-center rounded-[4px] text-lumen-3 hover:bg-smoke-3 hover:text-lumen" aria-label="Close">
              <X size={16} aria-hidden />
            </RDialog.Close>
          </div>
          {description ? <RDialog.Description className="mt-2 text-[0.9375rem] text-lumen-2">{description}</RDialog.Description> : <RDialog.Description className="sr-only">Dialog</RDialog.Description>}
          {children && <div className="mt-5">{children}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}

/** Collapsible long text with a fade; the full text is always in the DOM for assistive tech. */
export function Expandable({ children, collapsedHeight = 180, className, label = 'Show all' }: { children: ReactNode; collapsedHeight?: number; className?: string; label?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setOverflowing(el.scrollHeight > collapsedHeight + 24)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [collapsedHeight])
  return (
    <div className={className}>
      <div
        ref={ref}
        className="relative overflow-hidden"
        style={{ maxHeight: open || !overflowing ? undefined : collapsedHeight }}
      >
        {children}
        {!open && overflowing && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[var(--smoke)] to-transparent" />}
      </div>
      {overflowing && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="link mt-2 text-[0.84375rem] font-semibold text-lumen-2" aria-expanded={open}>
          {open ? 'Show less' : label}
        </button>
      )}
    </div>
  )
}
