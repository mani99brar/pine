// Test harness for the gateways lane (never imported by production code): a scripted fetch that records every call,
// scripted viem transports, GitHub-shaped fixtures and a buildGateways() wrapper over PGlite with every migration.

import { randomBytes } from "node:crypto";
import { sql, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { custom, type Transport } from "viem";
import {
  createTestDatabase,
  FakeClock,
  FakeModeration,
  MemoryMetrics,
  testConfig,
  type TestDatabase,
} from "../../../contracts/testing.js";
import type { Database } from "../../../contracts/app.js";
import type { AppConfig } from "../../../contracts/config.js";
import type { Gateways, PlatformSecrets } from "../../../contracts/platform.js";
import { createRedactor, type Redactor } from "../../../contracts/redact.js";
import { buildGateways } from "../index.js";
import type { LogSink } from "../log.js";

// ------------------------------------------------------------------------------------------------ fetch

export interface RecordedCall {
  method: string;
  url: string;
  headers: Headers;
  redirect: RequestInit["redirect"];
  body: RequestInit["body"];
  bodyText: string | null;
  signal: AbortSignal | null;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

export class FakeFetch {
  readonly calls: RecordedCall[] = [];
  private readonly routes: { method: string; match: string | RegExp; handler: Handler; times: number | null }[] = [];

  /** Registers a handler; later registrations win. `times` limits how often it answers. */
  on(method: string, match: string | RegExp, handler: Handler | Response | (() => Response), times: number | null = null): this {
    const wrapped: Handler = typeof handler === "function" ? (handler as Handler) : () => (handler as Response).clone();
    this.routes.unshift({ method, match, handler: wrapped, times });
    return this;
  }

  json(method: string, match: string | RegExp, status: number, body: unknown, headers: Record<string, string> = {}): this {
    return this.on(method, match, () => jsonResponse(status, body, headers));
  }

  /** Forgets every call and scripted route (each test scripts its own answers). */
  clear(): void {
    this.calls.length = 0;
    this.routes.length = 0;
  }

  callsTo(match: string | RegExp): RecordedCall[] {
    return this.calls.filter((call) => matches(match, call.url));
  }

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const call: RecordedCall = {
      method: init.method ?? "GET",
      url: input,
      headers: new Headers(init.headers),
      redirect: init.redirect,
      body: init.body,
      bodyText: typeof init.body === "string" ? init.body : null,
      signal: init.signal ?? null,
    };
    this.calls.push(call);
    // Model undici: an already aborted signal rejects before anything is sent.
    if (init.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
    const route = this.routes.find((candidate) => candidate.method === call.method && matches(candidate.match, input) && candidate.times !== 0);
    if (!route) throw new TypeError(`fetch failed: unscripted ${call.method} ${input}`);
    if (route.times !== null) route.times -= 1;
    const response = await route.handler(call);
    // Model undici: with redirect "error" a 3xx response rejects instead of being returned.
    if (response.status >= 300 && response.status < 400 && init.redirect === "error") throw new TypeError("fetch failed: unexpected redirect");
    return response;
  };
}

function matches(match: string | RegExp, url: string): boolean {
  return typeof match === "string" ? url === match : match.test(url);
}

/** The rejection of a promise that must reject (fails the test when it resolves). */
export async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(outcome instanceof Error)) throw new Error("expected the promise to reject with an Error");
  return outcome;
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A body streamed in chunks without Content-Length (the size cap must hold while streaming). */
export function streamedResponse(bytes: Uint8Array, chunk = 16_384, status = 200): Response {
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
  return new Response(stream, { status });
}

// ------------------------------------------------------------------------------------------------ rpc

export type RpcScript = (method: string, params: unknown) => unknown;

export function scriptedTransport(script: RpcScript): Transport {
  return custom({ request: async ({ method, params }: { method: string; params?: unknown }) => script(method, params) });
}

export const chainIdOnly: RpcScript = (method) => {
  if (method === "eth_chainId") return "0x64";
  throw new Error(`Unscripted RPC call: ${method}`);
};

// ------------------------------------------------------------------------------------------------ secrets

export const CLIENT_ID = "Iv1.pinetestclient01";
export const CLIENT_SECRET = "client-secret-0123456789abcdef";
export const WEBHOOK_SECRET = "webhook-secret-0123456789";
export const PINNING_TOKEN = "pinning-token-0123456789";
export const GATEWAY_URLS = ["https://gw1.ipfs.test", "https://gw2.ipfs.test/"];
export const KUBO_URL = "http://127.0.0.1:5001";
export const PINNING_URL = "https://pins.example.test/psa";

export function testKey(id: string): { id: string; key: Uint8Array } {
  return { id, key: new Uint8Array(randomBytes(32)) };
}

export function testSecrets(overrides: Partial<PlatformSecrets> = {}): PlatformSecrets {
  return {
    databaseUrl: "postgres://api:pw@localhost/pine",
    rpcUrls: { primary: "https://rpc1.example.test/key-primary-123456", secondary: "https://rpc2.example.test/key-secondary-123456" },
    github: { kind: "app", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, webhookSecret: WEBHOOK_SECRET },
    tokenEncryptionKeys: { current: testKey("k2"), previous: [testKey("k1")] },
    ipfs: { kuboApiUrl: KUBO_URL, pinningServiceUrl: PINNING_URL, pinningServiceToken: PINNING_TOKEN, gatewayUrls: GATEWAY_URLS },
    readModel: { kind: "native", databaseUrl: "postgres://ro:pw@localhost/indexer" },
    ...overrides,
  };
}

// ------------------------------------------------------------------------------------------------ gateways

export interface Harness {
  database: TestDatabase;
  clock: FakeClock;
  metrics: MemoryMetrics;
  moderation: FakeModeration;
  fetch: FakeFetch;
  logs: { level: string; msg: string }[];
  redact: Redactor;
  secrets: PlatformSecrets;
  config: AppConfig;
  gateways: Gateways;
  /** Builds another gateways instance on the same database (a second API process); `db` may wrap the database. */
  sibling(options?: { fetch?: FakeFetch; secrets?: PlatformSecrets; db?: Database }): Promise<Gateways>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createHarness(options: { secrets?: PlatformSecrets; config?: Partial<AppConfig>; primary?: RpcScript; secondary?: RpcScript } = {}): Promise<Harness> {
  const database = await createTestDatabase();
  const clock = new FakeClock();
  const metrics = new MemoryMetrics();
  const moderation = new FakeModeration();
  const fetch = new FakeFetch();
  const logs: { level: string; msg: string }[] = [];
  const secrets = options.secrets ?? testSecrets();
  const config = testConfig(options.config);
  const redact = createRedactor([secrets.github.clientSecret, secrets.github.webhookSecret ?? "", PINNING_TOKEN, secrets.rpcUrls.primary, secrets.rpcUrls.secondary]);
  const sink: LogSink = (line) => logs.push({ level: line.level, msg: line.msg });
  const build = (fakeFetch: FakeFetch, buildSecrets: PlatformSecrets, db: Database = database.db) =>
    buildGateways(
      { config, secrets: buildSecrets, db, clock, redact, metrics, moderation },
      {
        fetch: fakeFetch.fetch,
        transports: { primary: scriptedTransport(options.primary ?? chainIdOnly), secondary: scriptedTransport(options.secondary ?? chainIdOnly) },
        log: sink,
      },
    );
  const gateways = await build(fetch, secrets);
  return {
    database,
    clock,
    metrics,
    moderation,
    fetch,
    logs,
    redact,
    secrets,
    config,
    gateways,
    sibling: (sibling = {}) => build(sibling.fetch ?? fetch, sibling.secrets ?? secrets, sibling.db),
    async reset() {
      await database.db.execute(sql`TRUNCATE github_tokens, github_links, github_oauth_states, content_pins, content_blobs, users CASCADE`);
      fetch.clear();
      logs.length = 0;
      metrics.counters.clear();
      moderation.items.clear();
      clock.set(new Date("2026-10-01T00:00:00.000Z"));
    },
    close: () => database.close(),
  };
}

export async function insertUser(database: TestDatabase, userId: string): Promise<void> {
  const wallet = `0x${userId.replace(/-/g, "").slice(0, 32).padStart(40, "0")}`;
  await database.sql.query("INSERT INTO users (id, wallet_address) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, wallet]);
}

// ------------------------------------------------------------------------------------------------ GitHub fixtures

export const API = "https://api.github.com";
export const TOKEN_URL = "https://github.com/login/oauth/access_token";

export function repoJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4242,
    node_id: "R_kgDOtest",
    name: "pine",
    full_name: "kleros/pine",
    owner: { login: "kleros", id: 77, type: "Organization" },
    private: false,
    visibility: "public",
    fork: false,
    default_branch: "main",
    html_url: "https://github.com/kleros/pine",
    pushed_at: "2026-09-30T12:00:00Z",
    permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
    ...overrides,
  };
}

export const sha = (n: number): string => n.toString(16).padStart(40, "0");

export function commitJson(commitSha: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sha: commitSha,
    html_url: `https://github.com/kleros/pine/commit/${commitSha}`,
    parents: [{ sha: sha(1) }],
    author: { login: "alice" },
    commit: { message: "Fix things", committer: { date: "2026-09-29T10:00:00Z" } },
    ...overrides,
  };
}

