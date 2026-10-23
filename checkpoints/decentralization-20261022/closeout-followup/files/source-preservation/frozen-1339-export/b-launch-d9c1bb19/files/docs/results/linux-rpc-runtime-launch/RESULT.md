# linux-rpc-runtime-launch: RESULT

(Written 2026-10-23; finished 2026-10-23T11:44:20Z from `date -u`. Every time below is a git committer date or a queue-log
time, all measured. The host clock is UTC−07:00, and git dates are converted to Z.)

**Status:** the Linux host/guest launch integration of the local chain verifier is **committed source** with offline
tests in the production base image's own userland.
- Nothing was deployed, pushed or merged, and no image was built.
- No SSH, live RPC, wallet, VM restart, chain sync, disk write outside this tree, or cache allocation.
- Other trees (D, F, root, A, P, rpc-runtime-final-integration) were only read.
- **This is not SNP or native evidence:** the guest tests are chroot processes, not a measured VM.
- **This is not RPC independence:** fresh state still needs a configured, reachable proof source.

## 1. Source

| | commit | tree |
|---|---|---|
| Base: latest Linux source closure (linux-carrier-closure) | `fad657bc5626166bde1bde4454ec4f73d23dde47` | (descends from D's image commit `fec43a6a`, which is 19 commits back) |
| + A `25c051a95..e820e2405`, P `9fdc1418c..9e838ba75`, B `dc8adb8e1..c31e975a4` (`git am`; B without `test/windows-verifier.e2e.test.mjs`) | `5d2d2c3c9bf224f63d7a178dfd86a4a1c7ae7f5c` | `c4d4e7326021d92f9eff065117dd4ae0ea2f28a7` |
| **+ this work (7 commits) = final** | **`673601e54f8fdcf2ea72d239c87d92b483ff231b`** | **`ea4b9cac641e61b2b743972cfd1f579d01577699`** |

Lineage checks (`jobs/lineage.out`):
- P's files equal 9e838ba7;
- A's files equal e820e240;
- the runtime modules equal c31e975a;
- the only difference is the excluded Windows E2E.

A df8fbafa (the Windows bundle) is not composed: it is F's baseline (`handoff/HANDOFF-F.md`).

The base preserves D's line and fad's carriers:
- serving-first adoption;
- the app-paid lease cadence (lease-gas conduit `421d6584`, unchanged and `--check` verified);
- the admin platform-policy gate;
- the C2 attestation paths.

None of those files is touched here except gsup's single supervisor line (§2).

The 7 commits (author and committer SteveDeFacto, no trailers):

| commit | committed (Z) | what |
|---|---|---|
| `668121877` | 10:11:12 | runtime: `glibcRuntime` (an exact pinned 4-file set; Helios runs as `<loader> --library-path <dir> <bin>`, the helper through a 0500 wrapper) and an optional `binaryStaging: verify-in-place` |
| `a4bcf9045` | 10:11:12 | the guest launch: `metal/guest/chain-verifier.mjs`, gsup service, launcher pass-through, `metal/chain-verifier-image.json`, overlay `--chain-verifier-dir`, tests |
| `92ca07783` | 10:22:19 | rebuilt `windows/node/host-admission.bundle.mjs` 2dba0ceb → `efaf6fdb` (A's lease-reader change b7f88a862; `--check` failed before and passes after) |
| `60a4f969f` | 10:26:31 | `metal/build-image.mjs` installs `chain-verifier.mjs` (without it, a from-scratch image's gsup could not load); text pins name the new wrapper |
| `722cf1b04` | 10:50:39 | test fixes: complete contract-pins fixture; "unknown" must be for a chain reason; legacy supervisor start pinned |
| `927e2acfb` | 10:55:47 | the guest image uses **copy** staging: the base is owned by uid 1000 (§5 F3) |
| `673601e54` | 10:57:33 | the guest verifier port is restricted to **50000..57999** (§5 F4); docs section "Inside the Linux metal guest" |

## 2. What the launch does (supervisor/service-entry architecture, not a runbook)

1. **Host config.** The operator's opt-in is `config.json` `chainVerifier`:
   - `format`, `unsafeSigner` (the administrator's sequencer pin), 1..16 https `proofSources`, `port` 50000..57999;
   - optional `gossip` / `limits`.
   - `metal/enclave-metal.mjs` checks it with the one shared checker and passes the checked form through fw_cfg.
   - Invalid input refuses the launch. `witnessArchive`, `witnessCache` and unknown fields are refused. A direct control
     guest refuses the member (relay mode only for now).
2. **Guest (gsup.mjs, PID 1).**
   - It checks the member again, against the image's pin record `/opt/rpc-runtime/IMAGE.json`.
   - It writes `rpc-runtime.json` (0600) into `/mnt/ramdisk/enclave-chain-verifier` (0700).
   - It then **starts the runtime as the supervised child `chain-verifier` before the supervisor**. That child gets the
     same `start()` as every gsup child: restart with 500 ms → 15 s backoff, and a process-group kill.
3. **Names.** The supervisor's env is wrapped last by `withChainVerifierEnv`.
   - It sets exactly `ENCLAVE_CHAIN_AUTHORITY=verifier` and `ENCLAVE_CHAIN_VERIFIER=http://127.0.0.1:<port>/`, and
     drops both names from every other source.
   - Absent member: no names and no runtime. That is the inherited legacy mode, unchanged; it is tested, and the
     legacy-identity and wiring pins cover it.
   - Invalid member, or no runtime in the image: the verifier authority at `http://127.0.0.1:9/`, which nothing serves.
     Every verified read refuses. **There is never a provider fallback.**
4. **Consumers.** Two verified readers use this loopback endpoint:
   - host wallet admission (`hostAdmissionFromEnv`, the shipped bundle);
   - the platform host policy gate (`createHostServiceGate`).

   They refuse (as *unknown*) while the runtime boots, while it is not ready, and while no proof source can supply a
   fresh witness. **Booting is not readiness.**

   The supervisor is not held back. Adoption and serving of running apps start as before, and new verified decisions
   wait. The supervisor's other chain reads (claims and lease records over `BASE_RPCS`) are **unchanged, still on
   providers**.
5. **The runtime** (c31e975a + 668121877) does its own preflight:
   - `flock` (util-linux, the kernel lock);
   - a 0700 runtime-owned state dir;
   - every binary and glibc file copied into a fresh 0700 run dir and hashed **there** against the pins;
   - the reaping of recorded and staged orphans.

   Then it waits for bounded readiness: gossip head → verified roots → gateway → Helios, with `limits` timeouts. A
   timeout makes it exit, and gsup restarts it. SIGTERM gives an ordered stop and exit 0.

   Cold start needs no Sia or archive: none is offered in the guest.
6. **Image.**
   - `metal/overlay-control-image.py --chain-verifier-dir DIR` installs:
     - the runtime closure (9 network files plus viem);
     - `IMAGE.json`;
     - the 7 pinned native files, refused unless each digest is pinned (0555 executables, 0444 libraries).
   - Without the dir, the image carries the JavaScript only; `chainVerifier.installed` is false and an opt-in refuses.
   - `metal/build-image.mjs` carries `chain-verifier.mjs`.
   - Recipe: `RECIPE-IMAGE.md`.

## 3. Tests (all through `work/claude-test-queue.py`, inside `unshare -r -n`, external network refused)

Pinned binaries: `rpc-runtime-final-integration/bin{,-release}` (their PINS verified each run) and
`chain-verifier-inputs/` (PINS verified). No Helios was rebuilt.

| job (start Z) | what | result | peak MiB @ cap |
|---|---|---|---|
| `bundles` (10:20:52) | rebuild host-admission; every builder's `--check` | rc 0; efaf6fdb; lease-gas 421d6584 and host-policy 9a6aa25a current. Failing `--check` before this work too (714aa0dcd): Windows lease runtime, MCP and platform-API guest bundles, host-service packages | 274 @512 |
| `regress-base` (10:28:44) | 14 Linux suites on **5d2d2c3c9** (before my commits): relay-policy-carriers, metal-measured-control, owner-nomination-config, metal-launcher-certs/-isolation, metal-lease-gas-conduit, host-admission-runtime/-retry, attestation-route, tenant-compute-eligibility, mcp-guest-bundle, shielded-multi-card, custody-direct-host, mcp-hosted-control | **115/117**; #26 (stale MCP bundle) and #63 (legacy test diffs against `git show HEAD:`) | 659 @768 |
| `regress2` (10:35:39) | the same suites on my tree (60a4f969f + test edits) | **115/117, the same two failures** | 656 @768 |
| `regress3` (11:38:22) | the same suites on the final HEAD | **115/117, the same two failures** | 657 @768 |
| `guest-e2e2` (10:48:09) | `test/chain-verifier-guest.e2e.test.mjs` at 722cf1b04 (verify-in-place) | 5/5 | 943 @1408 |
| `guest-e2e3` (11:36:05) | the same at the final HEAD (copy staging, port range) | **5/5** | 913 @1408 |
| `unit-js3` (11:35:59) | chain-verifier-guest (checker, env boundary, real launcher with fake QEMU, gsup wiring), rpc-runtime, runtime-lock | **20/20** | 214 @512 |
| `overlay-py2` (11:42:51) | `test/metal-control-overlay.test.py` with `CHAIN_VERIFIER_INPUTS` (install, absent, digest mismatch) | **19/19 OK** | 418 @1024 |
| `runtime-e2e2` (10:54:00) | the runtime's release E2E at 722cf1b04 (`network/` is identical at the final HEAD): `rpc-runtime.e2e` + `rpc-runtime-base-heads`, release listener 9ca75047, copy staging, Reth + EIP-2935 genesis | **15/15** (= c31e975a's e2e-release2) | 977 @1408 |
| `image-inputs3` (11:38:17) | the install set of the final HEAD, without building (§4) | **ok, no fails** | 273 @512 |
| `scan` (11:44Z) | `.githooks/scan-crypto-keys.py` + gitleaks (repo config) over `fad657bc..673601e54` (27 commits), and gitleaks over the deliverables directory | **rc 0, no leaks** | 90 @256 |
| `base-owners` (10:53:57) | ownership facts of the production base cpio | rc 0 (`receipts/base-owners.json`) | 33 @256 |

**Guest E2E.** It runs in the production base's own userland: Debian 12, node v20.20.2, glibc 2.36, flock 2.38.1. The
whole base rootfs (29,038 entries) is extracted and chroot'ed, with `/proc` and `/dev` bind-mounted.

- **Setup:** gsup's real `start()` and its real chain-verifier block, sliced from the installed `gsup.mjs`.
- **The five tests:**
  1. absent opt-in: no names, no runtime; invalid (port 8080): the refusing URL, nothing started, unknown, 0 provider
     hits;
  2. cold start with proof sources down and the head feed frozen: unknown while booting; ready; Helios through the
     loader; still unknown while no proof source answers; admitted once one does; 0 provider hits;
  3. owner decline, owner clear and admin catalog delisting, each followed through the verifier;
  4. SIGKILL: gsup restarts the runtime, the orphaned Helios is reaped by its recorded identity, ready again. SIGTERM:
     exit 0, every child stopped, restarted, serving again;
  5. poweroff: no fixture process left, and the lock file is empty.
- **Test-only, labelled:**
  - the listener's `listen` is a Reth stand-in (its commitment step is the real release listener);
  - the proof sources are loopback http (the checker allows that only in tests);
  - the sequencer key is a test key.

**Not run** (recorded):
- the full repository suite;
- an SNP/VM boot;
- the wasm-manager in the guest;
- Windows.

## 4. Image closure (no build; `RECIPE-IMAGE.md`)

`tools/image-inputs.py` uses the commit's own overlay tool on the read-only base `516d766d…`. It reports:
`receipts/image-inputs-673601e54f8f.json`, from overlay tool sha256 `10db3d3d43a8…`:
- **Install set:** 65 committed files plus 8 chain-verifier files (the 7 pinned natives and `IMAGE.json`, pin record
  `23ac96adb0c6…`).
- **Base checks:** the base is the pinned one; no hardlinked or non-regular targets; no collisions; no DigitalOcean
  mirror literal; `/usr/local/bin/node` and `/usr/bin/flock` present. The packages come from the base (viem 2.53.1,
  cors, express, jose, ws).
- **Bundles:** host-admission `efaf6fdb`, host-policy `9a6aa25a`.
- **Against D's fec43a6a image (55 inputs): 0 removed.**
  - 6 changed: `gsup.mjs` and the host-admission bundle (fad's changes, then mine); `lease-gas-runtime.mjs`,
    `service-index.mjs`, `measured-control.mjs` and the host-policy bundle (fad657bc's carrier closure, not mine).
  - 10 added: the runtime closure (8 network files), `verified-chain.mjs` (fad) and `opt/metal/chain-verifier.mjs`.
- **Ownership:** `/`, `/opt` and `/app` are uid 1000 in the base. That is recorded only, because the staging is copy
  (§5 F3).

## 5. Findings, each fixed in source

- **F1. Stale shared bundle:** A's lease-reader change made `windows/node/host-admission.bundle.mjs` stale on this
  lineage. Rebuilt with the reviewed builder (92ca07783). F must rebuild its own; the bytes are never copied.
- **F2. The from-scratch builder would ship a gsup that cannot load:** `metal/build-image.mjs` lacked
  `chain-verifier.mjs`. Fixed in 60a4f969f.
- **F3. The base image is owned by uid 1000 (`node`):** 29,027 of 29,040 entries, `/` `/opt` `/app` `/usr` included.
  - So the runtime's verify-in-place rule (root-owned ancestors) refuses in a real guest.
  - The chroot fixture hid this: in its user namespace every file appears as root. The install-set probe found it.
  - Fix: no loosening of the rule. The image uses the reviewed `copy` staging, into a 0700 run dir on the
    root-mounted `/mnt/ramdisk` tmpfs (927e2acfb).
  - Cost: a second ~234 MB in RAM while the verifier runs, on opted-in hosts only.
  - (gsup runs every child as root, and tenants live in the `/opt/roots/wasm` chroot. Whether the base should be
    root-owned is root's question; it is not changed here.)
- **F4. Port collision with tenants:**
  - The wasm manager starts before the verifier and binds a tenant's free declared port (≤ 49999) literally.
  - A verifier restart could therefore lose its port to a tenant.
  - Now the port must be in 50000..57999, below init's pinned ephemeral range 58000–65535 (673601e54).
  - The manager's bind audit polices tenant processes only, so the verifier's listener is not policed.
- **F5. A test passed for the wrong reason:**
  - The first guest E2E's contract-pins fixture lacked the optional pins, so every decision was *unknown* for a
    configuration reason.
  - Fixed, and "unknown" is now asserted to be for a chain reason (722cf1b04). The supervision steps had already
    passed up to the final decision.
- **Job sizing (not code):**
  - the overlay unittest with the real 234 MB inputs was OOM-killed at 512 (it passes at 1024, peak 500);
  - the install-set probe was guard-stopped at 256 (peak 259; it passes at 512);
  - one runtime E2E run used the wrong genesis (needs the 2935 genesis; rerun 15/15).

## 6. Limits

- **Tenants can reach the verifier's port:** tenants share the guest loopback. The runtime serves only verified, public
  chain reads. A tenant flooding it degrades only verified admission, which fails closed. Policing connections to that
  port (`wasm_manager._audit_peers` knows tenant ports only) is a base-image change and not done here.
- **Egress not exercised:** the guest's outbound path to Base P2P peers and to the https proof sources (QEMU slirp,
  dial-out only) was not exercised. There was no VM and no network.
- **Debug builds:** Helios and the helper are debug builds, run through a copied Arch glibc 2.44 runtime.
- **Finality:** the unsafe-head tier only, with no finality.

## 7. Next activation delta (root executes; nothing here does it)

1. **Review and pick the commit.** Any later commit changes the measurement.
2. **Build the image** per `RECIPE-IMAGE.md`:
   - with `--chain-verifier-dir`, no `--control`;
   - calibration b8376e15/ed918e4b;
   - separate verify job.

   This gives a new measurement M.
3. **Admit M additively** on the API relay's Linux allowlist. The current measurement stays, for rollback.
4. **Cutover** as D's §8: dist and drop-in `WorkingDirectory`, `leaseGas` byte-identical, operational gate, both
   app-paid renewals audited.
   - Do it **without** `chainVerifier` first. The guest is then in legacy mode, and M only adds the files.
5. **Opt in one host.** Add to its `config.json`:

   ```json
   "chainVerifier": {"format": "enclave-chain-verifier/v1", "unsafeSigner": "<administrator's sequencer pin>",
                     "proofSources": ["https://<explicit state holder>/"], "port": 50546}
   ```

   Then relaunch the guest.
   - Watch for: the `[gsup] chain verifier configured` line; the runtime's `ready` event; `status.json` `head.fresh`;
     host admission and policy gate decisions not *unknown*.
   - **Precondition:** a reachable proof source. Without one, every verified decision stays *unknown*, which holds
     new claims; it is honest, but not available.
6. **Rollback:** remove `chainVerifier` and relaunch. The supervisor returns to the provider quorum, unchanged.

## 8. Handoffs and receipts

- **F:** `handoff/HANDOFF-F.md` plus `handoff/patches/` (`PATCHES.sha256`). None of the patches applies to F's
  14d1e495 lineage, and F need not take them.
- **D:** publishes the checkpoint. This tree only reads D's package; the cutover in §7 reuses D's harness.
- **S:** the public-rpc-host-role is not touched. This runtime stays on loopback.
- **Time correction:** `rpc-runtime-final-integration/RECEIPT-TIME-CORRECTION-20261023.md`. The old RESULT's "09:40Z"
  was an estimate; the measured write time is 09:33:51Z (mtime; sha256 unchanged `fbbb3153…`). That file was not
  edited.
- **Inventory:** `INVENTORY.json`. Scans: `jobs/scan.out`.
- **Committed result:**
  - These documents are committed on a separate branch, `linux-rpc-runtime-launch-result`: one commit on top of
    `673601e54` adding `docs/results/linux-rpc-runtime-launch/`.
  - That leaves the **image source commit at `673601e54`**. The result commit is never imaged; its id would change the
    measurement.
- **Known cosmetic mismatch:** the title of unit test 2 in `test/chain-verifier-guest.test.mjs` still ends "in place",
  while its assertion is `copy`. It is left alone, because renaming it would change the image commit.
