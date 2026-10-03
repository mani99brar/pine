import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_VARIABLES, ConfigError, createPlatformRedactor, loadConfig, registrableDomain, SECRET_VARIABLES } from "./config.js";

const KEY_A = Buffer.alloc(32, 7).toString("base64");
const KEY_B = Buffer.alloc(32, 9).toString("base64");
const DB_URL = "postgres://pine_api:db-password-123456@db.internal:5432/pine";
const RPC_A = "https://rpc-a.example.net/v1/rpc-key-aaaaaaaaaaaa";
const RPC_B = "https://rpc-b.example.org/v1/rpc-key-bbbbbbbbbbbb";
const CLIENT_SECRET = "github-client-secret-0123456789";
const WEBHOOK_SECRET = "github-webhook-secret-0123456789";
const DIGEST = `0x${"ab".repeat(32)}`;
const SANCTIONED = "0x00000000000000000000000000000000000bad01";
const KUBO_URL = "https://kubo.internal.example/api/v0";
const PINNING_URL = "https://pinning.example.com/psa";
const PINNING_TOKEN = "pinning-service-token-0123456789";

function devEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PINE_ENVIRONMENT: "development",
    PINE_PUBLIC_ORIGIN: "http://localhost:5173",
    PINE_USER_CONTENT_ORIGIN: "http://127.0.0.1:3001",
    PINE_CLAIM_REGISTRY: "0x00000000000000000000000000000000000c1a10",
    PINE_EVIDENCE_REGISTRY: "0x00000000000000000000000000000000000e01de",
    PINE_DEPLOYMENT_BLOCK: "1000",
    PINE_TERMS_DIGEST: DIGEST,
    PINE_DATABASE_URL: DB_URL,
    PINE_RPC_URL_PRIMARY: RPC_A,
    PINE_RPC_URL_SECONDARY: RPC_B,
    PINE_GITHUB_CLIENT_ID: "Iv1.0123456789abcdef",
    PINE_GITHUB_CLIENT_SECRET: CLIENT_SECRET,
    PINE_GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PINE_TOKEN_KEY_CURRENT: `k2:${KEY_A}`,
    PINE_TOKEN_KEYS_PREVIOUS: `k1:${KEY_B}`,
    PINE_READ_MODEL_DATABASE_URL: "postgres://pine_readonly:ro-password-123456@db.internal:5432/indexer",
    ...overrides,
  };
}

function prodEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return devEnv({
    PINE_ENVIRONMENT: "production",
    PINE_PUBLIC_ORIGIN: "https://verify.pine.example",
    PINE_USER_CONTENT_ORIGIN: "https://pine-usercontent.net",
    PINE_COMPLIANCE_COUNTRY_HEADER: "CF-IPCountry",
    PINE_TRUST_PROXY_HOPS: "1",
    PINE_SANCTIONS_MODE: "static",
    PINE_SANCTIONS_DENYLIST_PATH: "/etc/pine/denylist.json",
    PINE_KUBO_API_URL: KUBO_URL,
    PINE_PINNING_SERVICE_URL: PINNING_URL,
    PINE_PINNING_SERVICE_TOKEN: PINNING_TOKEN,
    ...overrides,
  });
}

const denylistFile = () => JSON.stringify([SANCTIONED]);

