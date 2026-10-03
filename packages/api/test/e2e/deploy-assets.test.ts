// The deployment assets match the code (PRD-06 sections 3 and 3a): deploy/env templates load through the real
// configuration loaders under production rules once their secrets are filled; the systemd units point at existing entry
// points and templates and run as one OS user each, with secret-file modes that agree across the env headers and
// deploy/README.md; the nginx and Caddy examples have the required edge properties (checked statically); the CI
// workflow, parsed as YAML, runs every controller check with pinned actions, a read-only token and the fork secret
// confined to its own job; and the commands and links in the README, deploy and operations docs resolve.
// No database, no network.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig as loadIndexerConfig } from "@pine/indexer-native/config";
import { CONFIG_VARIABLES, loadConfig } from "../../src/platform/core/config.js";
import { disposableClusterRefusal } from "./support/cluster.js";
import { databaseMode, REPO_ROOT } from "./support/database.js";

const read = (relative: string): string => readFileSync(path.join(REPO_ROOT, relative), "utf8");

/** KEY=value lines of an environment file (comments and blank lines skipped). */
function envFile(relative: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of read(relative).split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    expect(index, `${relative}: ${trimmed}`).toBeGreaterThan(0);
    out[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return out;
}

/** Valid secret values for the production checks (never real ones). */
const FILLED_API_SECRETS: Record<string, string> = {
  PINE_DATABASE_URL: "postgres://pine_api:deploy-test-password-0001@db.internal.example:5432/pine?sslmode=verify-full",
  PINE_RPC_URL_PRIMARY: "https://gnosis.provider-one.example/deploy-test-key-0001",
  PINE_RPC_URL_SECONDARY: "https://rpc.provider-two.example.net/deploy-test-key-0002",
  PINE_GITHUB_CLIENT_SECRET: "deploy-test-github-client-secret-0001",
  PINE_GITHUB_WEBHOOK_SECRET: "deploy-test-github-webhook-secret-0001",
  PINE_TOKEN_KEY_CURRENT: `k202610:${Buffer.alloc(32, 7).toString("base64")}`,
  PINE_KUBO_API_URL: "http://127.0.0.1:5001",
  PINE_PINNING_SERVICE_URL: "https://pins.provider.example/psa",
  PINE_PINNING_SERVICE_TOKEN: "deploy-test-pinning-token-0001",
  PINE_READ_MODEL_DATABASE_URL: "postgres://pine_readonly:deploy-test-password-0002@db.internal.example:5432/pine?sslmode=verify-full",
};

describe("e2e database selection", () => {
  it("runs on PostgreSQL 16 when PINE_E2E_DATABASE_URL is set, on PGlite otherwise, and fails without it under PINE_E2E_REQUIRE_PG=1", () => {
    expect(databaseMode({ PINE_E2E_DATABASE_URL: "postgres://postgres@127.0.0.1:5432/postgres" })).toBe("postgres");
    expect(databaseMode({ PINE_E2E_DATABASE_URL: "postgres://postgres@127.0.0.1:5432/postgres", PINE_E2E_REQUIRE_PG: "1" })).toBe("postgres");
    expect(databaseMode({})).toBe("pglite");
    expect(() => databaseMode({ PINE_E2E_REQUIRE_PG: "1" })).toThrow(/PINE_E2E_REQUIRE_PG=1/);
    expect(() => databaseMode({ PINE_E2E_REQUIRE_PG: "1", PINE_E2E_DATABASE_URL: " " })).toThrow(/PINE_E2E_REQUIRE_PG=1/);
  });
});

describe("environment templates", () => {
  it("SEC-OPS-01 deploy/env/api.env plus a filled secrets template loads under the production rules", () => {
    const base = envFile("deploy/env/api.env");
    const secrets = envFile("deploy/env/api.secrets.env.example");
    // Every variable of both files is one the API reads (catches typos that would silently fall back to defaults).
    for (const name of [...Object.keys(base), ...Object.keys(secrets)]) expect(CONFIG_VARIABLES, name).toContain(name);
    // The secrets template carries no values.
    expect(Object.values(secrets).filter((value) => value !== "")).toEqual([]);
    for (const name of Object.keys(FILLED_API_SECRETS)) expect(Object.keys(secrets), name).toContain(name);
    const env = { ...base, ...secrets, ...FILLED_API_SECRETS };
    for (const [key, value] of Object.entries(env)) if (value === "") delete env[key];
    const loaded = loadConfig(env, { readFile: () => "[]" });
    expect(loaded.config.environment).toBe("production");
    expect(loaded.config.claims.allowDraftPolicies).toBe(false);
    expect(loaded.config.claims.enabledPolicyFamilies).not.toContain("SC-001");
    expect(loaded.server.trustProxyHops).toBe(1);
    expect(loaded.server.compliance.countryHeader).toBe("x-pine-country");
    expect(loaded.server.sanctions.mode).toBe("static");
    expect(loaded.secrets.readModel.kind).toBe("native");
  });

  it("SEC-OPS-01 the production rules refuse the template with SC-001 enabled or with draft policies", () => {
    const env = { ...envFile("deploy/env/api.env"), ...FILLED_API_SECRETS };
    expect(() => loadConfig({ ...env, PINE_ENABLED_POLICY_FAMILIES: "FUNC-001,BOT-001,SC-001" }, { readFile: () => "[]" })).toThrow(/SC-001/);
    expect(() => loadConfig({ ...env, PINE_ALLOW_DRAFT_POLICIES: "true" }, { readFile: () => "[]" })).toThrow(/PINE_ALLOW_DRAFT_POLICIES/);
  });

  it("deploy/env/indexer.env plus a filled secrets template loads through the indexer's loader", () => {
    const base = envFile("deploy/env/indexer.env");
    const secrets = envFile("deploy/env/indexer.secrets.env.example");
    expect(Object.values(secrets).filter((value) => value !== "")).toEqual([]);
    expect(Object.keys(secrets).sort()).toEqual(["DATABASE_URL", "RPC_PRIMARY_URL", "RPC_SECONDARY_URL"]);
    const config = loadIndexerConfig({
      ...base,
      DATABASE_URL: "postgres://pine_indexer:deploy-test-password-0003@db.internal.example:5432/pine",
      RPC_PRIMARY_URL: "https://gnosis.provider-one.example/deploy-test-key-0001",
      RPC_SECONDARY_URL: "https://rpc.provider-two.example.net/deploy-test-key-0002",
    });
    expect(config.chainId).toBe(100);
    // The indexer's private listener must not collide with the API's metrics port on the same host.
    expect(String(config.metricsPort)).not.toBe(envFile("deploy/env/api.env").PINE_METRICS_PORT);
  });

  it("deploy/env/migrate.secrets.env.example names exactly the URLs both migrate commands read", () => {
    expect(Object.keys(envFile("deploy/env/migrate.secrets.env.example")).sort()).toEqual(["MIGRATION_DATABASE_URL", "PINE_MIGRATOR_DATABASE_URL"]);
    expect(read("packages/api/src/migrate.ts")).toContain('"PINE_MIGRATOR_DATABASE_URL"');
    expect(read("packages/indexer-native/src/migrate-cli.ts")).toContain("MIGRATION_DATABASE_URL");
  });
});

describe("systemd units", () => {
  const units = readdirSync(path.join(REPO_ROOT, "deploy", "systemd")).filter((name) => name.endsWith(".service"));
  /** Unit -> its OS user (SEC-OPS-10: one user per unit, so no unit can read another's secrets). */
  const USERS: Record<string, string> = {
    "pine-api.service": "pine-api",
    "pine-indexer-native.service": "pine-indexer",
    "pine-migrate.service": "pine-migrate",
    "pine-web.service": "pine-web",
  };
  const environmentFiles = (unit: string): string[] => [...read(`deploy/systemd/${unit}`).matchAll(/^EnvironmentFile=\/etc\/pine\/(.+)$/gm)].map((match) => match[1] ?? "");

  it("cover migrations (oneshot), the API, the native indexer and the web app, hardened", () => {
    expect(units.sort()).toEqual(["pine-api.service", "pine-indexer-native.service", "pine-migrate.service", "pine-web.service"]);
    for (const unit of units) {
      const text = read(`deploy/systemd/${unit}`);
      for (const line of ["NoNewPrivileges=yes", "ProtectSystem=strict", "PrivateTmp=yes", "CapabilityBoundingSet=", "UMask=0077"]) expect(text, `${unit}: ${line}`).toContain(line);
    }
    expect(read("deploy/systemd/pine-migrate.service")).toContain("Type=oneshot");
  });

  it("SEC-OPS-10 runs every unit as its own unprivileged OS user and group", () => {
    const seen = new Set<string>();
    for (const unit of units) {
      const text = read(`deploy/systemd/${unit}`);
      const users = [...text.matchAll(/^User=(.+)$/gm)].map((match) => match[1]);
      const groups = [...text.matchAll(/^Group=(.+)$/gm)].map((match) => match[1]);
      expect(users, unit).toEqual([USERS[unit]]);
      expect(groups, unit).toEqual([USERS[unit]]);
      expect(text, unit).not.toMatch(/^SupplementaryGroups=/m);
      seen.add(users[0] ?? "");
    }
    expect(seen.size).toBe(units.length);
    // deploy/README.md creates exactly these users.
    expect(read("deploy/README.md")).toContain("for user in pine-api pine-indexer pine-migrate pine-web; do useradd --system");
  });

  it("SEC-OPS-10 makes each secrets file readable only by its unit's user (0640 root:<user>), in the env headers and deploy/README.md alike", () => {
    const readme = read("deploy/README.md");
    const owners = new Map<string, string>();
    for (const unit of units) {
      const user = USERS[unit] ?? "";
      for (const file of environmentFiles(unit)) {
        // No file is shared between units.
        expect(owners.get(file), `${file} read by ${unit} and ${owners.get(file) ?? ""}`).toBeUndefined();
        owners.set(file, user);
        const template = existsSync(path.join(REPO_ROOT, "deploy", "env", file)) ? file : `${file}.example`;
        const header = read(`deploy/env/${template}`).split("\n").filter((line) => line.startsWith("#")).join("\n");
        expect(header, `${template} header`).toContain(`0640 root:${user}`);
        expect(header, `${template} header`).not.toMatch(/\b0600\b|root:pine\b(?!-)/);
        // The install command of deploy/README.md agrees: mode 0640, owner root, group = the unit's user.
        const installs = readme.split("\n").filter((line) => line.startsWith("install ") && line.endsWith(` /etc/pine/${file}`));
        expect(installs, `deploy/README.md install of ${file}`).toEqual([`install -m 0640 -o root -g ${user} deploy/env/${template} /etc/pine/${file}`]);
      }
    }
    expect([...owners.keys()].filter((file) => file.includes("secrets")).sort()).toEqual(["api.secrets.env", "indexer.secrets.env", "migrate.secrets.env"]);
    // The API reads the sanctions denylist at runtime: it belongs to pine-api only.
    expect(readme).toContain("install -m 0640 -o root -g pine-api /path/to/sanctions-denylist.json /etc/pine/sanctions-denylist.json");
    expect(readme).not.toMatch(/-g pine\s/);
  });

  it("start existing entry points from their working directories and read the deploy/env templates", () => {
    const templates = new Set(readdirSync(path.join(REPO_ROOT, "deploy", "env")).map((name) => name.replace(/\.example$/, "")));
    for (const unit of units) {
      const text = read(`deploy/systemd/${unit}`);
      const workdir = /^WorkingDirectory=\/opt\/pine\/current\/(.+)$/m.exec(text)?.[1];
      expect(workdir, unit).toBeDefined();
      if (unit === "pine-web.service") {
        // The web app is the Next.js server of the frontend workspace, bound to loopback only (the edge proxy is its
        // only client); its working directory is the Prism app, whose package runs `next`.
        expect(workdir).toBe("frontend/apps/prism");
        expect(text).toMatch(/^ExecStart=\/usr\/bin\/node node_modules\/next\/dist\/bin\/next start --hostname 127\.0\.0\.1 --port 3004$/m);
        expect(read(path.join(workdir ?? "", "package.json"))).toContain('"next"');
        for (const file of environmentFiles(unit)) expect(templates, `${unit}: ${file}`).toContain(file);
        continue;
      }
      const starts = [...text.matchAll(/^ExecStart=\/usr\/bin\/node --import tsx (\S+)$/gm)].map((match) => match[1] ?? "");
      expect(starts.length, unit).toBeGreaterThan(0);
      for (const script of starts) expect(existsSync(path.join(REPO_ROOT, workdir ?? "", script)), `${unit}: ${script}`).toBe(true);
      // tsx resolves from the working directory's package.
      expect(read(path.join(workdir ?? "", "package.json"))).toContain('"tsx"');
      for (const file of environmentFiles(unit)) expect(templates, `${unit}: ${file}`).toContain(file);
    }
    // The API migrations run before pine_index's (platform 0002 sets the default privileges later groups rely on).
    const migrate = read("deploy/systemd/pine-migrate.service");
    expect(migrate.indexOf("src/migrate.ts")).toBeLessThan(migrate.indexOf("migrate-cli.ts"));
  });
});

// ------------------------------------------------------------------------------------------------ edge proxy

interface Block {
  head: string;
  body: string;
}

/** Top-level `<head> { ... }` blocks of a brace-structured config (nginx, Caddyfile); comments are stripped first. */
function blocks(source: string): Block[] {
  const text = source
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");
  const out: Block[] = [];
  let depth = 0;
  let start = 0;
  let head = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      if (depth === 0) {
        const before = text.slice(0, index);
        head = before.slice(before.lastIndexOf("\n") + 1).trim();
        start = index + 1;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) out.push({ head, body: text.slice(start, index) });
    }
  }
  return out;
}

