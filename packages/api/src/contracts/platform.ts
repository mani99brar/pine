// FROZEN cross-lane contract between `platform-core` (src/platform/core/**, src/main.ts, src/migrate.ts) and
// `platform-gateways` (src/platform/gateways/**), and the composition seam for the read model (src/readmodel.ts,
// owned by the `assembly` lane). Security requirement ids refer to docs/security/requirements.md.

import type { ReadModel } from "@pine/shared/read-model";
import type {
  ChainGateway,
  Clock,
  ContentStore,
  Database,
  GitHubGateway,
  JobDefinition,
  Metrics,
  ModerationGateway,
  SessionInfo,
} from "./app.js";
import type { AppConfig } from "./config.js";
import type { Redactor } from "./redact.js";

/**
 * Secrets: loaded and validated by platform-core from the environment (fail closed), registered with the redactor,
 * and handed only to platform code. Never placed in AppConfig, logs, responses, audit rows or the database.
 */
export interface PlatformSecrets {
  /** Postgres URL of the API runtime role (DML only; migrations use a separate migrator URL in the migrate command). */
  databaseUrl: string;
  /** Two independent Gnosis RPC providers; URLs may embed API keys. */
  rpcUrls: { primary: string; secondary: string };
  github: {
    /** "app": GitHub App with zero permissions and expiring user tokens (default). "oauth": OAuth App with no scopes (fallback). */
    kind: "app" | "oauth";
    clientId: string;
    clientSecret: string;
    /** HMAC secret of the github_app_authorization webhook (kind "app"). */
    webhookSecret: string | null;
  };
  /** AES-256-GCM key-encryption keys for stored GitHub tokens; `current` encrypts, all decrypt (rotation, SEC-GH-06). */
  tokenEncryptionKeys: { current: { id: string; key: Uint8Array }; previous: { id: string; key: Uint8Array }[] };
  ipfs: {
    /** Kubo RPC API of Pine's own IPFS node (block/put raw + pin/add), or null in development. */
    kuboApiUrl: string | null;
    /** IPFS Pinning Service API endpoint and token (pin-only scope), or null when pinning is disabled (development). */
    pinningServiceUrl: string | null;
    pinningServiceToken: string | null;
    /** Trusted HTTPS gateways for fetch-by-CID (redirects off, size-capped, digest verified). */
    gatewayUrls: string[];
  };
  /** Read model connection: the native indexer's Postgres URL (read-only role on its schema) or Envio's GraphQL endpoint. */
  readModel: { kind: "native"; databaseUrl: string } | { kind: "envio"; graphqlUrl: string; adminSecret: string | null };
}

export interface GitHubIdentity {
  githubUserId: number;
  login: string;
}

/**
 * GitHub account linking (SEC-AUTH-18/19, SEC-GH-01..07). Only from a signed-in wallet session.
 * start(): authorization URL with PKCE S256 and a 128-bit single-use state bound to the session, valid 10 minutes.
 * complete(): validates and consumes the state (same session, unexpired), exchanges the code, reads the identity,
 * enforces one GitHub user id <-> one Pine user, encrypts tokens (AES-256-GCM, AAD bound to user, provider, token kind
 * and key id) and stores them; rotates the session (the platform does that after complete() returns).
 * Errors are ApiError (BAD_REQUEST for state/code problems, CONFLICT when the GitHub id is linked to another user).
 */
export interface GitHubAuthFlow {
  start(session: SessionInfo): Promise<{ authorizationUrl: string }>;
  complete(session: SessionInfo, input: { code: string; state: string }): Promise<GitHubIdentity>;
  unlink(userId: string): Promise<void>;
  /** The linked GitHub identity of a user, or null (used by the platform to fill SessionInfo). */
  identityOf(userId: string): Promise<GitHubIdentity | null>;
  /** github_app_authorization webhook: verifies the HMAC over the raw body, then revokes the user's stored tokens. */
  handleWebhook(rawBody: Buffer, signatureHeader: string | undefined): Promise<void>;
}

/** The user-content listener: a separate Fastify server on the user-content host (no cookies, attachment-only). */
export interface ContentServer {
  listen(options: { host: string; port: number }): Promise<void>;
  close(): Promise<void>;
}

export interface Gateways {
  github: GitHubGateway;
  githubAuth: GitHubAuthFlow;
  contentStore: ContentStore;
  chain: ChainGateway;
  createContentServer(): ContentServer;
  /** Gateway background jobs (pin outbox, token refresh, content re-verification). */
  jobs: JobDefinition[];
  close(): Promise<void>;
}

export interface GatewayDependencies {
  config: AppConfig;
  secrets: PlatformSecrets;
  db: Database;
  clock: Clock;
  redact: Redactor;
  metrics: Metrics;
  moderation: ModerationGateway;
}

export type GatewayFactory = (deps: GatewayDependencies) => Promise<Gateways>;

export type ReadModelFactory = (deps: { config: AppConfig; secrets: PlatformSecrets; redact: Redactor; clock: Clock }) => Promise<ReadModel & { close(): Promise<void> }>;
