import { cn } from '@/lib/cn'

/** A keyboard key cap. Accepts "⌘K" or "g c" (space-separated sequence). */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  if (typeof children === 'string' && children.includes(' ')) {
    const parts = children.split(' ')
    return (
      <span className={cn('inline-flex items-center gap-0.5', className)}>
        {parts.map((p, i) => (
          <Kbd key={i}>{p}</Kbd>
        ))}
      </span>
    )
  }
  return (
    <kbd
      className={cn(
        'mono-cond inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-line-strong bg-surface px-1 text-[10.5px] font-medium leading-none text-muted shadow-[0_1px_0_var(--line-strong)]',
        className,
      )}
    >
      {children}
    </kbd>
  )
}
