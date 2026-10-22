# App-zone certificates without a central certificate service

`https://<label>.app.enclave.host` (label = the first 8 hex digits of the deployment id) has a WebPKI certificate. A
measured direct guest can now obtain it itself:

- **Its own ACME account.** The guest runs ACME with an account key it mints in memory.
- **Its own key.** The certificate is for its own attested TLS key.
- **No central service.** The relay's certificate service (`CERTS_API`) and the central challenge store are not
  needed.

The existing paths keep working unchanged. An app that does not opt in is unaffected.

## Pieces

| Piece | Where | What it does |
| --- | --- | --- |
| Guest issuer | `isolation/m2/front/appzone.go` | Certifies exactly the name it already derives from its own `HOST_DATA` in the measured `-cert-zone`. It pushes each dns-01 value, signed by the attested key with an SNP report bound to the push, to every replica the owner selected. The push carries the lease identity the guest's chain quorum read. |
| Package member | `names.appZone` | `{directory, challenges: [1..8 https URLs], eab?}`, validated identically in Go and in the SDK. It chooses where the guest asks, never which name or zone. |
| Replica authority | `network/app-zone-challenge.mjs` | Each replica judges each push on its own (details below). |
| Replica service | `relay/dns-relay.js` with `APP_CHALLENGE_AUTH=attested-lease` | Runs only on a `DNS_READ_ONLY` route replica. Serves `POST`/`DELETE /v1/app-challenge`. Answers the TXT over DNS. Merges the previous challenge store during a transition (`APP_CHALLENGE_UPSTREAM`). Forwards each accepted push once to peer replicas (`APP_CHALLENGE_PEERS`), and each peer verifies it again. |

What the replica authority checks for each push:

- **Attestation.**
  - The signature and the attestation.
  - A pinned admitted front measurement.
  - `HOST_DATA` equal to the deployment.
- **Name.** The exact name `_acme-challenge.<label>.<zone>`, with a label that is unique in the ledger.
- **One agreeing chain block.** At that block it checks:
  - the current lease equals the push's (runner, operator, owner, app reference, envelope);
  - the runner's registry entry is active;
  - the platform catalog verdict allows the app (`catalogAdmissionRefusal`).
- **Freshness.**
  - The push is at most 300 s old, and the ACME authorization is unexpired.
  - Each push is one-shot.
  - A TXT answer lives at most 120 s.

## Platform governance

These are enforced at issuance by every replica independently:

- catalog delisting, yanking and rejection;
- registry host deactivation;
- the lease and ownership on the existing contracts.

No contract changes, and nothing bypasses platform administration.

## Operator setup

On each provider:

1. Build `dns.mjs` (`relay/build-network.mjs`, then `deploy/build-dns.mjs`) and install it.
2. Add the `deploy/route-dns-appzone.dropin.template` environment, filling in:
   - the admitted front measurements;
   - the RPCs;
   - the production pins;
   - the upstream;
   - the peers.
3. Route `/v1/app-challenge` on the literal-IP HTTPS site (`deploy/caddy-appzone.py`).
4. Point the front's challenge rule at the local replica (`deploy/dnsdist-challenge-rule.py`).

Do one provider at a time, as a canary. To roll back, restore the previous bundle, drop-in, Caddyfile and dnsdist rule.
Challenge values are disposable state.

## Owner setup

Add `"appZone": {"directory": "<ACME directory>", "challenges": ["https://<replica>", ...]}` under `names` in the
startup package. Use custody secrets for an EAB if the CA needs one.

## Limits

- **External dependencies.** Ordinary WebPKI still depends on the `enclave.host` registrar/NS delegation (Enclave's
  brand) and on a public CA. The attested native path (SPKI pinned through attestation) depends on neither.
- **Replica operators.** Replicas are listed by the owner and may be operated by anyone. A replica can only refuse or
  answer for what the chain and attestation authorize.
- **Supported guests.** SEV-SNP direct guests only. Enclave Shield (T0-hv) guests and m4 per-app guests keep the
  existing relay CSR path until their attestation is accepted by this authority.
