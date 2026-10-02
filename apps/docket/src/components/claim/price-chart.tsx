'use client'

import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from 'recharts'
import type { PricePoint } from '@pine/core'
import { formatPrice } from '@pine/core'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function tickLabel(t: number, spanMs: number) {
  const d = new Date(t)
  const hh = `${String(d.getUTCHours()).padStart(2, '0')}:00`
  if (spanMs <= 36 * 3600_000) return hh
  if (spanMs <= 5 * 24 * 3600_000) return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${hh}`
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}
function fullLabel(t: number) {
  const d = new Date(t)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`
}

/** Single-series chart of the Yes price as a market-implied chance. */
export function PriceChart({ points, deadline }: { points: PricePoint[]; deadline?: string }) {
  const span = points.length > 1 ? points[points.length - 1]!.t - points[0]!.t : 0
  const deadlineMs = deadline ? new Date(deadline).getTime() : undefined
  const showDeadline = deadlineMs !== undefined && points.length > 1 && deadlineMs >= points[0]!.t && deadlineMs <= points[points.length - 1]!.t
  const data = useMemo(() => points.map((p) => ({ t: p.t, yes: p.yes })), [points])
  const last = points[points.length - 1]

  return (
    <figure>
      <div className="h-56 w-full sm:h-64" role="img" aria-label={`Yes price over time. Latest ${last ? formatPrice(last.yes) : 'unknown'}.`}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 12, right: 52, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="yesWash" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#4433a6" stopOpacity={0.14} />
                <stop offset="100%" stopColor="#4433a6" stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#e3e6ec" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(t: number) => tickLabel(t, span)}
              tick={{ fill: '#4b5263', fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: '#cdd2dc' }}
              minTickGap={56}
            />
            <YAxis
              domain={[0, 1]}
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
              tick={{ fill: '#4b5263', fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              width={44}
              orientation="right"
            />
            {showDeadline ? (
              <ReferenceLine
                x={deadlineMs}
                stroke="#7a4b00"
                strokeDasharray="4 3"
                label={{ value: 'Evidence deadline', position: 'insideTopLeft', fill: '#7a4b00', fontSize: 12 }}
              />
            ) : null}
            <Tooltip
              cursor={{ stroke: '#1a1d2b', strokeWidth: 1 }}
              content={({ active, payload }) => {
                const p = payload?.[0]?.payload as { t: number; yes: number } | undefined
                if (!active || !p) return null
                return (
                  <div className="border border-rule bg-sheet px-3 py-2 text-sm shadow-[0_4px_14px_rgba(26,29,43,0.14)]">
                    <p className="text-graphite">{fullLabel(p.t)}</p>
                    <p className="mt-0.5 flex items-center gap-2 font-bold">
                      <span aria-hidden className="inline-block h-0.5 w-3 bg-violet" />
                      Yes {formatPrice(p.yes)}
                    </p>
                  </div>
                )
              }}
            />
            <Area
              type="monotone"
              dataKey="yes"
              stroke="#4433a6"
              strokeWidth={2}
              fill="url(#yesWash)"
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 5, stroke: '#fff', strokeWidth: 2, fill: '#4433a6' }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-2 print:hidden">
        <summary className="text-sm font-bold text-violet underline underline-offset-4">Show the data as a table</summary>
        <div className="mt-2 max-h-56 overflow-y-auto border border-rule">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-bond text-graphite">
              <tr>
                <th scope="col" className="px-3 py-1.5">Time (UTC)</th>
                <th scope="col" className="px-3 py-1.5 text-right">Yes price</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule tabular">
              {points
                .filter((_, i) => i % Math.max(1, Math.ceil(points.length / 40)) === 0 || i === points.length - 1)
                .map((p) => (
                  <tr key={p.t}>
                    <td className="px-3 py-1">{fullLabel(p.t)}</td>
                    <td className="px-3 py-1 text-right">{formatPrice(p.yes)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  )
}
