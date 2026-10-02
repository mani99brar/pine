'use client'

import { SHORTCUTS } from '@/lib/nav'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { useWorkbench } from './workbench'

export function ShortcutsSheet() {
  const { shortcutsOpen, setShortcutsOpen } = useWorkbench()
  const scopes = [...new Set(SHORTCUTS.map((s) => s.scope))]
  return (
    <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
      <DialogContent title="Keyboard shortcuts" description="Every shortcut also has a visible control. Shortcuts pause while you type in a field.">
        <div className="grid gap-x-8 gap-y-5 p-4 sm:grid-cols-2">
          {scopes.map((scope) => (
            <section key={scope}>
              <h3 className="stretch-cond mb-1.5 text-[13px] font-semibold text-muted">{scope}</h3>
              <ul className="divide-y divide-line">
                {SHORTCUTS.filter((s) => s.scope === scope).map((s) => (
                  <li key={s.keys + s.label} className="flex items-center justify-between gap-3 py-1.5 text-[13px]">
                    <span>{s.label}</span>
                    <Kbd>{s.keys}</Kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
