// The hardened Fastify application (PRD-02 2.2). Hook order on every request, unmatched routes included:
//   1. per-IP flood guard (@fastify/rate-limit, in memory; the FIRST instance-level onRequest hook)
//   2. route policy + CSRF (unsafe methods; only the GitHub webhook is exempt)
//   3. session lookup (never for public routes) and the Postgres per-user / per-route windows (one all-or-nothing
//      statement; routes with body-dependent keys consume all their keys together in preHandler, after validation)
// Public routes (config.pine.public) are GET/HEAD only, never read cookies, never set them and get ACAO `*`.

import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { AppContext, RouteModule, SessionInfo } from "../../contracts/app.js";
import { GitHubGatewayError } from "../../contracts/app.js";
import { ApiError, toErrorResponse, type ErrorCode } from "../../contracts/errors.js";
import type { Gateways } from "../../contracts/platform.js";
import { safeErrorMessage, type Redactor } from "../../contracts/redact.js";
import { PostgresAuditLog } from "./audit.js";
import { registerAuthRoutes, registerWebhookRoute, WEBHOOK_PATH } from "./auth-routes.js";
import type { ServerSettings } from "./config.js";
import { checkCsrf, UNSAFE_METHODS } from "./csrf.js";
import { registerHealthRoutes, type Readiness } from "./health.js";
import { consumeRateLimits, type RateLimitKey } from "./limits.js";
import { PostgresModeration, registerModerationRoutes } from "./moderation.js";
import { lookupSession, SESSION_COOKIE } from "./sessions.js";

/** Core-only route options (never set by modules). */
export interface CoreRouteConfig {
  /** Exempt from CSRF (the GitHub webhook only). */
  csrfExempt?: boolean;
  /** No session lookup (cookies are never read). */
  noSession?: boolean;
  /**
   * Keys that depend on the validated body (the SIWE per-address windows). The route's request keys are then consumed
   * in preHandler together with these, in the same all-or-nothing statement, instead of in onRequest.
   */
  bodyRateLimitKeys?: (request: FastifyRequest) => Promise<RateLimitKey[]>;
}

declare module "fastify" {
  interface FastifyContextConfig {
    pineCore?: CoreRouteConfig;
  }
}

export const ADMIN_STEP_UP_SECONDS = 300;
export const JSON_BODY_LIMIT = 64 * 1024;

export interface LogStream {
  write(line: string): void;
}

export interface BuildAppOptions {
  ctx: AppContext;
  /** The platform reads GitHub identities only through githubAuth (identityOf) and drives linking through it. */
  gateways: Pick<Gateways, "githubAuth">;
  modules: readonly RouteModule[];
  settings: ServerSettings;
  readiness: Readiness;
  /** Log destination (default stdout); tests capture lines here. */
  logStream?: LogStream;
}

