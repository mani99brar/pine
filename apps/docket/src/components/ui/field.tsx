'use client'

import { Info, Plus, X } from 'lucide-react'
import { forwardRef, useId, useState, type ComponentProps, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

const control =
  'block w-full rounded-xs border-2 border-ink bg-sheet px-3 text-base text-ink placeholder:text-graphite/80 aria-[invalid=true]:border-red'

export const Input = forwardRef<HTMLInputElement, ComponentProps<'input'> & { mono?: boolean }>(function Input(
  { className, mono, ...props },
  ref,
) {
  return <input ref={ref} className={cn(control, 'h-11', mono && 'font-mono text-[15px]', className)} {...props} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, ComponentProps<'textarea'> & { mono?: boolean; record?: boolean }>(
  function Textarea({ className, mono, record, rows = 3, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={cn(
          control,
          'py-2.5 leading-7',
          mono && 'font-mono text-[15px] leading-6',
          record && 'font-serif text-[18px] leading-7',
          className,
        )}
        {...props}
      />
    )
  },
)

export const Select = forwardRef<HTMLSelectElement, ComponentProps<'select'>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        control,
        'select-chevron h-11 appearance-none pr-9',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  )
})

export function Checkbox({
  label,
  description,
  className,
  ...props
}: Omit<ComponentProps<'input'>, 'type'> & { label: ReactNode; description?: ReactNode }) {
  const id = useId()
  return (
    <div className={cn('flex gap-3', className)}>
      <input
        id={props.id ?? id}
        type="checkbox"
        className="check-input mt-0.5 size-6 shrink-0 cursor-pointer appearance-none rounded-xs border-2 border-ink bg-sheet disabled:cursor-not-allowed disabled:opacity-50"
        {...props}
      />
      <label htmlFor={props.id ?? id} className="min-w-0 cursor-pointer">
        <span className="block font-bold">{label}</span>
        {description ? <span className="mt-0.5 block text-sm text-graphite">{description}</span> : null}
      </label>
    </div>
  )
}

export interface ChoiceOption<T extends string> {
  value: T
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
  aside?: ReactNode
}

