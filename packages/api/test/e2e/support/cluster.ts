// Pure safety helpers of the PostgreSQL e2e setup (PRD-06 section 3a), with injectable executors so that their failure
// paths are unit-tested without a database:
//   - disposableClusterRefusal: bootstrapRoles sets fixed, committed test passwords on the PRODUCTION role names, so it
//     runs only against a loopback cluster or one the operator declared disposable (PINE_E2E_DISPOSABLE_CLUSTER=1);
//   - dropE2eDatabase / closeE2eDatabase: a failed DROP DATABASE fails the file's afterAll with a redacted message
//     instead of leaving the database behind silently.

import type { Redactor } from "../../../src/contracts/redact.js";

export const DISPOSABLE_CLUSTER_FLAG = "PINE_E2E_DISPOSABLE_CLUSTER";

/** Hosts accepted without the flag, as WHATWG URL reports them for a postgres: URL (IPv6 keeps its brackets). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
/** Query parameters with which pg (pg-connection-string) connects somewhere other than the URL's authority. */
const HOST_OVERRIDES = ["host", "hostaddr"];

/**
 * Why the role bootstrap must not run on this cluster, or null when it may. Decides on the target `pg` actually connects
 * to: a `host`/`hostaddr` query parameter, a Unix socket or any non-loopback host needs the explicit flag. The returned
 * text never contains the URL (it carries the superuser password).
 */
export function disposableClusterRefusal(databaseUrl: string, env: Readonly<Record<string, string | undefined>>): string | null {
  if (env[DISPOSABLE_CLUSTER_FLAG] === "1") return null;
  const hint = `set ${DISPOSABLE_CLUSTER_FLAG}=1 only if the whole cluster is disposable`;
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return `PINE_E2E_DATABASE_URL is not a URL; ${hint}`;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return `PINE_E2E_DATABASE_URL must use postgres: or postgresql:; ${hint}`;
  for (const name of HOST_OVERRIDES) {
    if (url.searchParams.has(name)) return `PINE_E2E_DATABASE_URL overrides its host with the "${name}" parameter; ${hint}`;
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return `PINE_E2E_DATABASE_URL does not point at a loopback host (127.0.0.1, ::1, localhost); ${hint}`;
  return null;
}

/** Throws unless the cluster may receive the test roles' fixed passwords (see disposableClusterRefusal). */
export function assertDisposableCluster(databaseUrl: string, env: Readonly<Record<string, string | undefined>>): void {
  const refusal = disposableClusterRefusal(databaseUrl, env);
  if (refusal !== null) throw new Error(`refusing to bootstrap the e2e roles: ${refusal}`);
}

/** Names the e2e setup creates; the only ones the cleanup will drop. */
export const E2E_DATABASE_NAME = /^pine_e2e_[0-9a-f]{12}$/;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Drops one e2e database (terminating leftover sessions); a failure is rethrown with a redacted message. */
export async function dropE2eDatabase(query: (sql: string) => Promise<unknown>, name: string, redact: Redactor): Promise<void> {
  if (!E2E_DATABASE_NAME.test(name)) throw new Error("refusing to drop a database the e2e setup did not create");
  const failure = await query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).then(
    () => null,
    (error: unknown) => ({ error }),
  );
  // No `cause`: the original error may carry the connection string; only its redacted message is reported.
  if (failure !== null) throw new Error(`e2e cleanup: DROP DATABASE ${name} failed: ${redact(messageOf(failure.error))}`);
}

export interface E2eCleanup {
  /** Pools and clients connected to the e2e database; closed first (best effort: the drop terminates leftovers). */
  disconnect: (() => Promise<unknown>)[];
  /** Drops the database, or null when it was never created. */
  drop: (() => Promise<void>) | null;
  /** Ends the superuser connection; a failure is reported. */
  endAdmin: () => Promise<unknown>;
  redact: Redactor;
}

/** Closes every connection, drops the database and ends the admin connection; throws (redacted) if the drop or the end failed. */
export async function closeE2eDatabase(cleanup: E2eCleanup): Promise<void> {
  for (const close of cleanup.disconnect) await close().catch(() => undefined);
  const failures: string[] = [];
  if (cleanup.drop !== null) {
    await cleanup.drop().catch((error: unknown) => failures.push(cleanup.redact(messageOf(error))));
  }
  await cleanup.endAdmin().catch((error: unknown) => failures.push(`e2e cleanup: closing the admin connection failed: ${cleanup.redact(messageOf(error))}`));
  if (failures.length > 0) throw new Error(failures.join("; "));
}
