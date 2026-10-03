import type { Address, GitHubUser } from '@pine/core'

/**
 * The simulated wallet used in demo/mock mode. Fixtures give it outcome positions (one redeemable),
 * LP positions (one out of range) and transaction history. Checksummed.
 */
export const DEMO_WALLET_ADDRESS: Address = '0xDE30BD7C2A0B6f1e5C4b1a9F2f5d3C8E7a6b0D30'

/** The demo sign-in identity. Creator of four fixture claims, including the flagship keeper claim. */
export const DEMO_GITHUB_USER: GitHubUser = {
  login: 'mara-okafor',
  id: 48123370,
  name: 'Mara Okafor',
  avatarUrl: 'https://avatars.githubusercontent.com/u/48123370?v=4',
  htmlUrl: 'https://github.com/mara-okafor',
}
