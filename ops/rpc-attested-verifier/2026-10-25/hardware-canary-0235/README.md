# Hardware SNP canary of the verifier-only direct image 0235e7d96: PASS (20261025T174309Z)

Root ran one bounded, disposable SEV-SNP guest of the exact built verifier-only direct-control image on the local
host. It passed.
- The image is `out/dist-direct-0235e7d96-a`: measurement
  **`4287b65e718ff958027f31beec6a0753d42784086807b950f557a963cd0277f33c9869173420f03f5fb53e4ad2859be9`**.
- The host is an AMD EPYC 9115 (Turin, family 26, model 2, stepping 1).
- **What it proves:** hardware attestation, HOST_DATA config binding, rejection of tampered or replayed evidence and of
  a wrong measurement or wrong config, and a fail-closed `/chain-verifier` route while the Base backend is unready.
- **What it does NOT prove:** Base chain readiness, finality, native-binary provenance, or production readiness. No
  production activation, trust-list or allowlist change, key, wallet or chain transaction was involved.

## Exact pins

| what | value |
|---|---|
| source commit / tree | `0235e7d9659f1ccbf9f258bd03593d26f32f3f3a` / `d36f220ab4258b91c6f909d720ef18ce21f73cbc` |
| harness tree | `git archive` of that commit, plus a lock-checked `node_modules` (`SOURCES-tree.json`: 8 464 files, list sha `9bde36bc…`, 139 lock packages, 0 mismatches) |
| `FROZEN-PINS.json` (21 pins, re-verified at the launch boundary) | `bf6252fdcc15c86649f2462257e0675d2503fc1e8c7a8feb0d11900b87a83d5d` |
| image `initramfs.cpio.gz` / `vmlinuz` / `cmdline` / `manifest.json` / `MEASUREMENT` | `3720a663…` / `1a3a02d5…` / `fd236eb2…` / `9a41781e…` / `b2e01a68…` |
| OVMF / QEMU 11.1.2 / node v22.23.3 | `142589cc…` / `a2250f5e…` / `7af789e5…` |
| executed helpers (byte-identical copies in `helpers/`) | `run-canary.py` `89d46784…`, `verify-canary.mjs` `c4c355a8…`, `owner-config.mjs` `9c1368a2…`, `qemu-restrict.sh` `3fd3a1dc…` |
| canary owner config (public, verifier-only) | digest `0af7ce07…1195`, HOST_DATA `186382b4…d8e4`; wrong-config variant digest `e5fd6753…` |

All full hashes are in `SHA256SUMS`, `FROZEN-PINS.json` and the evidence files.

## Result (`evidence/run-20261025T174309Z/`)

**Run records:**
- **`result.json`:** `ok: true`, `failed: []`, `productionActivated: false`.
- **`terminal.json`:**
  - code 0;
  - the scope is `inactive`, `cgroupEmpty: true`, `ownedAbsenceProven: true`, no survivors, `privateAbsent: true`;
  - 33 s from start to cleanup.

**Resources:**
- 4 vCPU, a 2048 MiB guest, `MemoryMax=3072M`, `CPUQuota=200%`.
- **Scope cgroup peak:** 2199 MiB. **Process-tree RSS peak:** 696 MiB.
- **Admission:** RPC VM down, so 87 040 MiB were required, including the 66 GiB RPC restart reservation; 87 500 MiB
  were available. The guard floor was 83 968, and the lowest host available during the run was 85 306 MiB.

**Isolation:**
- Every QEMU present at admission is unchanged: 4 identities.
- The running user services and the enclave-* MainPIDs are unchanged.
- The RPC VM unit state is unchanged.
- The snapshots themselves are not published (machine inventory); `protected-snapshots.digest.json` holds their
  hashes, and they are identical.

**Launch:**
- **QEMU argv** (`qemu-argv.json`): the measured cmdline, 4 vCPU / 2048, `kernel-hashes=on`, `host-data` = the config's
  HOST_DATA, slirp `restrict=on` with one `127.0.0.1` forward to guest 8444 only, no drives, pinned QEMU. Exactly one
  QEMU start.
- **No keys:** `noKeyEvidence` comes from the launcher's own inputs and fw_cfg.
  - No registry key, fleet secret, relay, tunnel, certificate or ACME input.
  - fw `direct` is the verifier-only config, with no host-level `chainVerifier`, and its proof source is the refused
    stand-in. The fw_cfg file was 0600 in a 0700 directory.

**Acceptance (`verify-result.json.acceptance.json`): all required checks true.**

