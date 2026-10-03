/**
 * `next/headers` for the static build. Pages read request headers only in api mode (to forward the visitor's IP to
 * pine-api); this mock-mode build never does, so calling it is a bug.
 */
export async function headers(): Promise<Headers> {
  throw new Error('next/headers is not available in the static build')
}
