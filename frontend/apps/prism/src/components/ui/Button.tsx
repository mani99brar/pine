'use client'

import Link from 'next/link'
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'
import { cn } from '@/lib/cn'

type Variant = 'light' | 'glass' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const variantClass: Record<Variant, string> = {
  light: 'btn-light',
  glass: 'btn-glass',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
}
const sizeClass: Record<Size, string> = { sm: 'btn-sm', md: '', lg: 'btn-lg' }

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'light', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn('btn', variantClass[variant], sizeClass[size], className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="spinner" aria-hidden /> : icon}
      {children}
    </button>
  )
})

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string
  variant?: Variant
  size?: Size
  icon?: ReactNode
  external?: boolean
}

export function ButtonLink({ href, variant = 'light', size = 'md', icon, className, children, external, ...rest }: ButtonLinkProps) {
  const cls = cn('btn', variantClass[variant], sizeClass[size], className)
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={cls} {...rest}>
        {icon}
        {children}
      </a>
    )
  }
  return (
    <Link href={href} className={cls} {...rest}>
      {icon}
      {children}
    </Link>
  )
}

/** External link that is always inert to referrers and search engines. */
export function ExternalLink({ href, children, className, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={cn('link', className)} {...rest}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
