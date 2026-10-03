# Pin failures

Every stored blob (claim document, evidence manifest, artifact) must reach both pin targets: Pine's Kubo node and the
Pinning Service API provider (`deploy/ipfs/README.md`). The local copy in Postgres stays the source of truth for serving,
so a pin failure does not break downloads from the user-content host; it threatens availability to adjudicators and
agents who fetch by CID, and the claim's long-term record (SEC-EVID-04).

## Signals

- `pine_content_pin_failed_total` increasing; log lines `Pinning <sha256> failed (attempt N): ...` (redacted).
- `SELECT status, kubo_done, service_done, count(*), max(attempts) FROM content_pins GROUP BY 1, 2, 3;` shows
  `pending` rows with growing `attempts` (backoff doubles from 30 s up to 6 h).
- **`pine_content_pin_integrity_failed_total` > 0 or any `integrity_failed` row: a target returned a CID different
  from the locally computed one. Treat as an incident** (compromised or misbehaving pin target).

## Steps

1. Which target fails? `kubo_done = false` -> Kubo; `service_done = false` -> pinning service.
2. Kubo: `systemctl status ipfs`, disk space of `/var/lib/ipfs`, `curl -s -X POST http://127.0.0.1:5001/api/v0/version`
   from the API host. Restart Kubo; the outbox retries pending items at their next attempt time.
3. Pinning service: provider status, token validity (401/403 in the log line's status), account quota. Rotate the token
   if needed (`deploy/procedures/key-rotation.md`).
4. To retry everything now instead of waiting for the backoff:
   ```sql
   UPDATE content_pins SET next_attempt_at = now() WHERE status = 'pending';
   ```
5. `integrity_failed`: stop using that target (unset it only after a replacement is configured; production refuses to
   start without both), record the item's sha256 and the CID the target returned (from the log line), and open an
   incident. After the target is replaced, reopen the items:
   ```sql
   UPDATE content_pins SET status = 'pending', kubo_done = false, service_done = false, attempts = 0, last_error = NULL,
          next_attempt_at = now(), updated_at = now() WHERE status = 'integrity_failed';
   ```
   (Set only the failed target's flag to false when the other one is known good.)
6. Verify: the pending count drains, `pinned` grows, and `ipfs block stat <cid>` on Kubo and the provider's pin list both
   show the CID.
