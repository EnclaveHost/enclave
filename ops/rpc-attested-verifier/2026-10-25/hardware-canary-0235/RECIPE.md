# Verifier-only direct image 0235e7d96: SNP hardware canary, root recipe (EXECUTED: PASS 20261025T174309Z)

## Actual result (root run, 2026-10-25T17:43:09Z, 33 s from start to cleanup)

- **The run:** `runs/20261025T174309Z`, with FROZEN-PINS `bf6252fd…` unchanged.
  - `result.ok: true`, `failed: []`; terminal code 0.
  - The scope is inactive, `cgroupEmpty`, owned absence proven, no survivors, `privateAbsent`.
- **Measurement:** exactly `4287b65e…`, the real AMD Turin report verified.
- **Resources:** the scope `memory.peak` was 2199 MiB (cap 3072).
  - Admission: RPC VM down, so 87 040 MiB were needed (including the 66 GiB reservation) and 87 500 were available.
  - The guard floor was 83 968; the lowest host available was 85 306.
- **Isolation:** every protected QEMU, the user services and the RPC unit state were unchanged.
- **Acceptance A–D all true:**
  - `attestedOutcome` = attested;
  - offline: control verified; report tamper rejected (signature); statement tamper and other nonce rejected
    (binding);
  - live: wrong measurement and wrong config rejected;
  - route: the client attested but its read got 502; 3/3 reads 502 `service_unreachable`; the write 403
    `method_refused`.
- **No production activation.** Not Base readiness, finality or native provenance (limits below).
- **Repo suites:** root's complete run of the commit's own `attested-chain-verifier` + `metal-measured-control`
  suites, from a clean checkout (queue 1024), was 30/30 with 0 skipped.
- **The text below is the pre-run recipe, unchanged.**


Prepared by Claude for root. No QEMU, VM, SSH, sudo, network, registry, key or signing operation was performed.
- **Root reviews and executes ONE bounded run**, pinned by `FROZEN-PINS.json`: sha256
  `bf6252fdcc15c86649f2462257e0675d2503fc1e8c7a8feb0d11900b87a83d5d`, 21 pins.
- **Basis:** the root-reviewed `native-final-canary` (run 20261022T225651Z PASS).
- **Deltas:**
  - every changed line is in `public/SOURCE-DELTA-run-canary.diff` and `public/SOURCE-DELTA-others.diff`;
  - `canary/qemu-restrict.sh` is byte-identical to the reviewed copy.

## What one run does

**Boot:**
- The exact built image `attested-image-stage/out/dist-direct-0235e7d96-a` boots once:
  - initramfs `3720a663…`, vmlinuz `1a3a02d5…`, cmdline `fd236eb2…`, manifest `9a41781e…`;
  - commit `0235e7d96`, tree `d36f220a`.
- **Launcher:** the commit's own launcher (`tree/` = git archive of the commit).
- **Guest:** 4 vCPU, **2048 MiB**, OVMF `142589cc…`, QEMU `a2250f5e…`.

**Expected measurement:** `4287b65e718ff958027f31beec6a0753d42784086807b950f557a963cd0277f33c9869173420f03f5fb53e4ad2859be9`.
- SNP, 4 vCPU, family 26 model 2 stepping 1, QEMU.
- It must equal the image `MEASUREMENT` file and the independent `receipts/measurement-B.txt`. The image verification
  receipt (`image-verify-direct.json`, 45/45) must say `ok`.

**Owner config (VERIFIER-ONLY):** the reviewed bare config, plus:
```
chainVerifier: { format: "enclave-chain-verifier/v1", unsafeSigner: 0xaf6e19be…9e8a, proofSources: [http://10.0.2.2:<refused stand-in>/], port 50546, expose: "attested" }
```
- No txBackend, mcp, platformApi, leaseGas, ownerNomination or nativeControl.
- Not selling, and no registry key.
- **HOST_DATA** = `sha256("enclave-measured-control/v1\nconfig " + digest + "\n")`, passed as QEMU `host-data`.

