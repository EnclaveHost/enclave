# The platform API on Enclave hosts

The platform API is `relay/api-relay.js` and everything it serves. That covers:

- accounts, passkeys, SIWE and device pairing;
- SSO;
- billing, credits, Stripe checkout and webhooks, and the passkey credit vault;
- the sessions relayer;
- relay-held deployment secrets;
- the deployment gateway and controls;
- host status, featured views, referrals, upload tokens, claim hints and placement.

This document covers running that API as a **measured host role** on Enclave hosts. It does not run on a DigitalOcean box
or a single ordinary server. The API's routes, code, OpenAPI and the website default (`https://api.enclave.host/v1`) are
unchanged; only where that origin is served from changes.

## Where it runs, and why there

An Enclave catalog app is a WebAssembly component. The relay is a Node program, and this tree has no Node-to-component
path, so it is **not** packaged as an app.

The supported Node runtime on an Enclave host is the measured control guest. That is `metal/guest/gsup.mjs`, running as
PID 1 of an SEV-SNP CVM booted with `metal.control=direct`. The platform API is one more guest service there, as the hosted
MCP adapter is:

| piece | where |
| --- | --- |
| code | `/opt/metal/platform-api.bundle.mjs`, built by `scripts/build-platform-api-guest-bundle.mjs`. It bundles `metal/guest/platform-api-role.mjs`, `relay/state-replica.mjs` and the verifier, and the **unchanged** `relay/api-relay.js` with its whole closure. The manifest records the sha256 of every input, and `--check` refuses a stale bundle. `metal/build-image.mjs` copies the bundle into the image, so the SNP measurement covers it, and records it in the image manifest (`platformApiBundle`). |
| sidecar | `/opt/metal/fixtures/tpm-roots.pem`, the one file the relay reads beside its module (`relay/vbs-policy.mjs`). It is hashed in the bundle manifest. |
| runtime | the guest's own `/usr/local/bin/node`. No new runtime is added. |
| configuration | the optional `platformApi` member of the direct config (`enclave-direct-control-config/v1`). HOST_DATA binds it. A config without it keeps its exact bytes and digest, and its guest starts nothing new. |
| keys | PID 1 mints an X25519 **handoff key** per boot. The control statement names it (`keys.platformApi`) along with the bundle hash (`runtime.platformApiSha256`). |
| network | the role listens on loopback only. The control front routes `Host: <platformApi.hostname>` (upgrades included) to the role's API port, and the path prefix `/platform-api/` to its peer port. Everything else stays the supervisor's. |
| state | `/run/measured-control/platform-api/data` (0700, the guest RAM fs) is the relay's `AUTH_DATA_DIR`, replicated as described below. |

### The `platformApi` member

It is **identical on every host of the group**; each host's own identity is the config's `identity`. Every field is
required, and nothing is defaulted.

```json
"platformApi": {
  "apiPort": 8098, "peerPort": 8099, "hostname": "api.enclave.host",
  "members": [ { "operator": "0x…", "publicUrl": "https://…", "controlUrl": "https://<ip>:<controlPort>" } ],
  "measurements": ["<96 hex>"], "minTcb": { "Genoa": { "bootloader": 10, "tee": 0, "snp": 23, "microcode": 84 } },
  "admins": ["0x…"], "recovery": ["<64 hex X25519>"],
  "archives": ["https://…"], "archiveMs": 30000,
  "relayEnv": { "ADDRESS_BOOK_ADDRESS": "0xab214342d5a490150a4a977063a2f88e21f80907", "SIWE_DOMAIN": "enclave.host", "…": "…" },
  "leaseMs": 10000
}
```

- **`members`**: 3 to 7 hosts registered in the original `EnclaveRegistry`, with distinct operators. A majority must
  survive the loss of one.
- **`relayEnv`**: the relay's **public** configuration, for example:
  - the original contracts, through the admin `EnclaveAddressBook` (`0xab21…0907`);
  - the domains and the RP id;
  - the policies.
  A secret-shaped name (KEY, SECRET, TOKEN, PRIVATE, HMAC, SEED, EAB…) is refused here.
- **`admins`**: the Enclave admin wallets that may sign bootstrap, recovery and credentials packages. Platform
  administration stays where it is.

