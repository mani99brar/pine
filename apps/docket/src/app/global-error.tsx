'use client'

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', background: '#eef0f4', color: '#1a1d2b', margin: 0 }}>
        <main style={{ maxWidth: 640, margin: '0 auto', padding: '64px 16px' }}>
          <div style={{ borderLeft: '8px solid #b42318', background: '#fff', padding: 24 }}>
            <p style={{ fontWeight: 700, color: '#b42318', margin: 0 }}>Pine Docket could not start</p>
            <h1 style={{ fontSize: 30, margin: '8px 0' }}>The application failed to load</h1>
            <p style={{ color: '#4b5263', lineHeight: 1.6 }}>
              Drafts stay in this browser and on-chain records are unaffected. Try again, or reload the page.
              {error.digest ? ` Reference ${error.digest}.` : ''}
            </p>
            <button
              type="button"
              onClick={() => retry()}
              style={{ marginTop: 16, background: '#4433a6', color: '#fff', border: 0, padding: '12px 16px', fontWeight: 700, fontSize: 16, borderRadius: 3, cursor: 'pointer' }}
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  )
}
