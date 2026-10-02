import type { ClaimDraft, ClaimSpec } from '@pine/core'
import { getPolicy } from '@pine/core'

/**
 * The worked example from docs/keeper-bot-market-example.md, as a starting draft.
 * The commit is chosen in the Source step (prefilled with the keeper's pull request).
 */
export const WORKED_EXAMPLE_REF = 'kleros/gateway-balancer-bot#47'

export function workedExampleDraft(): Partial<ClaimDraft> {
  const policy = getPolicy('BOT-001')
  const parameters: ClaimSpec['parameters'] = {}
  for (const p of policy?.parameters ?? []) {
    if (p.example !== undefined) parameters[p.key] = p.example
  }
  const spec: Partial<ClaimSpec> = {
    title: 'Reporter deposits never draw on arbitration or gas reserves',
    policyId: 'BOT-001',
    claimClass: 'fund-separation',
    requirement:
      'For the frozen configuration and allowed states, each reporter-funding deposit’s principal must be allocated only from eligible bridging/reporter funds in the specified accounting scope. It must not consume a pair’s arbitration allocation or the operator’s transaction-gas reserve. Paying the reporter transaction’s legitimate gas fee from the operator reserve is permitted.',
    violation: 'reporter-deposit principal can consume arbitration funds or the operator transaction-gas reserve',
    scope: {
      inScope: ['src/funding/reporter-planner.ts', 'src/accounting/reservations.ts', 'src/accounting/gas-reserve.ts', 'src/accounting/ledger.ts'],
      outOfScope: ['Live LI.FI routing and bridge execution', 'Deployment and key management'],
    },
    faultModel: 'Process crash and restart, timeouts and replacement transactions, within the journal’s documented recovery model. Arbitrary database corruption is not allowed.',
    assumptions: ['Funds sharing the same EOA is not itself a violation', 'Price feeds return fresh observations unless stated otherwise'],
    exclusions: ['Paying the reporter-funding transaction’s own gas fee from the operator reserve'],
    parameters,
    environment: {
      runtime: 'node 22.14.0',
      packageManager: 'pnpm 10.9.2',
      config: { RESERVE_FLOOR_XDAI: '25', REPORTER_THRESHOLD_XDAI: '5', SIMULATE_LIFI: 'true' },
      reproductionCommand: 'pnpm vitest run test/reporter-funding.spec.ts test/accounting-separation.spec.ts',
      setupSteps: ['pnpm install --frozen-lockfile', 'cp config/example.toml config/local.toml'],
      externalState: 'none',
      configHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      envHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    },
    specReference: {
      label: 'Gateway balancer bot spec, sections 2.2, 4.2 and 12',
      url: 'https://github.com/kleros/kleros-v2/blob/dev/docs/gateway-balancer-bot-spec.md',
    },
  }
  return { spec, funding: { liquidity: '25', spendingLimit: '50', initialYesPrice: 0.12, priceRange: [0.02, 0.8], chainId: 100 } }
}
