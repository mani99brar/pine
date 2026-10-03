// The claims RouteModule (PRD-03): policy catalog, GitHub browsing, drafts, immutable previews, publication plans and
// reconciliation, claim integrity, public listings and agent discovery.

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppContext, RouteModule } from "../../contracts/app.js";
import { registerAgentRoutes } from "./agents.js";
import { registerDraftRoutes } from "./drafts.js";
import { registerGitHubRoutes } from "./github.js";
import { integrityJob } from "./integrity.js";
import { registerListingRoutes } from "./listings.js";
import { registerPolicyRoutes } from "./policies.js";
import { registerPreviewRoutes } from "./preview.js";
import { registerPublicationRoutes } from "./publications.js";
import { reconcileJob } from "./reconcile.js";
import { createStateLoader, withZod } from "./state.js";

export interface ClaimsModuleOptions {
  /** Directory holding catalog.json and the policy files it lists. */
  catalogDir: string;
}

/**
 * Builds the module. The catalog is loaded and verified (and config.seer checked against the deployment manifest) by
 * one memoized loader that register() and every job run call, so a tampered catalog or a disagreeing configuration
 * refuses startup and jobs never depend on register() having run in the same process.
 */
export function createClaimsModule(options: ClaimsModuleOptions): RouteModule {
  const load = createStateLoader(options.catalogDir);
  const stateFor = (ctx: AppContext) => load(ctx.config);
  return {
    name: "claims",
    async register(app, ctx) {
      const state = stateFor(ctx);
      const deps = { app: withZod(app), ctx, state };
      registerPolicyRoutes(deps);
      registerGitHubRoutes(deps);
      registerDraftRoutes(deps);
      registerPreviewRoutes(deps);
      registerPublicationRoutes(deps);
      registerListingRoutes(deps);
      registerAgentRoutes(deps);
    },
    jobs: [reconcileJob(stateFor), integrityJob(stateFor)],
  };
}

/** <repo>/policies/catalog, resolved from this file (packages/api/src/modules/claims). */
export const DEFAULT_CATALOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "policies", "catalog");

export const claimsModule: RouteModule = createClaimsModule({ catalogDir: DEFAULT_CATALOG_DIR });
