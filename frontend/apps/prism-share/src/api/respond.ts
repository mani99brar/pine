/** Response helpers matching @pine/server's http.ts shapes. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' },
  })
}

export function errorJson(status: number, code: string, message: string, extra?: { hint?: string }): Response {
  return json({ error: { code, message, ...(extra?.hint ? { hint: extra.hint } : {}) } }, status)
}
