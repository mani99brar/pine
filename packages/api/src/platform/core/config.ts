// Fail-closed configuration loader (PRD-02 2.1, SEC-OPS-01). Every value comes from the environment, is validated
// with zod, and any missing or invalid value is a startup error naming the variable, never its value. Secrets are
// returned separately (PlatformSecrets) and are never placed in AppConfig or ServerSettings.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { GNOSIS_EXTERNAL } from "@pine/shared/deployment";
import type { Address, Hex32 } from "@pine/shared/types";
import type { ComplianceAction, QuotaName } from "../../contracts/app.js";
import type { AmmAddresses, AppConfig, DeploymentEnvironment, SeerAddresses } from "../../contracts/config.js";
import type { PlatformSecrets } from "../../contracts/platform.js";
import { createRedactor, type Redactor } from "../../contracts/redact.js";

export const COMPLIANCE_ACTIONS: readonly ComplianceAction[] = ["publish_claim", "fund_market", "submit_evidence", "answer_oracle", "redeem"];

export const QUOTA_NAMES: readonly QuotaName[] = [
  "claim_drafts_per_day",
  "publications_per_day",
  "plans_per_day",
  "evidence_uploads_per_day",
  "evidence_bytes_per_day",
  "github_calls_per_hour",
];

export const DEFAULT_QUOTA_LIMITS: Record<QuotaName, number> = {
  claim_drafts_per_day: 50,
  publications_per_day: 10,
  plans_per_day: 100,
  evidence_uploads_per_day: 100,
  evidence_bytes_per_day: 20 * 1024 * 1024,
  github_calls_per_hour: 500,
};

export interface QuotaSetting {
  limit: number;
  windowSeconds: number;
}

export interface ComplianceSettings {
  /** Lowercase request header carrying the ISO 3166-1 alpha-2 country, set by the trusted proxy/CDN; null when unset. */
  countryHeader: string | null;
  /** Upper-case country codes refused per action (451). */
  blockedCountries: Record<ComplianceAction, ReadonlySet<string>>;
  /** Actions that fail closed in production when the country is unknown. */
  countryRequiredActions: ReadonlySet<ComplianceAction>;
}

export interface SanctionsSettings {
  mode: "off" | "static";
  /** Lowercase addresses refused for every compliance action (static denylist file plus PINE_BLOCKED_WALLETS). */
  blockedWallets: ReadonlySet<string>;
}

/** Process settings that are neither part of the module-visible AppConfig nor secrets. */
export interface ServerSettings {
  host: string;
  port: number;
  metricsHost: string;
  metricsPort: number;
  userContentHost: string;
  userContentPort: number;
  /** Number of trusted reverse-proxy hops; 0 means trustProxy off. */
  trustProxyHops: number;
  ipFloodLimitPerMinute: number;
  userRateLimitPerMinute: number;
  /** Lowercase admin wallet allowlist, re-checked on every request (SEC-AUTH-21). */
  adminWallets: ReadonlySet<string>;
  /** 0x-prefixed lowercase sha256 of the current terms and risk disclosure. */
  termsDigest: Hex32;
  compliance: ComplianceSettings;
  sanctions: SanctionsSettings;
  quotas: Record<QuotaName, QuotaSetting>;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  databasePoolMax: number;
}

export interface LoadedConfig {
  config: AppConfig;
  secrets: PlatformSecrets;
  server: ServerSettings;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

export interface LoadConfigOptions {
  /** Reads the sanctions denylist file (injectable for tests). */
  readFile?: (path: string) => string;
}

const MAX_DENYLIST_ENTRIES = 100_000;

const SEER_ENV: Record<Exclude<keyof SeerAddresses, "questionTimeoutSeconds" | "klerosForeignChainId">, string> = {
  marketFactory: "PINE_SEER_MARKET_FACTORY",
  realityProxy: "PINE_SEER_REALITY_PROXY",
  gnosisRouter: "PINE_SEER_GNOSIS_ROUTER",
  conditionalTokens: "PINE_SEER_CONDITIONAL_TOKENS",
  wrapped1155Factory: "PINE_SEER_WRAPPED1155_FACTORY",
  collateralToken: "PINE_SEER_COLLATERAL_TOKEN",
  realitio: "PINE_SEER_REALITIO",
  arbitrator: "PINE_SEER_ARBITRATOR",
  klerosForeignProxy: "PINE_KLEROS_FOREIGN_PROXY",
};

const AMM_ENV: Record<keyof AmmAddresses, string> = {
  factory: "PINE_AMM_FACTORY",
  positionManager: "PINE_AMM_POSITION_MANAGER",
  quoter: "PINE_AMM_QUOTER",
};

const SEER_DEFAULTS: SeerAddresses = {
  marketFactory: GNOSIS_EXTERNAL.seer.marketFactory,
  realityProxy: GNOSIS_EXTERNAL.seer.realityProxy,
  gnosisRouter: GNOSIS_EXTERNAL.seer.gnosisRouter,
  conditionalTokens: GNOSIS_EXTERNAL.seer.conditionalTokens,
  wrapped1155Factory: GNOSIS_EXTERNAL.seer.wrapped1155Factory,
  collateralToken: GNOSIS_EXTERNAL.seer.collateralToken,
  realitio: GNOSIS_EXTERNAL.seer.realitio,
  arbitrator: GNOSIS_EXTERNAL.seer.arbitrator,
  questionTimeoutSeconds: GNOSIS_EXTERNAL.seer.questionTimeoutSeconds,
  klerosForeignProxy: GNOSIS_EXTERNAL.kleros.foreignProxy,
  klerosForeignChainId: GNOSIS_EXTERNAL.kleros.foreignChainId,
};

const AMM_DEFAULTS: AmmAddresses = {
  factory: GNOSIS_EXTERNAL.amm.factory,
  positionManager: GNOSIS_EXTERNAL.amm.positionManager,
  quoter: GNOSIS_EXTERNAL.amm.quoter,
};

const DEFAULT_MEDIA_TYPES = ["application/json", "text/plain", "application/gzip", "application/zip", "application/x-tar", "image/png", "image/jpeg"];

// ------------------------------------------------------------------------------------------------ field schemas

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-f]{64}$/;

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === "" ? undefined : value.trim()));

