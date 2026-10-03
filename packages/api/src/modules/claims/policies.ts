// Public policy catalog routes (PRD-03 §2).

import { z } from "zod";
import { ApiError } from "../../contracts/errors.js";
import { PUBLIC_ROUTE, sendPublic } from "./common.js";
import { policyIdSchema, policyVersionSchema, type PolicyEntry } from "./catalog.js";
import type { ClaimsRouteDeps } from "./state.js";

export const SERVER_SIDE_RULES_COMMENT =
  "Structural schema only. Text-safety rules (NFC, no control/bidi/zero-width characters), title rules and cross-field rules are enforced server-side only.";

/** Policies are not moderated content: a shared cache may keep them for five minutes. */
const POLICY_CACHE = { maxAgeSeconds: 300 } as const;

const policyParams =z.object({ id: policyIdSchema, version: policyVersionSchema }).strict();

export function registerPolicyRoutes({ app, ctx, state }: ClaimsRouteDeps): void {
  const summary = (entry: PolicyEntry) => ({
    id: entry.id,
    version: entry.version,
    title: entry.title,
    family: entry.family,
    sha256: entry.sha256,
    cid: entry.cid,
    status: entry.status,
    publishable: state.catalog.isPublishable(entry, ctx.config),
  });
  const find = (id: string, version: string): PolicyEntry => {
    const entry = state.catalog.get(id, version);
    if (!entry) throw new ApiError("NOT_FOUND", "Policy not found");
    return entry;
  };

  app.get("/api/v1/policies", { config: PUBLIC_ROUTE }, async (request, reply) =>
    sendPublic(request, reply, { policies: state.catalog.entries.map(summary) }, POLICY_CACHE),
  );

  app.get("/api/v1/policies/:id/:version", { config: PUBLIC_ROUTE, schema: { params: policyParams } }, async (request, reply) => {
    const entry = find(request.params.id, request.params.version);
    return sendPublic(request, reply, { ...summary(entry), bytes: entry.bytes, gate: entry.gate, mediaType: "text/markdown; charset=utf-8", text: entry.text }, POLICY_CACHE);
  });

  app.get("/api/v1/policies/:id/:version/parameters.schema.json", { config: PUBLIC_ROUTE, schema: { params: policyParams } }, async (request, reply) => {
    const entry = find(request.params.id, request.params.version);
    const schema = state.catalog.parameterSchema(entry.id, entry.version);
    if (!schema) throw new ApiError("NOT_FOUND", "This policy version has no parameter schema");
    const json = z.toJSONSchema(schema, { io: "input", target: "draft-7" }) as Record<string, unknown>;
    return sendPublic(request, reply, { ...json, $comment: SERVER_SIDE_RULES_COMMENT, title: `${entry.id}@${entry.version} policy parameters` }, POLICY_CACHE);
  });
}
