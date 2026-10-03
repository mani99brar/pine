// Append-only audit log (SEC-OPS-07). Details are redacted recursively here (never left to callers) and capped at
// 8 KiB; created_at is database time. The runtime role has INSERT/SELECT only; IPs are nulled after 30 days by the
// SECURITY DEFINER function pine_audit_expire_ips (called by the cleanup job).

import { sql } from "drizzle-orm";
import type { AuditEntry, AuditLog, Database } from "../../contracts/app.js";
import { redactDeep, type Redactor } from "../../contracts/redact.js";
import { queryOne, type Executor } from "./db.js";

export const AUDIT_DETAILS_MAX_BYTES = 8 * 1024;

export function boundedDetails(details: Record<string, unknown>, redact: Redactor): Record<string, unknown> {
  const redacted = redactDeep(details, redact);
  const safe = typeof redacted === "object" && redacted !== null && !Array.isArray(redacted) ? (redacted as Record<string, unknown>) : { value: redacted };
  const json = JSON.stringify(safe);
  const size = Buffer.byteLength(json, "utf8");
  if (size <= AUDIT_DETAILS_MAX_BYTES) return safe;
  return { truncated: true, originalBytes: size, preview: json.slice(0, 1024) };
}

function bounded(value: string, max: number, redact: Redactor): string {
  return redact(value).slice(0, max);
}

export class PostgresAuditLog implements AuditLog {
  constructor(
    private readonly db: Database,
    private readonly redact: Redactor,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.recordWith(this.db, entry);
  }

  /** Records inside a caller's transaction (pass the transaction handle). */
  async recordWith(executor: Executor, entry: AuditEntry): Promise<void> {
    const details = boundedDetails(entry.details, this.redact);
    const ip = entry.ip === null ? null : entry.ip.slice(0, 64);
    await queryOne(
      executor,
      sql`INSERT INTO audit_log (actor_user_id, action, subject_type, subject_id, details, ip)
          VALUES (${entry.actorUserId}::uuid, ${bounded(entry.action, 128, this.redact)}, ${bounded(entry.subjectType, 64, this.redact)},
                  ${bounded(entry.subjectId, 256, this.redact)}, ${JSON.stringify(details)}::jsonb, ${ip})
          RETURNING id::text AS id`,
    );
  }
}
