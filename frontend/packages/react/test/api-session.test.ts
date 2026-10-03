import { describe, expect, it } from 'vitest'
import { createSiweMessage } from 'viem/siwe'
import { checkGitHubAuthorizationUrl, checkSiweChallenge, SiweChallengeError } from '../src/api/session'

const ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const
const ORIGIN = 'https://app.pine.example'
const NOW = new Date('2026-10-04T12:00:00Z')
const TERMS = `0x${'ab'.repeat(32)}`

function message(over: Partial<Parameters<typeof createSiweMessage>[0]> = {}): string {
  return createSiweMessage({
    domain: 'app.pine.example',
    address: ADDRESS,
    statement: `Sign in to Pine. I accept the terms with sha256 ${TERMS}.`,
    uri: ORIGIN,
    version: '1',
    chainId: 100,
    nonce: '0123456789abcdef0123456789abcdef',
    issuedAt: NOW,
    expirationTime: new Date(NOW.getTime() + 10 * 60_000),
    ...over,
  })
}

const expected = { address: ADDRESS, origin: ORIGIN, chainId: 100, now: NOW }

describe('checkSiweChallenge', () => {
  it('accepts the backend message and returns the accepted terms digest', () => {
    expect(checkSiweChallenge(message(), expected)).toEqual({ termsDigest: TERMS })
  })

  it('SEC-AUTH-04 refuses to sign a message for another domain or URI', () => {
    expect(() => checkSiweChallenge(message({ domain: 'evil.example' }), expected)).toThrow(SiweChallengeError)
    expect(() => checkSiweChallenge(message({ uri: 'https://evil.example' }), expected)).toThrow(SiweChallengeError)
  })

  it('SEC-AUTH-04 refuses a message for another chain', () => {
    expect(() => checkSiweChallenge(message({ chainId: 1 }), expected)).toThrow(/another chain/)
  })

  it('refuses a message for another wallet', () => {
    expect(() => checkSiweChallenge(message({ address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' }), expected)).toThrow(/another wallet/)
  })

  it('refuses a message without Pine’s terms statement', () => {
    expect(() => checkSiweChallenge(message({ statement: 'Transfer everything' }), expected)).toThrow(/terms statement/)
  })

  it('refuses expired or long-lived messages and extra resources', () => {
    expect(() => checkSiweChallenge(message({ expirationTime: new Date(NOW.getTime() - 1) }), expected)).toThrow(/expiry/)
    expect(() => checkSiweChallenge(message({ expirationTime: new Date(NOW.getTime() + 24 * 3600_000) }), expected)).toThrow(/expiry/)
    expect(() => checkSiweChallenge(message({ resources: ['https://evil.example/grant'] }), expected)).toThrow(/resources/)
  })

  it('refuses malformed text', () => {
    expect(() => checkSiweChallenge('not a siwe message', expected)).toThrow(SiweChallengeError)
  })
})

describe('checkGitHubAuthorizationUrl', () => {
  it('follows only github.com/login/oauth/authorize over https', () => {
    const ok = 'https://github.com/login/oauth/authorize?client_id=x&state=y&code_challenge=z&code_challenge_method=S256'
    expect(checkGitHubAuthorizationUrl(ok)).toBe(ok)
  })

  it('refuses an authorization link to any other host or path (SEC-AUTH-18: the link is the backend-issued github.com authorization)', () => {
    expect(() => checkGitHubAuthorizationUrl('https://github.com.evil.example/login/oauth/authorize')).toThrow()
    expect(() => checkGitHubAuthorizationUrl('http://github.com/login/oauth/authorize')).toThrow()
    expect(() => checkGitHubAuthorizationUrl('https://github.com/settings/applications')).toThrow()
    expect(() => checkGitHubAuthorizationUrl('javascript:alert(1)')).toThrow()
  })
})
