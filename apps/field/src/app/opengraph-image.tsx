import { ImageResponse } from 'next/og'

export const alt = 'Pine Field: every claim here is an open challenge'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

/** Site card: the headline over a tension bar. */
export default function OgImage() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#ECEEF2', padding: 72, color: '#161A33' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 30, fontWeight: 800 }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ width: 4, height: 30, background: '#161A33' }} />
            <div style={{ width: 22, height: 14, background: '#FF5A1F', marginLeft: 3 }} />
            <div style={{ width: 5, height: 34, background: '#161A33' }} />
            <div style={{ width: 34, height: 14, background: '#2B44FF' }} />
            <div style={{ width: 4, height: 30, background: '#161A33', marginLeft: 3 }} />
          </div>
          Pine Field
        </div>
        <div style={{ display: 'flex', fontSize: 84, fontWeight: 800, lineHeight: 1, letterSpacing: -2, marginTop: 64, maxWidth: 980 }}>Every claim here is an open challenge.</div>
        <div style={{ display: 'flex', alignItems: 'center', marginTop: 'auto', width: '100%' }}>
          <div style={{ width: 6, height: 64, background: '#161A33' }} />
          <div style={{ width: 300, height: 40, background: '#FF5A1F', marginLeft: 6 }} />
          <div style={{ width: 10, height: 72, background: '#161A33' }} />
          <div style={{ width: 736, height: 40, background: '#2B44FF' }} />
          <div style={{ width: 6, height: 64, background: '#161A33', marginLeft: 6 }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20, fontSize: 24, color: '#474D6B' }}>
          <span>Pinned commits, bounded claims, live market odds</span>
          <span>Seer, Reality.eth, Kleros</span>
        </div>
      </div>
    ),
    size,
  )
}
