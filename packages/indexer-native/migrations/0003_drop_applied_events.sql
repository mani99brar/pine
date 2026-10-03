-- indexers-003 (PRD-05 section 2.1): idempotency is the cursor-position guard of applyEvents (every event at or before
-- the stored (block, logIndex) position is skipped inside the applying transaction), so no per-event rows are kept.
-- 0001 and 0002 are applied history and stay unchanged; this file removes the table they created and granted.

DROP TABLE pine_index.applied_events;