/** Radio choices rendered as ruled rows. Native radios underneath for keyboard and screen readers. */
export function Choices<T extends string>({
  name,
  value,
  onChange,
  options,
  legend,
  className,
  columns = 1,
}: {
  name: string
  value: T | undefined
  onChange: (v: T) => void
  options: ChoiceOption<T>[]
  legend?: ReactNode
  className?: string
  columns?: 1 | 2 | 3
}) {
  return (
    <fieldset className={className}>
      {legend ? <legend className="mb-2 font-bold">{legend}</legend> : null}
      <div
        className={cn(
          'grid gap-2',
          columns === 2 && 'sm:grid-cols-2',
          columns === 3 && 'sm:grid-cols-2 lg:grid-cols-3',
        )}
      >
        {options.map((o) => {
          const checked = value === o.value
          return (
            <label
              key={o.value}
              className={cn(
                'relative flex cursor-pointer gap-3 rounded-xs border-2 bg-sheet p-4 transition-colors',
                checked ? 'border-violet bg-violet-wash' : 'border-rule hover:border-rule-strong',
                o.disabled && 'cursor-not-allowed opacity-70 hover:border-rule',
                'has-[input:focus-visible]:outline-3 has-[input:focus-visible]:outline-flag has-[input:focus-visible]:shadow-[0_0_0_6px_var(--color-ink)]',
              )}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={checked}
                disabled={o.disabled}
                onChange={() => onChange(o.value)}
                className="peer mt-1 size-5 shrink-0 cursor-pointer appearance-none rounded-full border-2 border-ink bg-sheet checked:border-[6px] checked:border-violet focus-visible:shadow-none! focus-visible:outline-none!"
              />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <span className="block font-bold">{o.label}</span>
                {o.description ? <span className="mt-1 block text-sm text-graphite">{o.description}</span> : null}
                {o.aside ? <span className="mt-2 block">{o.aside}</span> : null}
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

/**
 * A field with guidance in the margin.
 * Desktop: the guidance note sits in a right-hand margin column, aligned with the field.
 * Mobile: it folds into a "What does this mean?" disclosure under the label.
 */
export function Field({
  id,
  label,
  hint,
  error,
  guidance,
  guidanceTitle,
  optional,
  children,
  className,
}: {
  id: string
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  guidance?: ReactNode
  guidanceTitle?: string
  optional?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('grid gap-x-10 lg:grid-cols-[minmax(0,1fr)_17rem] xl:grid-cols-[minmax(0,1fr)_19rem]', className)}>
      <div className={cn('min-w-0', error && 'border-l-4 border-red pl-4')}>
        <label htmlFor={id} className="block text-base font-bold">
          {label}
          {optional ? <span className="ml-1.5 font-normal text-graphite">(optional)</span> : null}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="mt-0.5 text-sm text-graphite measure">
            {hint}
          </p>
        ) : null}
        {guidance ? (
          <details className="group mt-1.5 lg:hidden">
            <summary className="inline-flex items-center gap-1.5 text-sm font-bold text-violet underline underline-offset-4">
              <Info aria-hidden className="size-4" />
              {guidanceTitle ?? 'What does this mean?'}
            </summary>
            <div className="mt-2 border-l-4 border-violet-line bg-sheet py-1 pl-3 text-sm leading-6 text-ink">{guidance}</div>
          </details>
        ) : null}
        {error ? (
          <p id={`${id}-error`} className="mt-1.5 text-sm font-bold text-red" role="alert">
            <span className="sr-only">Error: </span>
            {error}
          </p>
        ) : null}
        <div className="mt-2">{children}</div>
      </div>
      {guidance ? (
        <aside aria-label={guidanceTitle ?? 'Guidance'} className="hidden pt-0.5 lg:block">
          <MarginNote title={guidanceTitle}>{guidance}</MarginNote>
        </aside>
      ) : (
        <div className="hidden lg:block" />
      )}
    </div>
  )
}

/** Guidance note for the margin column. */
export function MarginNote({ title, children, className }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('border-l-4 border-violet-line pl-4 text-sm leading-6 text-ink', className)}>
      {title ? <p className="mb-1 font-bold text-violet">{title}</p> : null}
      <div className="space-y-2 text-graphite [&_strong]:text-ink">{children}</div>
    </div>
  )
}

/** Editable list of short strings (scope items, assumptions, exclusions, setup steps). */
export function ListInput({
  id,
  value,
  onChange,
  placeholder,
  addLabel = 'Add another',
  mono,
  max = 20,
}: {
  id: string
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  addLabel?: string
  mono?: boolean
  max?: number
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim()
    if (!v || value.length >= max) return
    onChange([...value, v])
    setDraft('')
  }
  return (
    <div>
      {value.length > 0 ? (
        <ol className="mb-2 divide-y divide-rule border border-rule bg-sheet">
          {value.map((item, i) => (
            <li key={`${i}-${item}`} className="flex items-start gap-3 px-3 py-2">
              <span className="tabular w-5 shrink-0 pt-px text-sm text-graphite">{i + 1}.</span>
              <span className={cn('untrusted min-w-0 flex-1', mono && 'font-mono text-[15px]')}>{item}</span>
              <button
                type="button"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                className="shrink-0 rounded-xs p-1 text-graphite hover:bg-bond hover:text-red"
                aria-label={`Remove item ${i + 1}`}
              >
                <X aria-hidden className="size-4" />
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="flex gap-2">
        <Input
          id={id}
          value={draft}
          mono={mono}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-sm border border-rule-strong bg-sheet px-3 text-sm font-bold shadow-[0_2px_0_var(--color-rule)] hover:bg-bond disabled:opacity-50"
        >
          <Plus aria-hidden className="size-4" />
          <span className="hidden xs:inline">{addLabel}</span>
          <span className="xs:hidden">Add</span>
        </button>
      </div>
    </div>
  )
}
