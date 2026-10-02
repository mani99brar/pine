import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

const control =
  'w-full rounded-[4px] border-[1.5px] border-line-strong bg-sheet px-3 text-[0.95rem] text-ink placeholder:text-ink-3 transition-colors hover:border-ink/60 focus:border-ink focus:outline-none focus-visible:shadow-[0_0_0_3px_var(--lumen)] aria-[invalid=true]:border-flare-ink'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(control, 'h-10', className)} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(control, 'min-h-[6rem] py-2 leading-[1.5]', className)} {...rest} />
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        control,
        'h-10 appearance-none bg-[length:12px] bg-[right_0.75rem_center] bg-no-repeat pr-9',
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' fill='none' stroke='%235f6582' stroke-width='1.6'/%3E%3C/svg%3E\")]",
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
  help,
  error,
  children,
  className,
  optional,
}: {
  label: ReactNode
  htmlFor: string
  help?: ReactNode
  error?: ReactNode
  children: ReactNode
  className?: string
  optional?: boolean
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={htmlFor} className="mb-1.5 flex items-baseline gap-2 text-[0.88rem] font-[620] text-ink">
        {label}
        {optional && <span className="text-[0.78rem] font-[450] text-ink-3">optional</span>}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="mt-1.5 text-[0.82rem] font-[550] text-flare-ink" role="alert">
          {error}
        </p>
      ) : help ? (
        <p id={`${htmlFor}-help`} className="mt-1.5 text-[0.82rem] text-ink-3">
          {help}
        </p>
      ) : null}
    </div>
  )
}
