import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'

/** Values of the local stack (scripts/dev-stack/.state/frontend.env), overridable through the environment. */
export interface StackEnv {
  appOrigin: string
  rpcUrl: string
  controlUrl: string
  /** anvil dev account #1 (unlocked on the local fork; a public test account, never a real key). */
  account: `0x${string}`
  githubUserId: number
  githubLogin: string
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const i = trimmed.indexOf('=')
    if (i > 0) out[trimmed.slice(0, i)] = trimmed.slice(i + 1)
  }
  return out
}

export function stackEnv(): StackEnv {
  const here = dirname(fileURLToPath(import.meta.url))
  const file = readEnvFile(resolve(here, '../../../../../scripts/dev-stack/.state/frontend.env'))
  const get = (name: string, fallback: string) => process.env[name] ?? file[name] ?? fallback
  return {
    appOrigin: get('NEXT_PUBLIC_SITE_URL', 'http://localhost:3004'),
    rpcUrl: get('NEXT_PUBLIC_PINE_RPC_URL', 'http://127.0.0.1:8545'),
    controlUrl: get('PINE_DEV_CONTROL_URL', 'http://127.0.0.1:3999'),
    account: get('PINE_E2E_ACCOUNT', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8') as `0x${string}`,
    githubUserId: Number(get('PINE_E2E_GITHUB_USER_ID', '190455201')),
    githubLogin: get('PINE_E2E_GITHUB_LOGIN', 'pine-labs'),
  }
}

/**
 * A caption banner drawn over the page for the recorded walkthrough (test-only DOM, removed by the next caption).
 * It never interacts with the app.
 */
export async function caption(page: Page, text: string, holdMs = Number(process.env.PINE_E2E_CAPTION_MS ?? 0)): Promise<void> {
  await page.evaluate((t) => {
    document.getElementById('__pine_e2e_caption')?.remove()
    const el = document.createElement('div')
    el.id = '__pine_e2e_caption'
    el.textContent = t
    el.setAttribute('aria-hidden', 'true')
    Object.assign(el.style, {
      position: 'fixed',
      left: '50%',
      bottom: '28px',
      transform: 'translateX(-50%)',
      zIndex: '2147483647',
      padding: '10px 18px',
      borderRadius: '10px 3px 10px 3px',
      background: 'rgba(22,17,15,0.92)',
      border: '1px solid rgba(255,228,206,0.35)',
      color: '#f5ede4',
      font: '600 17px/1.35 system-ui, sans-serif',
      letterSpacing: '0.01em',
      boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
      pointerEvents: 'none',
      maxWidth: '80vw',
      textAlign: 'center',
    })
    document.body.appendChild(el)
  }, text)
  if (holdMs > 0) await page.waitForTimeout(holdMs)
}

/** A full-screen title card for the recorded walkthrough (test-only page content; nothing of the app is touched). */
export async function titleCard(page: Page, title: string, lines: string[], holdMs: number): Promise<void> {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#16110f;color:#f5ede4;font-family:system-ui,-apple-system,sans-serif}
    .wrap{height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 9vw}
    .bar{height:3px;width:220px;background:linear-gradient(90deg,#ff6b6b,#ffd166,#5ad8ff,#b79aff);margin-bottom:28px}
    h1{font-size:64px;font-weight:650;letter-spacing:-0.02em;margin:0 0 22px}
    p{font-size:26px;line-height:1.45;color:#cdbfb3;margin:6px 0;max-width:62ch}
  </style></head><body><div class="wrap"><div class="bar"></div><h1></h1></div></body></html>`
  await page.setContent(html)
  await page.evaluate(
    ({ t, ls }) => {
      const h1 = document.querySelector('h1')
      if (h1) h1.textContent = t
      const wrap = document.querySelector('.wrap')
      for (const l of ls) {
        const p = document.createElement('p')
        p.textContent = l
        wrap?.appendChild(p)
      }
    },
    { t: title, ls: lines },
  )
  await page.waitForTimeout(holdMs)
}
