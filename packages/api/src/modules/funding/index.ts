// The funding RouteModule (PRD-04 section 3, ADR D8): market liquidity state, the YES sell-ladder funding plan,
// positions, withdraw/merge/redeem plans, and a reconciled funding history.

import type { RouteModule } from "../../contracts/app.js";
import { assertConfigMatchesManifest, manifestOf, withZod } from "./common.js";
import { registerExitRoutes } from "./exits.js";
import { registerHistoryRoutes } from "./history.js";
import { registerLadderRoutes } from "./ladder.js";
import { registerLiquidityRoutes } from "./liquidity.js";
import { registerPositionRoutes } from "./positions.js";
import { reconcileJob } from "./reconcile.js";

export const fundingModule: RouteModule = {
  name: "funding",
  async register(app, ctx) {
    const manifest = manifestOf(ctx.config);
    assertConfigMatchesManifest(ctx.config, manifest);
    const deps = { app: withZod(app), ctx, manifest };
    registerLiquidityRoutes(deps);
    registerLadderRoutes(deps);
    registerPositionRoutes(deps);
    registerExitRoutes(deps);
    registerHistoryRoutes(deps);
  },
  jobs: [reconcileJob],
};