export function pullJson(number: number, headSha: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    title: "Add feature",
    state: "open",
    merged: false,
    merged_at: null,
    html_url: `https://github.com/kleros/pine/pull/${number}`,
    updated_at: "2026-09-30T00:00:00Z",
    user: { login: "alice" },
    head: { sha: headSha, ref: "feature", repo: { id: 9999 } },
    base: { sha: sha(2), ref: "main", repo: repoJson() },
    commits: 2,
    ...overrides,
  };
}

// ------------------------------------------------------------------------------------------------ linking

export interface GrantFixture {
  access_token: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

export function appGrant(n: number, overrides: Partial<GrantFixture> = {}): GrantFixture {
  return {
    access_token: `ghu_${String(n).padStart(36, "A")}`,
    token_type: "bearer",
    scope: "",
    expires_in: 28_800,
    refresh_token: `ghr_${String(n).padStart(76, "B")}`,
    refresh_token_expires_in: 15_811_200,
    ...overrides,
  };
}

export function sessionFor(userId: string, sessionId = `sess-${userId}`) {
  return {
    sessionId,
    userId,
    wallet: "0x00000000000000000000000000000000000a11ce" as const,
    githubUserId: null,
    githubLogin: null,
    isAdmin: false,
    authenticatedAt: new Date("2026-10-01T00:00:00Z"),
    idleExpiresAt: new Date("2026-10-02T00:00:00Z"),
    absoluteExpiresAt: new Date("2026-10-08T00:00:00Z"),
  };
}

/** Runs start() + complete() against scripted GitHub responses; returns the state used. */
export async function linkUser(
  h: Harness,
  userId: string,
  options: { githubUserId?: number; login?: string; grant?: GrantFixture; scopesHeader?: string | null; gateways?: Gateways } = {},
): Promise<string> {
  const gateways = options.gateways ?? h.gateways;
  await insertUser(h.database, userId);
  const session = sessionFor(userId);
  const { authorizationUrl } = await gateways.githubAuth.start(session);
  const state = new URL(authorizationUrl).searchParams.get("state") ?? "";
  const grant = options.grant ?? appGrant(1);
  h.fetch.json("POST", TOKEN_URL, 200, grant);
  const headers: Record<string, string> = {};
  if (options.scopesHeader !== null) headers["x-oauth-scopes"] = options.scopesHeader ?? "";
  h.fetch.on("GET", `${API}/user`, (call) =>
    call.headers.get("authorization") === `Bearer ${grant.access_token}`
      ? jsonResponse(200, { id: options.githubUserId ?? 1001, login: options.login ?? "alice" }, headers)
      : jsonResponse(401, { message: "Bad credentials" }),
  );
  await gateways.githubAuth.complete(session, { code: "code0123456789abcdef", state });
  return state;
}

/** A database whose `execute` (also inside transactions) reports each statement's SQL text to `onStatement` first, so a
 *  test can abort a job's signal exactly when the job reaches a given statement. */
export function observedDatabase(db: Database, onStatement: (text: string) => void): Database {
  const dialect = new PgDialect();
  const sqlText = (query: SQLWrapper): string => dialect.sqlToQuery(query.getSQL()).sql;
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(object, property, receiver) {
        const value: unknown = Reflect.get(object, property, receiver);
        if (property === "execute" && typeof value === "function") {
          return (query: SQLWrapper) => {
            onStatement(sqlText(query));
            return (value as (q: unknown) => unknown).call(object, query);
          };
        }
        if (property === "transaction" && typeof value === "function") {
          return (fn: (tx: object) => Promise<unknown>, ...rest: unknown[]) =>
            (value as (f: (tx: object) => Promise<unknown>, ...r: unknown[]) => unknown).call(object, (tx: object) => fn(wrap(tx)), ...rest);
        }
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(object) : value;
      },
    });
  return wrap(db);
}

