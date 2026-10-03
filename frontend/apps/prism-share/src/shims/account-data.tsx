import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAccountData as useRealAccountData } from '@pine-real/react'
import { buildAccountExport } from '../api/account'
import { sessionStore } from '../api/session'

/** Clipboard write that works inside a click handler, with the textarea + execCommand fallback. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function ExportText({ text }: { text: string }) {
  return (
    <span className="mt-2 grid gap-2">
      <span>Copying is blocked here. Select the JSON below and copy it.</span>
      <textarea
        readOnly
        value={text}
        rows={8}
        aria-label="Account export (JSON)"
        className="field t-code h-48 w-full min-w-[16rem] resize-y text-[0.72rem]"
        ref={(el) => el?.select()}
        onFocus={(e) => e.currentTarget.select()}
      />
    </span>
  )
}

/** `useAccountData` with an export that suits a static artifact (no download navigation). */
export function useAccountData() {
  const real = useRealAccountData()
  const exportData = useCallback(async () => {
    const session = sessionStore.get()
    if (!session) return
    const text = JSON.stringify(buildAccountExport(session.user), null, 2)
    if (await copyText(text)) {
      toast.success('Account export copied', {
        description: 'Downloads are off in this static preview, so the JSON export was copied to your clipboard instead.',
      })
    } else {
      toast('Account export', { description: <ExportText text={text} />, duration: Number.POSITIVE_INFINITY, closeButton: true })
    }
  }, [])
  return { exportData, deleteAccount: real.deleteAccount }
}
