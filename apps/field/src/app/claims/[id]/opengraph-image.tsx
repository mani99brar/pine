import { ImageResponse } from 'next/og'
import { formatClaimNumber, formatDate, formatPrice, OUTCOME_META } from '@pine/core'
import { getClaimServer } from '@/lib/server/data'

export const alt = 'A claim on Pine Field'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

/** Bar length between the anchors: 1200 − 2×64 padding − 2×6 anchors − 2×6 gaps */
const BAR = 1048

/** Claim card: number, title, policy and the tension bar at the current price (or the outcome). */
export default async function ClaimOgImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const claim = await getClaimServer(id)
  const yes = claim?.yesPrice
  const resolved = claim && (claim.status === 'resolved' || claim.status === 'settled') ? claim.outcome : undefined
  const p = Math.min(0.97, Math.max(0.03, yes ?? 0.5))
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#ECEEF2', padding: 64, color: '#161A33' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 26, fontWeight: 700 }}>
          <span>{claim ? `${formatClaimNumber(claim.number)}  ${claim.policy.id}@${claim.policy.version}` : 'Pine Field'}</span>
          <span style={{ color: '#474D6B', fontWeight: 600 }}>Pine Field</span>
        </div>
        <div style={{ display: 'flex', fontSize: 56, fontWeight: 800, lineHeight: 1.08, marginTop: 40, maxWidth: 1040 }}>{claim?.title ?? 'Claim not found'}</div>
        {claim && (
          <div style={{ display: 'flex', fontSize: 26, color: '#474D6B', marginTop: 18 }}>
            {claim.source.owner}/{claim.source.repo} @{claim.source.commitSha.slice(0, 7)}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'flex-end', marginTop: 'auto', gap: 24 }}>
          {resolved ? (
            <span style={{ fontSize: 44, fontWeight: 800 }}>{OUTCOME_META[resolved].label}</span>
          ) : yes !== undefined ? (
            <>
              <span style={{ fontSize: 88, fontWeight: 800, color: '#B93A0A', lineHeight: 1 }}>{formatPrice(yes)}</span>
              <span style={{ fontSize: 24, color: '#474D6B', maxWidth: 420, marginBottom: 8 }}>market-implied chance a qualifying counterexample is accepted</span>
            </>
          ) : (
            <span style={{ fontSize: 36, fontWeight: 700 }}>No market yet</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', marginTop: 24, width: '100%' }}>
          <div style={{ width: 6, height: 56, background: '#161A33' }} />
          {resolved ? (
            <div style={{ width: BAR, height: 34, marginLeft: 6, marginRight: 6, background: resolved === 'yes' ? '#FF5A1F' : resolved === 'no' ? '#2B44FF' : '#737891' }} />
          ) : (
            <>
              <div style={{ width: Math.round(BAR * p) - 5, height: 34, background: '#FF5A1F', marginLeft: 6 }} />
              <div style={{ width: 10, height: 62, background: '#161A33' }} />
              <div style={{ width: Math.round(BAR * (1 - p)) - 5, height: 34, background: '#2B44FF', marginRight: 6 }} />
            </>
          )}
          <div style={{ width: 6, height: 56, background: '#161A33' }} />
        </div>
        {claim && (
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16, fontSize: 22, color: '#474D6B' }}>
            <span>Evidence deadline {formatDate(claim.evidenceDeadline, 'long')}</span>
            <span>
              {claim.liquidity} {claim.collateralSymbol} liquidity
            </span>
          </div>
        )}
      </div>
    ),
    size,
  )
}
