import Link from 'next/link'
import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'quiet' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

const base =
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius-btn)] font-[620] whitespace-nowrap select-none transition-[background-color,color,border-color,transform] duration-150 active:translate-y-[1px] disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45'

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-on-ink hover:bg-[color-mix(in_oklab,var(--ink)_86%,var(--cobalt))]',
  secondary: 'border-[1.5px] border-ink text-ink bg-transparent hover:bg-ink/[0.06]',
  ghost: 'text-ink hover:bg-ink/[0.07]',
  quiet: 'text-ink-2 underline decoration-line-strong underline-offset-[3px] hover:text-ink hover:decoration-ink px-0',
  danger: 'border-[1.5px] border-flare-ink text-flare-ink hover:bg-flare-wash',
}

const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[0.84rem]',
  md: 'h-10 px-4 text-[0.94rem]',
  lg: 'h-12 px-5 text-[1rem]',
}

export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', className?: string): string {
  return cn(base, variants[variant], variant === 'quiet' ? 'h-auto text-[0.94rem]' : sizes[size], className)
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, icon, loading, children, type = 'button', disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  )
})

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
}

export function ButtonLink({ href, variant = 'primary', size = 'md', className, icon, children, ...rest }: ButtonLinkProps) {
  return (
    <Link href={href} className={buttonClass(variant, size, className)} {...rest}>
      {icon}
      {children}
    </Link>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent', className)}
    />
  )
}
