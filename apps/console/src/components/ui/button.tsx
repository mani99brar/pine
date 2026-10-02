import * as React from 'react'
import { Slot } from 'radix-ui'
import { cn } from '@/lib/cn'
import { Kbd } from './kbd'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet'
type Size = 'xs' | 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  primary:
    'bg-needle text-needle-ink border border-needle hover:brightness-110 active:brightness-95 disabled:opacity-50',
  secondary:
    'bg-surface text-bark border border-line-strong hover:border-needle hover:text-needle disabled:opacity-50 disabled:hover:border-line-strong disabled:hover:text-bark',
  ghost: 'bg-transparent text-bark border border-transparent hover:bg-sunken disabled:opacity-50',
  danger: 'bg-surface text-flare border border-flare/50 hover:bg-flare-soft disabled:opacity-50',
  quiet: 'bg-transparent text-muted border border-transparent hover:text-bark disabled:opacity-50',
}
const sizes: Record<Size, string> = {
  xs: 'h-6 px-2 text-xs gap-1',
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-8 px-3 text-sm gap-2',
  lg: 'h-10 px-4 text-sm gap-2',
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  asChild?: boolean
  /** Keyboard shortcut hint rendered inside the button */
  kbd?: string
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', asChild, kbd, className, children, type, ...rest },
  ref,
) {
  const Comp = asChild ? Slot.Root : 'button'
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-ctl font-medium transition-[color,background-color,border-color,filter] duration-100',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {asChild ? (
        children
      ) : (
        <>
          {children}
          {kbd ? (
            <Kbd className={cn('ml-1', variant === 'primary' && 'border-needle-ink/30 bg-transparent text-needle-ink/80')}>
              {kbd}
            </Kbd>
          ) : null}
        </>
      )}
    </Comp>
  )
})
