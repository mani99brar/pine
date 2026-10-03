import { ImageResponse } from 'next/og'
import { beamSvg, crystalSvg, svgDataUri } from '@/lib/crystal-svg'
import { ogFonts } from '@/lib/server/og'

export const alt = 'Pine Prism: hold your claim up to the light'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default async function SiteOgImage() {
  const crystal = svgDataUri(crystalSvg({ seed: 'pine-0009:og', hue: '#FFB648', state: 'luminous' }))
  const beams = svgDataUri(beamSvg({ yes: 0.3, no: 0.67, invalid: 0.03, width: 640, height: 420, prism: false }))
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', background: 'linear-gradient(135deg,#1c1512,#16110f 55%,#0e0a09)', color: '#F5EDE4', fontFamily: 'Geologica', position: 'relative' }}>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 72, width: 640 }}>
          <div style={{ display: 'flex', fontSize: 28, fontWeight: 600, color: '#CDBFB3' }}>Pine Prism</div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', fontSize: 84, fontWeight: 300, lineHeight: 1, letterSpacing: -3 }}>Hold your claim up to the light.</div>
            <div style={{ display: 'flex', fontSize: 26, fontFamily: 'Instrument Sans', color: '#CDBFB3', marginTop: 28, lineHeight: 1.4 }}>One bounded claim about an exact commit, and a market on whether anyone demonstrates a counterexample.</div>
          </div>
        </div>
        <div style={{ position: 'absolute', right: 0, top: 105, width: 640, height: 420, display: 'flex' }}>
          <img src={beams} width={640} height={420} alt="" />
        </div>
        <div style={{ position: 'absolute', right: 232, top: 130, display: 'flex' }}>
          <img src={crystal} width={250} height={371} alt="" />
        </div>
      </div>
    ),
    { ...size, fonts: await ogFonts() },
  )
}
