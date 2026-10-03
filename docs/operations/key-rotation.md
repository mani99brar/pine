# Key rotation (runbook)

Procedures (exact steps per secret): `deploy/procedures/key-rotation.md`. This runbook is about when and how to decide.

## Schedule

| Secret | Rotate |
|---|---|
| GitHub token encryption key | yearly, and on any suspected database or backup exposure |
| GitHub App client secret, webhook secret | yearly, on staff departure with access, on suspected exposure |
| Database role passwords | yearly, on staff departure with access |
| RPC provider keys, pinning token, Envio secrets | yearly or per provider policy, on suspected exposure |
| Terms digest | on every new terms or risk-disclosure version (forces re-acceptance) |
| Admin wallet list | on every staff change (effective at the restart) |

## Suspected exposure (any secret)

1. Open an incident ([incident-response.md](incident-response.md)); record which secret, where it may have appeared.
2. Rotate the secret immediately (procedure), then revoke the old one at its issuer; do not wait for the schedule.
3. Session store or cookies exposed: `DELETE FROM sessions;` (everyone signs in again).
4. Token key exposed together with a database copy: rotate the key, let `gateways.github-token-reencrypt` re-encrypt,
   and consider revoking all GitHub grants (users re-link) since the old ciphertexts may be decryptable by the attacker.
5. Check that the old value is gone from every env file, CI secret and deployment tool; gitleaks runs in CI over the
   whole history: a secret committed by mistake is a rotation, not a history rewrite.

Pine has no wallet keys to rotate: contracts are immutable with no owner, and the deployer hardware wallet has no role
after deployment.