**Base backend unready by construction:**
- The only proof source has no listener.
- slirp runs with `restrict=on`.
- The only host forward is `127.0.0.1:<ephemeral> → guest 8444` (the attested control front).
- No public listener, no raw disk, and no device other than /dev/sev and /dev/kvm.

## Acceptance (all REQUIRED; `result.json` names any failure)

**A. Hardware attestation and binding:**
- The published `verifyMeasuredControl` passes statement, config + HOST_DATA, TLS peer = the attested key, the AMD
  report (real AMD collateral COPY, `TCB_FLOORS`, `crl: required`) with measurement 4287b65e…, and the running
  supervisor's keys.
- Status is `pending` with registry null (no registry read). **`attestedOutcome` = `attested`** (the production
  verifier-only rule).
- **Archived evidence:**
  - digest and HOST_DATA = the owner config;
  - same boot; mode snp;
  - runtime gsup `b8882af9…`, helper `6489bf13…`, supervisor `9fe1ea99…` (image manifest);
  - no mcp or platformApi runtime; no `native` member.

**B. Offline, on the captured evidence, through the same `verifySnp` step:**
- **Control:** the unchanged evidence re-verifies. This is the non-vacuity check.
- **Tamper:** one flipped report byte (0x90, the MEASUREMENT field) is `rejected`.
- **Tamper:** one changed digit of the config digest in the statement is `rejected` (binding).
- **Replay:** another nonce is `rejected`.

**C. Live rejections (fresh nonces):**
- **Wrong measurement:** rejected at the report, with `hardware.measurement === false`.
- **Wrong config** (another unsafeSigner, a different digest): rejected at config.

**D. Route fails closed while Base is unready:**
- **The production client** (`createAttestedVerifier`) attests the replica, so status is `attested`.
  - Its `eth_blockNumber` read **fails with HTTP 502**.
- **Pinned POSTs:**
  - 3 reads over ~20 s, each answered **502 `{"error":"service_unreachable"}`**. A 200 would mean the guest reached a
    backend, and it FAILS the run.
  - `eth_sendRawTransaction` is answered **403 `method_refused`**.
- **A wrong-measurement client** never attests, and its read fails.
- **`checkAttestedReplicas`** refuses a different sequencer pin.

**Harness checks (reviewed, kept):**
- **Pins and QEMU launch:**
  - the pins hold at the launch boundary;
  - exactly one QEMU start;
  - the argv is the measured, restricted launch (4 / 2048, kernel-hashes, host-data, one loopback forward, no drives,
    pinned QEMU).
- **No keys, verifier-only:**
  - no-key evidence comes from the launcher's own host config and fw_cfg;
  - fw direct is the verifier-only config, with no host-level chainVerifier, and its proof source is the refused stand-in.
- **Ownership and cleanup:**
  - the fw_cfg file is 0600 in a 0700 directory;
  - every owned process is absent and no foreign group was signalled;
  - **every QEMU present at admission is unchanged** (a run-time snapshot);
  - the RPC VM unit state is unchanged;
  - the user services and enclave-* MainPIDs are unchanged;
  - the collateral source is unchanged;
  - private/ is removed.

**Diagnostic only:** `chipId`, the operator label, the offline failed-check names, `scopeMemoryPeakMiB`.

## Resources and admission (root rule 2026-10-25)

**Scope:**
```
systemd-run --user --scope --expand-environment=no --unit=enclave-snp-verifier-canary-<stamp>-<rand> -p MemoryMax=3072M -p MemorySwapMax=0 -p CPUQuota=200%
```
- It runs `memory-guard` (max RSS 3072, the floor below), then `timeout --kill-after=40s 420s`, then the child.
- The verifier deadline is 270 s.

**Memory admission:**

| RPC VM | MemAvailable needed at start | guard floor during the run |
|---|---|---|
| active | ≥ 16384 + 3072 = **19456 MiB** | 16384 |
| NOT active (its 66 GiB reservation is held) | ≥ 67584 + 3072 + 16384 = **87040 MiB** | **83968** |

