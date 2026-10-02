'use client'

/** Last-resort boundary for errors in the root layout. Minimal, self-contained styles. */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#ECEEF2', color: '#161A33' }}>
        <main style={{ maxWidth: 640, margin: '0 auto', padding: '80px 24px' }}>
          <h1 style={{ fontSize: 28, margin: 0 }}>Pine Field could not start</h1>
          <p style={{ color: '#474D6B', lineHeight: 1.55 }}>The app shell failed to load. Drafts and publication progress are stored in this browser and are not lost.</p>
          <button
            type="button"
            onClick={reset}
            style={{ marginTop: 16, height: 40, padding: '0 16px', borderRadius: 6, border: 0, background: '#161A33', color: '#fff', fontWeight: 600, cursor: 'pointer' }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  )
}
