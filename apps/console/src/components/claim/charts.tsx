'use client'

import * as React from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { DepthSnapshot, PricePoint } from '@pine/core'

const axisTick = { fill: 'var(--muted)', fontSize: 11, fontFamily: 'var(--font-archivo)' }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function fmtTime(t: number, spanMs: number) {
  const d = new Date(t)
  if (spanMs <= 36 * 3600_000) return `${d.toISOString().slice(11, 16)}`
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}

/** Evenly spaced UTC ticks: every 6h for short ranges, every N days at midnight otherwise. */
function timeTicks(t0: number, t1: number): number[] {
  const span = t1 - t0
  if (span <= 0) return []
  const H = 3600_000
  const D = 24 * H
  const step = span <= 36 * H ? 6 * H : span <= 8 * D ? D : span <= 32 * D ? 4 * D : 14 * D
  const first = Math.ceil(t0 / step) * step
  const out: number[] = []
  for (let t = first; t <= t1; t += step) out.push(t)
  return out
}

function TooltipBox({ children }: { children: React.ReactNode }) {
  return <div className="rounded-ctl border border-line bg-raised px-2.5 py-1.5 text-xs shadow-float">{children}</div>
}

/** YES price over time. Single series, so no legend; the pane title names it. */
export function PriceChart({ points, deadline, height = 240 }: { points: PricePoint[]; deadline?: string; height?: number }) {
  const data = points.map((p) => ({ t: p.t, yes: Math.round(p.yes * 1000) / 10 }))
  const t0 = data[0]?.t ?? 0
  const t1 = data[data.length - 1]?.t ?? 0
  const span = t1 - t0
  const dl = deadline ? Date.parse(deadline) : undefined
  const last = data[data.length - 1]
  return (
    <div style={{ height }} className="w-full" role="img" aria-label={`YES price history; latest ${last ? `${last.yes}%` : 'unknown'}`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 12, right: 44, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="yesWash" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.14} />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            ticks={timeTicks(t0, t1)}
            tickFormatter={(t: number) => fmtTime(t, span)}
            tick={axisTick}
            tickLine={false}
            axisLine={{ stroke: 'var(--line-strong)' }}
            minTickGap={48}
          />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            tickFormatter={(v: number) => `${v}%`}
            tick={axisTick}
            tickLine={false}
            axisLine={false}
            width={42}
          />
          {dl && dl >= t0 && dl <= t1 ? (
            <ReferenceLine
              x={dl}
              stroke="var(--bark)"
              strokeWidth={1}
              label={{ value: 'Evidence deadline', position: 'insideTopLeft', fill: 'var(--muted)', fontSize: 11 }}
            />
          ) : null}
          <Tooltip
            cursor={{ stroke: 'var(--faint)', strokeWidth: 1 }}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as { t: number; yes: number } | undefined
              if (!active || !p) return null
              return (
                <TooltipBox>
                  <p className="tnum text-[13px] font-semibold">{p.yes.toFixed(1)}%</p>
                  <p className="flex items-center gap-1.5 text-muted">
                    <span className="h-[2px] w-3 rounded-full bg-chart-1" aria-hidden /> YES price
                  </p>
                  <p className="mono-cond mt-0.5 text-[10.5px] text-muted">{new Date(p.t).toISOString().slice(0, 16).replace('T', ' ')} UTC</p>
                </TooltipBox>
              )
            }}
          />
          <Area
            type="monotone"
            dataKey="yes"
            stroke="var(--chart-1)"
            strokeWidth={2}
            fill="url(#yesWash)"
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 4, fill: 'var(--chart-1)', stroke: 'var(--surface)', strokeWidth: 2 }}
            label={(props: { index?: number; x?: number | string; y?: number | string; value?: unknown }) =>
              props.index === data.length - 1 ? (
                <text
                  key="end"
                  x={Number(props.x) + 6}
                  y={Number(props.y) + 4}
                  fontSize={12}
                  fontWeight={600}
                  fill="var(--bark)"
                  fontFamily="var(--font-archivo)"
                >
                  {String(props.value)}%
                </text>
              ) : (
                <g key={`l${props.index}`} />
              )
            }
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Cumulative depth: bids (left of mid) and asks (right of mid). Two series, so a legend sits above. */
export function DepthChart({ depth, height = 200 }: { depth: DepthSnapshot; height?: number }) {
  const bids = depth.levels.filter((l) => l.side === 'bid').sort((a, b) => a.price - b.price)
  const asks = depth.levels.filter((l) => l.side === 'ask').sort((a, b) => a.price - b.price)
  const data = [
    ...bids.map((l) => ({ p: Math.round(l.price * 1000) / 10, bid: l.size, ask: null as number | null })),
    { p: Math.round(depth.mid * 1000) / 10, bid: 0, ask: 0 },
    ...asks.map((l) => ({ p: Math.round(l.price * 1000) / 10, bid: null as number | null, ask: l.size })),
  ]
  return (
    <div>
      <div className="mb-1 flex items-center gap-4 text-xs text-muted" aria-hidden>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[2px] bg-chart-1/70" /> Bids (sell into)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[2px] bg-chart-2/70" /> Asks (buy from)
        </span>
        <span className="ml-auto tnum">mid {(depth.mid * 100).toFixed(1)}%</span>
      </div>
      <div style={{ height }} role="img" aria-label={`Order depth around mid price ${(depth.mid * 100).toFixed(1)}%`}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis dataKey="p" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(v: number) => `${v}%`} tick={axisTick} tickLine={false} axisLine={{ stroke: 'var(--line-strong)' }} minTickGap={36} />
            <YAxis tick={axisTick} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)))} />
            <ReferenceLine x={Math.round(depth.mid * 1000) / 10} stroke="var(--faint)" />
            <Tooltip
              cursor={{ stroke: 'var(--faint)', strokeWidth: 1 }}
              content={({ active, payload }) => {
                const row = payload?.[0]?.payload as { p: number; bid: number | null; ask: number | null } | undefined
                if (!active || !row) return null
                const size = row.bid ?? row.ask ?? 0
                return (
                  <TooltipBox>
                    <p className="tnum text-[13px] font-semibold">{size.toLocaleString('en-US', { maximumFractionDigits: 1 })} tokens</p>
                    <p className="text-muted">
                      cumulative {row.bid !== null ? 'bids' : 'asks'} to {row.p}%
                    </p>
                  </TooltipBox>
                )
              }}
            />
            <Area type="stepAfter" dataKey="bid" stroke="var(--chart-1)" strokeWidth={2} fill="var(--chart-1)" fillOpacity={0.12} isAnimationActive={false} connectNulls={false} />
            <Area type="stepBefore" dataKey="ask" stroke="var(--chart-2)" strokeWidth={2} fill="var(--chart-2)" fillOpacity={0.12} isAnimationActive={false} connectNulls={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
