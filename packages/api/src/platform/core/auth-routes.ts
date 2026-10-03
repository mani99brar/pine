// Authentication routes (PRD-02 2.3): SIWE challenge/verify, session, logout, GitHub linking and the GitHub webhook.
// Every SIWE failure is one generic UNAUTHENTICATED plus an audit entry with the server-side reason (SEC-AUTH-08).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { addressSchema } from "@pine/shared/types";
import type { AppContext } from "../../contracts/app.js";
import { GitHubGatewayError } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import type { GitHubAuthFlow } from "../../contracts/platform.js";
import { safeErrorMessage } from "../../contracts/redact.js";
import { requestCountry } from "./compliance.js";
import type { ServerSettings } from "./config.js";
import { queryRows } from "./db.js";
import { consumeRateLimits, ipBucket } from "./limits.js";
import { clearSessionCookie, deleteSession, deleteUserSessions, PRESESSION_COOKIE, rotateSession, setSessionCookie } from "./sessions.js";
import { challengedAddress, issueChallenge, nonceOf, PRESESSION_TTL_MS, SiweFailure, verifyChallenge, type SiweSettings } from "./siwe.js";
import { sql } from "drizzle-orm";

/** SEC-AUTH-08: challenge and verify, per IP (route limit) and per address. */
export const SIWE_RATE_LIMIT_PER_MINUTE = 20;
export const WEBHOOK_BODY_LIMIT = 64 * 1024;
export const WEBHOOK_PATH = "/api/v1/webhooks/github";
/** Upper bound of github.webhook.rejected audit rows per minute across all clients (anonymous traffic). */
export const WEBHOOK_REJECTED_AUDITS_PER_MINUTE = 60;

interface AuthDeps {
  ctx: AppContext;
  githubAuth: GitHubAuthFlow;
  settings: ServerSettings;
}

function readCookie(app: FastifyInstance, request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== "string" || header.length > 8192) return undefined;
  return app.parseCookie(header)[name];
}

function failureReason(error: unknown): string {
  if (error instanceof ApiError) return `api_${error.code.toLowerCase()}`;
  if (error instanceof GitHubGatewayError) return `github_${error.code.toLowerCase()}`;
  return "internal_error";
}

