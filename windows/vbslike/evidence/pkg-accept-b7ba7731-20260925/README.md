# Package-owned serving and lifecycle acceptance: candidate `b7ba7731` on enclave-63's v36 (run 094631)

**Scope: functional serving and stability only.** This run shows that enclave-63's packaged manager, node and launcher
serve the pinned fixture from candidate `b7ba7731`, and survive a relaunch, a node restart, a manager kill and two
kinds of domain death. It is **not** an eligibility promotion. `b7ba7731` stays `eligible:false`: the rollover follows
enclave-63's rule and enclave-99's verification review. It is **not** evidence of host exclusion: `host_excluded=no`.

- Box: nucbox-k11, Secure Boot ON. Run by d1 after enclave-63's explicit handoff ("BOX YOURS").
- Box clock: harness start 09:46:32Z, result 09:51:23Z, 2026-09-25.
- Evidence directory on the box: `C:\Users\claude\vbs-evidence\mgraccept-20260925-094631`.
- Result: phase 1 hvlab-accept ALL PASS (28 checks). Phase 2 restart-accept A0-A9 ALL PASS. Driver exit 0, harness
  exit 0. The temporary AllowFirmwareLoadFromFile setting was restored to Absent (verified). The 9001 hv_sock service
  that the run registered was removed (verified).

## What ran

