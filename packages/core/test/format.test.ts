import { describe, expect, it } from 'vitest'
import {
  explorerAddressUrl,
  explorerTxUrl,
  formatAmount,
  formatClaimNumber,
  formatDate,
  formatPrice,
  formatPriceCents,
  formatRelative,
  shortHash,
  shortSha,
} from '../src/format'

describe('format', () => {
  it('formatPrice', () => {
    expect(formatPrice(0.153)).toBe('15.3%')
    expect(formatPrice(0.15)).toBe('15%')
    expect(formatPrice(0)).toBe('0%')
    expect(formatPrice(1)).toBe('100%')
    expect(formatPrice(0.0001)).toBe('<0.1%')
    expect(formatPrice(0.9999)).toBe('>99.9%')
    expect(formatPrice(Number.NaN)).toBe('—')
  })
  it('formatPriceCents', () => {
    expect(formatPriceCents(0.153)).toBe('0.153')
  })
  it('formatAmount handles decimal strings, numbers, compact', () => {
    expect(formatAmount('12.5')).toBe('12.5')
    expect(formatAmount('1234567.891234', { symbol: 'sDAI' })).toBe('1,234,567.8912 sDAI')
    expect(formatAmount(5)).toBe('5')
    expect(formatAmount('0.1')).toBe('0.1')
    expect(formatAmount('1e-7')).toBe('<0.0001')
    expect(formatAmount('0')).toBe('0')
    expect(formatAmount('-3.25', { maxDecimals: 1 })).toBe('-3.3')
    expect(formatAmount('1500', { compact: true })).toBe('1.5K')
    expect(formatAmount('2340000', { compact: true, symbol: 'sDAI' })).toBe('2.3M sDAI')
    expect(formatAmount('999.999', { compact: true })).toBe('1,000')
    expect(formatAmount('12.345', { compact: true })).toBe('12.35')
    expect(formatAmount('')).toBe('—')
    expect(formatAmount('abc')).toBe('—')
  })
  it('formatDate is UTC', () => {
    expect(formatDate('2026-10-10T18:00:00Z')).toBe('Oct 10, 2026')
    expect(formatDate('2026-10-10T18:00:00Z', 'long')).toBe('Oct 10, 2026, 18:00 UTC')
    expect(formatDate('2026-10-10T18:00:00Z', 'utc')).toBe('2026-10-10 18:00 UTC')
    expect(formatDate('nope')).toBe('—')
  })
  it('formatRelative', () => {
    const now = new Date('2026-10-01T00:00:00Z')
    expect(formatRelative('2026-10-03T04:00:00Z', now)).toBe('in 2d 4h')
    expect(formatRelative('2026-09-30T21:00:00Z', now)).toBe('3h ago')
    expect(formatRelative('2026-10-01T00:00:10Z', now)).toBe('just now')
  })
  it('hash helpers', () => {
    expect(shortHash('0x1234567890abcdef1234567890abcdef')).toBe('0x1234…cdef')
    expect(shortSha('ABCDEF1234567890')).toBe('abcdef1')
    expect(shortSha('abcdef1234567890').length).toBe(7)
    expect(formatClaimNumber(42)).toBe('PINE-0042')
    expect(formatClaimNumber(12345)).toBe('PINE-12345')
  })
  it('explorer urls', () => {
    expect(explorerTxUrl(100, '0xabc')).toBe('https://gnosisscan.io/tx/0xabc')
    expect(explorerAddressUrl(1, '0xdef')).toBe('https://etherscan.io/address/0xdef')
  })
})
