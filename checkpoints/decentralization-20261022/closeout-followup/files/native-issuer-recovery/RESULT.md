# Native CA issuance, renewal and cold recovery without minipc: source review (read-only)

Reviewer: Claude (source reviewer). Date: 2026-10-22.

**Scope.**
- Repo: `native-control-attested/repo`, HEAD eaea7e463 on published 6f2c7da46, plus the native worker's uncommitted
  files, which were not edited.
- Public local reports: `work/control-vm/*`, `outputs/*`.
- Nothing was built, tested, run, SSHed, signed or sent. No secret file was opened. The CA key, `services.key`, the gpg
  archive and its passphrase were not read.
- Paths below are relative to the repo unless they start with `work/` or `outputs/`.

## Verdict

1. **Existing implementation.** No existing code hosts native CA issuance on Enclave hosts.
   - Today there are two paths:
     - the minipc timer (`work/control-vm/renew-native-cert.py`);
     - the offline/admin tool (`scripts/native-control-certificate.mjs`, which needs openssl and a CA key file).
   - There is **no activation recipe to give yet**.
2. **Proposed placement: the platform API group's primary.** Everything the issuer needs already exists there except
   about 150 lines of glue and a pure-JS leaf encoder.
   - **CA key storage and recovery:** the role's admin-signed credentials package. It is replicated AEAD under the
     group key K, held in plaintext only inside measured member guests, and escrowed to admin recovery keys
     (`metal/guest/platform-api-role.mjs:6-16, 245-262`; `docs/network/hosted-platform-api.md:63-90`).
   - **Target verification:** the role's own `verifyMeasuredControl` peer verifier (`metal/guest/platform-api-verify.mjs`).
   - **Admin moderation:** the platform host policy runtime the relay already uses (`relay/api-relay.js:116, 213, 221`).
   - **Delivery:** the guest's existing install endpoint, which needs no new protocol (`PUT /.well-known/enclave-native-certificate`, `measured-control.mjs:746, 820-833`).
3. **Trust root and compatibility.**
   - The trust root does not change: the same CA (sha256 `86bf2c48…a62c`, P-256, `pathlen:0`, name constraint
     `enclavehost.eth`, valid until 2036-10-15) and the same 7-day serverAuth leaf profile. Existing native pins and
     clients keep working.
   - No contract changes.
   - No new protocol: admin packages, the verifier, the policy gate and the install PUT all exist.
   - The CA key lives only in measured member guests, sealed state and admin escrow. It never goes into an ordinary
     config, a DigitalOcean host or a relay env file outside a measured guest.
4. **The blocker is external.**
   - A `platformApi` group needs 3–7 registered SEV-SNP members with distinct operators
     (`measured-control.mjs:341`). Only one SNP chip exists today (metal0/minipc).
   - Until then, minipc's timer, or admin offline issuance from the existing encrypted backup, remains the only issuer.
   - The source work can be done now.

## What exists today (facts)

**The CA (public certificate only, `work/control-vm/native-ca-public.pem`).**
- CN `Enclave ENS Service CA`, ECDSA P-256 with SHA-256.
- `CA:TRUE, pathlen:0`, critical name constraint permitting `DNS:enclavehost.eth`.
- Valid 2026-10-18 to 2036-10-15. DER sha256 `86bf2c486d9dea6ca6cafc6d5649f965121bd4d7ab0c7c8b8cbf88822641a62c`.
- Pinned by `work/control-vm/verify-native-fronts.py` and `outputs/native-fronts-verification.json` (all four fronts
  validated the native leaf with the pinned CA on 2026-10-19).

**minipc issuer (`work/control-vm/renew-native-cert.py`, run by `enclave-native-certs.timer` per `outputs/control-recovery-runbook.txt:21`).**
- It holds `/var/lib/enclave-native-ca/{ca.pem, ca.key, services.key}` on the minipc control VM.
- Its leaf is over a **shared host key** (`services.key`): basicConstraints critical CA:FALSE, keyUsage critical
  digitalSignature, EKU serverAuth, serial of 20 random bytes, 7 days, renewed when under 2 days remain (`-checkend 172800`).
