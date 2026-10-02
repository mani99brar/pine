import Link from 'next/link'
import { forwardRef, type ComponentProps, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'ink'
type Size = 'sm' | 'md' | 'lg'

const base =
  'inline-flex items-center justify-center gap-2 font-bold whitespace-nowrap select-none transition-[background-color,box-shadow,color] duration-100 disabled:cursor-not-allowed disabled:opacity-55 [&_svg]:shrink-0'

const variants: Record<Variant, string> = {
  // Civic button: solid fill with a 2px darker "press" edge underneath.
  primary:
    'bg-violet text-white shadow-[0_2px_0_var(--color-violet-deep)] hover:bg-violet-deep active:translate-y-px active:shadow-none rounded-sm',
  ink: 'bg-ink text-white shadow-[0_2px_0_#000] hover:bg-[#2c3044] active:translate-y-px active:shadow-none rounded-sm',
  secondary:
    'bg-sheet text-ink border border-rule-strong shadow-[0_2px_0_var(--color-rule)] hover:bg-bond active:translate-y-px active:shadow-none rounded-sm',
  quiet: 'text-violet underline underline-offset-4 decoration-1 hover:decoration-[3px] rounded-xs px-0!',
  danger:
    'bg-red text-white shadow-[0_2px_0_#7e1810] hover:bg-[#8f1b12] active:translate-y-px active:shadow-none rounded-sm',
}

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm [&_svg]:size-4',
  md: 'h-11 px-4 text-base [&_svg]:size-[18px]',
  lg: 'h-13 px-6 text-lg [&_svg]:size-5',
}

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
  iconAfter?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, icon, iconAfter, children, type = 'button', ...props },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cn(base, variants[variant], sizes[size], className)} {...props}>
      {icon}
      {children}
      {iconAfter}
    </button>
  )
})

export interface ButtonLinkProps extends Omit<ComponentProps<typeof Link>, 'className'> {
  variant?: Variant
  size?: Size
  className?: string
  icon?: ReactNode
  iconAfter?: ReactNode
}

export function ButtonLink({ variant = 'primary', size = 'md', className, icon, iconAfter, children, ...props }: ButtonLinkProps) {
  return (
    <Link className={cn(base, 'no-underline', variants[variant], sizes[size], className)} {...props}>
      {icon}
      {children}
      {iconAfter}
    </Link>
  )
}