export const USER_A = "00000000-0000-4000-8000-0000000000aa";
export const USER_B = "00000000-0000-4000-8000-0000000000bb";

/** Like observedDatabase, but `before` may run statements of its own (through `executor`, the same database or
 *  transaction handle, unwrapped) and is awaited before the intercepted statement executes. Lets a test interleave a
 *  concurrent writer at an exact point of a gateway operation (PGlite serialises queries, so races are staged). */
export function interceptedDatabase(db: Database, before: (text: string, executor: { execute(query: SQLWrapper): PromiseLike<unknown> }) => void | Promise<void>): Database {
  const dialect = new PgDialect();
  const sqlText = (query: SQLWrapper): string => dialect.sqlToQuery(query.getSQL()).sql;
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(object, property, receiver) {
        const value: unknown = Reflect.get(object, property, receiver);
        if (property === "execute" && typeof value === "function") {
          return async (query: SQLWrapper) => {
            await before(sqlText(query), object as unknown as { execute(query: SQLWrapper): PromiseLike<unknown> });
            return (value as (q: unknown) => unknown).call(object, query);
          };
        }
        if (property === "transaction" && typeof value === "function") {
          return (fn: (tx: object) => Promise<unknown>, ...rest: unknown[]) =>
            (value as (f: (tx: object) => Promise<unknown>, ...r: unknown[]) => unknown).call(object, (tx: object) => fn(wrap(tx)), ...rest);
        }
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(object) : value;
      },
    });
  return wrap(db);
}

/** A response whose body streams `bytes` in 64 KiB chunks and counts what the reader pulled. */
export function countedResponse(bytes: Uint8Array, init: ResponseInit = { status: 200 }): { response: Response; pulled: () => number } {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(pulled, pulled + 65_536));
      pulled = Math.min(bytes.byteLength, pulled + 65_536);
    },
  });
  return { response: new Response(stream, init), pulled: () => pulled };
}
