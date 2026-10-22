# Owner-authorized custody rewrap (original vault, original custodian image)

Moves a deployment's secrets from a committee of the ORIGINAL `EnclaveSecretVaultV2` (0xE486…) to another committee of
the same vault, using only:
- the vault's own owner-update path;
- the original custodian's own release path.

Nothing is added to either. Admin powers are unchanged.

## Why this path (and not code approval)

The running custodian image (measurement `0x2530eda0…`, commit 9d43e63; its bundle rebuilds byte-for-byte from
`test/fixtures/custodian-9d43e63`, see `MANIFEST.json`) cannot install corrected code in its committee:

- **Code changes need a seat signature the old daemon never produces.** The vault's `proposeCode`
  (`contracts/EnclaveSecretVaultV2.sol`, around line 417) needs approval weight ≥ t, signed by current machine identities.
  - Those identity keys exist only inside the measured guest.
  - The old daemon signs only four digests: genesis, handover approval, deal and ack (`member.mjs` `signDigest` call sites).
  - It serves only `/v2/custody/{info,challenge,release,evidence,join,approve,host-binding}` (`daemon.mjs`). There is no
    code-approval route.
- **A corrected machine can never join.** `member.mjs` `verifyCandidate` requires the newcomer's measurement to be active
  in the committee's code set, which is exactly what cannot be changed.
- **Owner read is not available either.** The old custodian has no owner-read route.

What the original contract and image DO support:

1. **A new committee in the same vault.** `createCommittee` is permissionless. It needs an active registry host whose
   operator signed the machine binding and whose payout is the Enclave wallet. It carries its own code set, so the old
   committee does not need to approve anything.
2. **An owner-authorized move of each policy.** `update`/`updateBySig` by the pinned owner can set
   `committeeId = new` together with a FRESH bundle. The vault refuses a committee change that leaves the old bundle in
   place.
3. **A normal release to an owner-admitted guest image.** The owner's rules admit `(measurement, runtimeId)` pairs (up to
   64) under ONE `appId`.

The old rules format (`v:1`, strict keys) allows exactly one `appId` and refuses unknown keys. The rewrap image therefore
keeps the app's `appId`: it is admitted as one more image of the same app. The app's own images stay admitted, so the app
keeps working throughout.

`ownerRead` must not be set while the old committee serves a policy: the old parser refuses the whole rules object.
`planRewrap` refuses rules that carry it.

## The flow

| Step | Who | What |
| --- | --- | --- |
| 1 admit | policy owner | `update`/`updateBySig`. The rules gain `{sev-snp, M_rw, REWRAP_RUNTIME_ID}`. Committee, pause and bundle are unchanged. policyRev + 1 |
| 2 authorize | policy owner | EIP-712 `Rewrap` (domain `EnclaveCustodyRewrap`/1, chain, vault): id, the source policyRev (after step 1), secretRev, committee, `keccak(bundle)`, destination committee, `keccak(Y_dest)`, the destination custodian measurement, destSecretRev = secretRev + 1, the lease endpoint, the rewrap image measurement and runtime id, expiry (≤ 3 days) |
| 3 run | lease host | `custody/v2/rewrap-host.mjs` launches the measured image with `HOST_DATA` = id, passes `{authorization, signature}` via fw_cfg, signs the ordinary v2 operator message for this release only, and receives the result |
| 4 switch | policy owner | `verifyRewrapResult` AUTHENTICATES the result's SEV-SNP attestation (below); only then does `checkResultAndSwitch` build ONE `update`: `expectPolicyRev` = the authorized revision, committee = destination, rules = the ORIGINAL rules, bundle = the new ciphertext |

