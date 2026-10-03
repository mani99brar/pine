// The only outbound HTTP path of the gateways (SSRF control, SEC-EVID-09). Every request goes to an origin from the
// configured allowlist, never follows redirects, has a timeout, and its body is read with a hard byte cap. URLs are
// built by the gateways from configuration and validated identifiers only; no user-supplied URL ever reaches here.

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  readonly kind: "blocked" | "network" | "too_large" | "redirect";
  constructor(kind: HttpError["kind"], message: string) {
    super(message);
    this.name = "HttpError";
    this.kind = kind;
  }
}

export interface HttpResult {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export interface HttpClient {
  /** Performs one request. Throws HttpError for disallowed origins, network failures, redirects and oversize bodies.
   *  With `redirect: "manual"` a 3xx answer is returned (empty body, never followed) instead of thrown. `signal` (a job's
   *  abort signal) cancels the request in addition to the timeout. */
  request(
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: RequestInit["body"];
      maxBytes: number;
      timeoutMs?: number;
      redirect?: "error" | "manual";
      signal?: AbortSignal;
    },
  ): Promise<HttpResult>;
}

/** Normalised `scheme://host[:port]` of a URL, or null when it is not an absolute http(s) URL without credentials. */
export function originOf(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.origin;
}

export function createHttpClient(fetchFn: FetchLike, allowedOrigins: readonly string[], defaultTimeoutMs = 10_000): HttpClient {
  const allowed = new Set(allowedOrigins);
  return {
    async request(url, init) {
      const origin = originOf(url);
      if (origin === null || !allowed.has(origin)) throw new HttpError("blocked", "Outbound request to a host that is not configured");
      const requestInit: RequestInit = {
        method: init.method ?? "GET",
        redirect: init.redirect ?? "error",
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(init.timeoutMs ?? defaultTimeoutMs)])
          : AbortSignal.timeout(init.timeoutMs ?? defaultTimeoutMs),
      };
      if (init.headers) requestInit.headers = init.headers;
      if (init.body !== undefined) requestInit.body = init.body;
      let response: Response;
      try {
        response = await fetchFn(url, requestInit);
      } catch (error) {
        // fetch rejects with a TypeError when a redirect is refused (redirect: "error") or the network fails.
        throw new HttpError("network", error instanceof Error ? `${error.name}: ${error.message}` : "network error");
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        if (init.redirect === "manual") return { status: response.status, headers: response.headers, body: new Uint8Array(0) };
        throw new HttpError("redirect", `Redirect refused (status ${response.status})`);
      }
      const body = await readCapped(response, init.maxBytes);
      return { status: response.status, headers: response.headers, body };
    },
  };
}

/** Reads a response body, aborting as soon as more than `maxBytes` arrive (Content-Length is only a hint). */
export async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new HttpError("too_large", "Response exceeds the size limit");
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError("too_large", "Response exceeds the size limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError("network", error instanceof Error ? `${error.name}: ${error.message}` : "network error");
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function parseJsonBody(body: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
}
