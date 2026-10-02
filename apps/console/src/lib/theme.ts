export type ThemePref = 'system' | 'light' | 'dark'
export const THEME_COOKIE = 'pine-console-theme'

/** Reads the explicit theme cookie value (server or client). */
export function parseTheme(v: string | undefined | null): ThemePref {
  return v === 'light' || v === 'dark' ? v : 'system'
}

export function readTheme(): ThemePref {
  if (typeof document === 'undefined') return 'system'
  const m = document.cookie.match(new RegExp(`(?:^|; )${THEME_COOKIE}=([^;]*)`))
  return parseTheme(m?.[1])
}

/**
 * Applies a theme immediately and persists it in a cookie, so the server layout can render
 * <html data-theme> on the next request without any inline script or flash.
 */
export function applyTheme(t: ThemePref) {
  const root = document.documentElement
  if (t === 'system') {
    root.removeAttribute('data-theme')
    document.cookie = `${THEME_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
  } else {
    root.setAttribute('data-theme', t)
    document.cookie = `${THEME_COOKIE}=${t}; Path=/; Max-Age=31536000; SameSite=Lax`
  }
}
