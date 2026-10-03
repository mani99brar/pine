import type { BrowserContext } from '@playwright/test'

/**
 * Completes the GitHub link of the local e2e stack without github.com: the app navigates to the backend-issued
 * `https://github.com/login/oauth/authorize?...` URL; this route asks the stack's dev control server (FakeGitHub behind
 * the API's gateways) to approve it for a test identity and redirects the browser to the backend callback with the
 * resulting code and state, exactly as GitHub would. Nothing ever reaches github.com.
 */
export async function routeGitHubAuthorize(
  context: BrowserContext,
  opts: { controlUrl: string; appOrigin: string; githubUserId: number; login: string },
): Promise<void> {
  await context.route('https://github.com/login/oauth/authorize**', async (route) => {
    const authorizationUrl = route.request().url()
    const res = await fetch(`${opts.controlUrl}/dev/github/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ authorizationUrl, githubUserId: opts.githubUserId, login: opts.login }),
    })
    if (!res.ok) throw new Error(`dev control refused the authorization: ${res.status} ${await res.text()}`)
    const { code, state, callbackUrl } = (await res.json()) as { code: string; state: string; callbackUrl?: string }
    // The backend callback, on the app's own origin (the API is same-origin), carrying GitHub's code and state.
    const redirect = callbackUrl
      ? new URL(callbackUrl)
      : new URL(new URL(authorizationUrl).searchParams.get('redirect_uri') ?? `${opts.appOrigin}/api/v1/auth/github/callback`)
    redirect.searchParams.set('code', code)
    redirect.searchParams.set('state', state)
    if (redirect.origin !== new URL(opts.appOrigin).origin) throw new Error(`unexpected GitHub callback origin ${redirect.origin}`)
    await route.fulfill({ status: 302, headers: { location: redirect.toString() } })
  })
}
