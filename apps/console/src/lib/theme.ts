export type ThemePref = 'system' | 'light' | 'dark'
export const THEME_KEY = 'pine-console:theme'

/** Runs before paint (inlined in <head>) so the stored theme never flashes. */
export const themeScript = `(function(){try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})();`

export function readTheme(): ThemePref {
  try {
    const t = localStorage.getItem(THEME_KEY)
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}

export function applyTheme(t: ThemePref) {
  try {
    if (t === 'system') {
      localStorage.removeItem(THEME_KEY)
      document.documentElement.removeAttribute('data-theme')
    } else {
      localStorage.setItem(THEME_KEY, t)
      document.documentElement.setAttribute('data-theme', t)
    }
  } catch {
    /* storage unavailable: theme applies for this page only */
  }
}
