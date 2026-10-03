// Process configuration from the environment, validated with zod and failing closed (PRD-05 section 2.3).

import { z } from "zod";
import { GNOSIS_EXTERNAL } from "@pine/shared/deployment";
import type { Address } from "@pine/shared/types";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address")
  .transform((value) => value.toLowerCase() as Address);
const rpcUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "must be an http(s) URL");

/**
 * The registrable-domain heuristic for provider independence: the last two DNS labels of the hostname. No public-suffix
 * list is available under the frozen dependencies, so two customers of one provider under a multi-label public suffix
 * (e.g. `a.example.co.uk` vs `b.other.co.uk`) are not told apart; operations must still pick two different companies.
 */
export function providerDomain(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/\.$/, "").split(".").slice(-2).join(".");
}
const integer = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,15}$/, "must be a non-negative integer")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const envSchema = z
  .object({
    DATABASE_URL: z.string().regex(/^postgres(?:ql)?:\/\//, "must be a postgres:// URL"),
    RPC_PRIMARY_URL: rpcUrl,
    RPC_SECONDARY_URL: rpcUrl,
    CHAIN_ID: z.literal("100"),
    CLAIM_REGISTRY_ADDRESS: address,
    EVIDENCE_REGISTRY_ADDRESS: address,
    DEPLOYMENT_BLOCK: integer(0, Number.MAX_SAFE_INTEGER),
    REALITY_ADDRESS: address.default(GNOSIS_EXTERNAL.seer.realitio),
    CONDITIONAL_TOKENS_ADDRESS: address.default(GNOSIS_EXTERNAL.seer.conditionalTokens),
    KLEROS_HOME_PROXY_ADDRESS: address.default(GNOSIS_EXTERNAL.kleros.homeProxy),
    QUESTION_TIMEOUT: integer(1, 2 ** 32 - 1).default(302_400),
    POLL_INTERVAL_MS: integer(500, 600_000).default(5_000),
    CHUNK_SIZE: integer(50, 2_000).default(500),
    METRICS_HOST: z.string().regex(/^[0-9a-zA-Z.:-]{1,253}$/).default("127.0.0.1"),
    METRICS_PORT: integer(1, 65_535).default(9464),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug"]).default("info"),
    /**
     * Local development only: allows http:// RPC URLs. Honoured only together with an explicit
     * PINE_INDEXER_ENV=development (never inferred from a missing NODE_ENV); refused otherwise and when NODE_ENV=production.
     */
    RPC_ALLOW_INSECURE_HTTP: z.enum(["true", "false"]).default("false"),
    /** Explicit deployment marker; only `development` unlocks RPC_ALLOW_INSECURE_HTTP. Unknown values are refused. */
    PINE_INDEXER_ENV: z.enum(["development", "production"]).optional(),
    NODE_ENV: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.RPC_PRIMARY_URL === env.RPC_SECONDARY_URL) ctx.addIssue({ code: "custom", path: ["RPC_SECONDARY_URL"], message: "the two RPC providers must differ" });
    else if (providerDomain(env.RPC_PRIMARY_URL) === providerDomain(env.RPC_SECONDARY_URL)) {
      ctx.addIssue({ code: "custom", path: ["RPC_SECONDARY_URL"], message: "the two RPC providers must be independent (different domains)" });
    }
    const insecure = env.RPC_ALLOW_INSECURE_HTTP === "true";
    if (insecure && (env.PINE_INDEXER_ENV !== "development" || env.NODE_ENV === "production")) {
      ctx.addIssue({ code: "custom", path: ["RPC_ALLOW_INSECURE_HTTP"], message: "http RPC is allowed only with PINE_INDEXER_ENV=development, never in production" });
    }
    for (const key of ["RPC_PRIMARY_URL", "RPC_SECONDARY_URL"] as const) {
      if (!insecure && !/^https:\/\//i.test(env[key])) ctx.addIssue({ code: "custom", path: [key], message: "must be an https URL" });
    }
    const addresses = [env.CLAIM_REGISTRY_ADDRESS, env.EVIDENCE_REGISTRY_ADDRESS, env.REALITY_ADDRESS, env.CONDITIONAL_TOKENS_ADDRESS, env.KLEROS_HOME_PROXY_ADDRESS];
    if (new Set(addresses).size !== addresses.length) ctx.addIssue({ code: "custom", path: ["CLAIM_REGISTRY_ADDRESS"], message: "indexed addresses must be distinct" });
  });

export interface IndexerConfig {
  databaseUrl: string;
  rpcPrimaryUrl: string;
  rpcSecondaryUrl: string;
  chainId: 100;
  addresses: { claimRegistry: Address; evidenceRegistry: Address; reality: Address; conditionalTokens: Address; klerosHomeProxy: Address };
  deploymentBlock: bigint;
  questionTimeout: number;
  pollIntervalMs: number;
  chunkSize: number;
  metricsHost: string;
  metricsPort: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug";
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Parses the environment. Error messages name the variables only, never their values (they may hold secrets). */
export function loadConfig(env: Record<string, string | undefined>): IndexerConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))].join(", ");
    throw new ConfigError(`Invalid indexer configuration: ${fields}`);
  }
  const e = result.data;
  return {
    databaseUrl: e.DATABASE_URL,
    rpcPrimaryUrl: e.RPC_PRIMARY_URL,
    rpcSecondaryUrl: e.RPC_SECONDARY_URL,
    chainId: 100,
    addresses: {
      claimRegistry: e.CLAIM_REGISTRY_ADDRESS,
      evidenceRegistry: e.EVIDENCE_REGISTRY_ADDRESS,
      reality: e.REALITY_ADDRESS,
      conditionalTokens: e.CONDITIONAL_TOKENS_ADDRESS,
      klerosHomeProxy: e.KLEROS_HOME_PROXY_ADDRESS,
    },
    deploymentBlock: BigInt(e.DEPLOYMENT_BLOCK),
    questionTimeout: e.QUESTION_TIMEOUT,
    pollIntervalMs: e.POLL_INTERVAL_MS,
    chunkSize: e.CHUNK_SIZE,
    metricsHost: e.METRICS_HOST,
    metricsPort: e.METRICS_PORT,
    logLevel: e.LOG_LEVEL,
  };
}

/** The secret-bearing parts of one URL (the URL itself, userinfo, long path segments and query values). */
export function urlSecrets(value: string): string[] {
  const secrets = [value];
  try {
    const url = new URL(value);
    if (url.password) secrets.push(decodeURIComponent(url.password));
    if (url.username) secrets.push(decodeURIComponent(url.username));
    for (const segment of url.pathname.split("/")) if (segment.length >= 8) secrets.push(segment);
    for (const item of url.searchParams.values()) if (item.length >= 8) secrets.push(item);
  } catch {
    // Not parseable: the whole value is registered above.
  }
  return secrets;
}

/** Every configured secret-bearing value, registered with the redactor (exact-match removal). */
export function configSecrets(config: IndexerConfig): string[] {
  return [config.databaseUrl, config.rpcPrimaryUrl, config.rpcSecondaryUrl].flatMap(urlSecrets);
}