Inside the guest (`runRewrap`), in order:
- the authorization is judged against ONE agreed block (`readRewrapFacts`):
  - the policy owner (EOA recovery, or the owner contract's ERC-1271 answer at that block);
  - beneficial owner = pinned owner;
  - the revisions, committee and `keccak(bundle)`;
  - not paused;
  - the destination exists, its `Y` matches the owner's hash, the authorized code is active in it, and every destination
    machine runs it;
  - its own report's measurement and `HOST_DATA`;
  - the rules admit its image;
  - expiry checked against chain time.
- The admin's platform host policy is checked for its own lease host (`checkLeaseHost`). The original image cannot do
  this; the corrected custodian does it at every release.
- A NORMAL v2 release follows: challenges, binding, SNP evidence (`report_data` = binding ‖ appId), the lease operator's
  signature, and every old-custodian check unchanged. Each partial's DLEQ proof is verified, then t of them are combined.
- `{env, configSha256}` is re-encrypted to `Y_dest` with the label for `(id, secretRev + 1, destination)`.
- The guest opens its own output once, with the encryption scalar, and compares it to the released payload. It then checks
  the label proof.
- Only `{format, chainId, vault, authorizationDigest, authorization, checkedAtBlock, destination, bundle, bundleHash,
  bundleBytes, attestation}` is returned. `assertResultShape` refuses any other field, both in the guest and at the host.
- The `attestation` is a FRESH SEV-SNP evidence document in the existing release format (`sev-snp-guest-domain-v1`,
  ABI/2, the rewrap runtime, the guest's transport key). Its report data is:
  - `report_data[0:32]` = `resultBinding(result)`: sha256 over a domain string, the canonical JSON of every public result
    field (bundle, bundle hash and size, the authorization, its digest, the destination, the checked block), and
    sha256(transport key);
  - `report_data[32:64]` = the policy's appId.

## Result authentication (the owner's side)

The result travels through the UNTRUSTED lease host. Without authentication a host could replace the bundle with its own
`encryptBundle(public Y_dest, public label, arbitrary env)`, which every public check (digest, chain, vault, label proof)
accepts. That was root security review P1, reproduced against the pre-fix candidate.

`verifyRewrapResult` therefore runs BEFORE any switch is built, and `checkResultAndSwitch` cannot be called without it. It
requires all of the following:
- **The result answers THIS authorization:** its digest and fields, chain, vault, destination and label. The bundle's hash
  and size are its own, and its label proof verifies.
- **The attestation verifies under the EXISTING verifier**, `custody/verifiers.mjs` (production: `productionVerifiers` with
  AMD KDS collateral; no test roots):
  - VCEK chain to AMD's root;
  - TCB at or above BOTH the policy's floor and the platform floor;
  - not debuggable, the rules' VMPL, CHIP_ID unmasked.
- **It is the right guest and output:**
  - its measurement is the rewrap image the policy ADMITS whose sha256 the authorization names;
  - its stated runtime is the rewrap runtime;
  - `HOST_DATA` = the deployment, `report_data[32:64]` = the appId;
  - `report_data[0:32]` binds EXACTLY this result and the attested transport key.

Refused (tests: `custody-rewrap-result-auth`, and `custody-owner-rewrap` against real guest runs):

| Attempt | Refusal |
| --- | --- |
| a substituted bundle | bad_attestation |
| another run's attestation | bad_attestation |
| a genuine result for another authorization or a stale one | bad_result |
| any tampered field | bad_attestation / bad_result |
| another deployment's evidence | bad_attestation |
| wrong `HOST_DATA` or measurement | bad_attestation |
| a non-AMD-signed or tampered report | bad_attestation |
| a debuggable guest | bad_attestation |
| another runtime or appId | bad_attestation |
| an image the policy does not admit | not_admitted |
| no verifier | no_verifier |

The owner CLI (`scripts/custody-rewrap-plan.mjs --switch`):
1. Reads the policy at one agreed block. It must still be exactly the authorized source state.
2. Derives the original rules as the on-chain rules minus exactly the authorized image.
3. Verifies with the production verifier, and refuses a synthetic verdict.
4. Only then prints the switch.

The host never sees a plaintext and cannot forge the attestation: the report is signed by the chip's VCEK over data only
the measured guest chose.

## Security properties (and their tests)

- **The host cannot substitute anything.** The destination, its key, the revisions, the bundle, the deployment and the
  expiry are all in the owner's signature or read from the chain. `HOST_DATA` binds the launch to the deployment. The
  custodian checks the lease and the operator. Tests: `custody-owner-rewrap` A.2 (12 refusal cases) and
  `custody-rewrap-unit`.
- **No plaintext leaves the measured code.**
  - The host sees only partials sealed to the guest's HPKE key, which is bound in the release binding, and the result.
  - Logs carry codes and public ids.
  - Test: every secret value is scanned for in all results, host messages and custodian/guest/host logs.
- **Retries and interruptions are harmless.**
  - A lost result changes nothing; the old policy keeps working.
  - A retry yields another valid ciphertext for the same destination and revision.
  - A replayed or late switch reverts (`StaleRevision`).
  - A used authorization can never run again.
  - Nothing destroys the old bundle except the owner's explicit switch, which replaces it in the same transaction.
- **Rules are never silently changed.** The switch restores the original rules bytes. `planRewrap` refuses rules that do
  not re-encode to the on-chain bytes.
- **The admin's bans are enforced.** A banned lease host gets no rewrap (guest). After the switch, the corrected custodian
  denies a banned host.
- **Old ciphertext is useless.** It fails the destination's label proof, and it opens only under the old committee's key.

## What source, build and quote establish

- **Source**:
  - `custody/v2/rewrap.mjs`, `rewrap-guest.mjs`, `rewrap-gsup.mjs` and their imports (the image manifest lists every
    bundle input; a release build requires them committed and clean).
  - Review of this source is what establishes WHAT the guest does with a release.
- **Build**:
  - `scripts/build-custody-rewrap.mjs` is deterministic: two builds give the same initramfs and measurement.
  - The base is the digest-checked metal image the custodian was built from. Every base entry is preserved; only
    `gsup.mjs` is replaced and `/opt/rewrap` is added.
  - The launch measurement (`sev-snp-measure`, the pinned OVMF) covers kernel, initramfs and cmdline
    (`kernel-hashes=on`). The same invocation reproduces the running custodian's measurement `c8663742…`.
  - So `M_rw` names exactly this source and measured configuration.
- **Quote** (verified by the OLD custodian, exactly as for any app), establishing that:
  - a genuine AMD SEV-SNP guest, VCEK-signed, on an admitted TCB, not debuggable, at the rules' VMPL, launched with
    measurement `M_rw` and `HOST_DATA` = the deployment, produced `report_data` = this release's binding ‖ appId;
  - so the partials are sealed to a key that only that guest holds.
  - It does NOT establish that the code is correct (source review + reproducible build do), that the host will run it
    (availability), or anything about the destination committee beyond what the chain says and the owner pinned.
- **Tests use a SYNTHETIC AMD chain** (`test/helpers/snp-synth.mjs`). They prove the protocol, the checks and the
  failure handling against the real vault contract and the real old custodian code. They are NOT evidence that any
  production TEE ran this image. That needs a hardware run of the measured image.

## Rollout order

1. Merge. Choose the production policy mirror list, which is measured into BOTH images.
2. Build the corrected custodian image from committed main (`--book`, `--host-policy`), giving `M_new`.
   - A custodian measured with `--host-policy` refuses releases while no platform policy is anchored, so the admin
     anchors one (even an empty denylist) before the new committee serves.
3. Build the rewrap image from committed main (`--host-policy`), giving `M_rw`. Publish both manifests.
4. Enroll the destination's Enclave host: TX1 by the host operator (`proposeOwner`), TX2 by the Enclave wallet
   (`acceptOwner`).
5. Genesis of the corrected committee: the corrected custodian signs, the host operator binds, any funded submitter pays.
   The old committee keeps running.
6. Per policy:
   - the lease must be LIVE on a host whose operator will sign the release;
   - then steps 1–4 above.
7. Verify: the app releases from the new committee. Keep the old committee until every policy has moved.

## Signatures needed

| Who | Signs | When |
| --- | --- | --- |
| policy owner | admit, rewrap authorization, switch (rollback if abandoned) | per policy |
| lease host registry operator | the ordinary v2 operator message for the run | automatic, by `rewrap-host.mjs` |
| destination host operator; Enclave wallet | host binding and `proposeOwner`; `acceptOwner` | once, enrollment |
| corrected custodian identity (in TEE) | genesis | once |
| book owner (admin) | the platform policy anchor (`setMany`), if host policy is measured | once, plus any bans |

No admin approval of the migration itself is needed. No wallet beyond the owner can move a policy.

## Rollback

- **Before the switch:** the owner applies `plan.rollback`. The original rules return byte-for-byte, and the authorization
  is stale from then on. Or the owner does nothing: an unused authorization expires.
- **After the switch:** the same mechanism in reverse. The owner admits the rewrap image on the new committee and
  authorizes the old committee as destination; the corrected custodian releases; the owner switches back. This is tested
  end to end.

## Failure points

| Failure | Effect |
| --- | --- |
| No live lease, or the operator will not sign | `release_refused` / `not_lease_holder`; nothing changes |
| Fewer than t old custodians answer | `release_refused`; retry later |
| The owner's ERC-1271 wallet withdraws, or the owner key changes | `bad_signature`; re-sign |
| The policy or bundle moved after signing | `stale_revision` / `bundle_mismatch`; re-plan |
| Lease host banned | `host_refused`; move the lease or have the admin lift the ban |
| Platform policy anchored but its document is not on the measured mirrors | `host_policy_undecided` |
| The destination changed key or code | `destination_key` / `destination_code` |
| A switch after any intervening update | reverts; re-plan |
