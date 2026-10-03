'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { GitPullRequest } from 'lucide-react'
import { parseGitHubRefDetailed } from '@pine/core'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { useWorkbench } from '@/components/shell/workbench'

const EXAMPLE = 'https://github.com/kleros/gateway-balancer-bot/pull/47'

/** The landing's entry point: paste a PR or commit URL and go straight to a pre-filled composer. */
export function PasteBox() {
  const router = useRouter()
  const { openPalette } = useWorkbench()
  const [value, setValue] = React.useState('')
  const parsed = value.trim() ? parseGitHubRefDetailed(value.trim()) : null
  const inputRef = React.useRef<HTMLInputElement>(null)
  const go = () => {
    // Never silently drop what was pasted: an unrecognized reference stays in the box with its reason.
    if (value.trim() && !parsed?.ref) {
      inputRef.current?.focus()
      return
    }
    router.push(value.trim() ? `/new?source=${encodeURIComponent(value.trim())}` : '/new')
  }
  return (
    <div className="w-full max-w-[640px]">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          go()
        }}
        className="flex flex-col gap-2 sm:flex-row"
      >
        <label htmlFor="landing-paste" className="sr-only">
          GitHub pull request or commit URL
        </label>
        <div className="relative min-w-0 flex-1">
          <GitPullRequest size={16} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input
            ref={inputRef}
            id="landing-paste"
            aria-invalid={(value.trim() && parsed && !parsed.ref) || undefined}
            aria-describedby="landing-paste-hint"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Paste a GitHub PR or commit URL"
            spellCheck={false}
            autoComplete="off"
            className="mono-cond h-11 w-full rounded-ctl border border-line-strong bg-surface pl-9 pr-3 text-[13px] text-bark shadow-[0_1px_0_var(--line)] placeholder:font-sans placeholder:text-[14px] focus:border-needle focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-needle aria-[invalid=true]:border-flare"
          />
        </div>
        <Button type="submit" variant="primary" size="lg" className="h-11 px-5">
          Verify a commit
        </Button>
      </form>
      <p id="landing-paste-hint" className="mt-2 text-[12.5px] text-muted" aria-live="polite">
        {value.trim() && parsed && !parsed.ref ? (
          <span className="text-flare">{parsed.reason ?? 'That does not look like a GitHub URL.'}</span>
        ) : (
          <>
            Try{' '}
            <button type="button" onClick={() => setValue(EXAMPLE)} className="mono-cond text-[11.5px] text-needle underline-offset-2 hover:underline">
              kleros/gateway-balancer-bot/pull/47
            </button>
            <span className="hidden sm:inline">
              , or press <Kbd>⌘K</Kbd> anywhere and paste
            </span>
            .{' '}
            <button type="button" onClick={() => openPalette()} className="sr-only">
              Open command palette
            </button>
          </>
        )}
      </p>
    </div>
  )
}