const sessionView = z.object({
  wallet: z.string(),
  githubUserId: z.number().nullable(),
  githubLogin: z.string().nullable(),
  isAdmin: z.boolean(),
  termsDigest: z.string(),
  termsAccepted: z.boolean(),
  authenticatedAt: z.string(),
  idleExpiresAt: z.string(),
  absoluteExpiresAt: z.string(),
});

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { ctx, githubAuth, settings } = deps;
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const siwe: SiweSettings = { publicOrigin: ctx.config.publicOrigin, chainId: ctx.config.chainId, termsDigest: settings.termsDigest };
  const redirect = (reply: FastifyReply, outcome: "linked" | "error") => reply.status(303).header("location", `${ctx.config.publicOrigin}/settings?github=${outcome}`).send();

  typed.post(
    "/api/v1/auth/siwe/challenge",
    {
      config: {
        pine: { rateLimitPerMinute: SIWE_RATE_LIMIT_PER_MINUTE },
        pineCore: { bodyRateLimitKeys: async (request) => [{ key: `siwe:${(request.body as { address: string }).address}`, limit: SIWE_RATE_LIMIT_PER_MINUTE }] },
      },
      schema: {
        body: z.object({ address: addressSchema }).strict(),
        response: { 200: z.object({ message: z.string(), nonce: z.string(), expiresAt: z.string() }) },
      },
    },
    async (request, reply) => {
      const now = ctx.clock.now();
      const address = request.body.address;
      const result = await issueChallenge(ctx.db, siwe, { address, presessionCookie: readCookie(app, request, PRESESSION_COOKIE), now });
      if (result.presessionToken !== null) {
        void reply.setCookie(PRESESSION_COOKIE, result.presessionToken, { path: "/", secure: true, httpOnly: true, sameSite: "strict", maxAge: PRESESSION_TTL_MS / 1000 });
      }
      return { message: result.message, nonce: result.nonce, expiresAt: result.expiresAt.toISOString() };
    },
  );

  typed.post(
    "/api/v1/auth/siwe/verify",
    {
      config: {
        pine: { rateLimitPerMinute: SIWE_RATE_LIMIT_PER_MINUTE },
        pineCore: {
          // For verify the per-address window is the challenged address of the stored message.
          bodyRateLimitKeys: async (request) => {
            const nonce = nonceOf((request.body as { message: string }).message);
            const challenged = nonce === null ? null : await challengedAddress(ctx.db, nonce);
            return challenged === null ? [] : [{ key: `siwe:${challenged}`, limit: SIWE_RATE_LIMIT_PER_MINUTE }];
          },
        },
      },
      schema: {
        body: z.object({ message: z.string().min(1).max(4096), signature: z.string().min(1).max(1024) }).strict(),
        response: { 200: sessionView },
      },
    },
    async (request, reply) => {
      const now = ctx.clock.now();
      const { message, signature } = request.body;
      const nonce = nonceOf(message);
      const challenged = nonce === null ? null : await challengedAddress(ctx.db, nonce);
      let result;
      try {
        result = await verifyChallenge(ctx.db, siwe, {
          message,
          signature,
          presessionCookie: readCookie(app, request, PRESESSION_COOKIE),
          now,
          country: requestCountry(request, settings),
        });
      } catch (error) {
        if (!(error instanceof SiweFailure)) throw error;
        await ctx.audit.record({
          actorUserId: null,
          action: "auth.siwe.failed",
          subjectType: "wallet",
          subjectId: error.address ?? challenged ?? "unknown",
          details: { reason: error.reason },
          ip: request.ip,
        });
        ctx.metrics.increment("siwe_failures", { reason: error.reason });
        throw new ApiError("UNAUTHENTICATED", "Sign-in failed");
      }
      setSessionCookie(reply, result.token, result.session, now);
      void reply.clearCookie(PRESESSION_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "strict" });
      await ctx.audit.record({
        actorUserId: result.userId,
        action: "auth.siwe.succeeded",
        subjectType: "user",
        subjectId: result.userId,
        details: { wallet: result.address, termsDigest: settings.termsDigest, admin: settings.adminWallets.has(result.address) },
        ip: request.ip,
      });
      const identity = await githubAuth.identityOf(result.userId);
      return {
        wallet: result.address,
        githubUserId: identity?.githubUserId ?? null,
        githubLogin: identity?.login ?? null,
        isAdmin: settings.adminWallets.has(result.address),
        termsDigest: settings.termsDigest,
        termsAccepted: true,
        authenticatedAt: result.session.authenticatedAt.toISOString(),
        idleExpiresAt: result.session.idleExpiresAt.toISOString(),
        absoluteExpiresAt: result.session.absoluteExpiresAt.toISOString(),
      };
    },
  );

  typed.get("/api/v1/auth/session", { preHandler: app.requireSession, schema: { response: { 200: sessionView } } }, async (request) => {
    const session = request.session;
    if (!session) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    const accepted = await queryRows(
      ctx.db,
      sql`SELECT 1::int AS ok FROM terms_acceptances WHERE user_id = ${session.userId}::uuid AND terms_digest = ${settings.termsDigest} LIMIT 1`,
    );
    return {
      wallet: session.wallet,
      githubUserId: session.githubUserId,
      githubLogin: session.githubLogin,
      isAdmin: session.isAdmin,
      termsDigest: settings.termsDigest,
      termsAccepted: accepted.length > 0,
      authenticatedAt: session.authenticatedAt.toISOString(),
      idleExpiresAt: session.idleExpiresAt.toISOString(),
      absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
    };
  });

  typed.post(
    "/api/v1/auth/logout",
    { schema: { body: z.object({ everywhere: z.boolean().optional() }).strict().nullish() } },
    async (request, reply) => {
      const session = request.session;
      if (session) {
        const everywhere = request.body?.everywhere === true;
        if (everywhere) await deleteUserSessions(ctx.db, session.userId);
        else await deleteSession(ctx.db, session.sessionId);
        await ctx.audit.record({ actorUserId: session.userId, action: "auth.logout", subjectType: "user", subjectId: session.userId, details: { everywhere }, ip: request.ip });
      }
      clearSessionCookie(reply);
      return reply.status(204).send();
    },
  );

  typed.post(
    "/api/v1/auth/github/start",
    { preHandler: app.requireSession, schema: { response: { 200: z.object({ authorizationUrl: z.string() }) } } },
    async (request) => {
      const session = request.session;
      if (!session) throw new ApiError("UNAUTHENTICATED", "Sign in required");
      const { authorizationUrl } = await githubAuth.start(session);
      await ctx.audit.record({ actorUserId: session.userId, action: "github.link.started", subjectType: "user", subjectId: session.userId, details: {}, ip: request.ip });
      return { authorizationUrl };
    },
  );

  // Top-level GET navigation from GitHub; protected by the single-use state bound to the session (SEC-GH-03,
  // SEC-AUTH-15 allowlisted exception). Every failure links nothing, is audited and redirects to ?github=error.
  app.get("/api/v1/auth/github/callback", { schema: { hide: true } }, async (request, reply) => {
    const session = request.session;
    const fail = async (reason: string) => {
      await ctx.audit.record({
        actorUserId: session?.userId ?? null,
        action: "github.link.failed",
        subjectType: "user",
        subjectId: session?.userId ?? "anonymous",
        details: { reason },
        ip: request.ip,
      });
      return redirect(reply, "error");
    };
    if (!session) return fail("no_session");
    const query = z.object({ code: z.string().min(1).max(512), state: z.string().min(1).max(512) }).safeParse(request.query);
    if (!query.success) return fail("invalid_callback");
    let identity;
    try {
      identity = await githubAuth.complete(session, { code: query.data.code, state: query.data.state });
    } catch (error) {
      request.log.info({ error: safeErrorMessage(error, ctx.redact) }, "github link failed");
      return fail(failureReason(error));
    }
    const now = ctx.clock.now();
    const rotated = await rotateSession(ctx.db, session.sessionId, now);
    if (rotated) setSessionCookie(reply, rotated.token, rotated.session, now);
    else clearSessionCookie(reply);
    await ctx.audit.record({
      actorUserId: session.userId,
      action: "github.link.succeeded",
      subjectType: "user",
      subjectId: session.userId,
      details: { githubUserId: identity.githubUserId, login: identity.login },
      ip: request.ip,
    });
    return redirect(reply, "linked");
  });

  app.delete("/api/v1/auth/github", { preHandler: app.requireSession }, async (request, reply) => {
    const session = request.session;
    if (!session) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    const before = await githubAuth.identityOf(session.userId);
    await githubAuth.unlink(session.userId);
    await deleteSession(ctx.db, session.sessionId);
    await ctx.audit.record({
      actorUserId: session.userId,
      action: "github.link.unlinked",
      subjectType: "user",
      subjectId: session.userId,
      details: { githubUserId: before?.githubUserId ?? null },
      ip: request.ip,
    });
    clearSessionCookie(reply);
    return reply.status(204).send();
  });
}

