// DEVELOPMENT-ONLY control server of the local integration stack, started by scripts/dev-server.ts on 127.0.0.1 (never the
// API port) after its loopback + anvil checks passed. Routes:
//   GET     /dev/health              -> { ok, api, userContent, chainId, rpc, ipfs }
//   GET     /dev/github/repos        -> the seeded repositories, branches, PRs and commit SHAs
//   POST    /dev/github/authorize    {authorizationUrl, githubUserId?, login?} -> {code, state, callbackUrl}
//                                    (the "user approves on github.com" step; a Playwright test intercepts the
//                                    github.com navigation and then navigates to callbackUrl)
//   OPTIONS /dev/fund                CORS preflight: answered only for the app origin (PINE_PUBLIC_ORIGIN), exactly
//   POST    /dev/fund                {address} -> FundResponse (scripts/dev-faucet.ts): tops the wallet's xDAI up on the
//                                    local anvil fork. Prism calls it on wallet connect in local builds only
//                                    (NEXT_PUBLIC_PINE_DEV_FORK_ORIGIN); needs Origin = the app origin, `x-pine-dev: 1`
//                                    and a JSON body.
//   GET     /login/oauth/authorize   the simulated github.com consent page for people testing by hand: the frontend sends
//                                    the browser here instead of github.com when NEXT_PUBLIC_PINE_DEV_GITHUB_ORIGIN is
//                                    set (local builds only); "Approve" completes the link through FakeGitHub and
//                                    redirects to the API callback, exactly like GitHub would.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { DevGitHub } from "./dev-fakes.js";
import type { DevFaucet } from "./dev-faucet.js";

export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export const CONTROL_HOST = "127.0.0.1";
const CONTROL_BODY_LIMIT = 16 * 1024;
export const DEFAULT_IDENTITY = { githubUserId: 190_455_201, login: "pine-labs" } as const;

export class DevRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevRefusal";
  }
}

