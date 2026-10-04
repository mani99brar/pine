/**
 * `next/server` for the static build: pages call `connection()` to opt into request-time rendering in api mode, which
 * this mock-mode build never uses. Nothing else from next/server is imported by the pages it renders.
 */
export async function connection(): Promise<void> {}
