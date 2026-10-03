-- platform-gateways: per-target pin completion (PRD-02 section 3a). An outbox item stays selectable while any CONFIGURED
-- target (Kubo, Pinning Service) has not confirmed it, so content stored before a provider was configured still reaches
-- it. 'pinned' now means BOTH targets confirmed the CID. 0001 is never edited (its checksum may already be recorded).

-- Backfill. Since 0001 the per-target flags are written only after that target confirmed the local CID, so a target that
-- already succeeded is already marked done and keeps its flag; an item that 0001-era code closed as 'pinned' while a
-- target was not configured is reopened for the missing target only (the done target is never contacted again).
UPDATE content_pins
   SET status = 'pending', attempts = 0, last_error = NULL
 WHERE status = 'pinned' AND NOT (kubo_done AND service_done);

ALTER TABLE content_pins
  ADD CONSTRAINT content_pins_pinned_means_all_targets CHECK (status <> 'pinned' OR (kubo_done AND service_done));
