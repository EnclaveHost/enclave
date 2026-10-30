# Verifier-only direct-control image at `0235e7d96`: build and verification receipts (2026-10-25)

**Status: built twice byte-identical and independently verified OFFLINE.**
- Not deployed, not activated, not attested on hardware. **Not a readiness or production claim.**
- This directory holds receipts, the exact tools as run, and a read-only cross-check. It does NOT contain the image (the
  322 MB initramfs), any native binary, any clone or dependency, or any private configuration.

## Result

| item | value |
|---|---|
| source commit | `0235e7d9659f1ccbf9f258bd03593d26f32f3f3a` ("fix: regenerate guest bundles in dependency order") |
| source tree | `d36f220ab4258b91c6f909d720ef18ce21f73cbc` |
| **SEV-SNP launch measurement** | `4287b65e718ff958027f31beec6a0753d42784086807b950f557a963cd0277f33c9869173420f03f5fb53e4ad2859be9` |
| measurement recipe | `sev-snp-measure 0.0.13 --mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU`, OVMF `OVMF.amdsev.fd` `142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9` |
| kernel cmdline (`artifacts/cmdline`) | the production base template + ` metal.control=direct`; measured with `${MODE}` = `snp` |

| artifact (A == B, byte-identical) | sha256 | bytes |
|---|---|---|
| `initramfs.cpio.gz` (not included) | `3720a6637ce43018ee2557d4c3d0d7a2f7b544aad293b1e7154ce1c01dae7a0f` | 322538664 |
| `vmlinuz` (== production base, not included) | `1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7` | 17232384 |
| `manifest.json` (`artifacts/`) | `9a41781e95cbd92239359616102416a343baa826388166470b71ed27ba9d897e` | 36997 |
| `cmdline` (`artifacts/`) | `fd236eb2762c457bbe20376216e078f3aab3f2f40a3646f9509137b8f67fabb6` | 126 |
| `MEASUREMENT` (`artifacts/`) | `b2e01a68faf1830b1dd5650cd7d6901c9e4397cd8d659d7da841237c422d6362` | 97 |

## Evidence in this directory

**Build receipts.**
- `receipts/build-{a,b}/artifacts.sha256`: identical for builds A and B.
- `receipts/build-{a,b}/build-{started,finished}.utc`.
- **Overlay unittest at the commit** (`receipts/build-{a,b}/overlay-unittest.out`): **19/19 OK, 0 skipped, in each
  build**, with `CHAIN_VERIFIER_INPUTS` set.

**Measurement.** Computed three times and in agreement: build A, build B, and an independent recomputation from A's
artifacts in a separate job (`receipts/measurement-B.txt`).
- Calibration in both builds: the same tool reproduced the production base (`b8376e15…`) and the KEPT runtime
  (`ed918e4b…`).

**Independent verifier** (`tools/verify-image-direct.py`; record `receipts/image-verify-direct.json`): **45/45 checks**.
- It has its own newc cpio reader.
- **Committed inputs:** every installed committed byte is compared with git at the commit (71 inputs).
- **Base entries:** 29012 are identical to the base, and the 80 additions are accounted for.
- **Natives:** the 7 natives match the RECIPE table, `PINS.sha256` and the commit's image record.
- **Direct-mode records:** these are recomputed from the committed bundle manifests.

**Bundle gates before building** (`logs/attimg3-g0.out`):
- all committed guest bundles rebuild byte-identical at the commit;
- `receipts/p2-rebuilt-final.sha256` lists 8 files, all equal to the committed blobs (checked in validation);
- every builder's `--check` passes;
- the dependency-ordered fixed point is reached (`receipts/0235e7d96-fixpoint.patch` is empty).

**Jobs** (`logs/attimg3-{g0,b1a,b1b,v1}.*`): every job ran in a private network namespace with loopback only (proved in
each log), with 0 ssh/scp/sftp invocations, rc 0, under the shared memory-guarded queue at 1024 MiB.

**Package cross-check:** `validation/check-package.py` gives **30/30** (`validation/check-package.out`). It is read-only and
builds nothing. It checks:
- every receipt, tool and log here against the build stage's originals;
- both artifact sets on disk against the receipts;
- the measurement against every record;
- the verifier record against git;
- the rebuilt bundles against the committed blobs;
- the source commit locatable with its tree;
- the local pinned inputs still present with their recorded bytes.

## What these receipts do NOT establish

1. **Native provenance.** The 7 native files (`helios`, `witness-check`, `enclave-base-head-listener` and their libraries;
   `receipts/chain-verifier-inputs.PINS.sha256`) and the base image are **pinned by hash only**. Reproducing them from
   source is a separate, open gate.
2. **Verifier-only is a property of the BOUND CONFIG, not of this measurement.**
   - The image also carries the (dormant) platform-API and MCP bundles. They stay off only because the reviewed
     verifier-only `canonicalDirectConfig` refuses those members.
   - **A trust list must bind this measurement TOGETHER WITH the exact verifier-only config digest (HOST_DATA).**
3. **Hardware.** No SEV-SNP hardware attestation was performed: this is an offline build and measurement recomputation. A
   real-hardware canary with real AMD collateral is required before any trust-list use.
4. **Chain.** The verifier inside follows a sequencer-signed head: tier unsafe, **no finality**. Nothing here proves Base
   mainnet readiness.
5. **Reproduction.** It is NOT portable as is. It needs this build host's local inputs (see `RECIPE.md`).
