'use client'

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', background: '#f2f4f1', color: '#16231f', padding: '48px 24px' }}>
        <div style={{ maxWidth: 560, margin: '0 auto' }}>
          <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#b02a42' }}>error{error.digest ? ` ${error.digest}` : ''}</p>
          <h1 style={{ fontSize: 28, margin: '4px 0 12px' }}>Pine Console failed to load</h1>
          <p style={{ color: '#55635e', lineHeight: 1.6 }}>
            The application shell crashed. Drafts and in-progress publications are stored in this browser and are not lost.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{ marginTop: 20, height: 36, padding: '0 16px', borderRadius: 6, border: '1px solid #1c5d50', background: '#1c5d50', color: '#fff', cursor: 'pointer' }}
          >
            Reload the console
          </button>
        </div>
      </body>
    </html>
  )
}
