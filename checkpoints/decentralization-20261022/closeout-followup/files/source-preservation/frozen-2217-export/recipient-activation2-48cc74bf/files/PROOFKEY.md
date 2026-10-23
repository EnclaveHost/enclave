# Proof-key verification around root's setProofKey (ROOT-BOOT-RECOVERY-VERIFY.txt)

This is source plus offline tests, prepared 2026-10-23. **No live run.** `attest-control.mjs` (2d407753), the activation scripts
and root's files are unchanged.

## `metal/measured-control-verify.mjs` cannot verify metal0

That verifier is for the **direct** measured-control guest (cmdline `metal.control=direct`). It fetches
`/.well-known/enclave-control`, whose statement `keys.proof` is bound into the report through the ABI/2 control role.

metal0's control runs the **legacy** path, in both ed918e4b and ee5df6b8. Its cmdline is
`metal.mode=snp metal.isolation=snp-guest-per-app`, and gsup serves that route only from `startDirectControl`.
measured-control-verify therefore fails at its evidence step every time:
- run, it would give a false REJECT;
- calling the legacy result "measured-control verified" would be untrue.

Neither is done. There is **no statement** in the legacy path. `servedDocumentSha256` (the supervisor's stored attestation
document) stands where the statement hash would be.

## The helper: `verify-recipient-proofkey.mjs`

```
node work/custody-recipient-activation-20261023/verify-recipient-proofkey.mjs --target current --expect-proof-key 0x<THIS boot's key>
```

The default for the current boot is `--target current` (ed918e4b, after the 21:37Z rollback); use `new` only if ee5df6b8 runs.

**The proof key rotates on every CVM boot.** Pass the key the running boot's `/t/metal0/v1/attestation` serves. W's
0x8853f452… is right only if that is still the running boot.

All three parts must pass.

| Part | Rests on | Checks |
|---|---|---|
| A. hardware | `attest-control.mjs` probe, unchanged | fresh quote over OUR nonce, AMD chain/CRL/policy/VMPL/TCB, full measurement pin; gives transport key T |
| B. supervisor | relay-routed `/t/metal0/v1/attestation`; **not hardware-bound** | `proofKey.address` == expected, `keySource` in-enclave, session key present; stored document names T and the pinned measurement, `report_data[0:32]` = sha256(T) |
| C. registry | quorum read of 0x868e… (2 of 3 public RPCs, lease modules byte-equal to production) | row `keccak("https://api.enclave.host/t/metal0")`: endpoint, operator 0xC9D0…E6aB, active; `proofKey` |

**Status and exit code:**

| Status | Exit | Meaning |
|---|---|---|
| `verified-legacy` | 0 | all three parts match |
| `pending-registry` | 2 | A and B pass, but the registry still has the old key. This is the expected state before the setProofKey lands. |
| `rejected` | 1 | any mismatch |
| `unknown` | 1 | a read failed |

The status is never plain "verified".

**Output:**
- **Public:** `evidence/recipient-proofkey-<UTC>.json` holds the expected and served proof key, `transportKeySha256`,
  `servedDocumentSha256` and the registry fields. It carries no chip id and no raw report.
- **Private:** `evidence/private/recipient-proofkey-raw-<UTC>.json`, mode 0600, gitignored, never overwritten.

**Limits, written into every verdict:**
- In legacy mode the proof key is bound only by the relay routing `/t/metal0` to the tunnel it attached with T. It is not in
  any report_data.
- The stored document is not fresh by itself; part A supplies freshness.

**Tests:** `tests/recipient-proofkey.test.mjs`, all stubbed, ran **5/5** (`logs/proofkey-tests-1.out`, 256 lane). They cover:
- verified-legacy;
- pending on the old registry key;
- 14 reject cases;
- 5 unknown cases;
- input checks, no leaks, and the 0600 raw file.

**Not done:** a mutation run of this helper. That differs from `attest-control.mjs`, which has one (9/9 killed).

## Build for H, gated on root's approval: `../custody-recipient-restore-20261023/build-approved.sh`

The template is prepared and **not run**. Without root's `APPROVED-COMMIT.txt` it refuses; see the format in its header.

When root approves a commit:

1. **Commit checks:**
   - the commit is in H's repo and descends from a6b1378c;
   - its delta touches only `supervisor.js`, the approved extras and `test/`;
   - the builder is unchanged;
   - the staged a6, base and production images are unchanged.
2. **Control:** a6b1378c rebuilt from H's repo must equal the staged ee5df6b8 image byte for byte.
3. **Candidate:** built twice, byte-identical.
4. **Manifest versus a6:** only these may differ:
   - `controlOverlay.commit`;
   - the changed file records, which must be within supervisor.js plus the extras (supervisorClosure, builder and base
     unchanged, nothing removed);
   - `initramfs`.
5. **Image entries:**
   - versus a6: exactly those files plus `manifest.json`;
   - versus production: those plus `gsup.mjs`.
6. **Image bytes:** every changed file in the image, and `gsup.mjs`, equals the commit's bytes.
7. **Measurement:** the recipe must reproduce ed918e4b and ee5df6b8 first, then the candidate is measured.

The builder reads only git objects and the base image, so H's dirty working tree cannot leak into an image.

**Run:** `./q.sh 1024 build-approved-1 bash ./build-approved.sh`. The restore build peaked at 301 MiB, within root's 1536.

**Refusal tests:** `refusal-tests/run.sh` ran **6/6**, each refusing before any build (`logs/build-approved-refusal-2.out`). The
cases: no file, a short hash, no extra line, an unknown commit, a non-descendant (deabf8f), and an empty delta (a6 itself).

The delta and manifest checks only run on a real build, so they have no offline test.

**H today:** still at a6b1378 with `supervisor.js` and the test uncommitted. There is no H commit to approve yet.