/** Path without query string or fragment (SEC-OPS-03). */
export function pathOnly(url: string | undefined): string {
  if (typeof url !== "string") return "";
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

const GITHUB_ERROR_MAP: Record<GitHubGatewayError["code"], ErrorCode> = {
  GITHUB_NOT_LINKED: "FORBIDDEN",
  REPO_NOT_PUBLIC: "UNPROCESSABLE",
  NOT_A_MEMBER: "UNPROCESSABLE",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  UPSTREAM: "UPSTREAM_UNAVAILABLE",
};

/** Maps GitHub gateway failures to client error codes so routine GitHub failures never surface as 500. */
export function mapPlatformError(error: unknown): unknown {
  if (error instanceof GitHubGatewayError) {
    const code = GITHUB_ERROR_MAP[error.code] ?? "UPSTREAM_UNAVAILABLE";
    return new ApiError(code, error.message, code === "RATE_LIMITED" ? { retryAfterSeconds: 60 } : {});
  }
  return error;
}

function routeConfig(request: FastifyRequest): { public: boolean; multipart: boolean; rateLimitPerMinute: number | undefined; core: CoreRouteConfig } {
  const config = request.is404 ? undefined : request.routeOptions.config;
  const pine = config?.pine;
  return {
    public: pine?.public === true,
    multipart: pine?.multipart === true,
    rateLimitPerMinute: typeof pine?.rateLimitPerMinute === "number" ? pine.rateLimitPerMinute : undefined,
    core: config?.pineCore ?? {},
  };
}

function loggerOptions(settings: ServerSettings, redact: Redactor, stream: LogStream | undefined) {
  return {
    level: settings.logLevel,
    ...(stream ? { stream } : {}),
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-pine-csrf"]',
        'res.headers["set-cookie"]',
        "headers.authorization",
        "headers.cookie",
        'headers["set-cookie"]',
        'headers["x-pine-csrf"]',
      ],
      censor: "[REDACTED]",
    },
    serializers: {
      req: (req: { method?: string | undefined; url?: string | undefined; routeOptions?: { url?: string | undefined } | undefined }) => ({ method: req.method ?? "", path: pathOnly(req.url), route: req.routeOptions?.url ?? "" }),
      res: (res: { statusCode?: number | undefined }) => ({ statusCode: res.statusCode ?? 0 }),
      err: (err: unknown) => ({ type: err instanceof Error ? err.name : "Error", message: safeErrorMessage(err, redact), stack: "" }),
    },
  };
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { ctx, gateways, modules, settings } = options;
  const production = ctx.config.environment === "production";

  const app = Fastify({
    logger: loggerOptions(settings, ctx.redact, options.logStream),
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    // Trust exactly the configured number of proxy hops (proxy-addr hop semantics); off by default (SEC-OPS-04).
    trustProxy: settings.trustProxyHops > 0 ? (_address: string, hop: number) => hop < settings.trustProxyHops : false,
    bodyLimit: JSON_BODY_LIMIT,
    onProtoPoisoning: "error",
    onConstructorPoisoning: "error",
    connectionTimeout: 60_000,
    requestTimeout: 30_000,
    routerOptions: { maxParamLength: 200 },
    return503OnClosing: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Module route options are validated at registration (before any plugin sees them): a misconfigured route refuses startup.
  app.addHook("onRoute", (route) => {
    if (route.config?.rateLimit !== undefined) throw new Error(`Route ${route.url} must not set config.rateLimit`);
    // The GitHub webhook is the only route without CSRF checks and session lookup (decisions.md).
    const core = route.config?.pineCore;
    if ((core?.csrfExempt === true || core?.noSession === true) && !(route.url === WEBHOOK_PATH && route.method === "POST")) {
      throw new Error(`Route ${route.url} must not be exempt from CSRF or the session lookup`);
    }
    const pine = route.config?.pine;
    if (!pine) return;
    const methods = (Array.isArray(route.method) ? route.method : [route.method]).map((method) => String(method).toUpperCase());
    if (pine.public === true && methods.some((method) => method !== "GET" && method !== "HEAD")) {
      throw new Error(`Public route ${route.url} must be GET/HEAD only`);
    }
    if (pine.public === true && pine.multipart === true) throw new Error(`Public route ${route.url} cannot accept multipart`);
    if (pine.rateLimitPerMinute !== undefined && (!Number.isInteger(pine.rateLimitPerMinute) || pine.rateLimitPerMinute < 1)) {
      throw new Error(`Route ${route.url} has an invalid rateLimitPerMinute`);
    }
  });

  // ---- 1. per-IP flood guard: first instance-level onRequest hook (no route ever sets config.rateLimit).
  await app.register(rateLimit, { global: false });
  app.addHook(
    "onRequest",
    app.rateLimit({
      max: settings.ipFloodLimitPerMinute,
      timeWindow: 60_000,
      keyGenerator: (request) => request.ip,
      errorResponseBuilder: (_request, context) => new ApiError("RATE_LIMITED", "Too many requests", { retryAfterSeconds: Math.max(1, Math.ceil(context.ttl / 1000)) }),
    }),
  );

  await app.register(cookie, { hook: false });
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: production ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: "no-referrer" },
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "same-origin" },
    xContentTypeOptions: true,
  });
  await app.register(multipart, { limits: { fileSize: ctx.config.evidence.maxUploadBytes, files: 1, fields: 10, parts: 11 } });
  await app.register(swagger, { openapi: { info: { title: "Pine API", version: "1.0.0" } }, transform: jsonSchemaTransform });

  app.decorateRequest("session", null);
  const deferredRateLimitKeys = new WeakMap<FastifyRequest, RateLimitKey[]>();

  // ---- 2. route policy and CSRF (before body parsing).
  app.addHook("onRequest", async (request) => {
    const route = routeConfig(request);
    if (route.public && request.method !== "GET" && request.method !== "HEAD") throw new ApiError("NOT_FOUND", "Not found");
    if (!UNSAFE_METHODS.has(request.method) || route.core.csrfExempt === true) return;
    const failure = checkCsrf(request.headers, { publicOrigin: ctx.config.publicOrigin, multipart: route.multipart });
    if (failure !== null) {
      request.log.info({ reason: failure, route: request.is404 ? null : request.routeOptions.url }, "csrf rejected");
      throw new ApiError("CSRF_REJECTED", "Request rejected");
    }
  });

  // ---- 3. authentication and Postgres rate-limit windows.
  app.addHook("onRequest", async (request) => {
    request.session = null;
    const route = routeConfig(request);
    const now = ctx.clock.now();
    if (!request.is404 && !route.public && route.core.noSession !== true) {
      const header = request.headers.cookie;
      if (typeof header === "string" && header.length <= 8192) {
        const token = app.parseCookie(header)[SESSION_COOKIE];
        if (token !== undefined) {
          const row = await lookupSession(ctx.db, token, now);
          if (row) {
            const identity = await gateways.githubAuth.identityOf(row.userId);
            const session: SessionInfo = {
              sessionId: row.sessionId,
              userId: row.userId,
              wallet: row.wallet,
              githubUserId: identity?.githubUserId ?? null,
              githubLogin: identity?.login ?? null,
              isAdmin: settings.adminWallets.has(row.wallet.toLowerCase()),
              authenticatedAt: row.authenticatedAt,
              idleExpiresAt: row.idleExpiresAt,
              absoluteExpiresAt: row.absoluteExpiresAt,
            };
            request.session = session;
          }
        }
      }
    }
    const keys: RateLimitKey[] = [];
    const routeId = request.is404 ? null : `${request.method} ${request.routeOptions.url ?? ""}`;
    if (request.session) {
      keys.push({ key: `user:${request.session.userId}`, limit: settings.userRateLimitPerMinute });
      if (route.rateLimitPerMinute !== undefined && routeId !== null) keys.push({ key: `user:${request.session.userId}:${routeId}`, limit: route.rateLimitPerMinute });
    } else if (route.rateLimitPerMinute !== undefined && routeId !== null) {
      keys.push({ key: `ip:${request.ip}:${routeId}`, limit: route.rateLimitPerMinute });
    }
    if (route.core.bodyRateLimitKeys !== undefined) deferredRateLimitKeys.set(request, keys);
    else await consumeRateLimits(ctx.db, now, keys);
  });

  app.addHook("preHandler", async (request) => {
    const extra = routeConfig(request).core.bodyRateLimitKeys;
    if (extra === undefined) return;
    const keys = [...(deferredRateLimitKeys.get(request) ?? []), ...(await extra(request))];
    deferredRateLimitKeys.delete(request);
    await consumeRateLimits(ctx.db, ctx.clock.now(), keys);
  });

  // ---- response headers: CORS only for public routes; no-store and no CORS for everything else.
  app.addHook("onSend", async (request, reply, payload) => {
    const route = routeConfig(request);
    reply.removeHeader("access-control-allow-credentials");
    if (route.public) {
      reply.header("access-control-allow-origin", "*");
      reply.removeHeader("set-cookie");
    } else {
      reply.removeHeader("access-control-allow-origin");
      reply.header("cache-control", "no-store");
    }
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    const route = request.is404 ? "unmatched" : (request.routeOptions.url ?? "unmatched");
    ctx.metrics.observe("http_request", reply.elapsedTime / 1000, { method: request.method, route, status: String(reply.statusCode) });
    request.log.info({ method: request.method, route, path: pathOnly(request.url), statusCode: reply.statusCode, durationMs: Math.round(reply.elapsedTime) }, "request completed");
  });

  app.decorate("requireSession", async (request: FastifyRequest) => {
    if (!request.session) throw new ApiError("UNAUTHENTICATED", "Sign in required");
  });
  app.decorate("requireAdmin", async (request: FastifyRequest) => {
    const session = request.session;
    if (!session) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    if (!session.isAdmin) throw new ApiError("FORBIDDEN", "Administrator access required");
    const age = (ctx.clock.now().getTime() - session.authenticatedAt.getTime()) / 1000;
    if (age > ADMIN_STEP_UP_SECONDS) throw new ApiError("STEP_UP_REQUIRED", "Sign in again to continue");
  });

  app.setErrorHandler((error, request, reply: FastifyReply) => {
    const response = toErrorResponse(mapPlatformError(error), String(request.id), ctx.redact);
    if (response.statusCode >= 500) {
      request.log.error({ error: safeErrorMessage(error, ctx.redact), code: response.body.error.code, route: request.is404 ? null : request.routeOptions.url }, "request failed");
      ctx.metrics.increment("http_errors", { code: response.body.error.code });
    }
    if (response.retryAfterSeconds !== undefined) void reply.header("retry-after", String(response.retryAfterSeconds));
    void reply.status(response.statusCode).send(response.body);
  });

  app.setNotFoundHandler((request, reply) => {
    const response = toErrorResponse(new ApiError("NOT_FOUND", "Not found"), String(request.id), ctx.redact);
    void reply.status(response.statusCode).send(response.body);
  });

  // ---- platform routes
  app.get("/api/openapi.json", { config: { pine: { public: true } }, schema: { hide: true } }, async () => app.swagger());
  registerHealthRoutes(app, { ctx, readiness: options.readiness });
  registerAuthRoutes(app, { ctx, githubAuth: gateways.githubAuth, settings });
  await app.register(async (scope) => {
    registerWebhookRoute(scope, { ctx, githubAuth: gateways.githubAuth });
  });
  registerModerationRoutes(app, { db: ctx.db, moderation: new PostgresModeration(ctx.db, ctx.clock), audit: new PostgresAuditLog(ctx.db, ctx.redact) });

  // ---- modules, each in its own plugin scope
  for (const module of modules) {
    await app.register(async (scope) => {
      await module.register(scope, ctx);
    });
  }

  await app.ready();
  return app;
}
