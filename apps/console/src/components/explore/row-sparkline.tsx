'use client'

import { usePriceHistory } from '@pine/react'
import { Sparkline } from '@/components/ui/instruments'

/** 7-day YES price sparkline for a table row. Reserves its box while loading (no layout shift). */
export function RowSparkline({ id, width = 72, height = 16 }: { id: string; width?: number; height?: number }) {
  const h = usePriceHistory(id, '7d')
  const values = (h.data ?? []).map((p) => p.yes)
  if (values.length < 2) return <span aria-hidden className="block" style={{ width, height }} />
  return <Sparkline values={values} width={width} height={height} label="YES price, last 7 days" />
}