- SAN = `api, mcp, get, ipfs, sia` `.enclavehost.eth`.
- It is served by minipc `enclave-control-tls`. The fronts only forward it, over loopback 30443 via the reverse tunnel.

**Cold copy.** `work/control-vm/backup-control.py:15` includes `var/lib/enclave-native-ca` in a gpg-AES256 archive. The
archive is stored on the four DigitalOcean providers; the passphrase is in `work/private/control-recovery`, which was not
read. This is an existing admin cold backup, not a serving path.

**Measured path (6f2c7da46 plus the native worker).**
- `nativeControl {names, caSha256}` is HOST_DATA-bound (`measured-control.mjs:205-215`). It requires the `platformApi`
  member (`:208`), so **every native-control guest is a platform API group member**.
- The leaf must carry the boot's attested control key.
- The guest validates any installed chain (`checkNativeCertificate`, `:769-785`): bound CA, own key, a real TLS handshake
  per name, and a strictly later expiry.
- Issuance is manual today: `request` → `issue` (openssl, CA key file) → `install` (`scripts/native-control-certificate.mjs:1-20, 64-79`).
- `docs/network/measured-control-guest.md:157` states: "the native CA key is held in one place today (the minipc control VM)".

**Platform API role (6f2c7da46).**
- K arrives sealed to the boot's handoff key, by admin genesis/recover or by a member that verified the newcomer.
- State is replicated by majority commit.
- Archives are pushed with K escrowed to `platformApi.recovery` keys.
- Credentials are an admin-signed (EIP-191) package with kind `credentials`, groupId, target statement and a strictly
  increasing `at`. The package **replaces the whole set** (`platform-api-role.mjs:245-262`). They are applied on the
  leader only, and leader/follower hooks exist (`:162-167`).
- `startRelay` passes **every** credential to the relay child's environment, writing `*_FILE` values to the RAM fs (`:121-133`).

**ACME certificate service (`relay/certs.js`).** Lease-holding enclaves trade a CSR for an ACME certificate there; the
relay holds the ACME accounts but "signs nothing itself". It has no internal CA backend, and app-zone names only. It is the
precedent for a "relay/platform-owned issuance, key stays in the CVM" service, but not the place to add native-CA signing.

**Custody v2** (vault, custodians, release to leased apps) is customer-secret custody with vault machine records and a
custodian quorum. It is not the platform-credential path and is not needed here.

## Proposal (minimal; source changes for root and the native worker to integrate)

### Files and entrypoints

