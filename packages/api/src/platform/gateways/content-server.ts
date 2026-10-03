// The user-content listener (SEC-EVID-06/07/11, ADR-0001 D11): a separate Fastify instance on the user-content
// registrable domain. It serves only GET/HEAD /c/:sha256 as an attachment with a sandbox CSP, never reads or sets
// cookies, has trustProxy off and no request logging. 451 when moderation blocks the digest, 404 when absent.
// No in-app per-IP rate limit: the edge proxy/CDN limits this host (decided, PRD-02 3.2).

import Fastify, { type FastifyInstance } from "fastify";
import type { ContentServer } from "../../contracts/platform.js";
import type { Redactor } from "../../contracts/redact.js";
import { safeErrorMessage } from "../../contracts/redact.js";
import type { ContentStoreInternals } from "./content-store.js";
import type { GatewayLogger } from "./log.js";

const DIGEST_PATTERN = /^0x[0-9a-f]{64}$/;

/** Headers on every response of the content host, whatever the status. */
const BASE_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "cross-origin",
  "x-frame-options": "DENY",
};

export function buildContentApp(store: ContentStoreInternals, redact: Redactor, log: GatewayLogger): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: false, requestIdHeader: false, bodyLimit: 1024 });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.removeHeader("set-cookie");
    for (const [name, value] of Object.entries(BASE_HEADERS)) void reply.header(name, value);
    if (reply.statusCode !== 200) {
      void reply.header("cache-control", "no-store");
      void reply.header("content-type", "text/plain; charset=utf-8");
      void reply.removeHeader("content-disposition");
    }
    return payload;
  });

  app.get<{ Params: { sha256: string } }>("/c/:sha256", async (request, reply) => {
    const sha256 = request.params.sha256.toLowerCase();
    if (!DIGEST_PATTERN.test(sha256)) return reply.code(404).send("Not found");
    const key = sha256 as `0x${string}`;
    if (await store.isBlocked(key)) return reply.code(451).send("Unavailable for legal reasons");
    const item = await store.get(key);
    if (!item) return reply.code(404).send("Not found");
    return reply
      .code(200)
      .header("content-type", "application/octet-stream")
      .header("content-disposition", `attachment; filename="${sha256}.bin"`)
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(Buffer.from(item.bytes));
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send("Not found");
  });
  app.setErrorHandler((error, _request, reply) => {
    log.error(`Content server error: ${safeErrorMessage(error, redact)}`);
    void reply.code(500).send("Internal error");
  });
  return app;
}

export function createContentServer(store: ContentStoreInternals, redact: Redactor, log: GatewayLogger): ContentServer {
  const app = buildContentApp(store, redact, log);
  return {
    async listen(options) {
      await app.listen({ host: options.host, port: options.port });
    },
    async close() {
      await app.close();
    },
  };
}
