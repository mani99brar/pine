import * as React from 'react'
import { cn } from '@/lib/cn'

const control =
  'w-full rounded-ctl border border-line-strong bg-surface px-2.5 text-sm text-bark transition-colors hover:border-faint focus:border-needle focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-needle aria-[invalid=true]:border-flare disabled:opacity-60'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(
  function Input({ className, mono, ...rest }, ref) {
    return <input ref={ref} className={cn(control, 'h-8', mono && 'mono-cond text-[12.5px]', className)} {...rest} />
  },
)

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }
>(function Textarea({ className, mono, rows = 3, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(control, 'min-h-16 resize-y py-1.5 leading-[1.5]', mono && 'mono-cond text-[12.5px]', className)}
      {...rest}
    />
  )
})

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        control,
        'h-8 appearance-none bg-[length:10px] bg-[right_10px_center] bg-no-repeat pr-7',
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%2366736e' stroke-width='1.4'/%3E%3C/svg%3E\")]",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  )
})

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className,
  aside,
  id,
  group,
}: {
  label: React.ReactNode
  /** The control is a group (radiogroup, segmented) that names itself; render the label as text, not <label for>. */
  group?: boolean
  htmlFor?: string
  hint?: React.ReactNode
  error?: string
  required?: boolean
  children: React.ReactNode
  className?: string
  aside?: React.ReactNode
  id?: string
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)} id={id}>
      <div className="flex items-baseline gap-2">
        {group ? (
          <span className="stretch-cond text-[13px] font-medium text-bark">{label}</span>
        ) : (
          <label htmlFor={htmlFor} className="stretch-cond text-[13px] font-medium text-bark">
            {label}
            {required ? <span className="ml-0.5 text-muted" aria-hidden>*</span> : null}
          </label>
        )}
        {aside ? <span className="ml-auto text-xs text-muted">{aside}</span> : null}
      </div>
      {children}
      {error ? (
        <p className="text-xs text-flare" id={htmlFor ? `${htmlFor}-error` : undefined}>
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs leading-[1.45] text-muted">{hint}</p>
      ) : null}
    </div>
  )
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  id,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: React.ReactNode
  description?: React.ReactNode
  id: string
  disabled?: boolean
}) {
  return (
    <label htmlFor={id} className={cn('flex cursor-pointer items-start gap-2.5 text-sm', disabled && 'cursor-not-allowed opacity-60')}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-[var(--needle)]"
      />
      <span className="min-w-0">
        <span className="text-bark">{label}</span>
        {description ? <span className="mt-0.5 block text-xs text-muted">{description}</span> : null}
      </span>
    </label>
  )
}

export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; id: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
        checked ? 'border-needle bg-needle' : 'border-line-strong bg-sunken',
      )}
    >
      <span
        className={cn(
          'inline-block size-3.5 rounded-full bg-surface shadow transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  )
}

/** Segmented control for small option sets. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = 'sm',
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: React.ReactNode; title?: string }[]
  label: string
  size?: 'xs' | 'sm'
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!d) return
    e.preventDefault()
    const next = (i + d + options.length) % options.length
    onChange(options[next]!.value)
    refs.current[next]?.focus()
  }
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value))
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex w-fit self-start rounded-ctl border border-line-strong bg-sunken p-0.5">
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={i === selectedIndex ? 0 : -1}
          title={o.title}
          onKeyDown={(e) => onKeyDown(e, i)}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-[4px] px-2 font-medium text-muted transition-colors hover:text-bark',
            size === 'xs' ? 'h-5 text-[11px]' : 'h-6 text-xs',
            value === o.value && 'bg-surface text-bark shadow-[0_0_0_1px_var(--line-strong)]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
