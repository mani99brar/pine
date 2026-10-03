'use client'

import type { ClaimDetail, ClaimSummary } from '@pine/core'
import { CrystalGlyph } from './CrystalGlyph'
import { crystalStateFor, cutFacetsForStatus, FAMILY_HEX } from '@/lib/crystal'
import { crystalSeed, statusLabel } from '@/lib/claims'

function isDetail(c: ClaimSummary | ClaimDetail): c is ClaimDetail {
  return 'manifest' in c
}

/** A claim's own crystal: silhouette from its id and commit, facets shaded by its hashes. */
export function ClaimCrystal({
  claim,
  size = 120,
  glow = true,
  pulse,
  animateFracture,
  className,
  decorative,
}: {
  claim: ClaimSummary | ClaimDetail
  size?: number
  glow?: boolean
  pulse?: number
  animateFracture?: boolean
  className?: string
  decorative?: boolean
}) {
  const detail = isDetail(claim) ? claim : undefined
  const confirmed = (detail?.publication?.steps ?? []).filter((s) => s.status === 'confirmed').map((s) => s.id)
  // Shading uses fields every view has (summary and detail), so a claim's crystal looks the same on the
  // light table, its page and its OG card. The commit SHA is the dominant seed.
  const sha = claim.source.commitSha
  const facetSeeds = {
    commit: sha,
    policy: `${claim.policy.id}@${claim.policy.version}`,
    question: `${claim.id}:${sha.slice(0, 16)}`,
    environment: sha.slice(16),
    deadline: claim.evidenceDeadline,
    oracle: `${claim.id}:oracle`,
    funding: `${claim.id}:${claim.collateralSymbol}`,
    manifest: sha.split('').reverse().join(''),
    market: claim.marketAddress ?? claim.id,
  }
  return (
    <CrystalGlyph
      seed={crystalSeed(claim)}
      facetSeeds={facetSeeds}
      hue={FAMILY_HEX[claim.policy.family]}
      state={crystalStateFor(claim.status, claim.outcome)}
      cut={cutFacetsForStatus(claim.status, confirmed)}
      size={size}
      glow={glow}
      pulse={pulse}
      animateFracture={animateFracture}
      className={className}
      decorative={decorative}
      label={`Crystal for ${claim.title}: ${statusLabel(claim.status, claim.outcome)}`}
    />
  )
}