const requiredString = (message = "is required") => z.string({ error: message }).trim().min(1, message);

const integer = (options: { min: number; max: number; fallback?: number }) =>
  optionalString.transform((value, ctx) => {
    if (value === undefined) {
      if (options.fallback !== undefined) return options.fallback;
      ctx.addIssue({ code: "custom", message: "is required" });
      return z.NEVER;
    }
    if (!/^\d+$/.test(value)) {
      ctx.addIssue({ code: "custom", message: "must be a non-negative integer" });
      return z.NEVER;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < options.min || parsed > options.max) {
      ctx.addIssue({ code: "custom", message: `must be between ${options.min} and ${options.max}` });
      return z.NEVER;
    }
    return parsed;
  });

const bool = (fallback: boolean) =>
  optionalString.transform((value, ctx) => {
    if (value === undefined) return fallback;
    if (value === "true") return true;
    if (value === "false") return false;
    ctx.addIssue({ code: "custom", message: "must be true or false" });
    return z.NEVER;
  });

const origin = requiredString().transform((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "must be an absolute http(s) origin" });
    return z.NEVER;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    ctx.addIssue({ code: "custom", message: "must be an origin (scheme://host[:port]) without path, query or credentials" });
    return z.NEVER;
  }
  return url.origin;
});

/**
 * Every secret value is at least 16 characters: the frozen createRedactor ignores registered secrets shorter than 8
 * characters, so a short secret (e.g. a default admin secret "testing") would load and then leak unredacted.
 */
export const MIN_SECRET_LENGTH = 16;
const MAX_SECRET_LENGTH = 512;
const SECRET_LENGTH_MESSAGE = `must be ${MIN_SECRET_LENGTH}-${MAX_SECRET_LENGTH} characters`;
const SECRET_URL_LENGTH_MESSAGE = `must be at least ${MIN_SECRET_LENGTH} characters`;
const longEnough = (value: string | undefined) => value === undefined || value.length >= MIN_SECRET_LENGTH;

const secretString = requiredString().refine((value) => value.length >= MIN_SECRET_LENGTH && value.length <= MAX_SECRET_LENGTH, { message: SECRET_LENGTH_MESSAGE });
const optionalSecretString = optionalString.refine((value) => value === undefined || (value.length >= MIN_SECRET_LENGTH && value.length <= MAX_SECRET_LENGTH), {
  message: SECRET_LENGTH_MESSAGE,
});

