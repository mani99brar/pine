-- Audit outbox of the markets lane (PRD-07 section 3, SEC-OPS-07). Every audited write inserts its audit entry here in
-- the SAME SQL statement as the write (a data-modifying CTE), so a write and its pending audit entry commit together.
-- flushAudit records each row through the platform AuditLog and then deletes it; a row whose record failed stays for
-- the next flush (at-least-once: a crash or a concurrent flusher can duplicate an entry, never lose one).
CREATE TABLE markets_audit_outbox (
  id uuid PRIMARY KEY,
  -- The AuditEntry exactly as it is handed to AuditLog.record (actor, action, subject, details, ip).
  entry jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX markets_audit_outbox_order_idx ON markets_audit_outbox (created_at, id);
