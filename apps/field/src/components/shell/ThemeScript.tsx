import Script from 'next/script'

/**
 * Applies the saved theme preference before first paint (no flash). Inline constant script, never
 * user content.
 */
const script = `try{var t=localStorage.getItem('pine-field:theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t}}catch(e){}`

export function ThemeScript() {
  return (
    <Script id="pine-field-theme" strategy="beforeInteractive">
      {script}
    </Script>
  )
}
