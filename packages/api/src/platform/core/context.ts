// Composition of the platform services into the AppContext handed to every module (PRD-02 2.4).

import type { AppContext, Clock, Database, Metrics } from "../../contracts/app.js";
import type { AppConfig } from "../../contracts/config.js";
import type { Gateways } from "../../contracts/platform.js";
import type { Redactor } from "../../contracts/redact.js";
import type { ReadModel } from "@pine/shared/read-model";
import { PostgresAuditLog } from "./audit.js";
import { PlatformCompliance } from "./compliance.js";
import type { ServerSettings } from "./config.js";
import { createAuditingGitHub } from "./github-audit.js";
import { PostgresQuotas } from "./limits.js";
import { PostgresModeration } from "./moderation.js";

export const systemClock: Clock = { now: () => new Date() };

export interface CoreServices {
  audit: PostgresAuditLog;
  quotas: PostgresQuotas;
  moderation: PostgresModeration;
  compliance: PlatformCompliance;
}

/** Services that exist before the gateways (moderation is a gateway dependency). */
export function createCoreServices(deps: { config: AppConfig; db: Database; clock: Clock; redact: Redactor; settings: ServerSettings }): CoreServices {
  const audit = new PostgresAuditLog(deps.db, deps.redact);
  return {
    audit,
    quotas: new PostgresQuotas(deps.db, deps.clock, deps.settings.quotas),
    moderation: new PostgresModeration(deps.db, deps.clock),
    compliance: new PlatformCompliance({
      db: deps.db,
      audit,
      environment: deps.config.environment,
      termsDigest: deps.settings.termsDigest,
      trustProxyHops: deps.settings.trustProxyHops,
      compliance: deps.settings.compliance,
      sanctions: deps.settings.sanctions,
    }),
  };
}

export function createAppContext(deps: {
  config: AppConfig;
  db: Database;
  clock: Clock;
  redact: Redactor;
  metrics: Metrics;
  readModel: ReadModel;
  gateways: Pick<Gateways, "github" | "githubAuth" | "contentStore" | "chain">;
  services: CoreServices;
  onAuditError?: (error: unknown) => void;
}): AppContext {
  return {
    config: deps.config,
    db: deps.db,
    clock: deps.clock,
    redact: deps.redact,
    readModel: deps.readModel,
    chain: deps.gateways.chain,
    contentStore: deps.gateways.contentStore,
    github: createAuditingGitHub(deps.gateways.github, deps.gateways.githubAuth, deps.services.audit, deps.onAuditError),
    audit: deps.services.audit,
    moderation: deps.services.moderation,
    compliance: deps.services.compliance,
    quotas: deps.services.quotas,
    metrics: deps.metrics,
  };
}
