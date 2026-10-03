'use client'

import { useEffect } from 'react'
import { Bot, FilePlus2, Printer } from 'lucide-react'
import type { ClaimDetail } from '@pine/core'
import { Button, ButtonLink } from '@/components/ui/button'

/** Open every <details> so the printed filing contains all of the record. */
function openAllDetails() {
  document.querySelectorAll('details').forEach((d) => {
    if (!d.open) {
      d.dataset.printOpened = '1'
      d.open = true
    }
  })
}
function restoreDetails() {
  document.querySelectorAll<HTMLDetailsElement>('details[data-print-opened]').forEach((d) => {
    d.open = false
    delete d.dataset.printOpened
  })
}

export function usePrintPreparation() {
  useEffect(() => {
    window.addEventListener('beforeprint', openAllDetails)
    window.addEventListener('afterprint', restoreDetails)
    return () => {
      window.removeEventListener('beforeprint', openAllDetails)
      window.removeEventListener('afterprint', restoreDetails)
    }
  }, [])
}

export function ClaimActions({ claim }: { claim: ClaimDetail }) {
  usePrintPreparation()
  return (
    <div className="flex flex-wrap gap-2 print:hidden">
      {claim.status === 'open' ? (
        <ButtonLink href={`/claims/${claim.id}/evidence`} icon={<FilePlus2 aria-hidden />}>
          File an exhibit
        </ButtonLink>
      ) : null}
      <Button
        variant="secondary"
        icon={<Printer aria-hidden />}
        onClick={() => {
          openAllDetails()
          window.print()
        }}
      >
        <span className="sm:hidden">Print</span>
        <span className="hidden sm:inline">Print or save as PDF</span>
      </Button>
      <ButtonLink href="#agent" variant="secondary" icon={<Bot aria-hidden />}>
        Agent brief
      </ButtonLink>
    </div>
  )
}
