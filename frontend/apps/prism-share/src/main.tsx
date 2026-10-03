import './prelude'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installApi } from './api/install'
import { installRouter, routerStore } from './router/router'
import { installAnchors } from './app/anchors'
import { installFormSubmit } from './app/forms'
import { App, htmlAttributes } from './app/App'
import { isNotFoundSignal, isRedirectSignal } from './shims/next-navigation'

const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Azeret+Mono:wght@100..900&family=Geologica:CRSV,SHRP,wght@0..1,0..100,100..900&family=Instrument+Sans:wdth,wght@75..100,400..700&display=swap'

/** index.html links the fonts; keep them if a host rewrites the document head. */
function ensureFonts() {
  if (document.querySelector('link[href^="https://fonts.googleapis.com/css2"]')) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = FONTS_HREF
  document.head.appendChild(link)
}

installApi()
installRouter()

// The landing hero's WebGL chunk (three.js) is fetched in parallel with the first render instead of after
// it, so the scene is ready well inside Hero's 4.5 s budget. Same chunk Prism splits out with next/dynamic.
try {
  if (routerStore.get().pathname === '/' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    void import('@/components/landing/HeroCanvas')
  }
} catch {
  /* matchMedia unavailable: Hero loads the chunk itself */
}

installAnchors()
installFormSubmit()
ensureFonts()

const html = document.documentElement
html.lang = htmlAttributes.lang
for (const c of htmlAttributes.className.split(/\s+/).filter(Boolean)) html.classList.add(c)

let container = document.getElementById('root')
if (!container) {
  container = document.createElement('div')
  container.id = 'root'
  document.body.appendChild(container)
}

createRoot(container, {
  // notFound() and redirect() are control flow, not errors (Next does not log them either).
  onCaughtError(error, info) {
    if (isNotFoundSignal(error) || isRedirectSignal(error)) return
    console.error(error, info.componentStack)
  },
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