- **An RPC restart during the run aborts the canary.** That is by design: it fails and is never a pass.
- **Queue:** `--run` takes BOTH shared queue lanes without blocking. If either is busy it exits 98 and creates nothing.

## Root commands (in order; nothing here was executed by Claude)

```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/snp-verifier-canary-stage
sha256sum FROZEN-PINS.json            # must print bf6252fdcc15c86649f2462257e0675d2503fc1e8c7a8feb0d11900b87a83d5d
. tools/env.sh                        # ssh/scp/sftp stubs first in PATH (shell + node child proved)
python3 canary/run-canary.py --preflight          # read-only; must end PREFLIGHT PASS (memory gate follows the RPC VM state)
python3 canary/run-canary.py --run --kds off      # ROOT ONLY; both queue lanes free; not overlapping an RPC VM start/stop
```

**Recommended window:**
- After root has restarted and verified the 64 GiB RPC VM. With it active, admission is 19 456 MiB and the floor is
  16 384.
- **The window must not overlap an RPC stop or start** (the `rpcStateUnchanged` check).
- **Coordinate the window with ExploreKVM through root only.**
  - Its `kvm-box-*-726c0318` QEMUs are protected by the snapshot and never signalled.
  - Astra/NucBox reservations are not touched: this harness runs only on this host and makes no remote call.

**Terminal evidence to inspect:**
- **`terminal.json`:**
  - `cgroupEmpty: true`;
  - `scopeActiveState: inactive`;
  - `ownedAbsenceProven: true`;
  - `survivors: []`;
  - `privateAbsent: true`;
  - `code: 0`.
- **`result.json`:** `ok: true`, `failed: []`, `acceptance.pass: true` (A–D), `scopeMemoryPeakMiB`.
- **`verify-result.json`:**
  - `final.identity.measurement` = 4287b65e…;
  - the raw evidence document, for offline re-verification;
  - `route.readProbes`.

## If 2048 MiB is too small (fails closed: no TLS before the deadline, or a scope OOM)

**This is not a pass.** The guest RAM size is not part of the SNP measurement, so the same pinned image can be retried.

To retry at a larger size, a root-reviewed change sets `MEM_MIB`/`CAP_MIB` in `canary/run-canary.py`, for example to
3072/4096. Then:
1. `python3 tools/freeze.py --replace`;
2. the preflight;
3. review the new FROZEN-PINS sha.

The memory admission grows with `CAP_MIB`. **It is not covered by the ≤ 2 GiB / ≤ 3 GiB target.**

## Re-pin after a native hash repin (prepare only; activate nothing)

If root rebuilds the image after a native repin:
1. Point `BUILD/IMAGE/RECEIPT/INPUTS` and `EXPECTED_MEASUREMENT` in `canary/run-canary.py` at the new build's directory,
   its 45/45 receipt and the independent measurement.
2. Re-stage `tree/` from the new commit (`tools/stage-tree.sh` with the new `C` and tree; move the old `tree/` aside
   first).
3. `bash tools/q.sh 512 unit bash tools/unit-checks.sh`.
4. `python3 tools/freeze.py --replace`, then `--preflight`.
5. Review the new FROZEN-PINS sha.

Nothing here touches allowlists, trust lists or production units.

## Not covered (stated limits)

- **What the run proves:** that the actual image boots, hardware attestation, HOST_DATA config binding, tamper,
  replay, wrong-config and wrong-measurement rejection, and fail-closed route behaviour.
- **What it does NOT prove:** Base chain readiness (Helios head, proof sources), native-binary provenance, finality,
  registration, MCP, Platform API, native names, or selling.
- **Scope of one run:** one chip, one boot, 4 vCPUs.
- **What a trust-list entry must still bind:** the measurement AND the exact verifier-only config digest of the
  production config, not this canary's config. That is root's separate, reviewed step.