1. **NEW `metal/guest/native-issuer.mjs`**: the issuer, started by the role on the leader only.
   - `leafFor({ caKeyPem, caCertPem, spkiDer, names, days = 7 })`: a pure-JS DER encoder, signed with node:crypto P-256
     (the guest has no openssl; see `measured-control.mjs:613-631` `selfSignedCert`, whose `der`/`oid`/`utcTime` helpers
     are reused, exported).
     - Profile: v3; positive 16-byte random serial; issuer = CA subject; notBefore = now−1 h; notAfter ≤ now+7 d;
       basicConstraints critical CA:FALSE; keyUsage critical digitalSignature; EKU serverAuth; SAN = names; CN = names[0].
     - Add SKI and AKI (keyid of the CA's SKI) so chain building matches openssl-issued leaves.
     - Self-check every leaf with the existing `checkNativeCertificate` before sending it.
   - `renewRound()`, for each `pa.members[i]`:
     1. Run `productionVerifier`-equivalent verification:
        - `verifyMeasuredControl(controlUrl, { measurements: pa.measurements, minTcb: pa.minTcb, configDigest: <the member statement's> })`;
        - status must be `verified`;
        - operator and publicUrl must equal `members[i]`.
     2. Re-read the evidence over a connection pinned to the attested key (same boot), using
        `nativeCertificateRequest({ evidence, identity })`. This function already exists, is pure, and is exported by
        `scripts/native-control-certificate.mjs`.
     3. Require `request.caSha256 === sha256(CA DER)`.
     4. Require a **fresh platform host policy decision** for the attested registry id, plus the attested chip (the
        native worker's sha256 CHIP_ID change), through the same `nativeHostDecision` / `freshAdmissions` path as
        `network/native-control-routes.mjs`. Refuse when the policy runtime is explicitly off.
     5. Issue only when the member's current leaf has less than 2 days left. Read its expiry from its native handshake or
        `/native` status; this matches `renew-native-cert.py`.
     6. Install with the existing `installNativeCertificate` (`scripts/native-control-certificate.mjs:121`), which PUTs
        to `NATIVE_CERT_PATH` pinned to the attested key. For itself, the leader calls its own front's in-process
        `installNativeCertificate(chainPem)` (`measured-control.mjs:795`), so it needs no hairpin.
   - Pacing: one round per hour plus at startup.
   - Logging: names, boot id and expiry only. No key or sealed material is logged.
2. **`metal/guest/platform-api-role.mjs`**:
   - **Start/stop:** `onLeader` starts the issuer when the credentials contain `NATIVE_CA_KEY` (PKCS#8 PEM) and
     `NATIVE_CA_CERT` (PEM). `onFollower` and `stop` stop it.
   - **Policy runtime:** the issuer's runtime is `createHostPolicyRuntime(resolveHostPolicyConfig({ env: pa.relayEnv, … }))`,
     the same configuration the relay uses, so no new authority is introduced.
   - **Least privilege:** in `startRelay`, exclude the `NATIVE_CA_*` names from the relay child's environment and RAM-fs
     files. The relay never needs the CA key. This is a one-line filter in the `credEnv` loop.
3. **`metal/guest/measured-control.mjs`**: export the existing DER helpers, or place `leafFor` beside `selfSignedCert`.
   Nothing else changes; the install, check and serving paths are unchanged.
4. **`scripts/build-platform-api-guest-bundle.mjs:34`**: add `metal/guest/native-issuer.mjs` and
   `scripts/native-control-certificate.mjs` (pure exports) to the required inputs. The new platform-api bundle means a
   **new measurement**. The native worker's gsup/measured-control edits already require one, so this rides along.
5. **Docs:**
   - `docs/network/measured-control-guest.md:157`: issuance is by the group leader; offline admin issuance remains the fallback.
   - `docs/network/hosted-platform-api.md:67`: add `NATIVE_CA_KEY` and `NATIVE_CA_CERT` to the credentials table, noting
     they are not exported to the relay.

### Key provisioning and recovery boundaries

- **Provisioning (one admin action at activation).**
  - The admin or root extracts `ca.key` and `ca.pem` from minipc, or from the existing gpg cold backup, onto the admin
    workstation.
  - They then run `scripts/platform-api-admin.mjs credentials` with the **complete current credential set plus**
    `NATIVE_CA_KEY` and `NATIVE_CA_CERT`. The package replaces the set (`:255-257`), so omitting existing names would
    drop them.
  - The package is signed by a `platformApi.admins` wallet. This is a signature, not a transaction.
  - The plaintext exists only in the admin's hands and in measured member guests.
- **Group and replication.** The key is replicated only as AEAD under K. The archive sinks see ciphertext, and K is escrowed
  to `platformApi.recovery`.
- **Not acceptable (and not proposed):**
  - the key in a direct config, `relayEnv`, a DigitalOcean host, a provider drop-in, or an Enclave app that is not a
    measured member;
  - minipc as a required endpoint.
- **minipc retirement.** After the group issues successfully for one full renewal cycle, root disables
  `enclave-native-certs.timer` and removes the key from the minipc VM. The gpg cold backup is admin escrow; keeping or
  re-keying it is root's decision.

### Issuance proof and admin authorization (all existing mechanisms)

- **Admin chooses the issuer:** the credentials package. Revocation is a newer package without `NATIVE_CA_*`.
- **Admin chooses the eligible boots:** `platformApi.members` and `measurements` are HOST_DATA-bound group config, and
  `nativeControl.caSha256` must equal the CA.
- **Hardware and boot proof:** `verifyMeasuredControl` (AMD chain, TCB floor, measurement, HOST_DATA, TLS key = attested,
  supervisor keys, original registry row through the quorum).
- **Admin moderation:** a fresh platform host policy decision (registry id, operator, owner, endpoint, chipId). A ban
  stops renewal, so exposure is at most 7 days. Discovery (`native-control-routes.mjs`) withdraws the route at its next
  60-second refresh.
- **Scope:** names ⊆ `statement.native.names` ⊆ `NATIVE_NAMES` (api/mcp), and the CA's own name constraint caps names at
  `enclavehost.eth`.

### Reboot, new host and cold recovery

- **One member reboots:**
  - its K is lost, because K lives on the RAM fs;
  - it rejoins by handoff from a verifying member (existing);
  - the leader issues it a leaf for its new key at the next round;
  - until then its native names fail closed, which is the existing behavior.
- **Leader loss:** the lease moves to a new leader, which starts the issuer from the replicated credentials. There is no
  state beyond the 7-day leaf.
- **New host:** the admin adds the member to the group config (new HOST_DATA, existing rolling procedure). It boots, is
  handed K, and is issued a leaf.
- **Total loss (all members):**
  - The admin `recover` package restores K and credentials from an archive to a newly verified boot (existing:
    `scripts/platform-api-admin.mjs`, `RECOVERY_INFO`). Issuance resumes.
  - Fallback if no SNP group can boot: admin offline `scripts/native-control-certificate.mjs request/issue/install` with
    the cold key. This needs the admin, not minipc.
  - Leaves outlive an outage by at most 7 days.

### Dependencies and circularities

- **No circularity.**
  - The issuer reaches members at their attested `controlUrl` (`https://<ip>:<port>`, pinned key), never through native
    names.
  - K handoff and verification do not use native names.
  - The policy and registry are read through the guest's bound RPC quorum.
  - AMD collateral is handled exactly as for the existing handoff verifier.
- **Transport versus service.**
  - DigitalOcean stays minimal WireGuard/SNI transport: forwarding 443 to member control fronts if members sit behind it.
    It holds no key and issues nothing.
  - The issuer is the service, and it runs only in measured member guests.
- **Adjacent minipc dependencies not closed here (reported, not dropped):**
  - (a) `relay/native-discovery.mjs` (port 8187, serving `/native/ca.pem` and routes) still runs on the minipc control VM.
    It holds no key, so it can be placed elsewhere.
  - (b) The legacy shared `services.key` leaf for **get, ipfs and sia** `.enclavehost.eth` is served by minipc
    `enclave-control-tls`. The measured path covers only api/mcp (`NATIVE_NAMES`). Those names need their own attested
    serving host before minipc issuance can stop for them.
  - (c) New-client ENS-authorized CA bootstrap is still incomplete (`docs/design/nan-retirement.md:45`).
- **Dependency on the native worker:** the chip-aware `decideHost` (sha256 CHIP_ID) should land first, so the issuer and
  discovery share one decision path.

### Focused tests (to add; not run)

1. `leafFor` output, checked three ways: `checkNativeCertificate` accepts it; Node `tls` handshakes for each name under the
   CA; `openssl verify -verify_hostname` passes under the name constraint. Extension set equals the minipc leaf's profile
   plus AKI/SKI; lifetime ≤ 7 days; serial positive.
2. **Refusal cases (no issuance; each check is a separate case):**
   - unverified, rejected or unknown attestation;
   - measurement not in `pa.measurements`;
   - operator or publicUrl not a member;
   - `caSha256` mismatch;
   - names outside `NATIVE_NAMES`;
   - registry pending;
   - policy denies (registryId, operator or chipId);
   - policy runtime off or unreadable.
3. **Leader only:** a follower never issues. On leadership loss, a round in flight stops before install.
4. **Renewal window:** no issuance when more than 2 days remain; issuance below that; a replayed older leaf is refused by
   the guest (existing).
5. **Credentials:**
   - missing `NATIVE_CA_*` means the issuer is inert;
   - a newer package without them stops issuance;
   - `NATIVE_CA_*` never appears in the relay child's environment or files.
6. **Cold recovery:** genesis → archive → `recover` to a new boot → leader issues with the restored key. Use a synthetic
   AMD chain as in `test/platform-api-hosted.test.mjs`.
7. **Ban:** after an anchored ban, the member is not renewed and discovery drops its route. This is the integration test
   with `native-control-routes.mjs`.

## Can be done now versus external prerequisites

**Now (source, local, root-authorized queue):**
- items 1–5 and the tests above;
- a bundle rebuild and an image rebuild (new measurement), coordinated with the native worker's chip change.

**External prerequisites (real):**
1. **Hardware:** ≥3 SEV-SNP measured control hosts with distinct operators, registered in the original EnclaveRegistry
   (operator-wallet registration transactions, existing). Today only metal0 exists, and the authorized hardware is one site.
2. **Admin keys:** admin wallet(s) and `platformApi.recovery` X25519 keys created and held by the admin.
3. **Genesis and handoff:** platform API genesis or import per `docs/network/hosted-platform-api.md:152-166`.
4. **CA provisioning:** the admin-signed credentials package including `NATIVE_CA_*`. This is the one-time CA key
   extraction from minipc or the cold backup, done by root or the admin.
5. **Policy:** any policy change is the existing admin sign plus anchor. No new wallet steps are needed for issuance.
6. **minipc decommission:** after one observed cycle, root disables the minipc timer and removes the key.

## Real unknowns

- **Exact parity with minipc leaves.** OpenSSL 3 `x509 -req -extfile` may add SKI/AKI. No public minipc leaf was inspected
  here (doing so would need a live fetch). Compare one public leaf offline before finalizing `leafFor`'s extension set.
- **CA key encoding** (SEC1 or PKCS#8 PEM) in `ca.key` was not read. The provisioning step should normalize to PKCS#8.
- **Collateral reachability.** Whether member guests can reach AMD KDS or the configured collateral mirror for peer
  verification depends on the group deployment, exactly as for the existing handoff. It is unverified on hardware.
- **Placement of `native-discovery` and the get/ipfs/sia native names.** This is outside this issuer change; it is a
  root placement decision.

## Commands and paths inspected (read-only)

- `cat work/effective-goal-requirements.txt`.
- `sed`/`grep` over:
  - `scripts/native-control-certificate.mjs` (1-168);
  - `docs/network/measured-control-guest.md` (110-175);
  - `docs/network/hosted-platform-api.md` (headings, 63-90, 152-166);
  - `docs/design/nan-retirement.md` (native lines);
  - `metal/guest/platform-api-role.mjs` (1-170, 245-262);
  - `metal/guest/platform-api-verify.mjs`;
  - `metal/guest/measured-control.mjs` (40-49, 205-250, 329-391, 605-640, 746-873);
  - `relay/native-discovery.mjs`;
  - `relay/certs.js` (header, symbols, 828-847);
  - `relay/api-relay.js` (116, 209-221, 3050-3062);
  - `network/native-client.mjs` (header);
  - `scripts/platform-api-admin.mjs` (26-131).
- `git log` for `relay/native-discovery.mjs` and `-S "native CA"`; `git show --stat` of bb7fcfcfd, 2a7d5fbf9 and dbeb31c7d.
- Reports and scripts: `work/control-vm/{renew-native-cert.py, verify-native-fronts.py, backup-control.py, control-backup-inventory.py, activate-native-ingress.py, cert-inventory.jsonl}`,
  `outputs/{native-fronts-verification.json, control-recovery-runbook.txt, enclave-decentralization-investigation.txt}`.
- `openssl x509 -noout -text` and `sha256sum` of the public `work/control-vm/native-ca-public.pem`.
