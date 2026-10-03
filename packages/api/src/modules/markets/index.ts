// The markets RouteModule (PRD-04 section 2): evidence content intake, evidence plans and the salt-free reveal template,
// public evidence browsing and ERC-1497 output, oracle status with dueActions, oracle helper plans, the plan store with
// reconciliation, notifications and public account activity. The module never registers @fastify/multipart (the
// platform core does, once).

import type { DeploymentManifest } from "@pine/shared/deployment";
import type { AppContext, RouteModule } from "../../contracts/app.js";
import { registerAccountRoutes } from "./accounts.js";
import { assertConfig, BoundedCache, FanOutLimiter, manifestOf, withZod, type MarketsState } from "./common.js";
import { EVIDENCE_LIST_CACHE_ENTRIES, EVIDENCE_LIST_CACHE_SECONDS, registerEvidenceBrowseRoutes } from "./evidence-browse.js";
import { registerEvidenceContentRoutes } from "./evidence-content.js";
import { registerEvidencePlanRoutes } from "./evidence-plans.js";
import { registerNotificationRoutes, watchJob } from "./notifications.js";
import { registerOraclePlanRoutes } from "./oracle-plans.js";
import { ORACLE_CACHE_ENTRIES, ORACLE_CACHE_SECONDS, ORACLE_MAX_IN_FLIGHT, ORACLE_RETRY_AFTER_SECONDS, registerOracleStatusRoute } from "./oracle.js";
import { registerPlanRoutes } from "./plans.js";
import { reconcileJob } from "./reconcile.js";

/** Fresh per-process state of the module: the verified manifest, the public-route caches and the RPC fan-out limiter. */
export function createMarketsState(manifest: DeploymentManifest): MarketsState {
  return {
    manifest,
    retrievableCache: new Map(),
    oracleCache: new BoundedCache(ORACLE_CACHE_SECONDS, ORACLE_CACHE_ENTRIES),
    oracleFanOut: new FanOutLimiter(ORACLE_MAX_IN_FLIGHT, ORACLE_RETRY_AFTER_SECONDS),
    evidenceCache: new BoundedCache(EVIDENCE_LIST_CACHE_SECONDS, EVIDENCE_LIST_CACHE_ENTRIES),
  };
}

/**
 * Builds the module. State (the verified manifest, the public-route caches and the RPC fan-out limiter) is created once
 * per configuration by a loader that register() and every job run share, so jobs never depend on register() having
 * run in the same process.
 */
export function createMarketsModule(): RouteModule {
  const states = new WeakMap<object, MarketsState>();
  const stateFor = (ctx: AppContext): MarketsState => {
    let state = states.get(ctx.config);
    if (!state) {
      const manifest = manifestOf(ctx.config);
      assertConfig(ctx.config, manifest);
      state = createMarketsState(manifest);
      states.set(ctx.config, state);
    }
    return state;
  };
  return {
    name: "markets",
    async register(app, ctx) {
      const deps = { app: withZod(app), ctx, state: stateFor(ctx) };
      registerEvidenceContentRoutes(deps);
      registerEvidencePlanRoutes(deps);
      registerEvidenceBrowseRoutes(deps);
      registerOracleStatusRoute(deps);
      registerOraclePlanRoutes(deps);
      registerPlanRoutes(deps);
      registerNotificationRoutes(deps);
      registerAccountRoutes(deps);
    },
    jobs: [reconcileJob(stateFor), watchJob(stateFor)],
  };
}

export const marketsModule: RouteModule = createMarketsModule();