const hostOf = (origin: string | undefined): string => new URL(origin ?? "").hostname;
/** The last two DNS labels: a stand-in for the registrable domain of the example hosts. */
const registrable = (host: string): string => host.split(".").slice(-2).join(".");

describe("edge proxy examples (static: no nginx or caddy binary on the verification host)", () => {
  const apiEnv = envFile("deploy/env/api.env");
  const appHost = hostOf(apiEnv.PINE_PUBLIC_ORIGIN);
  const contentHost = hostOf(apiEnv.PINE_USER_CONTENT_ORIGIN);
  const apiUpstream = `127.0.0.1:${apiEnv.PINE_PORT ?? ""}`;
  const contentUpstream = `127.0.0.1:${apiEnv.PINE_USER_CONTENT_PORT ?? ""}`;
  /** pine-web.service: the Next.js server of the web app, loopback only. */
  const webUpstream = "127.0.0.1:3004";

  it("the API configuration they serve is same-origin with a user-content host on another registrable domain", () => {
    expect(apiEnv.PINE_API_ORIGIN).toBe(apiEnv.PINE_PUBLIC_ORIGIN);
    expect(registrable(contentHost)).not.toBe(registrable(appHost));
    expect(apiEnv.PINE_TRUST_PROXY_HOPS).toBe("1");
  });

  describe("nginx (deploy/proxy/nginx-http.conf + nginx.conf)", () => {
    const http = read("deploy/proxy/nginx-http.conf");
    const main = read("deploy/proxy/nginx.conf");
    const servers = blocks(main).filter((block) => block.head === "server");
    const upstreams = new Map(blocks(main).filter((block) => block.head.startsWith("upstream ")).map((block) => [block.head.split(/\s+/)[1] ?? "", block.body]));
    const serverFor = (host: string, tls: boolean): string => {
      const found = servers.filter((server) => new RegExp(`server_name[^;]*\\s${host.replaceAll(".", "\\.")}[\\s;]`).test(server.body) && /listen 443 ssl;/.test(server.body) === tls);
      expect(found.length, `${host} tls=${tls}`).toBe(1);
      return found[0]?.body ?? "";
    };
    const proxiedTo = (server: string): string[] => [...server.matchAll(/proxy_pass http:\/\/(\w+);/g)].map((match) => upstreams.get(match[1] ?? "")?.match(/server (\S+?);/)?.[1] ?? "?");

    it("keeps log_format and the other http-context directives out of server blocks (nginx -t), in nginx-http.conf", () => {
      for (const server of servers) expect(server.body).not.toMatch(/\b(log_format|geoip2|limit_req_zone|limit_conn_zone)\b/);
      expect(main).not.toMatch(/^\s*log_format\b/m);
      expect(http).toMatch(/^log_format pine_noquery /m);
      expect(blocks(http).map((block) => block.head)).toEqual(["geoip2 /usr/share/GeoIP/GeoLite2-Country.mmdb"]);
      // deploy/README.md documents both includes, nginx-http.conf first.
      const readme = read("deploy/README.md");
      const first = readme.indexOf("include /etc/nginx/pine/nginx-http.conf;");
      expect(first).toBeGreaterThan(0);
      expect(readme.indexOf("include /etc/nginx/pine/nginx.conf;")).toBeGreaterThan(first);
    });

    it("serves the web app and the API on one origin and user content only from its own host", () => {
      const app = serverFor(appHost, true);
      const content = serverFor(contentHost, true);
      expect(app).toMatch(/location ~ \^\/\(api\//);
      // The regex location (API, health, well-known) wins over the prefix `location /` of the web app.
      expect(/location ~ \^\/\(api\/[^{]*\{[^}]*proxy_pass http:\/\/(\w+);/.exec(app)?.[1]).toBe("pine_api");
      expect(/location \/ \{[^}]*proxy_pass http:\/\/(\w+);/.exec(app)?.[1]).toBe("pine_web");
      expect([...proxiedTo(app)].sort()).toEqual([apiUpstream, webUpstream].sort());
      expect(proxiedTo(content)).toEqual([contentUpstream]);
      // Untrusted content: GET only, no cookies or credentials either way.
      for (const line of ["limit_except GET { deny all; }", 'proxy_set_header Cookie "";', 'proxy_set_header Authorization "";', "proxy_hide_header Set-Cookie;"]) expect(content, line).toContain(line);
      expect(content).toMatch(/location \/ \{ return 404; \}/);
    });

    it("applies per-IP limits on the user-content host", () => {
      const content = serverFor(contentHost, true);
      const zone = /limit_req zone=(\w+) /.exec(content)?.[1] ?? "";
      const conn = /limit_conn (\w+) \d+;/.exec(content)?.[1] ?? "";
      expect(http).toMatch(new RegExp(`^limit_req_zone \\$binary_remote_addr zone=${zone}:\\d+m rate=\\d+r/s;$`, "m"));
      expect(http).toMatch(new RegExp(`^limit_conn_zone \\$binary_remote_addr zone=${conn}:\\d+m;$`, "m"));
      expect(serverFor(appHost, true)).toMatch(/limit_req zone=\w+ /);
    });

    it("terminates TLS (1.2/1.3 only, HSTS) and redirects plain HTTP", () => {
      for (const host of [appHost, contentHost]) {
        const server = serverFor(host, true);
        expect(server, host).toMatch(new RegExp(`ssl_certificate\\s+/etc/letsencrypt/live/${host.replaceAll(".", "\\.")}/fullchain\\.pem;`));
        expect(server, host).toMatch(/ssl_protocols TLSv1\.2 TLSv1\.3;/);
        expect(server, host).toMatch(/add_header Strict-Transport-Security "max-age=\d+/);
        expect(server, host).not.toMatch(/listen (\[::\]:)?80\b/);
        expect(serverFor(host, false), host).toMatch(/return 301 https:\/\/\$host\$request_uri;/);
      }
    });

    it("logs no query strings: every server logs with pine_noquery, whose format has no query or cookie variable", () => {
      for (const server of servers) {
        const logs = [...server.body.matchAll(/access_log ([^;]+);/g)].map((match) => match[1] ?? "");
        expect(logs.length, server.body.slice(0, 80)).toBeGreaterThan(0);
        for (const log of logs) expect(log).toMatch(/ pine_noquery$/);
      }
      const format = /^log_format pine_noquery (.+);$/m.exec(http)?.[1] ?? "";
      expect(format).toContain("$uri");
      expect(format).not.toMatch(/\$(request_uri|request|args|arg_\w+|query_string|is_args|http_cookie|cookie_\w+|http_authorization|http_referer)\b/);
    });
  });

  describe("Caddy (deploy/proxy/Caddyfile)", () => {
    const caddy = read("deploy/proxy/Caddyfile");
    const sites = new Map(blocks(caddy).map((block) => [block.head, block.body]));
    const app = sites.get(appHost) ?? "";
    const content = sites.get(contentHost) ?? "";

    it("serves the web app and the API on one origin and user content only from its own host", () => {
      expect(app).toMatch(/@api path \/api\/\* /);
      expect(app).toContain(`reverse_proxy ${apiUpstream} {`);
      // Everything else goes to the web app (Next.js on loopback).
      expect(app).toContain(`reverse_proxy ${webUpstream} {`);
      expect(app).not.toContain("file_server");
      expect(app).not.toContain(contentUpstream);
      expect(content).toContain(`reverse_proxy ${contentUpstream} {`);
      expect(content).not.toContain(apiUpstream);
      expect(content).not.toContain(webUpstream);
      for (const line of ["method GET HEAD", "header_up -Cookie", "header_up -Authorization", "header_down -Set-Cookie"]) expect(content, line).toContain(line);
      // A bare `respond` is ordered after `handle` and the catch-all would shadow it.
      expect(app).toMatch(/handle \/metrics \{\s*respond 404\s*\}/);
      expect(app).not.toMatch(/^\s*respond \/metrics/m);
    });

    it("applies per-IP limits on the user-content host", () => {
      expect(content).toMatch(/rate_limit \{\s*zone \w+ \{\s*key \{remote_host\}\s*events \d+\s*window \d+m\s*\}/);
      expect(caddy).toMatch(/order rate_limit before reverse_proxy/);
    });

    it("terminates TLS for both hosts (automatic HTTPS: domain site addresses, never disabled)", () => {
      expect([...sites.keys()]).toEqual(expect.arrayContaining([appHost, contentHost]));
      for (const head of sites.keys()) expect(head).not.toMatch(/^http:\/\//);
      expect(caddy).not.toMatch(/auto_https\s+(off|disable_redirects)|tls internal/);
      expect(app).toMatch(/header Strict-Transport-Security "max-age=\d+/);
    });

    it("logs no query strings: both hosts import the snippet that strips the query, cookies and authorization", () => {
      expect(app).toContain("import pine_noquery_log");
      expect(content).toContain("import pine_noquery_log");
      const snippet = sites.get("(pine_noquery_log)") ?? "";
      expect(snippet).toContain('request>uri regexp "\\?.*$" ""');
      expect(snippet).toContain("request>headers>Cookie delete");
      expect(snippet).toContain("request>headers>Authorization delete");
    });
  });
});

// ------------------------------------------------------------------------------------------------ CI

interface WorkflowStep {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface WorkflowJob {
  if?: string;
  env?: Record<string, string>;
  permissions?: unknown;
  services?: Record<string, { image?: string }>;
  steps: WorkflowStep[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: unknown;
  jobs: Record<string, WorkflowJob>;
}

// The `yaml` package (YAML 1.2: `on` stays a string key) is not a dependency of @pine/api; it resolves, pinned by the
// lockfile, from @fastify/swagger, which is.
const requireHere = createRequire(import.meta.url);
const { parse: parseYaml } = createRequire(requireHere.resolve("@fastify/swagger"))("yaml") as { parse(source: string): unknown };

/** Any forge test run (directly or through the TAP wrapper). */
const FORGE_TEST = /forge-test-tap\.mjs|\bforge test\b/;
/** The only forge selection that needs no RPC: the fork and fork-e2e suites fall back to a public RPC without the secret. */
const OFFLINE_FORGE_SELECTION = 'node scripts/forge-test-tap.mjs --match-path "test/{claim-registry,evidence-registry}/**/*.sol"';

describe("CI workflow (.github/workflows/ci.yml, parsed as YAML)", () => {
  const ci = read(".github/workflows/ci.yml");
  const workflow = parseYaml(ci) as Workflow;
  const jobs = Object.entries(workflow.jobs);
  const runs = jobs.flatMap(([, job]) => job.steps.map((step) => step.run ?? "")).join("\n");

  it("runs on both push and pull_request, never pull_request_target", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push"]);
    // No branch or path filter narrows either trigger.
    expect(workflow.on.push ?? null).toBeNull();
    expect(workflow.on.pull_request ?? null).toBeNull();
  });

  it("pins every action to a full commit SHA and keeps the token read-only", () => {
    const uses = jobs.flatMap(([, job]) => job.steps.flatMap((step) => (step.uses === undefined ? [] : [step.uses])));
    expect(uses.length).toBeGreaterThan(3);
    for (const action of uses) expect(action, action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const [id, job] of jobs) expect(job.permissions, id).toBeUndefined();
  });

  it("runs the GNOSIS_RPC_URL fork commands only in the fork job, whose job-level env maps the secret and whose steps are guarded on it", () => {
    const fork = workflow.jobs.fork;
    expect(fork).toBeDefined();
    expect(fork?.env?.GNOSIS_RPC_URL).toBe("${{ secrets.GNOSIS_RPC_URL }}");
    // GitHub refuses `secrets` in a job-level `if`; no job has one, and the fork job has no job-level condition at all.
    expect(fork?.if).toBeUndefined();
    for (const [id, job] of jobs) expect(job.if ?? "", id).not.toContain("secrets");
    // Every step that does work is guarded on the mapped secret; the one unguarded-by-presence step only reports the skip.
    const steps = fork?.steps ?? [];
    for (const step of steps) {
      if (step.if === "env.GNOSIS_RPC_URL == ''") expect(step.uses === undefined && /^echo /.test(step.run ?? ""), step.name).toBe(true);
      else expect(step.if, step.name ?? step.uses).toBe("env.GNOSIS_RPC_URL != ''");
      // The secret reaches the steps through the job env only.
      expect(JSON.stringify(step), step.name).not.toContain("secrets.");
    }
    const forkCommands = steps.map((step) => step.run ?? "").filter((run) => FORGE_TEST.test(run));
    expect(forkCommands).toEqual(['node scripts/forge-test-tap.mjs --match-path "test/fork/**/*.sol"', 'node scripts/forge-test-tap.mjs --match-path "test/e2e/**/*.sol"']);
    // Every other job runs only the offline registry suites and never references the secret (or the variable).
    for (const [id, job] of jobs) {
      if (id === "fork") continue;
      for (const step of job.steps) {
        const run = step.run ?? "";
        if (FORGE_TEST.test(run)) expect(run, id).toBe(OFFLINE_FORGE_SELECTION);
      }
      expect(JSON.stringify(job), id).not.toContain("GNOSIS_RPC_URL");
    }
    // The whole workflow references exactly one secret, once.
    expect(JSON.stringify(workflow).match(/secrets\./g)).toEqual(["secrets."]);
  });

  it("runs the e2e suite on a postgres:16 service with PINE_E2E_REQUIRE_PG=1 against a cluster the role guard accepts", () => {
    const e2e = jobs.flatMap(([, job]) => job.steps.filter((step) => step.run === "pnpm --filter @pine/api exec vitest run test/e2e").map((step) => ({ job, step })));
    expect(e2e.length).toBe(1);
    const job = e2e[0]?.job;
    const env = { ...job?.env, ...e2e[0]?.step.env };
    expect(Object.values(job?.services ?? {}).map((service) => service.image)).toContain("postgres:16");
    expect(env.PINE_E2E_REQUIRE_PG).toBe("1");
    const url = env.PINE_E2E_DATABASE_URL ?? "";
    expect(url).toMatch(/^postgres:\/\//);
    // support/cluster.ts refuses a non-loopback cluster without PINE_E2E_DISPOSABLE_CLUSTER=1: CI must pass that guard.
    expect(disposableClusterRefusal(url, env)).toBeNull();
  });

  it("scans the whole history with a checksum-pinned gitleaks and the reviewed allowlist", () => {
    const secrets = workflow.jobs.secrets;
    const checkout = secrets?.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(secrets?.env?.GITLEAKS_SHA256).toMatch(/^[0-9a-f]{64}$/);
    const scripts = (secrets?.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(scripts).toContain('echo "${GITLEAKS_SHA256}  gitleaks.tar.gz" | sha256sum --check --strict');
    expect(scripts).toContain("./gitleaks git --redact --no-banner --config .github/workflows/gitleaks.toml .");
    expect(existsSync(path.join(REPO_ROOT, ".github", "workflows", "gitleaks.toml"))).toBe(true);
  });

  it("runs every controller check of every feature, pnpm audit and the forbidden gate", () => {
    const featureDirs = readdirSync(path.join(REPO_ROOT, "features")).filter((name) => existsSync(path.join(REPO_ROOT, "features", name, "policy.json")));
    const commands = new Set<string>();
    for (const feature of featureDirs) {
      const policy = JSON.parse(read(`features/${feature}/policy.json`)) as { workers: { checks: { argv: string[] }[] }[] };
      for (const worker of policy.workers) for (const check of worker.checks) commands.add(check.argv.join(" "));
    }
    expect(commands.size).toBeGreaterThan(20);
    const normalized = runs.replaceAll('"', "");
    // Package-level checks are subsumed by the workspace-wide steps; contract unit suites by the registry pattern; the
    // e2e-pglite check (`env -u ... vitest run test/e2e`) by `pnpm -r test`, which runs test/e2e without the URL.
    const subsumed = (command: string): boolean =>
      /^pnpm --filter @pine\/[\w-]+ (typecheck|test)$/.test(command) ||
      /^pnpm --filter @pine\/api exec vitest run src(\/[\w/]+)?( src\/[\w/]+)*$/.test(command) ||
      /^env -u PINE_E2E_DATABASE_URL -u PINE_E2E_REQUIRE_PG pnpm --filter @pine\/api exec vitest run test\/e2e$/.test(command) ||
      /^pnpm exec eslint packages\/[\w/-]+$/.test(command) ||
      /^node scripts\/forge-test-tap\.mjs --match-path test\/(claim-registry|evidence-registry)\/\*\*\/\*\.sol$/.test(command);
    for (const command of commands) expect(normalized.includes(command) || subsumed(command), command).toBe(true);
    for (const step of ["pnpm -r typecheck", "pnpm -r --workspace-concurrency=1 test", "pnpm exec eslint packages", "test/{claim-registry,evidence-registry}/**/*.sol", "node scripts/check-forbidden.mjs", "pnpm audit --prod --audit-level high", "pnpm install --frozen-lockfile"]) {
      expect(normalized, step).toContain(step);
    }
    expect(runs).toContain("corepack prepare pnpm@12.8.1 --activate");
    expect(read(".nvmrc").trim()).toBe("24");
    expect(read("package.json")).toContain('"packageManager": "pnpm@12.8.1"');
  });
});

describe("documentation", () => {
  const docs = ["README.md", "deploy/README.md", ...readdirSync(path.join(REPO_ROOT, "deploy", "procedures")).map((name) => `deploy/procedures/${name}`), "deploy/ipfs/README.md", ...readdirSync(path.join(REPO_ROOT, "docs", "operations")).map((name) => `docs/operations/${name}`)];

  it("documents only pnpm scripts that exist", () => {
    const packages = new Map<string, Record<string, string>>();
    for (const dir of readdirSync(path.join(REPO_ROOT, "packages"))) {
      const manifest = JSON.parse(read(`packages/${dir}/package.json`)) as { name: string; scripts?: Record<string, string> };
      packages.set(manifest.name, manifest.scripts ?? {});
    }
    let checked = 0;
    for (const doc of docs) {
      for (const match of read(doc).matchAll(/pnpm --filter (@pine\/[\w-]+) ([\w:-]+)/g)) {
        const [, name = "", script = ""] = match;
        expect(packages.has(name), `${doc}: ${name}`).toBe(true);
        if (script !== "exec") expect(Object.keys(packages.get(name) ?? {}), `${doc}: ${name} ${script}`).toContain(script);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("links only to files that exist", () => {
    for (const doc of docs) {
      for (const match of read(doc).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const target = match[1] ?? "";
        if (/^https?:/.test(target)) continue;
        expect(existsSync(path.resolve(REPO_ROOT, path.dirname(doc), target)), `${doc} -> ${target}`).toBe(true);
      }
    }
  });

  it("the release checklist lists every launch gate of PRD-06 section 3 and the two standing statements", () => {
    const checklist = read("docs/operations/release-checklist.md");
    for (const gate of [
      "External audit",
      "bug-bounty scope",
      "SEC-SC-17",
      "Policy approval",
      "Legal review",
      "jurisdictions",
      "hosted sanctions-screening provider",
      "conflict-of-interest policy",
      "SEC-LEGAL-07",
      "GitHub App spike",
      "Real-Postgres lease test",
      "Envio live conformance",
      "independently built and released client",
      "eth_chainId",
      "re-renders the question",
      "builds evidence reveals locally",
      "SPEC section 8 state",
      "SEC-TX-01/02/05/07/10, SEC-AUTH-13",
      "Pilot claim selected",
      "Named operational owner and on-call",
      "Pilot measurement plan",
      "valid findings, noise, latency and total cost",
      "Pine executes no submitted code",
      "anvil fork",
      "throwaway keys only",
    ]) {
      expect(checklist, gate).toContain(gate);
    }
  });
});