- **Package:** v36, `C:\Users\claude\vbs-like\pkg\3384e097aa024b73\` (windows/vbslike-pkg `adea692b`).
  - Its `control/` is hv-acceptance `2c3a2873`, plus `control/node_modules` built from 15 tarballs.
  - Manager, node, fetcher, wmiserve and phase-1 harness all ran from that `control/` tree.
- **Launcher (wmiserve):** `control\vbslike-host.exe` `435717def62bb5c9a632f80210b5c3fbcbeb7cb8c1047f9beef4ca578ebe99e7`.
  - This is the packaged launcher (source `1a6f1556`, the shared FORMAT_HYPERV) and the only launcher v34 onward carries.
  - It is NOT the box's `target\release` `0160d835`, which the standalone canary 093904 used through
    uefi-dev-boot `-Bundle`.
- **Guest:** `guest\igvm-vbs\vbs-linux-candidate-1539-b7ba7731.bin`
  `b7ba7731240ec9025f8c92651be17ecf8af17764e2c3eb0bd20af60f00923748`.
  - It is passed as an explicit override (`-IgvmRel` and `-IgvmSha256`) because it is no profile's firmware in v36.
- **Fixture:** the package's pinned `hello-world-1.0.4`. No customer app.
- **Harness, pinned outside the package** (windows/isolation-manager `37c4f5a3`, copied to
  `C:\Users\claude\d1-pkgaccept-37c4f5a3\`):
  - `manager-accept.ps1` `73885218c764b373505112da001e74900b98d4155b8b8627e8c32f93894a7b34`;
  - `restart-accept.mjs` `8d3bdf82f9affe60de7551a29016efeaeac458587e5d6b348a813d13c5267844`.

## Hashes at use

The harness hashed every input after the pre-run checks and before it applied the setting or started a manager
(09:46:32Z to 09:48:30Z). See `harness.log.txt`.

| Input | sha256 |
|---|---|
| `control/` tree: 12490 files, the list in `tree-hashes-094631.txt` | list `842ba05613d0cac25662b487132c2879f56ad3950b381360108eb0b118c78be2` |
| ↳ `control\vbslike-host.exe` (wmiserve) | `435717def62bb5c9a632f80210b5c3fbcbeb7cb8c1047f9beef4ca578ebe99e7` |
| ↳ `control\windows\vbslike\manager\main.mjs` (= `2c3a2873`) | `5a455f8ae1cda989b49ae8943476c3d13db5e70e067195a03b3e2554dbf35395` |
| ↳ `control\windows\node\host.mjs` | `70f0ddd381bbc62d2c17db0982f924179d80c45520fbcf8ab01f78ef3812391c` |
| ↳ `control\isolation\m3\hvlab-accept.mjs` (enclave-5d `c192380c`) | `5830dedc7ccba6e131d539f49b8176be6a2006e39e2418411dd452c314ec84f0` |
| IGVM `b7ba7731` (candidate, `eligible:false`) | `b7ba7731240ec9025f8c92651be17ecf8af17764e2c3eb0bd20af60f00923748` |
| `guest\runtime.json` (RuntimeID) | `ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8` |
| `apps\hello-world-1.0.4\spawn.json` | `523983d7711dbf27d1862ffdebe1b3973708c73ea9d9856802d68b4a0bb317f9` |
| `apps\hello-world-1.0.4\app.bundle` (appId) | `9c3d10f1450e17bc6a21478723193ef7e3da409afe353e264714cb801d180d45` |
| `restart-accept.mjs` (driver, outside the package) | `8d3bdf82f9affe60de7551a29016efeaeac458587e5d6b348a813d13c5267844` |
| `C:\Users\claude\vbs-like\type1.vmgs` (guest-state master, box-local) | `4f051697a74dc72d60e7b36d7cc80554493d64038ea6e146d72b454585ae930d` |
| `C:\Users\claude\hyperv.psm1` (petri module, box-local) | `17ca4352c500d3498f71be420ddfa418c7ed1d1b5f455856c24e633a4635e49c` |

The guest-state master and the petri module come from the box, not from the package. The launcher also rechecks its
own sha256 when the manager starts it: each manager log names `435717de`.

### Manager environment: the harness's, not the package's managerEnv

The managers ran with restart-accept's `startManager()` environment, not the package's 19-line `managerEnv` block
(which enclave-63's `check.ps1` prints). The differences:

- `ENCLAVE_GUEST_IGVM` was the `b7ba7731` override. The package's managerEnv names `a44bb55a`, the profile's firmware.
- `ENCLAVE_LIVENESS_MS` and `ENCLAVE_ANSWER_CHECK_MS` were 5000. The package defaults are 15000 and 30000 (main.mjs
  at `2c3a2873`). The A8 and A9 timings are at the harness's 5 s interval. At the defaults, A9's three strikes take
  about 90 s.
- `ENCLAVE_HYPERV_MODULE_SHA256` was not set, so the launcher used its built-in pin, `17ca4352…` (wmi-launcher.mjs at
  `2c3a2873`). That is the same value the package's managerEnv sets.

## Results

**Phase 1: hvlab-accept (the node's own path), ALL PASS.** See `driver.out`.

- ensureApp reaches `running` in 21.3 s. The labels are T0-hv and `hostExcluded=false`. The guest's tuple states
  `hv_isolation=vbs` (stated by the hypervisor, not a proof) and `host_excluded=no`.
- browser → tunnel → app zone → data plane → domain: a monitor-signed session on the manager-verified key
  `1224c4f41f47f0b7`. The app answers `200 "Hello World!"`.
- The verifier refuses another key, another nonce and another app. The data plane refuses another transport key,
  guest image, app, runtime and instance, and admits the exact record.
- A forced relaunch reaches `running` on a new instance with a new key (`b1df7d2b5d0d624f`). The old instance, route
  and key are refused. A client pinned to the old key must refuse.
- A node restart adopts the same instance and key. Cleanup retires the instance and confirms it is gone.
- The `HVLAB-ERR ... publicUrl ... IGNORED` lines are the lab tunnel refusing a loopback URL as the node's public
  route, as in runs 084443 and 090327. No on-chain runner id is stamped.

**Phase 2: restart-accept, ALL PASS.**

| Check | Result |
|---|---|
| A0 | Inventory ready and empty; no manager-owned VM. |
| A1 | POST 201 in 8167 ms. |
| A2, A2s | One VM carries the id, and it is Running. The status is `running`, the relay accepts, the image is `b7ba7731…`, and the statement is `wmi-openhcl-gen2-igvm-linux` / `igvm-linux-direct`. |
| A3, A7 | After the manager is killed the VM stays Running, and the relay dies with the manager. |
| A4 | A new manager reports `recovered:true`, held, not serving, relay null. |
| A5 | A second POST gets 409, and no second VM is created. |
| A6 | DELETE 200; no VM is left. |
| A9 | Monitor stop inside a still-Running VM: failed by the answer sweep after 29738 ms (3 strikes, ECONNRESET). |
| A8 | A VM turned Off from the host: failed by the liveness sweep within 1003 ms. |

## Policies this run did not change

- **Production attach:** unchanged. The node attached only to the lab tunnel. No relay policy, on-chain transaction
  or production deployment was touched.
- **Respawn:** unchanged. Neither harness sets `ENCLAVE_ISOLATION_RESPAWN`, so it stays at its default, OFF, pending
  Steven's decision. The respawn-free path is what A4 shows: a recovered instance is held, not re-served.
- **Firmware opt-in:** applied for the run and restored to Absent (verified). Secure Boot stays ON.

## Unresolved proof boundaries, unchanged by this run

- **No real VbsReport from any measured guest.** The report capture is provider-blocked and PARKED, not rerouted.
- **No report signer verified.** A refusal of a dummy report (enclave-99's V1, main `0e2bdee2`) shows the verifier
  refuses, not who signs. V3's measurement equals the launch digest only as a PREDICTION.
- **No guest key or app binding in any report.** The monitor-signed session binds the key to the monitor, not to a
  hardware report.
- **No host-memory exclusion evidence.** E3 is PARKED. PCR0 is unpinned. `host_excluded=no`.
- **Neighbour denial is not established.** Runs 093326 and 093904 are INCONCLUSIVE. The root-namespace existence
  statements, and 5d's runtime probe extensions, are PARKED after the safety-classifier block.
- **A domain's reach to the host signer on 9001 is untested.** It is ruled in enclave-99's contract (main `de2a9f66`:
  the launcher's signature binds the PARTITION, not a domain). The source-level signer concern stays with 99 for
  review. No capture or live probe was started for it.

## Files

- `driver.out`: the driver's full output (both phases).
- `harness.log.txt`: manager-accept's log, with the hashes at use, setting and service state, and cleanup.
- `manager-1.log.txt`, `manager-2.log.txt`, `manager-3.log.txt`: the three manager instances' logs.
- `config.json`: the driver's config (paths, pins, ports).
- `tree-hashes-094631.txt`: sha256 of every file in `control/`, the list whose digest is above.
