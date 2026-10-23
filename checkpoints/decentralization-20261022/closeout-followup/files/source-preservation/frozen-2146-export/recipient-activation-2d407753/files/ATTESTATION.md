# Nonce-bound SEV-SNP verification of the control recipient image (ROOT-ATTESTATION-VERIFY.txt)

Source and offline tests only (2026-10-23). **No live probe was run.** Root runs it fresh after activation, after review. The
activation scripts are unchanged; this adds new files only. `.gitignore` gains `evidence/private/`.

## Root's commands, after `activate.py` reports PROVISIONAL

```
node   work/custody-recipient-activation-20261023/attest-control.mjs            # --target new (default)
python3 work/custody-recipient-activation-20261023/check-attestation-verdict.py work/custody-recipient-activation-20261023/evidence/attestation-<UTC>.json
```

`attest-control.mjs` behaves as follows.

**Before any network call** it asserts:
- the restore repo is at **a6b1378c**, and the 9 verifier modules have their pinned sha256s. `relay/snp-verify.mjs` is `10520dd2…`, the
  same file as the control image's `/app/relay/snp-verify.mjs`.
- the staged image `~/enclave-prod/dist-leasegas-a6b1378cd` still has the reviewed `MEASUREMENT` (`d99cb428…`), which names the
  pin, and the reviewed `manifest.json` (`3874066d…`).

**Then** it calls the existing trusted verifier unchanged: `verifier/consumer.mjs verifyMetalBox` (the CLI's `enclave attest`).
- The measurement is caller-pinned to **ee5df6b83948f5bacebee414574adb87be9d58412b09ae9183fc4deed5aed3d96bc1cbead096372e7ee755febbbc22ec**.
- `--target current` pins ed918e4b instead, for a pre-activation comparison.

| Check | Rests on | Reported as |
|---|---|---|
| freshness | OUR random 32-byte nonce → `GET /v1/enclaves/metal0/attestation?nonce=` → the box's agent quotes `report_data[0:32] = sha256(transport SPKI ‖ nonce)`, `[32:64] = 0` | `binding` PASS/FAIL; `freshness: "verifier nonce"` |
| report shape, product line | the report itself (v≥2, Turin from CPUID, confirmed by the chain) | PASS/FAIL |
| signature + chain + CRL | VCEK from the box's cert table, else AMD KDS directly; chained to the **pinned** AMD ARK; AMD CRL; VCEK chip/TCB match the report | `chain` PASS/FAIL, `crl` PASS/FAIL/UNAVAILABLE |
| guest policy, VMPL | DEBUG and MIGRATE_MA refused; VMPL 0 | PASS/FAIL |
| certificate TCB | the published Turin floor (fmc 1, bl 3, tee 2, snp 5, ucode 117 = the image's isolationMinTcb) on reported and committed TCB | `tcb policy` PASS/FAIL |
| what runs | launch measurement == the pin above (caller-pinned, so "verified" is possible; the relay's own allowlist alone would be "limited") | `measurement` PASS/FAIL |

**UNAVAILABLE, never counted as PASS.** These are listed in every verdict:
- **Operator identity:** this route returns no attach operator signature.
- **Attach-key equality:** this route does not return the relay's attach-time key. The verdict names the bound key's sha256.
- **The supervisor's custody env:** this is not attestable directly. It is implied only by the measurement, because the vault
  constants are measured gsup source.

A check the verifier never reached (because an earlier one failed) is also UNAVAILABLE.

**Exit code:** 0 only when status is `verified`, `admissionSafe` is true, all 7 required checks PASS, the observed measurement equals
the pin, the binding is to the verifier nonce, and VMPL is 0. Anything else exits 1.

**Outputs:**
- **Public:** `evidence/attestation-<UTC>.json`. It holds the verdict, checks, reasons, TCB, policy, `reportData`, `hostData`, the ARK
  fingerprint, `chipIdSha256` and `rawSha256`. It carries **no** raw report, chip id or VCEK fingerprint; the reasons are scrubbed of
  the chip id.
- **Private:** `evidence/private/attestation-raw-<UTC>.json` holds the relay's exact answer. It is mode **0600** in a 0700 directory,
  gitignored, and never overwritten.

## `keep.py`'s evidence requirement (frozen; documented, not changed)

`keep.py --checked-attestation <file>` only asserts that the file's bytes **contain the ee5df6b8 hex**. That is a substring test:
- a rejected verdict, a verdict that was never fresh, a `--target current` run's expectation, or any text naming the measurement
  would satisfy it.
- It does not check the verdict.

**Root must not treat it as verification.** Before `keep.py`:
1. Run `check-attestation-verdict.py` on the public verdict. It accepts ONLY an `attest-control/1` verdict for target `new` with all
   of the following:
   - `pass` true and `status: "verified"`, with `admissionSafe`;
   - every required check PASS, and no failed check;
   - observed = expected = ee5df6b8;
   - freshness by the verifier's nonce, and VMPL 0;
   - produced **after** `result.json` `attachedAt`;
   - its private raw answer present, mode 0600, and hashing to `rawSha256`.
2. Pass that same verdict file to `keep.py --checked-attestation`.

## Tests

All offline, through the queue (512 lane, peak ≤ 45 MiB).

**Results:**
- **`logs/attest-tests-2.out`:** `tests/attest-control.test.mjs` 6/6, and `python3 -m unittest discover -s tests` **21/21**. The latter
  is the 16 earlier activation tests plus 5 for the checker.
- **`logs/attest-mutants-3.out`:** 9 mutants, **all killed**; the unmutated control passes. They cover a nonce binding made
  optional, an UNAVAILABLE counted as PASS, a chip id leaked, the raw answer leaked into the public file, a world-readable raw file,
  an image pin left unchecked, the checker accepting "limited", skipping required checks, and skipping the time check.
- **Earlier runs, kept:**
  - `attest-mutants-1` is **invalid**: its copies ran in `/tmp`, where the restore repo path does not resolve, so every copy failed.
  - `attest-mutants-2` was valid. It found the time check masked by a missing-raw-file failure; the test was fixed.

**What the offline tests show:**
- The only authentic Turin report on hand is public: the M4a domain document in the restore repo's `test/fixtures/verifier`, with
  AMD's Turin chain, CRL and VCEK.
- Run through the **real** verifier with its own measurement pinned, the AMD signature/chain, CRL, policy, TCB and measurement
  checks **PASS**, and the verdict is **REJECTED at `binding`**, because that report is not bound to our nonce. That is the
  freshness property.
- With the ee5df6b8 pin, it is **REJECTED at `measurement`**, and `binding` shows as UNAVAILABLE.
- Another nonce, an HTTP error, a non-metal document or a network failure are each **unavailable**.
- The public verdict leaks neither the chip id nor the report. `persist` writes 0600 and refuses to overwrite.
- `checkImage` refuses another manifest or MEASUREMENT.

## Limits

- There is **no authentic metal-format control document offline**, so a live PASS cannot be shown here. Root's fresh run after
  activation is the proof.
- The relay can withhold or delay a quote, but cannot forge one.
- The TLS of the request ends at the relay. The report binds the box's transport key, whose sha256 the verdict names.
- Operator identity and attach-key equality stay UNAVAILABLE from this route.
