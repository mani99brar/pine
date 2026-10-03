'use client'

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: '100vh', background: '#16110f', color: '#f5ede4', fontFamily: 'ui-sans-serif, system-ui, sans-serif', display: 'grid', placeItems: 'center', padding: 24 }}>
        <main style={{ maxWidth: 560 }}>
          <p style={{ color: '#a69789', margin: 0 }}>Pine Prism</p>
          <h1 style={{ fontSize: 40, fontWeight: 300, letterSpacing: '-0.02em', margin: '8px 0 12px' }}>The light scattered.</h1>
          <p style={{ color: '#cdbfb3', lineHeight: 1.6 }}>The app failed to load. Your drafts and transaction progress are saved in this browser, so you can reload without losing anything.</p>
          {error.digest && <p style={{ color: '#a69789', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>Reference {error.digest}</p>}
          <button type="button" onClick={reset} style={{ marginTop: 20, height: 44, padding: '0 18px', background: '#f5ede4', color: '#16110f', border: 0, borderRadius: '9px 3px 9px 3px', fontWeight: 600, cursor: 'pointer' }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  )
}
