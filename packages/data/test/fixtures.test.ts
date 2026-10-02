import { buildQuestion, canonicalJson, deriveStatus, getPolicy, hashJson, type ClaimStatus } from '@pine/core'
import { describe, expect, it } from 'vitest'
import { DEMO_GITHUB_USER, DEMO_WALLET_ADDRESS } from '../src'
import { buildFixtures, fixtures, getFixtures } from '../src/mock/fixtures'

const ANCHOR_MS = fixtures.anchor

const ALL_STATUSES: ClaimStatus[] = ['draft', 'publishing', 'open', 'awaiting_answer', 'answer_proposed', 'disputed', 'arbitration', 'resolved', 'settled', 'failed']
const BANNED = /\b(safe|secure|certified|audited|verified correct|bounty|reward|refund(?!ed))\b/i

describe('fixtures', () => {
  it('has ≥14 claims covering every published status, plus a local draft', () => {
    expect(fixtures.claims.length).toBeGreaterThanOrEqual(14)
    const present = new Set(fixtures.claims.map((c) => c.status))
    for (const s of ALL_STATUSES.filter((x) => x !== 'draft')) expect(present, s).toContain(s)
    // drafts are local records, not published claims
    expect(fixtures.drafts.some((d) => d.owner === DEMO_GITHUB_USER.login)).toBe(true)
  })

  it('covers every outcome and a sponsored claim', () => {
    const resolved = fixtures.claims.filter((c) => c.status === 'resolved' || c.status === 'settled')
    expect(new Set(resolved.map((c) => c.outcome))).toEqual(new Set(['yes', 'no', 'invalid']))
    expect(fixtures.claims.some((c) => c.sponsored)).toBe(true)
    for (const c of fixtures.claims) {
      if (c.status === 'resolved' || c.status === 'settled') expect(c.outcome, c.id).toBeDefined()
      else expect(c.outcome, c.id).toBeUndefined()
    }
  })

  it('open claims vary in policy, price, liquidity and deadline', () => {
    const open = fixtures.claims.filter((c) => c.status === 'open')
    expect(open.length).toBeGreaterThanOrEqual(5)
    expect(new Set(open.map((c) => c.policy.id))).toEqual(new Set(['FUNC-001', 'BOT-001']))
    const prices = open.map((c) => c.yesPrice ?? 0)
    expect(Math.min(...prices)).toBeLessThanOrEqual(0.04)
    expect(Math.max(...prices)).toBeGreaterThanOrEqual(0.62)
    const liq = open.map((c) => Number(c.liquidity))
    expect(Math.min(...liq)).toBeLessThanOrEqual(5)
    expect(Math.max(...liq)).toBeGreaterThanOrEqual(2400)
    const hoursLeft = open.map((c) => (Date.parse(c.evidenceDeadline) - ANCHOR_MS) / 3_600_000)
    expect(Math.min(...hoursLeft)).toBeLessThanOrEqual(9)
    expect(Math.max(...hoursLeft)).toBeGreaterThanOrEqual(12 * 24)
    expect(hoursLeft.every((h) => h > 0)).toBe(true)
  })

  it('never uses SC-001 for live claims', () => {
    expect(fixtures.claims.some((c) => c.policy.id === 'SC-001')).toBe(false)
  })

  it('every manifest hash equals hashJson(manifest) and the question matches buildQuestion', () => {
    for (const c of fixtures.claims) {
      expect(hashJson(c.manifest), c.id).toBe(c.manifestHash)
      // survives a JSON round-trip (what IPFS / REST would deliver)
      expect(hashJson(JSON.parse(JSON.stringify(c.manifest))), c.id).toBe(c.manifestHash)
      expect(c.manifestUri).toMatch(/^ipfs:\/\/bafkrei[a-z2-7]{52}$/)
      const policy = getPolicy(c.manifest.policy.id, c.manifest.policy.version)
      expect(policy, c.id).toBeDefined()
      const q = buildQuestion({ spec: c.manifest.claim, source: c.manifest.source, policy: policy! })
      expect(c.manifest.question).toEqual(q)
      expect(c.manifest.question.text).toContain(c.source.commitSha)
      expect(c.manifest.claim.evidence.deadline).toBe(c.evidenceDeadline)
      expect(c.manifest.claim.oracle.timeoutSeconds).toBe(302_400)
      expect(Date.parse(c.manifest.claim.oracle.openingTime)).toBeGreaterThanOrEqual(Date.parse(c.evidenceDeadline))
      expect(canonicalJson(c.manifest)).not.toContain('undefined')
    }
  })

  it('source refs match the mock GitHub PRs and commits', () => {
    for (const c of fixtures.claims) {
      const key = `${c.source.owner}/${c.source.repo}`
      const pr = fixtures.pulls[key]?.find((p) => p.number === c.source.prNumber)
      expect(pr, c.id).toBeDefined()
      expect(pr?.headSha).toBe(c.source.commitSha)
      expect(fixtures.commitsBySha[c.source.commitSha]?.repo).toBe(key)
      expect(c.source.commitSha).toMatch(/^[0-9a-f]{40}$/)
      // the head commit predates the claim
      expect(Date.parse(fixtures.commitsBySha[c.source.commitSha]!.author.date)).toBeLessThanOrEqual(Date.parse(c.createdAt))
    }
  })

  it('markets: Gnosis sDAI, prices sum ≈ 1, Seer URLs', () => {
    for (const c of fixtures.claims) {
      if (!c.market) {
        expect(c.status).toBe('failed')
        continue
      }
      expect(c.market.chainId).toBe(100)
      expect(c.market.collateral.symbol).toBe('sDAI')
      expect(c.market.collateral.decimals).toBe(18)
      expect(c.market.outcomes.map((o) => o.label)).toEqual(['Yes', 'No', 'Invalid result'])
      expect(c.market.seerUrl).toBe(`https://app.seer.pm/markets/100/${c.market.address}`)
      if (Number(c.liquidity) > 0) {
        const sum = c.market.outcomes.reduce((a, o) => a + o.price, 0)
        expect(sum, c.id).toBeGreaterThan(0.97)
        expect(sum, c.id).toBeLessThan(1.03)
      }
      expect(c.oracle?.realityUrl).toContain('reality.eth.limo')
    }
  })

  it('disputed and arbitration claims have doubling bonds; arbitration is in ETH on Ethereum', () => {
    for (const c of fixtures.claims.filter((x) => x.status === 'disputed' || x.status === 'arbitration')) {
      const bonds = c.oracle!.history.map((h) => Number(h.bond))
      expect(bonds.length).toBeGreaterThan(1)
      for (let i = 1; i < bonds.length; i++) expect(bonds[i]).toBe(bonds[i - 1]! * 2)
    }
    const arb = fixtures.claims.find((c) => c.status === 'arbitration')!
    expect(arb.oracle?.arbitration).toMatchObject({ requested: true, status: 'appeal_period', cost: '0.1674' })
    expect(arb.oracle?.arbitration.klerosUrl).toMatch(/^https:\/\/resolve\.kleros\.io\/cases\/\d+\?requiredChainId=1$/)
    expect(arb.oracle?.arbitration.court).toMatch(/General Court/)
  })

  it('publishing and failed claims carry recoverable / irrecoverable publication steps', () => {
    const pub = fixtures.claims.find((c) => c.status === 'publishing')!
    expect(pub.publication?.resumable).toBe(true)
    expect(pub.publication?.steps.find((s) => s.id === 'create_market')?.status).toBe('confirmed')
    expect(pub.publication?.steps.find((s) => s.id === 'approve_collateral')?.status).toBe('confirmed')
    expect(pub.publication?.steps.find((s) => s.id === 'split_position')).toMatchObject({ status: 'failed', error: 'User rejected the request.' })
    expect(pub.yesPrice).toBeUndefined()
    expect(pub.creator).toBe(DEMO_WALLET_ADDRESS)

    const failed = fixtures.claims.find((c) => c.status === 'failed')!
    expect(failed.publication?.resumable).toBe(false)
    expect(failed.publication?.steps.find((s) => s.id === 'upload_manifest')?.status).toBe('confirmed')
    expect(failed.publication?.steps.find((s) => s.id === 'create_market')?.status).toBe('failed')
    expect(failed.market).toBeUndefined()
    expect(failed.creator).toBe(DEMO_WALLET_ADDRESS)
  })

  it('the flagship is the open BOT-001 gateway-balancer keeper claim by the demo user', () => {
    const f = fixtures.claims.find((c) => c.source.repo === 'gateway-balancer-bot' && c.status === 'open')!
    expect(f.policy.id).toBe('BOT-001')
    expect(f.creator).toBe(DEMO_WALLET_ADDRESS)
    expect(f.creatorGithub).toBe('mara-okafor')
    expect(f.manifest.claim.environment.runtime).toBe('node 22.14.0')
    expect(f.manifest.claim.environment.config.CHAIN_PAIR).toBe('gnosis↔arbitrum')
    expect(f.manifest.claim.exclusions.join(' ')).toMatch(/gas fee/)
    expect(f.evidence.map((e) => e.kind).sort()).toEqual(['clarification', 'commitment'])
    expect(f.evidence.find((e) => e.kind === 'commitment')?.commitment?.revealed).toBe(false)
    expect(fixtures.claims.filter((c) => c.creator === DEMO_WALLET_ADDRESS).length).toBeGreaterThanOrEqual(4)
  })

  it('includes a hostile evidence item and a late one', () => {
    const all = fixtures.claims.flatMap((c) => c.evidence)
    const hostile = all.find((e) => e.title.includes('<script>alert(1)</script>'))
    expect(hostile).toBeDefined()
    expect(hostile!.summary).toMatch(/\[[^\]]+\]\(javascript:alert\(1\)\)/)
    expect(hostile!.summary.split(/\s+/).some((w) => w.length >= 10_000)).toBe(true)
    expect(hostile!.attachments.some((a) => a.name.length > 200)).toBe(true)
    expect(all.some((e) => !e.timely)).toBe(true)
    expect(all.some((e) => e.kind === 'commitment')).toBe(true)
    for (const e of all) expect(e.chainId).toBe(1)
  })

  it('timelines are sorted, with future events marked as scheduled', () => {
    for (const c of fixtures.claims) {
      const times = c.timeline.map((t) => Date.parse(t.at))
      expect([...times].sort((a, b) => a - b)).toEqual(times)
      for (const t of c.timeline) {
        if (Date.parse(t.at) > ANCHOR_MS && t.kind !== 'drafted') expect(t.scheduled, `${c.id} ${t.kind}`).toBe(true)
      }
    }
  })

  it('dates are relative to the anchor hour', () => {
    expect(ANCHOR_MS % 3_600_000).toBe(0)
    expect(Math.abs(Date.now() - ANCHOR_MS)).toBeLessThan(2 * 3_600_000)
  })

  it('rebuilds per hour: same hour → same build, later hour → shifted dates, same statuses', () => {
    const now = Date.now()
    expect(getFixtures(now)).toBe(getFixtures(now))
    const later = buildFixtures(now + 37 * 3_600_000)
    expect(later.anchor - fixtures.anchor).toBe(37 * 3_600_000)
    const a = fixtures.claims.find((c) => c.number === 10)!
    const b = later.claims.find((c) => c.number === 10)!
    expect(Date.parse(b.evidenceDeadline) - Date.parse(a.evidenceDeadline)).toBe(37 * 3_600_000)
    expect(b.status).toBe('open')
    expect(hashJson(b.manifest)).toBe(b.manifestHash)
  })

  it.each([0, 9.5, 47, 80, 500])('fixture statuses agree with core deriveStatus %s hours from now (no staleness)', (h) => {
    const at = Date.now() + h * 3_600_000
    const fx = getFixtures(at)
    for (const c of fx.claims) {
      if (c.status === 'publishing' || c.status === 'failed') continue
      const derived = deriveStatus({ market: c.market, oracle: c.oracle, evidenceDeadline: c.evidenceDeadline, settled: c.status === 'settled', now: new Date(at) })
      expect(derived.status, `${c.id} at +${h}h`).toBe(c.status)
      expect(derived.outcome, `${c.id} at +${h}h`).toBe(c.outcome)
    }
    for (const c of fx.claims.filter((x) => x.status === 'open')) expect(Date.parse(c.evidenceDeadline)).toBeGreaterThan(at)
  })

  it('price history is deterministic, hourly and ends at the current price', () => {
    for (const c of fixtures.claims.filter((x) => x.status === 'open')) {
      const pts = fixtures.prices[c.id]!
      expect(pts.length).toBeGreaterThan(24)
      for (let i = 1; i < pts.length; i++) expect(pts[i]!.t - pts[i - 1]!.t).toBe(3_600_000)
      expect(pts.at(-1)!.yes).toBe(c.yesPrice)
      for (const p of pts) {
        expect(p.yes).toBeGreaterThan(0)
        expect(p.yes + p.no).toBeLessThanOrEqual(1.0001)
      }
    }
  })

  it('has ≥60 activity items across claims, actors and types', () => {
    expect(fixtures.activity.length).toBeGreaterThanOrEqual(60)
    const types = new Set(fixtures.activity.map((a) => a.type))
    for (const t of ['market_created', 'approval', 'split', 'liquidity_added', 'trade', 'evidence_submitted', 'answer_posted', 'arbitration_requested', 'ruling', 'finalized', 'redeemed'] as const) {
      expect(types, t).toContain(t)
    }
    expect(new Set(fixtures.activity.map((a) => a.actor)).size).toBeGreaterThan(8)
    expect(fixtures.activity.some((a) => a.side === 'buy') && fixtures.activity.some((a) => a.side === 'sell')).toBe(true)
  })

  it('demo portfolio: one redeemable position on the resolved-yes claim, one LP out of range', () => {
    const p = fixtures.portfolios[DEMO_WALLET_ADDRESS.toLowerCase()]!
    const redeemable = p.positions.filter((x) => x.redeemable)
    expect(redeemable).toHaveLength(1)
    const claim = fixtures.claims.find((c) => c.id === redeemable[0]!.claimId)!
    expect(claim.outcome).toBe('yes')
    expect(p.liquidity.some((l) => !l.inRange)).toBe(true)
    expect(Number(p.totals.redeemable)).toBe(Number(redeemable[0]!.redeemableAmount))
  })

  it('mock GitHub: ≥8 public repos, one private flagged, agent-authored PRs, commits with files', () => {
    expect(fixtures.repos.filter((r) => !r.private).length).toBeGreaterThanOrEqual(8)
    expect(fixtures.repos.filter((r) => r.private)).toHaveLength(1)
    const authors = Object.values(fixtures.pulls).flat().map((p) => p.author.login)
    for (const bot of ['devin-ai-integration[bot]', 'copilot-swe-agent[bot]', 'claude[bot]']) expect(authors).toContain(bot)
    for (const list of Object.values(fixtures.pullCommits)) for (const c of list) expect(c.files?.length).toBeGreaterThan(0)
  })

  it('fixture copy follows the language rules (except the intentionally hostile item and quoted policy text)', () => {
    for (const c of fixtures.claims) {
      const texts = [c.title, c.violation, c.manifest.claim.requirement, ...c.timeline.map((t) => `${t.title} ${t.detail ?? ''}`), c.publication?.note ?? '']
      // explicit negations ("not a refund", "not a bounty") are the mandated disclosures, so they are allowed
      for (const t of texts) expect(t.replace(/\bnot an? (refund|bounty|reward)\b/gi, ''), `${c.id}: ${t}`).not.toMatch(BANNED)
    }
  })
})