function refusal(env: Record<string, string | undefined>, readFile: (p: string) => string = denylistFile): ConfigError {
  try {
    loadConfig(env, { readFile });
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("expected loadConfig to refuse the configuration");
}

describe("loadConfig", () => {
  it("loads a valid development configuration with defaults", () => {
    const { config, secrets, server } = loadConfig(devEnv());
    expect(config.environment).toBe("development");
    expect(config.apiOrigin).toBe("http://localhost:5173");
    expect(config.chainId).toBe(100);
    expect(config.claims.allowDraftPolicies).toBe(false);
    expect(config.contracts.deploymentBlock).toBe(1000n);
    expect(secrets.tokenEncryptionKeys.current.id).toBe("k2");
    expect(secrets.tokenEncryptionKeys.current.key).toHaveLength(32);
    expect(secrets.tokenEncryptionKeys.previous.map((k) => k.id)).toEqual(["k1"]);
    expect(server.trustProxyHops).toBe(0);
    expect(server.ipFloodLimitPerMinute).toBe(600);
    expect(server.userRateLimitPerMinute).toBe(120);
    expect(server.sanctions.mode).toBe("off");
  });

  it("loads a valid production configuration and reads the sanctions denylist once", () => {
    const reads: string[] = [];
    const { config, server } = loadConfig(prodEnv(), {
      readFile: (p) => {
        reads.push(p);
        return denylistFile();
      },
    });
    expect(config.environment).toBe("production");
    expect(reads).toEqual(["/etc/pine/denylist.json"]);
    expect(server.sanctions.blockedWallets.has(SANCTIONED)).toBe(true);
    expect(server.compliance.countryHeader).toBe("cf-ipcountry");
  });

  for (const [backend, overrides] of [
    ["native", { PINE_READ_MODEL_DATABASE_URL: "postgres://pine_readonly:ro-password-123456@db.internal:5432/indexer" }],
    ["envio", { PINE_INDEXER_BACKEND: "envio", PINE_READ_MODEL_DATABASE_URL: undefined, PINE_ENVIO_GRAPHQL_URL: "https://envio.internal.example/v1/graphql-key-0123456789", PINE_ENVIO_ADMIN_SECRET: "envio-admin-secret-0123456789" }],
  ] as const) {
    it(`SEC-OPS-02 secrets are not part of AppConfig or ServerSettings (production, every secret set, ${backend} read model)`, () => {
      const env = prodEnv({ ...overrides, PINE_MIGRATOR_DATABASE_URL: "postgres://pine_migrator:migrator-password-123456@db.internal:5432/pine" });
      const { config, server } = loadConfig(env, { readFile: denylistFile });
      const serialized = JSON.stringify({ config, server }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof Set ? [...v] : v));
      const values = SECRET_VARIABLES.map((variable) => env[variable]).filter((value): value is string => value !== undefined);
      // Every secret variable that applies to this backend is set (Envio adds the GraphQL URL and admin secret).
      expect(values).toHaveLength(backend === "native" ? 12 : 13);
      const fragments = [KEY_A, KEY_B, "db-password-123456", "ro-password-123456", "migrator-password-123456", "rpc-key-aaaaaaaaaaaa", "rpc-key-bbbbbbbbbbbb", "graphql-key-0123456789"];
      for (const secret of [...values, ...fragments]) expect(serialized, secret).not.toContain(secret);
    });
  }

  it("loads compliance lists, wallet allowlists, quotas and loopback host defaults", () => {
    const checksummed = "0x00000000000000000000000000000000000000Ab";
    const admin = "0x00000000000000000000000000000000000000Cd";
    const { server } = loadConfig(
      devEnv({
        PINE_BLOCKED_COUNTRIES: "ru",
        PINE_BLOCKED_COUNTRIES_FUND_MARKET: "us",
        PINE_BLOCKED_COUNTRIES_PUBLISH_CLAIM: "kp",
        PINE_BLOCKED_COUNTRIES_SUBMIT_EVIDENCE: "ir",
        PINE_BLOCKED_COUNTRIES_ANSWER_ORACLE: "sy",
        PINE_BLOCKED_COUNTRIES_REDEEM: "cu",
        PINE_BLOCKED_WALLETS: checksummed,
        PINE_ADMIN_WALLETS: admin,
        PINE_QUOTA_CLAIM_DRAFTS_PER_DAY: "11",
        PINE_QUOTA_PUBLICATIONS_PER_DAY: "12",
        PINE_QUOTA_PLANS_PER_DAY: "13",
        PINE_QUOTA_EVIDENCE_UPLOADS_PER_DAY: "14",
        PINE_QUOTA_EVIDENCE_BYTES_PER_DAY: "15",
        PINE_QUOTA_GITHUB_CALLS_PER_HOUR: "16",
      }),
    );
    const sorted = (set: ReadonlySet<string>) => [...set].sort();
    expect(sorted(server.compliance.blockedCountries.fund_market)).toEqual(["RU", "US"]);
    expect(sorted(server.compliance.blockedCountries.publish_claim)).toEqual(["KP", "RU"]);
    expect(sorted(server.compliance.blockedCountries.submit_evidence)).toEqual(["IR", "RU"]);
    expect(sorted(server.compliance.blockedCountries.answer_oracle)).toEqual(["RU", "SY"]);
    expect(sorted(server.compliance.blockedCountries.redeem)).toEqual(["CU", "RU"]);
    expect(sorted(server.sanctions.blockedWallets)).toEqual([checksummed.toLowerCase()]);
    expect(sorted(server.adminWallets)).toEqual([admin.toLowerCase()]);
    expect(server.quotas).toEqual({
      claim_drafts_per_day: { limit: 11, windowSeconds: 86_400 },
      publications_per_day: { limit: 12, windowSeconds: 86_400 },
      plans_per_day: { limit: 13, windowSeconds: 86_400 },
      evidence_uploads_per_day: { limit: 14, windowSeconds: 86_400 },
      evidence_bytes_per_day: { limit: 15, windowSeconds: 86_400 },
      github_calls_per_hour: { limit: 16, windowSeconds: 3_600 },
    });
    // Internal listeners default to loopback (never 0.0.0.0).
    expect([server.host, server.metricsHost, server.userContentHost]).toEqual(["127.0.0.1", "127.0.0.1", "127.0.0.1"]);
  });

  for (const [variable, value] of [
    ["PINE_BLOCKED_COUNTRIES", "russia"],
    ["PINE_BLOCKED_COUNTRIES_FUND_MARKET", "U1"],
    ["PINE_BLOCKED_WALLETS", "0x1234"],
    ["PINE_ADMIN_WALLETS", "not-an-address"],
    ["PINE_QUOTA_PUBLICATIONS_PER_DAY", "-1"],
    ["PINE_QUOTA_GITHUB_CALLS_PER_HOUR", "ten"],
  ] as const) {
    it(`refuses an invalid ${variable} naming the variable`, () => {
      expect(refusal(devEnv({ [variable]: value })).message).toContain(variable);
    });
  }

  it("SEC-OPS-01 names a missing variable without echoing any value", () => {
    const error = refusal(devEnv({ PINE_DATABASE_URL: undefined }));
    expect(error.message).toContain("PINE_DATABASE_URL");
    const bad = refusal(devEnv({ PINE_RPC_URL_PRIMARY: "not a url rpc-key-aaaaaaaaaaaa" }));
    expect(bad.message).toContain("PINE_RPC_URL_PRIMARY");
    expect(bad.message).not.toContain("rpc-key");
  });

  it("SEC-OPS-01 refuses token keys that are not 32 bytes or have duplicate ids", () => {
    expect(refusal(devEnv({ PINE_TOKEN_KEY_CURRENT: `k2:${Buffer.alloc(16, 1).toString("base64")}` })).message).toContain("PINE_TOKEN_KEY_CURRENT");
    expect(refusal(devEnv({ PINE_TOKEN_KEYS_PREVIOUS: `k2:${KEY_B}` })).message).toContain("unique");
    const error = refusal(devEnv({ PINE_TOKEN_KEY_CURRENT: "k2:short-secret-key-material" }));
    expect(error.message).not.toContain("short-secret-key-material");
  });

  it("SEC-OPS-01 validates every previous token key: 32 bytes, base64, unique ids, no key material echoed", () => {
    const short = Buffer.alloc(16, 5).toString("base64");
    for (const value of [`k1:${short}`, "k1:not-base64-previous-key-material!", `k1:${KEY_B},k1:${Buffer.alloc(32, 3).toString("base64")}`]) {
      const error = refusal(devEnv({ PINE_TOKEN_KEYS_PREVIOUS: value }));
      expect(error.message, value).toContain("PINE_TOKEN_KEYS_PREVIOUS");
      for (const material of [short, "not-base64-previous-key-material", KEY_B, Buffer.alloc(32, 3).toString("base64")]) expect(error.message).not.toContain(material);
    }
  });

  describe("SEC-OPS-02 every secret variable is at least 16 characters (the redactor ignores secrets under 8)", () => {
    // One refusal per secret variable; the message names the variable and never echoes the value.
    const cases: [string, string, Record<string, string | undefined>][] = [
      ["PINE_DATABASE_URL", "postgres://a/b", {}],
      ["PINE_MIGRATOR_DATABASE_URL", "postgres://m/x", {}],
      ["PINE_RPC_URL_PRIMARY", "https://r.io/k", {}],
      ["PINE_RPC_URL_SECONDARY", "https://s.io/k", {}],
      ["PINE_GITHUB_CLIENT_SECRET", "testing", {}],
      ["PINE_GITHUB_WEBHOOK_SECRET", "testing", {}],
      ["PINE_TOKEN_KEY_CURRENT", "k2:testing", {}],
      ["PINE_TOKEN_KEYS_PREVIOUS", "k1:testing", {}],
      ["PINE_KUBO_API_URL", "http://k.io/a", {}],
      ["PINE_PINNING_SERVICE_URL", "https://p.io/a", { PINE_PINNING_SERVICE_TOKEN: PINNING_TOKEN }],
      ["PINE_PINNING_SERVICE_TOKEN", "testing", { PINE_PINNING_SERVICE_URL: PINNING_URL }],
      ["PINE_READ_MODEL_DATABASE_URL", "postgres://r/x", {}],
      ["PINE_ENVIO_GRAPHQL_URL", "https://e.io/g", { PINE_INDEXER_BACKEND: "envio", PINE_READ_MODEL_DATABASE_URL: undefined }],
      ["PINE_ENVIO_ADMIN_SECRET", "testing", { PINE_INDEXER_BACKEND: "envio", PINE_READ_MODEL_DATABASE_URL: undefined, PINE_ENVIO_GRAPHQL_URL: "https://envio.internal.example/v1/graphql" }],
    ];
    it("covers every secret variable", () => {
      expect(cases.map(([variable]) => variable).sort()).toEqual([...SECRET_VARIABLES].sort());
    });
    for (const [variable, value, extra] of cases) {
      it(`refuses a ${value.length}-character ${variable} naming the variable without echoing the value`, () => {
        expect(value.length).toBeLessThan(16);
        const error = refusal(devEnv({ ...extra, [variable]: value }));
        expect(error.message).toContain(variable);
        expect(error.message).not.toContain(value);
      });
    }
    it("accepts a 16-character admin secret and pinning token", () => {
      const sixteen = "abcdefghijklmnop";
      expect(() =>
        loadConfig(devEnv({ PINE_INDEXER_BACKEND: "envio", PINE_READ_MODEL_DATABASE_URL: undefined, PINE_ENVIO_GRAPHQL_URL: "https://envio.internal.example/v1/graphql", PINE_ENVIO_ADMIN_SECRET: sixteen, PINE_PINNING_SERVICE_URL: PINNING_URL, PINE_PINNING_SERVICE_TOKEN: sixteen })),
      ).not.toThrow();
    });
  });

  it("refuses a malformed terms digest", () => {
    expect(refusal(devEnv({ PINE_TERMS_DIGEST: `0x${"AB".repeat(32)}` })).message).toContain("PINE_TERMS_DIGEST");
    expect(refusal(devEnv({ PINE_TERMS_DIGEST: "ab".repeat(32) })).message).toContain("PINE_TERMS_DIGEST");
  });

  it("refuses a user-content origin equal to the public origin in every environment", () => {
    expect(refusal(devEnv({ PINE_USER_CONTENT_ORIGIN: "http://localhost:5173" })).message).toContain("PINE_USER_CONTENT_ORIGIN");
  });

  describe("production refinements (SEC-OPS-01)", () => {
    const cases: [string, Record<string, string | undefined>, string][] = [
      ["http public origin", { PINE_PUBLIC_ORIGIN: "http://verify.pine.example" }, "PINE_PUBLIC_ORIGIN must use https"],
      ["http user-content origin", { PINE_USER_CONTENT_ORIGIN: "http://pine-usercontent.net" }, "PINE_USER_CONTENT_ORIGIN must use https"],
      ["api origin differs from public origin", { PINE_API_ORIGIN: "https://api.pine.example" }, "PINE_API_ORIGIN must equal PINE_PUBLIC_ORIGIN"],
      ["SEC-AUTH-17 user content on a subdomain", { PINE_USER_CONTENT_ORIGIN: "https://content.verify.pine.example" }, "different registrable domain"],
      ["SEC-AUTH-17 user content on a sibling subdomain", { PINE_USER_CONTENT_ORIGIN: "https://usercontent.pine.example" }, "different registrable domain"],
      ["chain id other than 100", { PINE_CHAIN_ID: "10200" }, "PINE_CHAIN_ID must be 100"],
      ["draft policies allowed", { PINE_ALLOW_DRAFT_POLICIES: "true" }, "PINE_ALLOW_DRAFT_POLICIES must be false"],
      ["SC-001 enabled", { PINE_ENABLED_POLICY_FAMILIES: "FUNC-001,SC-001" }, "must not include SC-001"],
      ["identical RPC URLs", { PINE_RPC_URL_SECONDARY: RPC_A }, "must be different providers"],
      ["missing compliance country header", { PINE_COMPLIANCE_COUNTRY_HEADER: undefined }, "PINE_COMPLIANCE_COUNTRY_HEADER is required"],
      ["SEC-LEGAL-02 sanctions mode off", { PINE_SANCTIONS_MODE: "off" }, "PINE_SANCTIONS_MODE must be static"],
      ["SEC-LEGAL-02 sanctions mode unset", { PINE_SANCTIONS_MODE: undefined }, "PINE_SANCTIONS_MODE must be static"],
      ["SEC-OPS-04 implicit trust proxy", { PINE_TRUST_PROXY_HOPS: undefined }, "PINE_TRUST_PROXY_HOPS must be set explicitly"],
      ["trust proxy 0 with a country header", { PINE_TRUST_PROXY_HOPS: "0" }, "PINE_TRUST_PROXY_HOPS must be at least 1"],
      ["Seer address override", { PINE_SEER_MARKET_FACTORY: "0x0000000000000000000000000000000000000001" }, "PINE_SEER_MARKET_FACTORY must equal"],
      ["AMM address override", { PINE_AMM_QUOTER: "0x0000000000000000000000000000000000000001" }, "PINE_AMM_QUOTER must equal"],
      ["GitHub App without webhook secret", { PINE_GITHUB_WEBHOOK_SECRET: undefined }, "PINE_GITHUB_WEBHOOK_SECRET is required"],
      ["SEC-EVID pin target Kubo missing", { PINE_KUBO_API_URL: undefined }, "PINE_KUBO_API_URL is required in production"],
      ["SEC-EVID pin target Pinning Service missing", { PINE_PINNING_SERVICE_URL: undefined, PINE_PINNING_SERVICE_TOKEN: undefined }, "PINE_PINNING_SERVICE_URL and PINE_PINNING_SERVICE_TOKEN are required in production"],
      ["SEC-EVID pin targets both missing", { PINE_KUBO_API_URL: undefined, PINE_PINNING_SERVICE_URL: undefined, PINE_PINNING_SERVICE_TOKEN: undefined }, "PINE_KUBO_API_URL is required in production"],
    ];
    for (const [name, overrides, expected] of cases) {
      it(`refuses ${name}`, () => {
        const error = refusal(prodEnv(overrides));
        expect(error.message).toContain(expected);
        for (const secret of [DB_URL, RPC_A, RPC_B, CLIENT_SECRET, WEBHOOK_SECRET, KEY_A, KEY_B, KUBO_URL, PINNING_URL, PINNING_TOKEN]) expect(error.message).not.toContain(secret);
      });
    }

    it("refuses a pinning endpoint without its token (every environment)", () => {
      expect(refusal(prodEnv({ PINE_PINNING_SERVICE_TOKEN: undefined })).message).toContain("must be set together");
      expect(refusal(devEnv({ PINE_PINNING_SERVICE_URL: PINNING_URL })).message).toContain("must be set together");
    });

    it("loads a production configuration with both pin targets into the secrets", () => {
      const { secrets } = loadConfig(prodEnv(), { readFile: denylistFile });
      expect(secrets.ipfs.kuboApiUrl).toBe(KUBO_URL);
      expect(secrets.ipfs.pinningServiceUrl).toBe(PINNING_URL);
      expect(secrets.ipfs.pinningServiceToken).toBe(PINNING_TOKEN);
    });

    it("accepts the same overrides outside production", () => {
      expect(() => loadConfig(devEnv({ PINE_CHAIN_ID: "10200", PINE_ALLOW_DRAFT_POLICIES: "true", PINE_SEER_MARKET_FACTORY: "0x0000000000000000000000000000000000000001" }))).not.toThrow();
    });
  });

  describe("sanctions configuration (SEC-LEGAL-02)", () => {
    it("static mode requires a denylist path", () => {
      expect(refusal(devEnv({ PINE_SANCTIONS_MODE: "static" })).message).toContain("PINE_SANCTIONS_DENYLIST_PATH is required");
    });
    it("refuses an unreadable denylist file", () => {
      const error = refusal(devEnv({ PINE_SANCTIONS_MODE: "static", PINE_SANCTIONS_DENYLIST_PATH: "/nonexistent/denylist.json" }), () => {
        throw new Error("ENOENT");
      });
      expect(error.message).toContain("PINE_SANCTIONS_DENYLIST_PATH could not be read");
    });
    for (const [name, content] of [
      ["invalid JSON", "{not json"],
      ["an object", JSON.stringify({ addresses: [SANCTIONED] })],
      ["an uppercase address", JSON.stringify([SANCTIONED.toUpperCase().replace("0X", "0x")])],
      ["a short address", JSON.stringify(["0x1234"])],
    ] as const) {
      it(`refuses a denylist file with ${name}`, () => {
        const error = refusal(devEnv({ PINE_SANCTIONS_MODE: "static", PINE_SANCTIONS_DENYLIST_PATH: "/etc/pine/denylist.json" }), () => content);
        expect(error.message).toContain("PINE_SANCTIONS_DENYLIST_PATH must contain");
      });
    }
    it("refuses a denylist with more than 100000 entries", () => {
      const many = JSON.stringify(Array.from({ length: 100_001 }, () => SANCTIONED));
      expect(refusal(devEnv({ PINE_SANCTIONS_MODE: "static", PINE_SANCTIONS_DENYLIST_PATH: "/x.json" }), () => many).message).toContain("PINE_SANCTIONS_DENYLIST_PATH");
    });
    it("reads a real denylist file from disk (duplicates allowed)", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "pine-denylist-"));
      const file = path.join(dir, "denylist.json");
      writeFileSync(file, JSON.stringify([SANCTIONED, SANCTIONED]), "utf8");
      const { server } = loadConfig(devEnv({ PINE_SANCTIONS_MODE: "static", PINE_SANCTIONS_DENYLIST_PATH: file }));
      expect([...server.sanctions.blockedWallets]).toEqual([SANCTIONED]);
    });
  });

  describe("SEC-OPS-02 every secret is registered with the platform redactor (PRD-02 3b)", () => {
    const MIGRATOR_URL = "postgres://pine_migrator:migrator-password-123456@db.internal:5432/pine";
    const READ_MODEL_URL = "postgres://pine_readonly:ro-password-123456@db.internal:5432/indexer";
    const ENVIO_URL = "https://envio.internal.example/v1/graphql-key-0123456789";
    const ENVIO_ADMIN = "envio-admin-secret-0123456789";
    const shared: [string, string][] = [
      ["PINE_DATABASE_URL", DB_URL],
      ["PINE_MIGRATOR_DATABASE_URL", MIGRATOR_URL],
      ["PINE_RPC_URL_PRIMARY", RPC_A],
      ["PINE_RPC_URL_SECONDARY", RPC_B],
      ["PINE_GITHUB_CLIENT_SECRET", CLIENT_SECRET],
      ["PINE_GITHUB_WEBHOOK_SECRET", WEBHOOK_SECRET],
      ["PINE_TOKEN_KEY_CURRENT", KEY_A],
      ["PINE_TOKEN_KEYS_PREVIOUS", KEY_B],
      ["PINE_KUBO_API_URL", KUBO_URL],
      ["PINE_PINNING_SERVICE_URL", PINNING_URL],
      ["PINE_PINNING_SERVICE_TOKEN", PINNING_TOKEN],
    ];
    const backends: [string, Record<string, string | undefined>, [string, string][]][] = [
      ["native read model", { PINE_READ_MODEL_DATABASE_URL: READ_MODEL_URL }, [["PINE_READ_MODEL_DATABASE_URL", READ_MODEL_URL]]],
      [
        "envio read model",
        { PINE_INDEXER_BACKEND: "envio", PINE_READ_MODEL_DATABASE_URL: undefined, PINE_ENVIO_GRAPHQL_URL: ENVIO_URL, PINE_ENVIO_ADMIN_SECRET: ENVIO_ADMIN },
        [
          ["PINE_ENVIO_GRAPHQL_URL", ENVIO_URL],
          ["PINE_ENVIO_ADMIN_SECRET", ENVIO_ADMIN],
        ],
      ],
    ];
    for (const [backend, overrides, specific] of backends) {
      it(`masks each production secret exactly (${backend}), not only by URL or label patterns`, () => {
        const env = prodEnv({ ...overrides, PINE_MIGRATOR_DATABASE_URL: MIGRATOR_URL });
        const { secrets } = loadConfig(env, { readFile: denylistFile });
        const redact = createPlatformRedactor(secrets, env);
        const all = [...shared, ...specific];
        // Exact registration is the only path that turns the whole value (host included) into one marker: the URL
        // pattern alone would keep scheme and host, and plain tokens would pass through unchanged.
        for (const [variable, secret] of all) expect(redact(`before ${secret} after`), variable).toBe("before [REDACTED] after");
        const line = all.map(([, secret], i) => `<${i}> ${secret} </${i}>`).join(" ");
        expect(redact(line)).toBe(all.map((_, i) => `<${i}> [REDACTED] </${i}>`).join(" "));
        // Every secret-bearing variable of the environment is covered by this test.
        for (const variable of SECRET_VARIABLES) {
          if (env[variable] !== undefined) expect(all.map(([name]) => name), variable).toContain(variable);
        }
      });
    }
  });

  it("approximates registrable domains by the last two labels", () => {
    expect(registrableDomain("a.b.pine.example")).toBe("pine.example");
    expect(registrableDomain("pine-usercontent.net")).toBe("pine-usercontent.net");
  });

  it("documents every variable in .env.example", () => {
    const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    for (const variable of CONFIG_VARIABLES) expect(example, variable).toMatch(new RegExp(`\\b${variable}=`));
  });
});
