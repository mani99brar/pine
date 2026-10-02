// FROZEN. The route modules the platform registers, in order.
import type { RouteModule } from "./contracts/app.js";
import { claimsModule } from "./modules/claims/index.js";
import { marketsModule } from "./modules/markets/index.js";

export const routeModules: readonly RouteModule[] = [claimsModule, marketsModule];