/**
 * Rejected-webhook audit sampling through the atomic fixed-window statement (no in-memory state): true only for the
 * first rejection of a client (IPv4, or IPv6 /64) in the current minute, and then only while the global budget of
 * WEBHOOK_REJECTED_AUDITS_PER_MINUTE lasts. The global window is consumed only by rejections that passed the per-client
 * window, so it counts audit rows.
 */
async function sampleRejectedWebhook(ctx: AppContext, ip: string): Promise<boolean> {
  const now = ctx.clock.now();
  try {
    // One all-or-nothing statement: the global window is consumed only together with a fresh per-client window.
    await consumeRateLimits(ctx.db, now, [
      { key: `webhook-rejected:${ipBucket(ip)}`, limit: 1 },
      { key: "webhook-rejected:global", limit: WEBHOOK_REJECTED_AUDITS_PER_MINUTE },
    ]);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.code === "RATE_LIMITED") return false;
    throw error;
  }
}

function headerToken(value: string | string[] | undefined, pattern: RegExp): string | null {
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === "string" && pattern.test(single) ? single : null;
}

/**
 * POST /api/v1/webhooks/github inside its own plugin scope: no session, CSRF-exempt, raw Buffer bodies (64 KiB) for
 * JSON and form encodings so the HMAC covers the exact bytes.
 */
export function registerWebhookRoute(scope: FastifyInstance, deps: { ctx: AppContext; githubAuth: GitHubAuthFlow }): void {
  const { ctx, githubAuth } = deps;
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser(["application/json", "application/x-www-form-urlencoded"], { parseAs: "buffer", bodyLimit: WEBHOOK_BODY_LIMIT }, (_request, body, done) => {
    done(null, body);
  });
  scope.post(WEBHOOK_PATH, { bodyLimit: WEBHOOK_BODY_LIMIT, config: { pineCore: { csrfExempt: true, noSession: true } }, schema: { hide: true } }, async (request, reply) => {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const signature = headerToken(request.headers["x-hub-signature-256"], /^[\x21-\x7e]{1,200}$/) ?? undefined;
    const details = {
      event: headerToken(request.headers["x-github-event"], /^[a-z_]{1,64}$/),
      delivery: headerToken(request.headers["x-github-delivery"], /^[0-9A-Za-z-]{1,64}$/),
    };
    try {
      await githubAuth.handleWebhook(raw, signature);
    } catch (error) {
      if (error instanceof ApiError && error.code === "UNAUTHENTICATED") {
        ctx.metrics.increment("github_webhook_rejected");
        try {
          if (await sampleRejectedWebhook(ctx, request.ip)) {
            await ctx.audit.record({ actorUserId: null, action: "github.webhook.rejected", subjectType: "github_webhook", subjectId: details.delivery ?? "unknown", details, ip: request.ip });
          }
        } catch (auditError) {
          // The answer stays 401: a failing audit write must not turn a forged delivery into a 500 GitHub would retry.
          request.log.error({ error: safeErrorMessage(auditError, ctx.redact) }, "github webhook rejection audit failed");
        }
        throw new ApiError("UNAUTHENTICATED", "Invalid webhook signature");
      }
      await ctx.audit.record({ actorUserId: null, action: "github.webhook.failed", subjectType: "github_webhook", subjectId: details.delivery ?? "unknown", details, ip: request.ip });
      // Any other failure is internal (GitHub redelivers on 5xx).
      request.log.error({ error: safeErrorMessage(error, ctx.redact) }, "github webhook failed");
      throw new ApiError("INTERNAL", "Internal error");
    }
    await ctx.audit.record({ actorUserId: null, action: "github.webhook.accepted", subjectType: "github_webhook", subjectId: details.delivery ?? "unknown", details, ip: request.ip });
    return reply.status(204).send();
  });
}