| section | outcome |
|---|---|
| A. hardware + binding | The published `verifyMeasuredControl` with the real AMD Turin collateral (cache copy; 28 hits, 0 fetches, `--kds off`; CRL valid until 2026-11-09): statement, config + HOST_DATA, TLS peer = the attested key, report with measurement 4287b65e…, and the supervisor holds the minted keys. Status `pending` with no registry read; **`attestedOutcome` = `attested`**. Runtime gsup `b8882af9…`, helper `6489bf13…` and supervisor `9fe1ea99…` equal the image manifest. No mcp or platformApi runtime; no `native` member. |
| B. offline (captured evidence through the same `verifySnp` step) | control: **verified**; 1 flipped report byte: **rejected (signature)**; 1 changed statement digit: **rejected (binding)**; another nonce: **rejected (binding)** |
| C. live rejections | wrong measurement: **rejected** ("not an allowed measurement"; hardware measurement false); wrong config: **rejected (config)** |
| D. route fail-closed (Base unready) | the production client `createAttestedVerifier` attests the replica, but its read fails with **HTTP 502**; 3 pinned reads over 20 s are all **502 `service_unreachable`**; `eth_sendRawTransaction` gets **403 `method_refused`**; a wrong-measurement client is **rejected** and its read fails; a different sequencer pin is refused by `checkAttestedReplicas` |

**Diagnostic:** `chipId` `0xa52dc9bd…` (from the accepted report).

## Offline re-verification (public material only)

`verify-result.json` keeps the raw evidence document:
- `statement`, the SNP `report`, and the guest's public control TLS `certificate`;
- the request `nonce`, and the TLS peer SPKI sha256 of the same connection.

`evidence/amd-collateral/Turin/` (the cache layout `fileCollateral` reads) holds the exact public AMD collateral the run used, copied from the KDS cache:
- `chain.pem` (ARK/ASK Turin), sha `cc9a52fb…`;
- `crl.der`, sha `0699382a…`;
- the chip's VCEK, sha `463053e1…`, TCB `0103020500000075`.

**To reproduce section B:**
1. Use a checkout of the commit above, with `helpers/canary/verify-canary.mjs` placed beside a `tree/` of that commit.
2. Call `offlineReport(document, {nonce, peerSpki, measurement, hostData, collateral})`, with:
   - `peerSpki`: the DER of the certificate's SPKI;
   - `collateral`: `fileCollateral` over `evidence/amd-collateral`.

**This exact re-verification command was NOT executed during publication.** No additional tests were run, per
root's rule. The run's own section-B result is the executed evidence.

## Tests

| test | where | result |
|---|---|---|
| canary launcher dry run with a fake QEMU, wrapper refusals, A–D acceptance (26 failing mutations), owner config, launcher refusal of a host-level chainVerifier | `tests/unit-node.tap` (queue 512) | **6/6, 0 skipped** |
| harness: acceptance, verifier-only no-key, RPC-aware admission, argv, pins, ownership, supervise | `tests/unit-python.log` (queue 512) | **21/21 OK** |
| the commit's own `attested-chain-verifier` + `metal-measured-control` suites, from root's full clean source checkout | `tests/root-repo-complete.tap` (queue 1024, peak 572 MiB) | **30/30, 0 skipped** |
| preflight (read-only) and the run | `tests/root-preflight.out`, `tests/root-canary-run.out` | PREFLIGHT PASS; CANARY TERMINAL 0 |

**Attempts NOT counted:**
1. **Earlier 512-lane repo-suite attempts on the git-archive tree:**
   - guard stop at 518/524 MiB (exit 99);
   - 14/15, where the one failure was the archive having no `.git` for a history test.

   Root's complete 1024 run from a real checkout supersedes them.
2. **One harness defect, found by these tests before the run and fixed before freezing:** `c.registry ?? "absent"`
   would have failed a correct run.

## Files

- `helpers/`: the exact executed canary, tools, stubs and tests (no tree, `node_modules`, image or private config).
- `source-delta/`: every changed line versus the root-reviewed `native-final-canary` (run 20261022T225651Z PASS).
- `FROZEN-PINS.json`, `PLANNED-EFFECTS.json`, `SOURCES-tree.json`, `RECIPE.md`.
- `evidence/`:
  - **published:** the run records, `serial.sanitized.log` (the harness redaction; no unredacted serial), and the public
    AMD collateral;
  - **redacted:** `attempt.redacted.json` and `preflight.redacted.txt` (QEMU unit names; counts and a sha256 of the
    original kept);
  - **not published:** the protected snapshots (hashes only) and `private/` (the fw_cfg and the random test pairing key,
    deleted by the run).
- `tree.sha256` (988 KB) is not copied. It is the `find | sha256sum` listing of the `git archive` of the commit (sha
  pinned in `FROZEN-PINS.json`), so it can be regenerated from the commit with `tools/stage-tree.sh`.

## Limits

- **One chip, one boot, 4 vCPUs, the canary's own config.**
  - The production trust list must bind this measurement together with the exact PRODUCTION verifier-only config digest.
  - That is root's separate, reviewed step.
- **The Base backend was unready by construction:**
  - its only proof source was a refused stand-in;
  - slirp ran with `restrict=on`, so the guest reached no network.

  So no chain answer, Helios head, witness, finality or native-binary provenance is shown. The chain-verifier natives
  are pinned bytes whose reproducible build is a separate, open gate.
- **2048 MiB guest:** sufficient for this boot (scope peak 2199 MiB, which includes QEMU). There is no claim for
  long-running load with a live Helios head.
- **`kds off`:** no fresh KDS fetch. The cached VCEK matched the chip's reported TCB.