## Secrets boundary

| kind | examples | where it exists |
| --- | --- | --- |
| platform credentials | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SSO_SIGNER_KEY`, `SESSIONS_RELAYER_KEY`, `PROVISIONER_PRIVATE_KEY`, `HOST_SPONSOR_*_KEY`, `SECRETS_KEY`, `UPLOAD_KEY`, `DNS_TXT_KEY`, `ACME_EAB_*`, `BILLING_ADMIN_TOKEN`, `SECRETS_RELEASE_SIGNING_KEY_FILE`, `SECRETS_RELEASE_PREDICT_SEED` | as plaintext, only inside member guests and in the admin's offline tool. They arrive as an admin-signed package sealed to the primary's boot (`platform-credentials.json` in the replicated state). They reach the relay's environment, and a `*_FILE` credential reaches a 0600 file on the RAM fs. An older package replayed later is refused, so a rotation cannot be rolled back. |
| the native CA (optional) | `NATIVE_CA_KEY`, `NATIVE_CA_CERT` (metal/guest/native-issuer.mjs) | the same sealed credentials, but used ONLY by the primary's native issuer: never in the relay child's environment or files (the role drops every `NATIVE_CA_*` name at the final environment boundary, whatever its source) |
| platform private state | accounts, passkey credentials, the account-session signing key, orders, Stripe events, the relayer journal, referrals, pads, placement, domains, ACME account keys | as plaintext, only in member guests; elsewhere only as AEAD ciphertext under the group key K |
| customer secrets | relay-held deployment secrets | under `SECRETS_KEY`, exactly as today. Custody v2 (independent) is unaffected. |
| public data | ledger, registry and catalog reads, `/enclaves`, `/availability` | not state |

## The group key K, and who receives it

K never leaves a member guest except sealed to an attested boot:

- **Genesis or import** (`scripts/platform-api-admin.mjs genesis`). The admin's tool verifies a fresh guest. It then
  seals it a new K, the platform credentials and, at cutover, the existing relay data directory, read and sealed but
  never shown.
- **Handoff.** A member holding K seals it to a newcomer only after:
  - `verifyMeasuredControl` (unchanged) accepted the newcomer: the AMD chain and TCB floor, a measurement in
    `measurements`, HOST_DATA binding the config it presented, the TLS peer as the attested key, the supervisor holding
    the minted keys, and the **original registry** (read through this guest's bound RPC quorum) naming the bound operator
    as active with this boot's proof key;
  - the newcomer's config carries the identical `platformApi`.
  K is sealed to the handoff key that boot's statement names.
- **Recovery** (`… recover`). K is escrowed (HPKE) to every `recovery` key and stored beside each archive. After a total
  loss the admin opens it offline, verifies a fresh guest, and seals it K plus the latest archive.

Every package is signed (EIP-191) by an `admins` wallet and names its target boot by statement hash.
`--print-message` / `--signature` let a hardware wallet sign.

The admin's tool verifies with AMD collateral fetched from KDS into a local cache: `--collateral-dir`, by default
`$XDG_CACHE_HOME/enclave/amd-collateral`. The data is public, and every entry is authenticated against the pinned AMD
roots when it is read. The tool has no option for other roots or for skipping the verification.

The tool sends a package only:
- to the boot it has just verified, over a connection pinned to that boot's attested control key, so nothing is sent
  to another key;
- if the package names that boot's statement, this group and the command. A package prepared for an earlier boot is
  refused locally.

`status` is an unauthenticated read.

## Durable state, the single writer, and failover (`relay/state-replica.mjs`)

**One primary per epoch, elected by a majority of `members`.**

- **Pre-vote.** A member that cannot win disturbs no one.
- **Leases.** A member grants an epoch at most once, and only after `leaseMs` without contact from a primary. A member
  that just rebooted waits a lease first, because it has forgotten its votes.
- **Commit.** The primary scans the data directory, replicates the change to every member, and counts it once a
  **majority applied it**. A member that lags gets a full snapshot.
- **Successor.** An elected successor adopts the most advanced state among its voters, then opens its epoch with a
  snapshot that a majority must hold.
- **Renewal.** The primary renews its lease by majority heartbeat. It kills the relay the moment it cannot.

**Output commit.** Nothing the relay does leaves the guest before what it wrote is on a majority:

- every HTTP response is held until the commit;
- every outbound `fetch` (chain RPC and transaction submission through viem, Stripe, ACME, DNS, screening lists) waits
  for it too.

A response or request whose state could not be committed is never sent.

**Replay- and tamper-proof transport.**

- **AEAD.** Every message is AEAD under K, with the group in the AAD.
- **Requests** carry the recipient, the sender, a fresh nonce and the sender's clock.
- **Answers** echo the exact digest of the request they answer, so a captured answer to anything else is never
  counted.
- **Members refuse** anything outside their freshness window (`maxSkewMs`, by their own clock), any nonce already seen,
  and anything addressed to another member.
- **Monotonic.** Every state change is monotonic in (epoch, seq), so an old authentic request replayed later changes
  nothing.
- **Crash-safe.** A change is journaled before it is applied, so a crash between two files re-applies it whole.

**Standbys** forward API requests to the primary's control front, pinned to the TLS key it announces in AEAD-sealed The standby completes the TLS handshake (without SNI, so the front presents its attested control certificate, not the WebPKI one) and compares the key on that socket before it writes any request byte. A wrong key, a silent peer (10 s handshake bound) or a client that leaves ends the forward.
heartbeats. With no primary reachable they answer 503 with `retry-after`.

### What this guarantees, and what it does not

- **Minority loss** (any member, the primary included): **no acknowledged write is lost**. Every response and outbound
  call followed its commit.
- **Whole-group loss** (every member at once, for example every host rebooted): state survives only in the archives, so
  up to `archiveMs` of writes can be lost. The data directory lives on the guest RAM fs; SEV-SNP sealed disks are not
  implemented here.
- **Lost on failover by design:** in-memory state (SIWE and passkey challenges, rate limits, attached host tunnels).
  Clients retry, and hosts re-attach.
- **Same as today:** cross-file atomicity of one relay operation. The relay writes JSON files one at a time.
- **Assumption:** clocks are loosely synchronized (freshness window `maxSkewMs`, default 120 s; leases with a 20 %
  margin).

## What this is, and is not, evidence of

| claim | status |
| --- | --- |
| Source support: the config member, launch, front routes, statement key, bundle and image inclusion, role, replication, admin tool | in this candidate, tested |
| The unchanged relay serving accounts across a primary loss, standby forwarding, credentials, archive ciphertext and total-loss recovery | tested end to end on loopback (`test/platform-api-hosted.test.mjs`). The SEV-SNP evidence is **synthetic**, and the supervisor behind each front is a stand-in that serves only the minted-key attestation. |
| The original `EnclaveRegistry` as the admission authority, through an RPC quorum | tested against the original contract source on anvil (`test/platform-api-registry.test.mjs`) |
| A real SEV-SNP measurement of an image carrying the bundle | not produced: needs SNP hardware and an image build by root |
| A WebPKI certificate for `api.enclave.host` inside the guest, and DNS to the member hosts | **not mine**: certificate-hosted-placement and hosted-service-placement. Until then browsers cannot reach the role at the production name. |
| Deployed coverage | **none**. Nothing is activated; root owns production. |

## Activation and rollback (root only)

1. **Build.** Run `node scripts/build-platform-api-guest-bundle.mjs --check` on the reviewed tree, then the image build.
   Record `platformApiBundle.sha256` and the measurement.
2. **Configure.** Write the `platformApi` member for 3 or more hosts. The `relayEnv` must keep today's public relay
   configuration, the original contracts through the address book. HOST_DATA changes.
3. **Boot and verify.** Boot the members, then verify each one (`metal/measured-control-verify.mjs`).
4. **Genesis with import.** At the cutover window, stop writes on the old API (read-only maintenance), run
   `scripts/platform-api-admin.mjs genesis --import-dir <the old AUTH_DATA_DIR> --credentials <file>` against one member,
   and let the others be handed K.
5. **Switch.** Point `api.enclave.host` (DNS and the WebPKI certificate, other owners) at the members.
6. **Rollback.** Before step 5 the old API is untouched. After it, the old data directory is the rollback point until
   writes resume.