const secretUrl = (protocols: readonly string[]) =>
  requiredString()
    .refine(longEnough, { message: SECRET_URL_LENGTH_MESSAGE })
    .refine(
    (value) => {
      try {
        return protocols.includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: `must be a ${protocols.map((p) => p.replace(":", "")).join("/")} URL` },
  );

const optionalSecretUrl = (protocols: readonly string[]) =>
  optionalString
    .refine(longEnough, { message: SECRET_URL_LENGTH_MESSAGE })
    .refine(
    (value) => {
      if (value === undefined) return true;
      try {
        return protocols.includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: `must be a ${protocols.map((p) => p.replace(":", "")).join("/")} URL` },
  );

const address = requiredString().regex(ADDRESS, "must be a 0x-prefixed 20-byte hex address").transform((value) => value.toLowerCase() as Address);
const optionalAddress = optionalString.refine((value) => value === undefined || ADDRESS.test(value), { message: "must be a 0x-prefixed 20-byte hex address" });

const csv = optionalString.transform((value) =>
  value === undefined
    ? []
    : value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
);

const addressList = csv.transform((items, ctx) => {
  const out: string[] = [];
  for (const item of items) {
    if (!ADDRESS.test(item)) {
      ctx.addIssue({ code: "custom", message: "must be a comma-separated list of 0x-prefixed 20-byte hex addresses" });
      return z.NEVER;
    }
    out.push(item.toLowerCase());
  }
  return out;
});

const countryList = csv.transform((items, ctx) => {
  const out: string[] = [];
  for (const item of items) {
    if (!/^[A-Za-z]{2}$/.test(item)) {
      ctx.addIssue({ code: "custom", message: "must be a comma-separated list of ISO 3166-1 alpha-2 country codes" });
      return z.NEVER;
    }
    out.push(item.toUpperCase());
  }
  return out;
});

interface ParsedKey {
  id: string;
  key: Uint8Array;
  encoded: string;
}

function parseKey(entry: string): ParsedKey | null {
  const separator = entry.indexOf(":");
  if (separator <= 0) return null;
  const id = entry.slice(0, separator).trim();
  const encoded = entry.slice(separator + 1).trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) return null;
  // Standard base64 of exactly 32 bytes (AES-256): 43 symbols and one padding character.
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return null;
  const key = new Uint8Array(Buffer.from(encoded, "base64"));
  if (key.length !== 32) return null;
  return { id, key, encoded };
}

const KEY_FORMAT = "must be <id>:<base64 of exactly 32 bytes> (id: 1-32 of A-Z a-z 0-9 _ -)";

const currentKey = requiredString().transform((value, ctx) => {
  const parsed = parseKey(value);
  if (!parsed) {
    ctx.addIssue({ code: "custom", message: KEY_FORMAT });
    return z.NEVER;
  }
  return parsed;
});

const previousKeys = csv.transform((items, ctx) => {
  const out: ParsedKey[] = [];
  for (const item of items) {
    const parsed = parseKey(item);
    if (!parsed) {
      ctx.addIssue({ code: "custom", message: `must be a comma-separated list; each entry ${KEY_FORMAT}` });
      return z.NEVER;
    }
    out.push(parsed);
  }
  return out;
});

const environmentSchema = z.enum(["development", "test", "staging", "production"], { error: "must be one of development, test, staging, production" });

const ENV_SCHEMA = z.object({
  PINE_ENVIRONMENT: environmentSchema,
  PINE_PUBLIC_ORIGIN: origin,
  PINE_API_ORIGIN: optionalString.pipe(z.union([z.undefined(), origin])),
  PINE_USER_CONTENT_ORIGIN: origin,
  PINE_CHAIN_ID: integer({ min: 1, max: 2 ** 31, fallback: 100 }),
  PINE_CLAIM_REGISTRY: address,
  PINE_EVIDENCE_REGISTRY: address,
  PINE_DEPLOYMENT_BLOCK: integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  PINE_SEER_QUESTION_TIMEOUT_SECONDS: integer({ min: 1, max: 365 * 86_400, fallback: SEER_DEFAULTS.questionTimeoutSeconds }),
  PINE_KLEROS_FOREIGN_CHAIN_ID: integer({ min: 1, max: 2 ** 31, fallback: SEER_DEFAULTS.klerosForeignChainId }),
  PINE_MIN_EVIDENCE_WINDOW_SECONDS: integer({ min: 86_400, max: 90 * 86_400, fallback: 3 * 86_400 }),
  PINE_MAX_EVIDENCE_WINDOW_SECONDS: integer({ min: 86_400, max: 90 * 86_400, fallback: 30 * 86_400 }),
  PINE_DEFAULT_EVIDENCE_WINDOW_SECONDS: integer({ min: 86_400, max: 90 * 86_400, fallback: 7 * 86_400 }),
  PINE_REVEAL_WINDOW_SECONDS: integer({ min: 12 * 3_600, max: 7 * 86_400, fallback: 48 * 3_600 }),
  PINE_DEFAULT_MIN_BOND_WEI: optionalString.transform((value, ctx) => {
    if (value === undefined) return 10n * 10n ** 18n;
    if (!/^(?:0|[1-9][0-9]{0,30})$/.test(value)) {
      ctx.addIssue({ code: "custom", message: "must be a base-10 integer amount in wei" });
      return z.NEVER;
    }
    return BigInt(value);
  }),
  PINE_ENABLED_POLICY_FAMILIES: csv.transform((items) => (items.length === 0 ? ["FUNC-001", "BOT-001"] : items)).pipe(
    z.array(z.string().regex(/^[A-Z]{2,8}-\d{3}$/, "must be a comma-separated list of policy family ids like FUNC-001")),
  ),
  PINE_ALLOW_DRAFT_POLICIES: bool(false),
  PINE_QUESTION_CATEGORY: optionalString.transform((value) => value ?? "misc").pipe(z.string().regex(/^[a-z0-9_-]{1,32}$/, "must be a short lowercase category")),
  PINE_QUESTION_LANGUAGE: optionalString.transform((value) => value ?? "en_US").pipe(z.string().regex(/^[a-z]{2}_[A-Z]{2}$/, "must look like en_US")),
  PINE_MAX_UPLOAD_BYTES: integer({ min: 1, max: 262_144, fallback: 262_144 }),
  PINE_ALLOWED_ARTIFACT_MEDIA_TYPES: csv.transform((items) => (items.length === 0 ? DEFAULT_MEDIA_TYPES : items)).pipe(
    z.array(z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/, "must be a comma-separated list of media types")),
  ),
  PINE_INDEXER_BACKEND: optionalString.transform((value) => value ?? "native").pipe(z.enum(["native", "envio"], { error: "must be native or envio" })),
  PINE_MAX_INDEXER_LAG_SECONDS: integer({ min: 1, max: 86_400, fallback: 900 }),

  PINE_HOST: optionalString.transform((value) => value ?? "127.0.0.1"),
  PINE_PORT: integer({ min: 0, max: 65_535, fallback: 3000 }),
  PINE_METRICS_HOST: optionalString.transform((value) => value ?? "127.0.0.1"),
  PINE_METRICS_PORT: integer({ min: 0, max: 65_535, fallback: 9464 }),
  PINE_USER_CONTENT_HOST: optionalString.transform((value) => value ?? "127.0.0.1"),
  PINE_USER_CONTENT_PORT: integer({ min: 0, max: 65_535, fallback: 3001 }),
  PINE_TRUST_PROXY_HOPS: optionalString.pipe(z.union([z.undefined(), z.string().regex(/^\d{1,2}$/, "must be an integer 0-99")])),
  PINE_IP_FLOOD_LIMIT_PER_MINUTE: integer({ min: 1, max: 1_000_000, fallback: 600 }),
  PINE_USER_RATE_LIMIT_PER_MINUTE: integer({ min: 1, max: 1_000_000, fallback: 120 }),
  PINE_ADMIN_WALLETS: addressList,
  PINE_TERMS_DIGEST: requiredString().regex(HEX32, "must be 0x-prefixed lowercase 32-byte hex"),
  PINE_COMPLIANCE_COUNTRY_HEADER: optionalString.pipe(
    z.union([z.undefined(), z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "must be an HTTP header name").transform((value) => value.toLowerCase())]),
  ),
  PINE_BLOCKED_COUNTRIES: countryList,
  PINE_BLOCKED_COUNTRIES_PUBLISH_CLAIM: countryList,
  PINE_BLOCKED_COUNTRIES_FUND_MARKET: countryList,
  PINE_BLOCKED_COUNTRIES_SUBMIT_EVIDENCE: countryList,
  PINE_BLOCKED_COUNTRIES_ANSWER_ORACLE: countryList,
  PINE_BLOCKED_COUNTRIES_REDEEM: countryList,
  PINE_SANCTIONS_MODE: optionalString.pipe(z.union([z.undefined(), z.enum(["off", "static"], { error: "must be off or static" })])),
  PINE_SANCTIONS_DENYLIST_PATH: optionalString,
  PINE_BLOCKED_WALLETS: addressList,
  PINE_QUOTA_CLAIM_DRAFTS_PER_DAY: integer({ min: 0, max: 1_000_000, fallback: DEFAULT_QUOTA_LIMITS.claim_drafts_per_day }),
  PINE_QUOTA_PUBLICATIONS_PER_DAY: integer({ min: 0, max: 1_000_000, fallback: DEFAULT_QUOTA_LIMITS.publications_per_day }),
  PINE_QUOTA_PLANS_PER_DAY: integer({ min: 0, max: 1_000_000, fallback: DEFAULT_QUOTA_LIMITS.plans_per_day }),
  PINE_QUOTA_EVIDENCE_UPLOADS_PER_DAY: integer({ min: 0, max: 1_000_000, fallback: DEFAULT_QUOTA_LIMITS.evidence_uploads_per_day }),
  PINE_QUOTA_EVIDENCE_BYTES_PER_DAY: integer({ min: 0, max: 2 ** 40, fallback: DEFAULT_QUOTA_LIMITS.evidence_bytes_per_day }),
  PINE_QUOTA_GITHUB_CALLS_PER_HOUR: integer({ min: 0, max: 1_000_000, fallback: DEFAULT_QUOTA_LIMITS.github_calls_per_hour }),
  PINE_LOG_LEVEL: optionalString
    .transform((value) => value ?? "info")
    .pipe(z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"], { error: "must be a pino log level" })),
  PINE_DATABASE_POOL_MAX: integer({ min: 1, max: 200, fallback: 10 }),

  // ---- secrets (no defaults, SEC-OPS-01)
  PINE_DATABASE_URL: secretUrl(["postgres:", "postgresql:"]),
  PINE_RPC_URL_PRIMARY: secretUrl(["https:", "http:"]),
  PINE_RPC_URL_SECONDARY: secretUrl(["https:", "http:"]),
  PINE_GITHUB_KIND: optionalString.transform((value) => value ?? "app").pipe(z.enum(["app", "oauth"], { error: "must be app or oauth" })),
  PINE_GITHUB_CLIENT_ID: requiredString().regex(/^[A-Za-z0-9._-]{1,128}$/, "must be a GitHub client id"),
  PINE_GITHUB_CLIENT_SECRET: secretString,
  PINE_GITHUB_WEBHOOK_SECRET: optionalString.refine((value) => value === undefined || (value.length >= MIN_SECRET_LENGTH && value.length <= MAX_SECRET_LENGTH), {
    message: SECRET_LENGTH_MESSAGE,
  }),
  PINE_TOKEN_KEY_CURRENT: currentKey,
  PINE_TOKEN_KEYS_PREVIOUS: previousKeys,
  PINE_KUBO_API_URL: optionalSecretUrl(["https:", "http:"]),
  PINE_PINNING_SERVICE_URL: optionalSecretUrl(["https:"]),
  PINE_PINNING_SERVICE_TOKEN: optionalSecretString,
  PINE_IPFS_GATEWAYS: csv.pipe(
    z.array(
      z.string().refine(
        (value) => {
          try {
            const url = new URL(value);
            return url.protocol === "https:" && !url.search && !url.hash;
          } catch {
            return false;
          }
        },
        { message: "must be a comma-separated list of https gateway URLs" },
      ),
    ),
  ),
  PINE_READ_MODEL_DATABASE_URL: optionalSecretUrl(["postgres:", "postgresql:"]),
  PINE_ENVIO_GRAPHQL_URL: optionalSecretUrl(["https:", "http:"]),
  PINE_ENVIO_ADMIN_SECRET: optionalSecretString,
  // Never used by the API (migrate.ts only), but registered with the redactor when present, so it is validated here too.
  PINE_MIGRATOR_DATABASE_URL: optionalSecretUrl(["postgres:", "postgresql:"]),
});

