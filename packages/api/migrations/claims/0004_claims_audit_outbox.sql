-- claims lane, claims-hardening (PRD-07 §3b, SEC-OPS-07): audit outbox. Every audited claims write inserts its entry here
-- in the same transaction (or the same statement) as the write; claims.flushAudit records each row through the audit log
-- and then deletes it, so an audit outage never loses an entry (at-least-once: a crash between record and delete, or a
-- concurrent flusher in another process, can only duplicate one).

CREATE TABLE claims_audit_outbox (
  id uuid PRIMARY KEY,
  -- The AuditEntry exactly as it is recorded (actorUserId, action, subjectType, subjectId, details, ip).
  entry jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX claims_audit_outbox_order_idx ON claims_audit_outbox (created_at, id);
