# Kubo and pinning (ADR-0001 D11, SEC-EVID-04/09)

Pine stores every claim document, evidence manifest and artifact itself (Postgres table `content_blobs`, the source of
truth for serving) and pushes each one, as a single raw IPFS block (CIDv1, raw codec, sha2-256, at most 256 KiB), to two
pin targets through the **pin outbox** job (`gateways.content-pin-outbox`, every 30 s):

1. Pine's own Kubo node: `POST {PINE_KUBO_API_URL}/api/v0/block/put?cid-codec=raw&mhtype=sha2-256&mhlen=32&pin=false`,
   then `POST /api/v0/pin/add?arg=<cid>`;
2. an IPFS **Pinning Service API** provider: `GET {PINE_PINNING_SERVICE_URL}/pins?cid=<cid>&status=...`, then `POST /pins`.

Each target is confirmed separately (a retry repeats only what has not succeeded; backoff 30 s doubling up to 6 h). A
CID returned by a target that differs from the locally computed CID marks the item `integrity_failed` and increments
`pine_content_pin_integrity_failed_total`. Production refuses to start unless both targets are configured.

## Kubo node (same host or private network)

```sh
# Kubo >= 0.30, as its own unprivileged user (e.g. `ipfs`), repository in /var/lib/ipfs.
ipfs init --profile server
# RPC API on loopback only: it is unauthenticated and must never be reachable from the internet.
ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001
# Pine never serves content through Kubo's gateway; disable it (the user-content server serves the bytes).
ipfs config --json Addresses.Gateway '[]'
# Keep pinned blocks; garbage collection removes only unpinned data.
ipfs config --json Datastore.StorageMax '"50GB"'
ipfs config --json Reprovider.Strategy '"pinned"'
systemctl enable --now ipfs   # unit from the Kubo packaging, ExecStart=ipfs daemon --enable-gc
```

Then `PINE_KUBO_API_URL=http://127.0.0.1:5001` in `/etc/pine/api.secrets.env` (http is accepted for Kubo only because
the API is on loopback). The URL is treated as a secret (never logged).

## Pinning Service API provider

- Create an account with a provider that implements the IPFS Pinning Service API (launch gate: pinning provider
  accounts) and a token whose scope is **pin only** (no account administration, no deletion if the provider allows that).
- `PINE_PINNING_SERVICE_URL=https://<provider>/psa` (https only) and `PINE_PINNING_SERVICE_TOKEN=<token>`.
- `PINE_IPFS_GATEWAYS` lists trusted https gateways used only for content-addressed reads (redirects refused,
  size-capped, digest verified after download); never a user-supplied URL.

## Checks after setup

- `curl -s -X POST http://127.0.0.1:5001/api/v0/version` answers on the host and is refused from anywhere else.
- After the first upload: `SELECT status, count(*) FROM content_pins GROUP BY status;` shows `pinned`, and
  `pine_content_pin_failed_total` stays flat. Failures: docs/operations/pin-failures.md.
