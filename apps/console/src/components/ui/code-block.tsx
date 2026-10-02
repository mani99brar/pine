import { cn } from '@/lib/cn'
import { CopyButton } from './copy-button'

/** A copyable command or code snippet. `prompt` adds a `$` gutter for shell commands. */
export function CodeBlock({
  code,
  label,
  prompt,
  className,
  wrap = true,
}: {
  code: string
  label: string
  prompt?: boolean
  className?: string
  wrap?: boolean
}) {
  return (
    <div className={cn('group relative rounded-ctl border border-line bg-sunken', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1">
        <span className="stretch-cond text-[11.5px] text-muted">{label}</span>
        <CopyButton value={code} label={label} size={13} />
      </div>
      <pre
        className={cn(
          'mono-cond scrollbar-thin overflow-x-auto px-3 py-2.5 text-[12px] leading-[1.6] text-bark',
          wrap && 'wrap-anywhere whitespace-pre-wrap',
        )}
      >
        {prompt
          ? code.split('\n').map((line, i) => (
              <span key={i} className="block">
                <span className="select-none text-faint">$ </span>
                {line}
              </span>
            ))
          : code}
      </pre>
    </div>
  )
}