type ParsedEnv = z.output<typeof ENV_SCHEMA>;

/** Every environment variable the API reads (documented in .env.example). */
export const CONFIG_VARIABLES: readonly string[] = [...Object.keys(ENV_SCHEMA.shape), ...Object.values(SEER_ENV), ...Object.values(AMM_ENV)];

/** The variables whose values are secrets (registered with the redactor; never echoed). */
export const SECRET_VARIABLES = [
  "PINE_DATABASE_URL",
  "PINE_RPC_URL_PRIMARY",
  "PINE_RPC_URL_SECONDARY",
  "PINE_GITHUB_CLIENT_SECRET",
  "PINE_GITHUB_WEBHOOK_SECRET",
  "PINE_TOKEN_KEY_CURRENT",
  "PINE_TOKEN_KEYS_PREVIOUS",
  "PINE_KUBO_API_URL",
  "PINE_PINNING_SERVICE_URL",
  "PINE_PINNING_SERVICE_TOKEN",
  "PINE_READ_MODEL_DATABASE_URL",
  "PINE_ENVIO_GRAPHQL_URL",
  "PINE_ENVIO_ADMIN_SECRET",
  "PINE_MIGRATOR_DATABASE_URL",
] as const;

// ------------------------------------------------------------------------------------------------ helpers

