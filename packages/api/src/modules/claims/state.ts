// Module state shared by routes and jobs: the verified policy catalog and the deployment manifest. One memoized loader
// is called by register() and by every job run, so jobs never depend on register() having run in the same process.

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { DeploymentManifest } from "@pine/shared/deployment";
import type { AppContext } from "../../contracts/app.js";
import type { AppConfig } from "../../contracts/config.js";
import { loadPolicyCatalog, type PolicyCatalog } from "./catalog.js";
import { assertConfigMatchesManifest, manifestOf } from "./common.js";

export interface ClaimsState {
  catalog: PolicyCatalog;
  manifest: DeploymentManifest;
}

export const withZod = (app: FastifyInstance) => app.withTypeProvider<ZodTypeProvider>();
export type ZodApp = ReturnType<typeof withZod>;

export interface ClaimsRouteDeps {
  app: ZodApp;
  ctx: AppContext;
  state: ClaimsState;
}

export function createStateLoader(catalogDir: string): (config: AppConfig) => ClaimsState {
  let catalog: PolicyCatalog | null = null;
  const manifests = new WeakMap<AppConfig, DeploymentManifest>();
  return (config) => {
    catalog ??= loadPolicyCatalog(catalogDir);
    let manifest = manifests.get(config);
    if (!manifest) {
      manifest = manifestOf(config);
      assertConfigMatchesManifest(config, manifest);
      manifests.set(config, manifest);
    }
    return { catalog, manifest };
  };
}
