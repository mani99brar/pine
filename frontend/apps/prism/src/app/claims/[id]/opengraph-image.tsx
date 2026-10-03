import { ImageResponse } from 'next/og'
import { formatDate, formatPrice, OUTCOME_META } from '@pine/core'
import { beamSvg, crystalSvg, svgDataUri } from '@/lib/crystal-svg'
import { crystalStateFor, cutFacetsForStatus, FAMILY_HEX } from '@/lib/crystal'
import { apiFactsOf, apiOutcomePrices, claimLabel, repoLabel } from '@/lib/claims'
import { getClaimServer } from '@/lib/server/data'
import { ogFonts } from '@/lib/server/og'

export const alt = 'A claim on Pine Prism'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

/** The claim's own crystal and its beam split (or its fractured, dimmed or clouded ending). */
export default async function ClaimOgImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const claim = await getClaimServer(id)
  const fonts = await ogFonts()
  if (!claim) {
    return new ImageResponse(
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#16110f', color: '#F5EDE4', fontSize: 56, fontFamily: 'Geologica', fontWeight: 300 }}>Claim not found</div>,
      { ...size, fonts },
    )
  }
  const resolved = (claim.status === 'resolved' || claim.status === 'settled') && claim.outcome ? claim.outcome : undefined
  const sha = claim.source.commitSha
  const state = crystalStateFor(claim.status, claim.outcome)
  const crystal = svgDataUri(
    crystalSvg({
      seed: `${claim.id}:${sha}`,
      hue: FAMILY_HEX[claim.policy.family],
      state,
      cut: cutFacetsForStatus(claim.status, (claim.publication?.steps ?? []).filter((s) => s.status === 'confirmed').map((s) => s.id)),
      facetSeeds: {
        commit: sha,
        policy: `${claim.policy.id}@${claim.policy.version}`,
        question: `${claim.id}:${sha.slice(0, 16)}`,
        environment: sha.slice(16),
        deadline: claim.evidenceDeadline,
        oracle: `${claim.id}:oracle`,
        funding: `${claim.id}:${claim.collateralSymbol}`,
        manifest: sha.split('').reverse().join(''),
        market: claim.marketAddress ?? claim.id,
      },
    }),
  )
  const outs = claim.market?.outcomes ?? []
  // Backend claims: only reported pool prices (an unknown price is never drawn as a guess).
  const api = apiFactsOf(claim)
  const known = api ? apiOutcomePrices(claim) : null
  const yesPrice = known ? known.yes : claim.yesPrice
  const yes = known ? (known.yes ?? 0) : (outs.find((o) => /^yes$/i.test(o.label))?.price ?? claim.yesPrice ?? 0)
  const no = known ? (known.no ?? 0) : (outs.find((o) => /^no$/i.test(o.label))?.price ?? Math.max(0, 1 - yes))
  const inv = known ? 0 : (outs.find((o) => /invalid/i.test(o.label))?.price ?? 0)
  const beams = claim.market || resolved ? svgDataUri(beamSvg({ yes, no, invalid: inv, outcome: resolved, width: 560, height: 300, prism: false })) : null
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', background: 'linear-gradient(135deg,#1c1512,#16110f 55%,#0e0a09)', color: '#F5EDE4', fontFamily: 'Geologica', padding: 64, position: 'relative' }}>
        <div style={{ display: 'flex', flexDirection: 'column', width: 640 }}>
          <div style={{ display: 'flex', fontSize: 24, color: '#A69789', fontWeight: 600 }}>
            <span>{claimLabel(claim)}</span>
            <span style={{ marginLeft: 22 }}>
              {claim.policy.id}@{claim.policy.version}
            </span>
            <span style={{ marginLeft: 22, color: '#CDBFB3' }}>Pine Prism</span>
          </div>
          <div style={{ display: 'flex', fontSize: 54, fontWeight: 300, lineHeight: 1.06, letterSpacing: -1.5, marginTop: 28 }}>{claim.title}</div>
          <div style={{ display: 'flex', fontSize: 24, fontFamily: 'Instrument Sans', color: '#CDBFB3', marginTop: 18 }}>
            {repoLabel(claim)} at {sha.slice(0, 7)}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 'auto' }}>
            {resolved ? (
              <div style={{ display: 'flex', fontSize: 40, fontWeight: 600, color: resolved === 'yes' ? '#FF6B83' : '#F5EDE4' }}>{OUTCOME_META[resolved].label}</div>
            ) : yesPrice !== undefined ? (
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <div style={{ display: 'flex', fontSize: 88, fontWeight: 300, color: '#FF6B83', lineHeight: 1 }}>{formatPrice(yes)}</div>
                <div style={{ display: 'flex', fontSize: 22, fontFamily: 'Instrument Sans', color: '#CDBFB3', marginLeft: 20, marginBottom: 10, width: 300 }}>market-implied chance a qualifying counterexample is accepted</div>
              </div>
            ) : (
              <div style={{ display: 'flex', fontSize: 34, fontWeight: 600 }}>{api ? 'Not priced yet' : 'No market price yet'}</div>
            )}
            <div style={{ display: 'flex', fontSize: 20, fontFamily: 'Instrument Sans', color: '#A69789', marginTop: 16 }}>Evidence deadline {formatDate(claim.evidenceDeadline, 'utc')}</div>
          </div>
        </div>
        {beams && (
          <div style={{ position: 'absolute', right: 0, top: 170, display: 'flex' }}>
            <img src={beams} width={560} height={300} alt="" />
          </div>
        )}
        <div style={{ position: 'absolute', right: 184, top: 126, display: 'flex' }}>
          <img src={crystal} width={260} height={386} alt="" />
        </div>
      </div>
    ),
    { ...size, fonts },
  )
}