export function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const authorizeBody = z
  .object({
    authorizationUrl: z.string().url().max(4096),
    githubUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    login: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/).optional(),
  })
  .strict();

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > CONTROL_BODY_LIMIT) throw new DevRefusal("body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A stable fake numeric GitHub id per login (distinct from the seeded owner's id). */
function devGithubId(login: string): number {
  let hash = 0;
  for (const char of login.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return 300_000_000 + (hash % 100_000_000);
}

function sendHtml(response: ServerResponse, status: number, body: string, formTarget = ""): void {
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>GitHub (simulated)</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;color:#e6edf3;font:16px/1.5 system-ui,sans-serif}
main{width:min(460px,92vw);background:#161b22;border:1px solid #30363d;border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 6px}p{color:#9da7b3}label{display:block;margin:18px 0 6px;font-weight:600}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;font:inherit}
button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:8px;background:#238636;color:#fff;font:600 16px system-ui;cursor:pointer}
.note{font-size:13px;margin-top:18px}code{background:#0d1117;padding:1px 5px;border-radius:5px}
</style></head><body><main>${body}</main></body></html>`;
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${formTarget}`.trim() });
  response.end(page);
}

/** The simulated github.com consent screen (local manual testing only). */
function consentPage(response: ServerResponse, url: URL, callbackOrigin: string): void {
  if (url.searchParams.get("code_challenge_method") !== "S256" || !url.searchParams.get("state") || !url.searchParams.get("code_challenge")) {
    return sendHtml(response, 400, "<p>Not a Pine authorization request (PKCE S256 and state are required).</p>");
  }
  const suggested = `dev-${(url.searchParams.get("state") ?? "x").replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toLowerCase()}`;
  const hidden = [...url.searchParams].map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`).join("");
  sendHtml(
    response,
    200,
    `<h1>Authorize Pine (local dev)</h1>
<p>This is the local stack's <b>simulated GitHub</b>: nothing is sent to github.com and no GitHub permissions exist.</p>
<form method="get" action="/login/oauth/authorize/approve">${hidden}
<label for="pine_login">Sign in to GitHub as</label>
<input id="pine_login" name="pine_login" value="${escapeHtml(suggested)}" pattern="[A-Za-z0-9][A-Za-z0-9-]{0,38}" required>
<button type="submit">Approve</button></form>
<p class="note">Each GitHub account links to one wallet only. <code>${escapeHtml(DEFAULT_IDENTITY.login)}</code> owns the seeded repositories but is already linked to the e2e test wallet; any other login works, and you can still open <code>pine-labs/keeper-bot</code> by name in the composer.</p>`,
    // The approve step redirects to the API callback: CSP form-action also governs that redirect.
    callbackOrigin,
  );
}

export interface ControlDeps {
  /** Port to listen on (0 picks a free one, for tests). */
  port: number;
  github: Pick<DevGitHub, "authorize" | "describe">;
  /** The API origin: callback URLs are only ever built on it. */
  callbackOrigin: string;
  /** The app's web origin (PINE_PUBLIC_ORIGIN): the only origin allowed to call POST /dev/fund. */
  publicOrigin: string;
  health: () => Record<string, unknown>;
  /** The local-fork faucet; /dev/fund answers 404 without one. */
  faucet?: DevFaucet | null;
  /** Dev log line (no secrets: addresses and amounts only). */
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/** CORS answer for the app origin only, and only when the call is actually cross-origin. */
function corsFor(origin: string | undefined, selfOrigin: string, publicOrigin: string): Record<string, string> {
  if (origin === undefined || origin !== publicOrigin || origin === selfOrigin) return { vary: "Origin" };
  return { "access-control-allow-origin": publicOrigin, vary: "Origin" };
}

async function handleFund(request: IncomingMessage, response: ServerResponse, deps: ControlDeps, selfOrigin: string): Promise<void> {
  const origin = request.headers.origin;
  // A browser always sends Origin on a POST. Only the app's own page may ask: any other site (or a page on another
  // loopback port) is refused before the body is read.
  if (origin !== deps.publicOrigin) return send(response, 403, { error: "only the app origin may call the faucet" }, { vary: "Origin" });
  const cors = corsFor(origin, selfOrigin, deps.publicOrigin);
  if (request.headers["x-pine-dev"] !== "1") return send(response, 403, { error: "the x-pine-dev: 1 header is required" }, cors);
  if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return send(response, 415, { error: "content-type must be application/json" }, cors);
  if (!deps.faucet) return send(response, 404, { error: "the faucet is not configured" }, cors);
  let input: unknown;
  try {
    input = JSON.parse(await readBody(request)) as unknown;
  } catch (error) {
    if (error instanceof DevRefusal) return send(response, 413, { error: "body too large" }, cors);
    return send(response, 400, { error: "invalid JSON body" }, cors);
  }
  const outcome = await deps.faucet.fund(input);
  if (!outcome.ok) {
    const retry: Record<string, string> = outcome.retryAfterSeconds ? { "retry-after": String(outcome.retryAfterSeconds) } : {};
    return send(response, outcome.status, { error: outcome.error }, { ...cors, ...retry });
  }
  deps.log?.("dev faucet", { address: outcome.body.address, funded: outcome.body.funded, balanceWei: outcome.body.balanceWei, delegatedTo: outcome.body.delegatedTo });
  return send(response, 200, outcome.body, cors);
}

function handleFundPreflight(request: IncomingMessage, response: ServerResponse, deps: ControlDeps): void {
  const origin = request.headers.origin;
  const method = request.headers["access-control-request-method"];
  if (origin !== deps.publicOrigin || method !== "POST") return send(response, 403, { error: "preflight refused" }, { vary: "Origin" });
  const headers: Record<string, string> = {
    "access-control-allow-origin": deps.publicOrigin,
    "access-control-allow-methods": "POST",
    "access-control-allow-headers": "content-type, x-pine-dev",
    "access-control-max-age": "600",
    vary: "Origin",
    "cache-control": "no-store",
  };
  // Chrome's Private/Local Network Access preflight (a page on localhost calling 127.0.0.1).
  if (request.headers["access-control-request-private-network"] === "true") headers["access-control-allow-private-network"] = "true";
  response.writeHead(204, headers);
  response.end();
}

/**
 * The request handler. `allowedHosts` is read per request so a server bound to port 0 can fill it in after listen.
 */
export function createControlHandler(deps: ControlDeps, allowedHosts: () => ReadonlySet<string>): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void (async () => {
      // DNS-rebinding and cross-site guards: loopback Host only; browsers' cross-origin requests are refused, except the
      // app origin's faucet call below (a JSON POST needs a CORS preflight, answered for that one route and origin only).
      const host = (request.headers.host ?? "").toLowerCase();
      if (!allowedHosts().has(host)) return send(response, 421, { error: "unexpected Host header" });
      const origin = request.headers.origin;
      if (origin !== undefined && !LOOPBACK_HOSTS.has(hostOf(origin) ?? "")) return send(response, 403, { error: "cross-origin requests are refused" });
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (url.pathname === "/dev/fund") {
        if (request.method === "OPTIONS") return handleFundPreflight(request, response, deps);
        if (request.method === "POST") return handleFund(request, response, deps, `http://${host}`);
        return send(response, 405, { error: "method not allowed" }, { allow: "POST, OPTIONS" });
      }
      if (request.method === "GET" && url.pathname === "/dev/health") return send(response, 200, { ok: true, ...deps.health() });
      if (request.method === "GET" && url.pathname === "/dev/github/repos") return send(response, 200, { defaultIdentity: DEFAULT_IDENTITY, repos: deps.github.describe() });
      if (request.method === "POST" && url.pathname === "/dev/github/authorize") {
        if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return send(response, 415, { error: "content-type must be application/json" });
        let parsed;
        try {
          parsed = authorizeBody.safeParse(JSON.parse(await readBody(request)) as unknown);
        } catch {
          return send(response, 400, { error: "invalid JSON body" });
        }
        if (!parsed.success) return send(response, 400, { error: "invalid body", issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message })) });
        const identity = { githubUserId: parsed.data.githubUserId ?? DEFAULT_IDENTITY.githubUserId, login: parsed.data.login ?? DEFAULT_IDENTITY.login };
        let result;
        try {
          result = deps.github.authorize(parsed.data.authorizationUrl, identity);
        } catch (error) {
          return send(response, 400, { error: error instanceof Error ? error.message : "authorization refused" });
        }
        // The callback the browser would be sent to: only on the configured API origin.
        const redirect = new URL(parsed.data.authorizationUrl).searchParams.get("redirect_uri");
        let callbackUrl: string | null = null;
        if (redirect !== null && hostOf(redirect) !== null && new URL(redirect).origin === deps.callbackOrigin) {
          const callback = new URL(redirect);
          callback.searchParams.set("code", result.code);
          callback.searchParams.set("state", result.state);
          callbackUrl = callback.toString();
        }
        return send(response, 200, { code: result.code, state: result.state, callbackUrl, identity });
      }
      if (request.method === "GET" && url.pathname === "/login/oauth/authorize") return consentPage(response, url, deps.callbackOrigin);
      if (request.method === "GET" && url.pathname === "/login/oauth/authorize/approve") {
        const login = url.searchParams.get("pine_login") ?? "";
        if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return sendHtml(response, 400, "<p>Invalid GitHub login.</p>");
        const github = new URL("https://github.com/login/oauth/authorize");
        for (const [key, value] of url.searchParams) if (key !== "pine_login") github.searchParams.append(key, value);
        const identity = login === DEFAULT_IDENTITY.login ? { ...DEFAULT_IDENTITY } : { githubUserId: devGithubId(login), login };
        let result;
        try {
          result = deps.github.authorize(github.toString(), identity);
        } catch (error) {
          return sendHtml(response, 400, `<p>Authorization refused: ${escapeHtml(error instanceof Error ? error.message : "unknown error")}</p>`);
        }
        const redirect = github.searchParams.get("redirect_uri") ?? `${deps.callbackOrigin}/api/v1/auth/github/callback`;
        if (hostOf(redirect) === null || new URL(redirect).origin !== deps.callbackOrigin) return sendHtml(response, 400, "<p>The callback is not on the API origin.</p>");
        const callback = new URL(redirect);
        callback.searchParams.set("code", result.code);
        callback.searchParams.set("state", result.state);
        response.writeHead(302, { location: callback.toString(), "cache-control": "no-store" });
        return response.end();
      }
      return send(response, 404, { error: "not found" });
    })().catch(() => {
      if (!response.headersSent) send(response, 500, { error: "internal error" });
      else response.destroy();
    });
  };
}

export function startControlServer(deps: ControlDeps, host: string = CONTROL_HOST): Promise<Server> {
  let allowed: ReadonlySet<string> = new Set();
  const server = createServer(createControlHandler(deps, () => allowed));
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port, host, () => {
      server.off("error", reject);
      const port = (server.address() as AddressInfo).port;
      allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      resolve(server);
    });
  });
}
