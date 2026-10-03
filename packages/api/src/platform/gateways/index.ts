// platform-gateways: GitHub auth flow and REST gateway, content store with IPFS pin outbox, the user-content server and
// the dual-RPC chain gateway (PRD-02 section 3). createGateways() wires production I/O; buildGateways() takes the I/O
// explicitly (fetch and the two viem transports) so tests run offline against recorded fixtures.

import { http as httpTransport, type Transport } from "viem";
import type { JobDefinition } from "../../contracts/app.js";
import type { GatewayDependencies, GatewayFactory, Gateways } from "../../contracts/platform.js";
import { createChainGateway } from "./chain.js";
import { createContentServer } from "./content-server.js";
import { createContentStore } from "./content-store.js";
import { createKeyRing } from "./crypto.js";
import { createGitHubGateway } from "./github.js";
import { createGitHubAuthFlow } from "./github-auth.js";
import { createGitHubClient, GITHUB_API_ORIGIN, GITHUB_WEB_ORIGIN } from "./github-client.js";
import { createTokenStore } from "./github-tokens.js";
import { createHttpClient, originOf, type FetchLike } from "./http.js";
import { createLogger, stderrSink, type LogSink } from "./log.js";
import { createPinOutbox } from "./pin-outbox.js";

export interface GatewayIo {
  /** Used for GitHub, the IPFS gateways, Kubo and the pinning service (never for RPC). */
  fetch: FetchLike;
  transports: { primary: Transport; secondary: Transport };
  /** Log sink; defaults to JSON lines on stderr. Messages are redacted before they reach it. */
  log?: LogSink;
}

/** Path of the core-owned OAuth callback route on the API origin. */
export const GITHUB_CALLBACK_PATH = "/api/v1/auth/github/callback";

export const JOB_NAMES = {
  pinOutbox: "gateways.content-pin-outbox",
  reencryptTokens: "gateways.github-token-reencrypt",
  purgeOAuthStates: "gateways.github-oauth-state-purge",
} as const;

/** Validates a configured base URL (absolute http(s), no credentials, query or fragment) and strips trailing slashes. */
function baseUrl(value: string, name: string, requireHttps: boolean): string {
  const origin = originOf(value);
  if (origin === null) throw new Error(`Invalid ${name} URL`);
  const url = new URL(value);
  if (url.search !== "" || url.hash !== "") throw new Error(`The ${name} URL must not contain a query or fragment`);
  if (requireHttps && url.protocol !== "https:") throw new Error(`The ${name} URL must use https`);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export async function buildGateways(deps: GatewayDependencies, io: GatewayIo): Promise<Gateways> {
  const { config, secrets, db, clock, redact, metrics, moderation } = deps;
  const log = createLogger(io.log ?? stderrSink, redact);
  const production = config.environment === "production";

  const keyRing = createKeyRing(secrets.tokenEncryptionKeys);
  const gatewayUrls = secrets.ipfs.gatewayUrls.map((value) => baseUrl(value, "IPFS gateway", production));
  const kuboApiUrl = secrets.ipfs.kuboApiUrl === null ? null : baseUrl(secrets.ipfs.kuboApiUrl, "Kubo API", false);
  const pinningServiceUrl = secrets.ipfs.pinningServiceUrl === null ? null : baseUrl(secrets.ipfs.pinningServiceUrl, "pinning service", production);
  const apiOrigin = originOf(config.apiOrigin);
  if (apiOrigin === null) throw new Error("Invalid API origin");

  // SSRF control: the complete list of hosts the gateways may contact over fetch.
  const allowedOrigins = [GITHUB_API_ORIGIN, GITHUB_WEB_ORIGIN, ...gatewayUrls, kuboApiUrl, pinningServiceUrl]
    .filter((value): value is string => value !== null)
    .map((value) => originOf(value))
    .filter((value): value is string => value !== null);
  const http = createHttpClient(io.fetch, allowedOrigins);

  const client = createGitHubClient(http, secrets.github);
  const tokens = createTokenStore({ db, clock, keyRing, client, metrics, log });
  const githubAuth = createGitHubAuthFlow({ db, clock, keyRing, client, tokens, github: secrets.github, redirectUri: `${apiOrigin}${GITHUB_CALLBACK_PATH}`, metrics, log });
  const github = createGitHubGateway({ db, clock, client, tokens });
  const contentStore = createContentStore({ db, clock, moderation, http, gatewayUrls, metrics, log });
  const pinOutbox = createPinOutbox({
    db,
    clock,
    http,
    targets: { kuboApiUrl, pinningServiceUrl, pinningServiceToken: secrets.ipfs.pinningServiceToken },
    metrics,
    redact,
    log,
  });
  const chain = await createChainGateway({ chainId: config.chainId, transports: io.transports, redact });

  const jobs: JobDefinition[] = [
    {
      name: JOB_NAMES.pinOutbox,
      intervalMs: 30_000,
      async run(_ctx, signal) {
        await pinOutbox.run(signal);
      },
    },
    {
      name: JOB_NAMES.reencryptTokens,
      intervalMs: 3_600_000,
      async run(_ctx, signal) {
        await tokens.reencrypt(signal);
      },
    },
    {
      name: JOB_NAMES.purgeOAuthStates,
      intervalMs: 300_000,
      async run(_ctx, signal) {
        // Bounded batches; core's cleanup never touches gateway tables.
        for (let round = 0; round < 20 && !signal.aborted; round += 1) {
          if ((await githubAuth.purgeExpiredStates(500)) < 500) break;
        }
      },
    },
  ];

  return {
    github,
    githubAuth: {
      start: (session) => githubAuth.start(session),
      complete: (session, input) => githubAuth.complete(session, input),
      unlink: (userId) => githubAuth.unlink(userId),
      identityOf: (userId) => githubAuth.identityOf(userId),
      handleWebhook: (rawBody, signatureHeader) => githubAuth.handleWebhook(rawBody, signatureHeader),
    },
    contentStore: {
      put: (input) => contentStore.put(input),
      get: (sha256) => contentStore.get(sha256),
      has: (sha256) => contentStore.has(sha256),
      retrieve: (sha256, maxBytes) => contentStore.retrieve(sha256, maxBytes),
    },
    chain,
    createContentServer: () => createContentServer(contentStore, redact, log),
    jobs,
    async close() {
      // No pooled resources: the database pool belongs to core and the viem HTTP transports hold no sockets of their own.
    },
  };
}

export const createGateways: GatewayFactory = async (deps) => {
  const rpc = (url: string) => httpTransport(url, { timeout: 10_000, retryCount: 2, fetchOptions: { redirect: "error" } });
  return buildGateways(deps, {
    fetch: (input, init) => fetch(input, init),
    transports: { primary: rpc(deps.secrets.rpcUrls.primary), secondary: rpc(deps.secrets.rpcUrls.secondary) },
  });
};
