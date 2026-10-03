import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Static font instances for OG images (committed in src/assets/fonts; OFL). */
export async function ogFonts() {
  const dir = join(process.cwd(), 'src', 'assets', 'fonts')
  const load = async (file: string) => {
    try {
      return await readFile(join(dir, file))
    } catch {
      return null
    }
  }
  const [light, semi, body] = await Promise.all([load('Geologica-Light.ttf'), load('Geologica-SemiBold.ttf'), load('InstrumentSans-Regular.ttf')])
  const fonts: { name: string; data: Buffer; weight: 300 | 400 | 600; style: 'normal' }[] = []
  if (light) fonts.push({ name: 'Geologica', data: light, weight: 300, style: 'normal' })
  if (semi) fonts.push({ name: 'Geologica', data: semi, weight: 600, style: 'normal' })
  if (body) fonts.push({ name: 'Instrument Sans', data: body, weight: 400, style: 'normal' })
  return fonts
}