/** Registrable-domain approximation: the last two DNS labels (IP literals compare whole). */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return host;
  const labels = host.split(".");
  return labels.slice(-2).join(".");
}

function sharesSite(a: string, b: string): boolean {
  const hostA = new URL(a).hostname.toLowerCase();
  const hostB = new URL(b).hostname.toLowerCase();
  return hostA === hostB || hostA.endsWith(`.${hostB}`) || hostB.endsWith(`.${hostA}`) || registrableDomain(hostA) === registrableDomain(hostB);
}

function parseDenylist(text: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const result = z
    .array(z.string().regex(/^0x[0-9a-f]{40}$/))
    .max(MAX_DENYLIST_ENTRIES)
    .safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Every secret string (and its common encodings) for createRedactor: the PlatformSecrets values plus the migrator URL,
 * which the API never uses but may still see in its environment (it is never part of PlatformSecrets).
 */
export function secretStrings(secrets: PlatformSecrets, env: Readonly<Record<string, string | undefined>> = {}): string[] {
  const keys = [secrets.tokenEncryptionKeys.current, ...secrets.tokenEncryptionKeys.previous].flatMap((entry) => {
    const buffer = Buffer.from(entry.key);
    return [buffer.toString("base64"), buffer.toString("base64url"), buffer.toString("hex")];
  });
  const values: (string | null | undefined)[] = [
    secrets.databaseUrl,
    secrets.rpcUrls.primary,
    secrets.rpcUrls.secondary,
    secrets.github.clientSecret,
    secrets.github.webhookSecret,
    secrets.ipfs.kuboApiUrl,
    secrets.ipfs.pinningServiceUrl,
    secrets.ipfs.pinningServiceToken,
    secrets.readModel.kind === "native" ? secrets.readModel.databaseUrl : secrets.readModel.graphqlUrl,
    secrets.readModel.kind === "envio" ? secrets.readModel.adminSecret : null,
    ...keys,
    env.PINE_MIGRATOR_DATABASE_URL,
  ];
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** The platform redactor (PRD-02 2.1): every secret of the loaded configuration and the migrator URL of `env`. */
export function createPlatformRedactor(secrets: PlatformSecrets, env: Readonly<Record<string, string | undefined>> = {}): Redactor {
  return createRedactor(secretStrings(secrets, env));
}

// ------------------------------------------------------------------------------------------------ loader

/**
 * Loads and validates the whole configuration. Throws ConfigError naming every bad variable (never a value).
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>, options: LoadConfigOptions = {}): LoadedConfig {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const problems: string[] = [];

  const parsed = ENV_SCHEMA.safeParse(env);
  const overrides = collectAddressOverrides(env, problems);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const variable = String(issue.path[0] ?? "environment");
      problems.push(`${variable} ${safeIssueMessage(issue.message)}`);
    }
    throw new ConfigError(dedupe(problems));
  }
  const e = parsed.data;
  const environment: DeploymentEnvironment = e.PINE_ENVIRONMENT;
  const production = environment === "production";

  const seer: SeerAddresses = { ...SEER_DEFAULTS, ...overrides.seer, questionTimeoutSeconds: e.PINE_SEER_QUESTION_TIMEOUT_SECONDS, klerosForeignChainId: e.PINE_KLEROS_FOREIGN_CHAIN_ID };
  const amm: AmmAddresses = { ...AMM_DEFAULTS, ...overrides.amm };

  const apiOrigin = e.PINE_API_ORIGIN ?? e.PINE_PUBLIC_ORIGIN;

  // ---- secrets
  const readModel = buildReadModelSecrets(e, problems);
  const previousIds = e.PINE_TOKEN_KEYS_PREVIOUS.map((entry) => entry.id);
  if (new Set([e.PINE_TOKEN_KEY_CURRENT.id, ...previousIds]).size !== previousIds.length + 1) {
    problems.push("PINE_TOKEN_KEYS_PREVIOUS key ids must be unique and differ from the current key id");
  }
  if ((e.PINE_PINNING_SERVICE_URL === undefined) !== (e.PINE_PINNING_SERVICE_TOKEN === undefined)) {
    problems.push("PINE_PINNING_SERVICE_URL and PINE_PINNING_SERVICE_TOKEN must be set together");
  }

  // ---- general consistency (every environment)
  if (e.PINE_MIN_EVIDENCE_WINDOW_SECONDS > e.PINE_DEFAULT_EVIDENCE_WINDOW_SECONDS || e.PINE_DEFAULT_EVIDENCE_WINDOW_SECONDS > e.PINE_MAX_EVIDENCE_WINDOW_SECONDS) {
    problems.push("PINE_DEFAULT_EVIDENCE_WINDOW_SECONDS must lie between PINE_MIN_EVIDENCE_WINDOW_SECONDS and PINE_MAX_EVIDENCE_WINDOW_SECONDS");
  }
  if (sameOrigin(e.PINE_USER_CONTENT_ORIGIN, e.PINE_PUBLIC_ORIGIN) || sameOrigin(e.PINE_USER_CONTENT_ORIGIN, apiOrigin)) {
    problems.push("PINE_USER_CONTENT_ORIGIN must differ from PINE_PUBLIC_ORIGIN and PINE_API_ORIGIN");
  }

  // ---- sanctions
  const sanctionsMode = e.PINE_SANCTIONS_MODE ?? "off";
  const blockedWallets = new Set<string>(e.PINE_BLOCKED_WALLETS);
  if (sanctionsMode === "static") {
    if (e.PINE_SANCTIONS_DENYLIST_PATH === undefined) {
      problems.push("PINE_SANCTIONS_DENYLIST_PATH is required when PINE_SANCTIONS_MODE is static");
    } else {
      let text: string | null = null;
      try {
        text = readFile(e.PINE_SANCTIONS_DENYLIST_PATH);
      } catch {
        problems.push("PINE_SANCTIONS_DENYLIST_PATH could not be read");
      }
      if (text !== null) {
        const entries = parseDenylist(text);
        if (entries === null) {
          problems.push(`PINE_SANCTIONS_DENYLIST_PATH must contain a JSON array of at most ${MAX_DENYLIST_ENTRIES} lowercase 0x-prefixed 20-byte hex addresses`);
        } else {
          for (const entry of entries) blockedWallets.add(entry);
        }
      }
    }
  }

  // ---- trust proxy
  const trustProxyHops = e.PINE_TRUST_PROXY_HOPS === undefined ? 0 : Number(e.PINE_TRUST_PROXY_HOPS);

  // ---- production refinements (PRD-02 2.1, 2.5a; SEC-OPS-01, SEC-AUTH-17)
  if (production) {
    for (const [variable, value] of [
      ["PINE_PUBLIC_ORIGIN", e.PINE_PUBLIC_ORIGIN],
      ["PINE_API_ORIGIN", apiOrigin],
      ["PINE_USER_CONTENT_ORIGIN", e.PINE_USER_CONTENT_ORIGIN],
    ] as const) {
      if (new URL(value).protocol !== "https:") problems.push(`${variable} must use https in production`);
    }
    if (apiOrigin !== e.PINE_PUBLIC_ORIGIN) problems.push("PINE_API_ORIGIN must equal PINE_PUBLIC_ORIGIN in production");
    if (sharesSite(e.PINE_USER_CONTENT_ORIGIN, e.PINE_PUBLIC_ORIGIN) || sharesSite(e.PINE_USER_CONTENT_ORIGIN, apiOrigin)) {
      problems.push("PINE_USER_CONTENT_ORIGIN must be on a different registrable domain than PINE_PUBLIC_ORIGIN");
    }
    if (e.PINE_CHAIN_ID !== 100) problems.push("PINE_CHAIN_ID must be 100 in production");
    if (e.PINE_ALLOW_DRAFT_POLICIES) problems.push("PINE_ALLOW_DRAFT_POLICIES must be false in production");
    if (e.PINE_ENABLED_POLICY_FAMILIES.includes("SC-001")) problems.push("PINE_ENABLED_POLICY_FAMILIES must not include SC-001 in production");
    if (e.PINE_RPC_URL_PRIMARY === e.PINE_RPC_URL_SECONDARY) problems.push("PINE_RPC_URL_PRIMARY and PINE_RPC_URL_SECONDARY must be different providers in production");
    if (e.PINE_COMPLIANCE_COUNTRY_HEADER === undefined) problems.push("PINE_COMPLIANCE_COUNTRY_HEADER is required in production");
    if (sanctionsMode !== "static") problems.push("PINE_SANCTIONS_MODE must be static in production");
    // Both pin targets (PRD-02 2.1, 3a): content must reach Pine's own Kubo node and the pinning provider.
    if (e.PINE_KUBO_API_URL === undefined) problems.push("PINE_KUBO_API_URL is required in production");
    if (e.PINE_PINNING_SERVICE_URL === undefined || e.PINE_PINNING_SERVICE_TOKEN === undefined) {
      problems.push("PINE_PINNING_SERVICE_URL and PINE_PINNING_SERVICE_TOKEN are required in production");
    }
    if (e.PINE_TRUST_PROXY_HOPS === undefined) {
      problems.push("PINE_TRUST_PROXY_HOPS must be set explicitly in production");
    } else if (trustProxyHops === 0 && e.PINE_COMPLIANCE_COUNTRY_HEADER !== undefined) {
      problems.push("PINE_TRUST_PROXY_HOPS must be at least 1 when PINE_COMPLIANCE_COUNTRY_HEADER is configured");
    }
    if (e.PINE_GITHUB_KIND === "app" && e.PINE_GITHUB_WEBHOOK_SECRET === undefined) {
      problems.push("PINE_GITHUB_WEBHOOK_SECRET is required in production when PINE_GITHUB_KIND is app");
    }
    for (const [key, variable] of Object.entries(SEER_ENV) as [keyof typeof SEER_ENV, string][]) {
      if (seer[key] !== SEER_DEFAULTS[key]) problems.push(`${variable} must equal the verified Gnosis deployment in production`);
    }
    if (seer.questionTimeoutSeconds !== SEER_DEFAULTS.questionTimeoutSeconds) problems.push("PINE_SEER_QUESTION_TIMEOUT_SECONDS must equal the verified Gnosis deployment in production");
    if (seer.klerosForeignChainId !== SEER_DEFAULTS.klerosForeignChainId) problems.push("PINE_KLEROS_FOREIGN_CHAIN_ID must equal the verified Gnosis deployment in production");
    for (const [key, variable] of Object.entries(AMM_ENV) as [keyof AmmAddresses, string][]) {
      if (amm[key] !== AMM_DEFAULTS[key]) problems.push(`${variable} must equal the verified Gnosis deployment in production`);
    }
  }

  if (problems.length > 0) throw new ConfigError(dedupe(problems));

  const config: AppConfig = {
    environment,
    publicOrigin: e.PINE_PUBLIC_ORIGIN,
    apiOrigin,
    userContentOrigin: e.PINE_USER_CONTENT_ORIGIN,
    chainId: e.PINE_CHAIN_ID,
    contracts: { claimRegistry: e.PINE_CLAIM_REGISTRY, evidenceRegistry: e.PINE_EVIDENCE_REGISTRY, deploymentBlock: BigInt(e.PINE_DEPLOYMENT_BLOCK) },
    seer,
    amm,
    claims: {
      minEvidenceWindowSeconds: e.PINE_MIN_EVIDENCE_WINDOW_SECONDS,
      maxEvidenceWindowSeconds: e.PINE_MAX_EVIDENCE_WINDOW_SECONDS,
      defaultEvidenceWindowSeconds: e.PINE_DEFAULT_EVIDENCE_WINDOW_SECONDS,
      revealWindowSeconds: e.PINE_REVEAL_WINDOW_SECONDS,
      defaultMinBondWei: e.PINE_DEFAULT_MIN_BOND_WEI,
      enabledPolicyFamilies: e.PINE_ENABLED_POLICY_FAMILIES,
      allowDraftPolicies: e.PINE_ALLOW_DRAFT_POLICIES,
      questionCategory: e.PINE_QUESTION_CATEGORY,
      questionLanguage: e.PINE_QUESTION_LANGUAGE,
    },
    evidence: { maxUploadBytes: e.PINE_MAX_UPLOAD_BYTES, allowedArtifactMediaTypes: e.PINE_ALLOWED_ARTIFACT_MEDIA_TYPES },
    indexerBackend: e.PINE_INDEXER_BACKEND,
    maxIndexerLagSeconds: e.PINE_MAX_INDEXER_LAG_SECONDS,
  };

  const secrets: PlatformSecrets = {
    databaseUrl: e.PINE_DATABASE_URL,
    rpcUrls: { primary: e.PINE_RPC_URL_PRIMARY, secondary: e.PINE_RPC_URL_SECONDARY },
    github: { kind: e.PINE_GITHUB_KIND, clientId: e.PINE_GITHUB_CLIENT_ID, clientSecret: e.PINE_GITHUB_CLIENT_SECRET, webhookSecret: e.PINE_GITHUB_WEBHOOK_SECRET ?? null },
    tokenEncryptionKeys: {
      current: { id: e.PINE_TOKEN_KEY_CURRENT.id, key: e.PINE_TOKEN_KEY_CURRENT.key },
      previous: e.PINE_TOKEN_KEYS_PREVIOUS.map((entry) => ({ id: entry.id, key: entry.key })),
    },
    ipfs: {
      kuboApiUrl: e.PINE_KUBO_API_URL ?? null,
      pinningServiceUrl: e.PINE_PINNING_SERVICE_URL ?? null,
      pinningServiceToken: e.PINE_PINNING_SERVICE_TOKEN ?? null,
      gatewayUrls: e.PINE_IPFS_GATEWAYS,
    },
    // buildReadModelSecrets pushed a problem when null, and problems throw above.
    readModel: readModel ?? { kind: "native", databaseUrl: "" },
  };

  const blocked = (specific: string[]): ReadonlySet<string> => new Set([...e.PINE_BLOCKED_COUNTRIES, ...specific]);
  const server: ServerSettings = {
    host: e.PINE_HOST,
    port: e.PINE_PORT,
    metricsHost: e.PINE_METRICS_HOST,
    metricsPort: e.PINE_METRICS_PORT,
    userContentHost: e.PINE_USER_CONTENT_HOST,
    userContentPort: e.PINE_USER_CONTENT_PORT,
    trustProxyHops,
    ipFloodLimitPerMinute: e.PINE_IP_FLOOD_LIMIT_PER_MINUTE,
    userRateLimitPerMinute: e.PINE_USER_RATE_LIMIT_PER_MINUTE,
    adminWallets: new Set(e.PINE_ADMIN_WALLETS),
    termsDigest: e.PINE_TERMS_DIGEST as Hex32,
    compliance: {
      countryHeader: e.PINE_COMPLIANCE_COUNTRY_HEADER ?? null,
      blockedCountries: {
        publish_claim: blocked(e.PINE_BLOCKED_COUNTRIES_PUBLISH_CLAIM),
        fund_market: blocked(e.PINE_BLOCKED_COUNTRIES_FUND_MARKET),
        submit_evidence: blocked(e.PINE_BLOCKED_COUNTRIES_SUBMIT_EVIDENCE),
        answer_oracle: blocked(e.PINE_BLOCKED_COUNTRIES_ANSWER_ORACLE),
        redeem: blocked(e.PINE_BLOCKED_COUNTRIES_REDEEM),
      },
      countryRequiredActions: new Set<ComplianceAction>(["publish_claim", "fund_market"]),
    },
    sanctions: { mode: sanctionsMode, blockedWallets },
    quotas: {
      claim_drafts_per_day: { limit: e.PINE_QUOTA_CLAIM_DRAFTS_PER_DAY, windowSeconds: 86_400 },
      publications_per_day: { limit: e.PINE_QUOTA_PUBLICATIONS_PER_DAY, windowSeconds: 86_400 },
      plans_per_day: { limit: e.PINE_QUOTA_PLANS_PER_DAY, windowSeconds: 86_400 },
      evidence_uploads_per_day: { limit: e.PINE_QUOTA_EVIDENCE_UPLOADS_PER_DAY, windowSeconds: 86_400 },
      evidence_bytes_per_day: { limit: e.PINE_QUOTA_EVIDENCE_BYTES_PER_DAY, windowSeconds: 86_400 },
      github_calls_per_hour: { limit: e.PINE_QUOTA_GITHUB_CALLS_PER_HOUR, windowSeconds: 3_600 },
    },
    logLevel: e.PINE_LOG_LEVEL,
    databasePoolMax: e.PINE_DATABASE_POOL_MAX,
  };

  return { config, secrets, server };
}

function buildReadModelSecrets(e: ParsedEnv, problems: string[]): PlatformSecrets["readModel"] | null {
  if (e.PINE_INDEXER_BACKEND === "native") {
    if (e.PINE_READ_MODEL_DATABASE_URL === undefined) {
      problems.push("PINE_READ_MODEL_DATABASE_URL is required when PINE_INDEXER_BACKEND is native");
      return null;
    }
    return { kind: "native", databaseUrl: e.PINE_READ_MODEL_DATABASE_URL };
  }
  if (e.PINE_ENVIO_GRAPHQL_URL === undefined) {
    problems.push("PINE_ENVIO_GRAPHQL_URL is required when PINE_INDEXER_BACKEND is envio");
    return null;
  }
  return { kind: "envio", graphqlUrl: e.PINE_ENVIO_GRAPHQL_URL, adminSecret: e.PINE_ENVIO_ADMIN_SECRET ?? null };
}

function collectAddressOverrides(env: Readonly<Record<string, string | undefined>>, problems: string[]): { seer: Partial<SeerAddresses>; amm: Partial<AmmAddresses> } {
  const seer: Partial<Record<keyof typeof SEER_ENV, Address>> = {};
  const amm: Partial<AmmAddresses> = {};
  const read = (variable: string): Address | undefined => {
    const result = optionalAddress.safeParse(env[variable]);
    if (!result.success) {
      problems.push(`${variable} must be a 0x-prefixed 20-byte hex address`);
      return undefined;
    }
    return result.data === undefined ? undefined : (result.data.toLowerCase() as Address);
  };
  for (const [key, variable] of Object.entries(SEER_ENV) as [keyof typeof SEER_ENV, string][]) {
    const value = read(variable);
    if (value !== undefined) seer[key] = value;
  }
  for (const [key, variable] of Object.entries(AMM_ENV) as [keyof AmmAddresses, string][]) {
    const value = read(variable);
    if (value !== undefined) amm[key] = value;
  }
  return { seer, amm };
}

function sameOrigin(a: string, b: string): boolean {
  return new URL(a).origin === new URL(b).origin;
}

/** Zod messages never echo input for the schemas above; still strip anything that could quote a value. */
function safeIssueMessage(message: string): string {
  const cleaned = message.replace(/received\s+.*$/i, "").trim();
  return cleaned.length > 0 && cleaned.length <= 200 && !/["'`]/.test(cleaned) ? cleaned : "is invalid";
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
