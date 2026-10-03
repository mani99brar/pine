/**
 * `next/font/google` for the static build. The font files come from Google Fonts (a `<link>` in
 * index.html, allowed by the artifact CSP); the `variable` classes and the metric-matched fallback
 * faces that next/font generates are declared in src/fonts.css with the same values.
 */
export interface NextFont {
  className: string
  variable: string
  style: { fontFamily: string; fontWeight?: number; fontStyle?: string }
}

interface FontOptions {
  variable?: string
  subsets?: string[]
  axes?: string[]
  display?: string
  weight?: string | string[]
  style?: string | string[]
  preload?: boolean
  fallback?: string[]
  adjustFontFallback?: boolean
}

function font(family: string, slug: string) {
  return (_options: FontOptions = {}): NextFont => ({
    className: `ps-font-${slug}`,
    variable: `ps-font-${slug}-variable`,
    style: { fontFamily: `'${family}', '${family} Fallback'` },
  })
}

export const Geologica = font('Geologica', 'geologica')
export const Instrument_Sans = font('Instrument Sans', 'instrument-sans')
export const Azeret_Mono = font('Azeret Mono', 'azeret-mono')
