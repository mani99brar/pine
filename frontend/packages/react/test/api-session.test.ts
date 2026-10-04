import { describe, expect, it } from 'vitest'
import { createSiweMessage } from 'viem/siwe'
import { checkGitHubAuthorizationUrl, checkSiweChallenge, githubConsentUrl, SiweChallengeError } from '../src/api/session'

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
    expect(() => checkSiweChallenge(message({ expirationTime: NOW }), expected)).toThrow(/expiry/)
    expect(() => checkSiweChallenge(message({ expirationTime: new Date(NOW.getTime() + 15 * 60_000 + 1_000) }), expected)).toThrow(/expiry/)
    expect(() => checkSiweChallenge(message({ expirationTime: new Date(NOW.getTime() + 24 * 3600_000) }), expected)).toThrow(/expiry/)
    expect(() => checkSiweChallenge(message({ resources: ['https://evil.example/grant'] }), expected)).toThrow(/resources/)
  })

  it('accepts a device clock minutes off: the validity window comes from the message itself', () => {
    for (const offsetMin of [-30, -6, 6, 11, 30]) {
      expect(checkSiweChallenge(message(), { ...expected, now: new Date(NOW.getTime() + offsetMin * 60_000) })).toEqual({ termsDigest: TERMS })
    }
  })

  it('SEC-AUTH-04 refuses a message stale or from the future by more than an hour on this device’s clock', () => {
    // Expired more than an hour ago here (issued 10 min before its expiry).
    expect(() => checkSiweChallenge(message(), { ...expected, now: new Date(NOW.getTime() + 71 * 60_000) })).toThrow(/expired more than an hour ago/)
    // Issued more than an hour ahead of this clock.
    expect(() => checkSiweChallenge(message(), { ...expected, now: new Date(NOW.getTime() - 61 * 60_000) })).toThrow(/more than an hour ahead/)
  })

  it('refuses malformed text', () => {
    expect(() => checkSiweChallenge('not a siwe message', expected)).toThrow(SiweChallengeError)
  })

  it('SEC-AUTH-01 refuses a message with lines appended after the last field', () => {
    expect(() => checkSiweChallenge(`${message()}\nResources:\n- https://evil.example/grant`, expected)).toThrow(/extra resources/)
    expect(() => checkSiweChallenge(`${message()}\nI also approve every transfer.`, expected)).toThrow(/not exactly Pine’s sign-in message/)
    expect(() => checkSiweChallenge(`${message()}\n`, expected)).toThrow(/not exactly Pine’s sign-in message/)
  })

  it('SEC-AUTH-01 refuses a message with lines injected before the URI', () => {
    const injected = message().replace('\nURI: ', '\nI transfer my claim market to the bearer.\nURI: ')
    expect(() => checkSiweChallenge(injected, expected)).toThrow(/not exactly Pine’s sign-in message/)
  })

  it('SEC-AUTH-04 refuses an expiration or issue time that is not a real instant', () => {
    const iso = new Date(NOW.getTime() + 10 * 60_000).toISOString()
    // viem parses a date-only value to an Invalid Date, which every comparison lets through.
    expect(() => checkSiweChallenge(message().replace(`Expiration Time: ${iso}`, 'Expiration Time: 2999-01-01'), expected)).toThrow(/invalid expiry/)
    expect(() => checkSiweChallenge(message().replace(`Issued At: ${NOW.toISOString()}`, 'Issued At: yesterday'), expected)).toThrow(/invalid issue time/)
    expect(() => checkSiweChallenge(message({ expirationTime: undefined }), expected)).toThrow(/invalid expiry/)
  })

  it('refuses a message whose fields are not in canonical form', () => {
    // Same instant, written without milliseconds: not the text createSiweMessage (the backend) produces.
    const iso = new Date(NOW.getTime() + 10 * 60_000).toISOString()
    expect(() => checkSiweChallenge(message().replace(`Expiration Time: ${iso}`, `Expiration Time: ${iso.replace('.000Z', 'Z')}`), expected)).toThrow(/not exactly Pine’s sign-in message/)
    // A lowercase address is the same wallet but not the canonical (EIP-55) text.
    expect(() => checkSiweChallenge(message().replace(ADDRESS, ADDRESS.toLowerCase()), expected)).toThrow(/not exactly Pine’s sign-in message/)
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

describe('githubConsentUrl (local dev stack only)', () => {
  const checked = 'https://github.com/login/oauth/authorize?client_id=x&state=y&code_challenge=z&code_challenge_method=S256'

  it('keeps github.com when no dev origin is configured (every production build)', () => {
    expect(githubConsentUrl(checked, undefined)).toBe(checked)
    expect(githubConsentUrl(checked, '')).toBe(checked)
  })

  it('opens the dev stack consent page on a loopback dev origin, same path and query', () => {
    expect(githubConsentUrl(checked, 'http://127.0.0.1:3999')).toBe('http://127.0.0.1:3999/login/oauth/authorize?client_id=x&state=y&code_challenge=z&code_challenge_method=S256')
  })

  it('ignores a dev origin that is not loopback, so a misconfigured build can never redirect elsewhere', () => {
    expect(githubConsentUrl(checked, 'https://evil.example')).toBe(checked)
    expect(githubConsentUrl(checked, 'http://192.168.1.15:3999')).toBe(checked)
    expect(githubConsentUrl(checked, 'javascript:alert(1)')).toBe(checked)
    expect(githubConsentUrl(checked, 'http://127.0.0.1:3999/path')).toBe(checked)
  })
})
