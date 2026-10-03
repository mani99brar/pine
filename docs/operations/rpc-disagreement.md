# RPC disagreement and RPC outages

Pine reads Gnosis through two independent providers. The indexer cross-checks them (finalized block hash, headers, every
log request); the API asserts both report chain id 100 at startup and requires the secondary to confirm the primary's
finalized block hash where finality matters (SEC-IDX-05/06).

## Indexer: disagreement halt

A provider difference or a single-response anomaly is re-checked 3 times, 10 s apart, on both providers before the
halt; header and finalized-hash disagreements halt at once ([indexer-halt.md](indexer-halt.md)).

1. Identify the block from the halt row and query both providers yourself from an operator machine (never paste the
   URLs with keys into tickets):
   ```sh
   cast block <n> --rpc-url "$RPC_A" --field hash
   cast block <n> --rpc-url "$RPC_B" --field hash
   cast logs --from-block <n> --to-block <n> --address <claimRegistry> --rpc-url "$RPC_A" | sha256sum
   cast logs --from-block <n> --to-block <n> --address <claimRegistry> --rpc-url "$RPC_B" | sha256sum
   ```
   Compare with a third, independent source (a public explorer or another provider).
2. The provider that disagrees with the majority is faulty: replace it in `/etc/pine/indexer.secrets.env` and
   `/etc/pine/api.secrets.env` (keep two **different companies**; the indexer refuses two hosts of one registrable
   domain), restart both services, then delete the halt row.
3. If both agree now and the anomaly was transient (lagging node, truncated response), record it and delete the halt.
4. If the canonical chain itself differs from what was indexed below finality, this is an incident: a finalized reorg on
   Gnosis or a compromised provider. Escalate ([incident-response.md](incident-response.md)).

## API: RPC outage or error

Symptoms: plan routes and oracle status answer `502 UPSTREAM_UNAVAILABLE` ("Could not read the chain"), the claims jobs
keep publications `planned`/`submitted` and claims `pending` with `last_error` set (the redacted short error, never the
URL). Pine never falls back to a single provider or to unfinalized data.

1. Check both providers' status pages and `eth_chainId` from the API host.
2. Swap in a standby provider (rotate per `deploy/procedures/key-rotation.md`), restart `pine-api`.
3. Jobs retry by themselves (claims reconciliation every 30 s, integrity with backoff up to 1 h).
