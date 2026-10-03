// Lane-local test app (PRD-04 section 4; decisions): mirrors the frozen `buildTestApp` request contract (zod type
// provider, `request.session` from the test header, `app.requireSession`, the shared error mapping) and additionally
// registers `@fastify/multipart` once with exactly the core options of PRD-02 section 2.2 and a logger writing to an
// in-memory stream, so tests can assert that nothing secret is ever logged. The module itself never registers multipart.
// Every inject waits for the request's audit flush (awaitAuditAfterInject, PRD-07 3c).

import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyRequest, type InjectOptions, type LightMyRequestResponse } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { AppContext, RouteModule, SessionInfo } from "../../../contracts/app.js";
import { ApiError, toErrorResponse } from "../../../contracts/errors.js";
import { ADMIN_STEP_UP_SECONDS, TEST_SESSION_HEADER } from "../../../contracts/testing.js";
import { settledAudit } from "../audit.js";

export interface LogCapture {
  readonly lines: string[];
  text(): string;
}

function readTestSession(request: FastifyRequest): SessionInfo | null {
  const raw = request.headers[TEST_SESSION_HEADER];
  if (typeof raw !== "string") return null;
  const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
  return {
    ...(parsed as unknown as SessionInfo),
    authenticatedAt: new Date(String(parsed.authenticatedAt)),
    idleExpiresAt: new Date(String(parsed.idleExpiresAt)),
    absoluteExpiresAt: new Date(String(parsed.absoluteExpiresAt)),
  };
}

export async function buildLaneTestApp(modules: RouteModule[], ctx: AppContext): Promise<{ app: FastifyInstance; logs: LogCapture }> {
  const lines: string[] = [];
  const logs: LogCapture = { lines, text: () => lines.join("") };
  const app = Fastify({
    logger: {
      level: "trace",
      stream: { write: (line: string) => void lines.push(line) },
      // Mirrors the platform rule: request logs carry the route pattern only (no query strings, cookies or headers).
      serializers: { req: (request: FastifyRequest) => ({ method: request.method, route: request.routeOptions?.url ?? null }) },
    },
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(multipart, { limits: { fileSize: ctx.config.evidence.maxUploadBytes, files: 1, fields: 10, parts: 11 } });
  app.decorateRequest("session", null);
  app.addHook("onRequest", async (request) => {
    request.session = readTestSession(request);
  });
  app.decorate("requireSession", async (request: FastifyRequest) => {
    if (!request.session) throw new ApiError("UNAUTHENTICATED", "Sign in required");
  });
  app.decorate("requireAdmin", async (request: FastifyRequest) => {
    if (!request.session) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    if (!request.session.isAdmin) throw new ApiError("FORBIDDEN", "Administrator access required");
    const age = (ctx.clock.now().getTime() - request.session.authenticatedAt.getTime()) / 1000;
    if (age > ADMIN_STEP_UP_SECONDS) throw new ApiError("STEP_UP_REQUIRED", "Sign in again to continue");
  });
  app.setErrorHandler((error, request, reply) => {
    // Logs the raw error (strictest choice for the "never logged" assertions: nothing is redacted on the way).
    request.log.error({ err: error }, "request failed");
    const response = toErrorResponse(error, String(request.id), ctx.redact);
    if (response.retryAfterSeconds !== undefined) void reply.header("retry-after", String(response.retryAfterSeconds));
    void reply.status(response.statusCode).send(response.body);
  });
  for (const module of modules) {
    await app.register(async (scope) => {
      await module.register(scope, ctx);
    });
  }
  await app.ready();
  awaitAuditAfterInject(app, ctx);
  return { app, logs };
}

/** The unwrapped inject of each test app (see awaitAuditAfterInject). */
const rawInjects = new WeakMap<FastifyInstance, FastifyInstance["inject"]>();

/**
 * Test-harness rule (PRD-07 3c, operator decision): handlers start the audit flush without awaiting it, so every
 * inject of a test app waits for the module's in-flight flush after the response (it requests no further drain). The
 * existing exact-match audit tests therefore see the recorded entries right after the response.
 */
function awaitAuditAfterInject(app: FastifyInstance, ctx: AppContext): void {
  const raw = app.inject.bind(app) as FastifyInstance["inject"];
  rawInjects.set(app, raw);
  const wrapped = async (options: InjectOptions | string): Promise<LightMyRequestResponse> => {
    const response = await raw(options);
    await settledAudit(ctx);
    return response;
  };
  app.inject = wrapped as unknown as FastifyInstance["inject"];
}

/** An inject that does not wait for the audit flush its request started (the "slow audit store" tests). */
export function rawInject(app: FastifyInstance, options: InjectOptions): Promise<LightMyRequestResponse> {
  const raw = rawInjects.get(app);
  if (!raw) throw new Error("not a lane test app");
  return raw(options);
}
