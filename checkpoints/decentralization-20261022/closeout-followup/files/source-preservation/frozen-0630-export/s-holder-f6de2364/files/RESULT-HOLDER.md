# Private Base state holder: package, storage/cache, L1 trace (RESULT-HOLDER, 2026-10-23 ~05:35Z)

**Status: source + offline/loopback tests only. NOT activation-ready.** Nothing was allocated, activated, synced or
downloaded beyond metadata. This work did no SSH, used no wallet or credentials, made no production change and did not
push. The live restore and the storage VM were not touched. Bridge `f98786e` was not touched.

Commits (repo `work/fresh-witness-supply`, author SteveDeFacto):
- `0cec8c6`: the first audit;
- `4267c1e`: first package commit;
- then the root-review fixes and this file (`git log`).

`RESULT.md` carries dated corrections (overclaim, timestamp, sizes, stale Sia statement); this file supersedes its §4/§6/§7.

## 1. What exists now

A **strict launcher, config schema, renderer and root-run storage recipe** for a private stock `base rpc` node
(base/base v1.5.1).
- **Role:** it is an **untrusted witness source** for B (`rpc-runtime-composition`). It plugs into B's existing
  interface, `proofSources.untrusted: ["http://127.0.0.1:18545/"]`, and B verifies every proof against the
  sequencer-signed head.
- **Not changed:** B was not edited. No protocol or cryptography is changed.

| File | sha256 | Role |
|---|---|---|
| `holder/holder.py` | `7a5ee157…cc78` | `validate`, `render`, `preflight`, `run`, `status`; supervisor |
| `holder/FLAGS.json` | `7b2b87a4…e499e59` | every rendered flag → its clap definition (file:line) plus that file's sha256, in base/base `5476069f` and base/reth `7134be3b`; release asset pin |
| `holder/holder-storage.sh.in` | `802cfb1d…4d604` | root-only storage script template (`create`, `assemble`, `disassemble`, `verify-cap`, `cache-loss`) |
| `holder/drill-cache.sh` | `743acde5…238f1` | root-only small dm-cache boundary drill (scratch images); **not run** |
| `holder/holder.example.json` | `7ff667be…0ce2` | example; **refused by `validate`** until the extracted binary's sha256 is recorded |
| `holder/test/*`, `run-tests.sh`, `run-mutants.sh` | see `git ls-files` | tests (§8) |
| `tools/snapshot_sizes.py`, `tools/extract_flags.py` | `6fc46402…`, `bef41fa7…` | size computation and flag manifest generation from pinned sources |
| `evidence/render-sample/` | `manifest.json` lists every hash | a SAMPLE render with a dummy pin (`0…01`); for review only |

**What the launcher guarantees**, each tested in §8:

**Execution.**
- It runs exact argv arrays: no shell and no `eval`.
- The child's environment is the **whole** environment and is closed. It holds `PATH`, `LANG`, `HOME` and `TMPDIR`
  (on the HDD-backed mount), plus `BASE_NODE_L1_TRUST_RPC=false`.
  - **Why the env is closed:** base also reads `OP_RETH_SEQUENCER_HTTP` (a hidden sequencer route, `standard_node.rs:286`)
    and `BASE_NODE_*` / `RETH_*`.
  - **Why the trust variable is set:** `--l1-trust-rpc` is a SetTrue bool that defaults to **true** (`l1.rs:11,31-37`),
    so only the env can turn it off.

**Exposure.**
- Both RPCs bind `127.0.0.1`: execution `--http.addr` and consensus `--rpc.addr`. The consensus default is 0.0.0.0.
- The API is limited to `eth,net,web3`; admin, debug, txpool and miner are refused.
- `--ipcdisable` is set. The Engine API uses base's internal auth IPC, with auth on port 0 at localhost
  (`configure_unified_auth_endpoint`). No JWT is configured; reth creates its own.
- The local verifier port (B's 8545) and any duplicate port are refused.
- **No sequencer forwarding** unless `txForwarding.endpoint` is set explicitly (https).
- **P2P** binds the explicit `p2p.listenIp`; loopback is refused because it cannot reach peers. P2P is protocol
  participation, not Enclave serving. The holder is not a host-service role and is never written to the host-services
  file.

**Supervision.**
- The binary must be a regular file that is not group/other writable and that matches its sha256 pin.
- `preflight` also requires that every rendered flag appears in the binary's own help. **This has not run**, because
  no Base binary is present.
- The child gets its own process group, `PDEATHSIG=SIGKILL`, and an `RLIMIT_NOFILE`.
- **Readiness** means `eth_chainId == 0x2105` on loopback, reported to systemd with `READY=1`.
- **Stop** sends SIGTERM to the group, then SIGKILL after the grace period. When the child exits, the group is reaped.
- **Exit codes:** a child failure propagates its code; "never ready" exits 70.

**systemd unit.**
- `Type=notify`, `KillMode=mixed`, `Restart=on-failure` with a start limit.
- Limits: `MemoryMax`, `MemoryHigh`, `MemorySwapMax=0`, `TasksMax`, `LimitNOFILE`.
- Hardening: `NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths` set to the holder mount only,
  `PrivateTmp`/`PrivateDevices`, and `RestrictAddressFamilies`.
- It requires the storage unit.

**Cold-cycle avoidance.**
- **Start path:** local disk, Base P2P and the DECLARED L1 endpoints. No Enclave lease, no Sia and no Enclave RPC.
- **Unit type:** it is a host-level systemd unit, not a lease-paid app.

## 2. Binary and source closure (honest)

**Pinned release.**
- Asset: `base-v1.5.1-x86_64-unknown-linux-gnu.tar.gz`, GitHub asset digest
  `6779c45dbc6041205cc4e52bc2cd9d40746a5a4366a309899bf6533fccebe2b7` (release JSON in `evidence/upstream-…`).
- **Not downloaded.** The `.asc` signature is **not verified**, because the release key was not established.

**Binaries present locally.**
- **No Base binary.** There are no matching Docker images and no Base binaries on PATH.
- **The only maintained client present** is upstream Ethereum reth v2.8.0, `8cdd1f35…`, which cannot run Base.

**Flags.** Validated against **pinned source only** and **not executed**. The open items are:
- `--minimal` together with the download-generated prune config;
- the exact `dmsetup table` echo format.

`preflight` checks the first against the binary's own help before any start.

**Missing for activation:** download the release tarball, check its digest, extract it, and record the binary's sha256
in the config. That is a root action.

## 3. Sizes (computed from Base's own manifest with the pinned reth selection rules)

- **Manifest:** `mainnet-v2-snapshots.base.org/1792713607/manifest.json`, metadata only, sha256 `7b5071ef…`.
- **Snapshot:** block 52962126, reth `2.5.2-dev (7134be3)`.
- **Selection rules:** `--minimal` = state + headers in full, then transactions, account changesets and storage
  changesets for the last 10,064 blocks, receipts for the last 64, no senders, no RocksDB indices (base/reth
  `download/mod.rs` `pruning_selection_for_component`, `pruning.rs` `minimal_prune_modes`, `manifest.rs`
  `size_for_distance`).

| Profile | Download | Extracted on disk |
|---|---|---|
| **minimal** | **820.0 GB** | **1,258.0 GB** (state 1,138.2; headers 31.7; transactions 26.9; receipts 21.5; storage changesets 36.0; account changesets 3.8) |
| full (excluding transactions since Paris) | 803.0 GB | 1,231.1 GB |
| not selected | senders 46.2 / 219.4, RocksDB indices 597.6 / 718.3, proofs 872.5 / 1,163.6, all transactions 1,278.1 / 2,422.6 | |

**Peak disk during restore.**
- **Non-resumable** (`streaming_download_and_extract`): about the extracted size.
- **`--resumable`**: keeps `.part` archives first, so the peak can add up to the 761 GB state archive.

**Growth and runtime.** Not measured. The origin image in the example is 3.1 TB: about 2× extracted plus 20 %, per
Base's capacity formula.

## 4. L1 dependence (pinned source traced; UNEXECUTED)

| Phase | Behaviour | Source |
|---|---|---|
| CLI | `--l1-eth-rpc` and `--l1-beacon` are **required** (no default) | `consensus/cli/src/l1.rs:17-40`; `rpc.rs` test `REQUIRED_CONSENSUS_ARGS` |
| **Startup** | P2P setup **always** reads the unsafe-block signer from L1 `SystemConfig` storage at the latest L1 block: 5 attempts, backoff 100 ms → 10 s. When they run out, **startup fails**. The value is taken from that RPC with **no proof verification**. A zero result falls back to the built-in signer. | `p2p.rs:464-620`, call site `node.rs:533` (`Some(l1_eth_rpc)`), `base_retry DEFAULT_BOUNDED_*` |
| Startup, upgrade signal | Default `metrics-only` reads nothing before start. `startup-apply`/`runtime-admin` **retry indefinitely** until the L1 schedule is read ("refusing to start without an authoritative L1 upgrade schedule"). The launcher pins `metrics-only` unless the config says otherwise. | `upgrade-signal/config/args.rs`, `types.rs:18-45`, `schedule.rs:294-337` |
| Runtime, **unsafe following** | The gossip block goes to engine `InsertTask::unsafe_payload`, with no L1 call on that path. A validator bootstraps from reth's head and "awaits gossip for EL sync". | `actors/network/actor.rs:193-198`, `engine/validator_engine_request_handler.rs:151`, `engine_request_processor.rs:340-383,548-557` |
| Runtime, **safe/finalized** | Derivation needs L1 blocks, receipts and **beacon blob sidecars** continuously. Without them the safe head stalls. | derivation pipeline (`OnlineBeaconClient`) |
| Runtime, L1 watcher | It polls L1. Each new L1 head's SystemConfig log fetch gets 10 retries; when they run out, the actor returns `Err`. **Any** actor exit cancels the whole service (`drop_guard`), and `base rpc` then stops execution too. Behaviour under a *total* outage (no new heads) is UNVERIFIED. | `l1_watcher/actor.rs:44-97,270-312`, `service/util.rs:16-60`, `bin/base/src/commands/rpc.rs` select |

**Conclusion.**
- The holder **cannot start without a reachable L1 execution endpoint**, and its signer comes from that endpoint
  unverified.
- Unsafe following does not call L1 per block, but the node can exit on L1 errors, and a restart then needs L1 again.

**What removing public L1 RPC still requires**, from maintained clients and docs:
- a **self-hosted L1 execution client plus beacon node**, the latter serving blob sidecars from L1 P2P;
- the holder's two L1 URLs pointed at loopback (`l1.selfHosted` is labelled).

That is another TB-class node, with the same storage question. Its sizes were not measured here, and no L1 sync was
started.

**What the stock client does not provide:**
- **no light-client L1 mode:** a Helios-style verified L1 proxy would still need an L1 execution source and does not
  serve beacon blobs;
- **no verified signer:** that would need an L1 storage proof against an authenticated L1 header (nimbus LC, prior
  audit P3), which is not integrated.

## 5. NVMe cache: design, enforcement status, gaps

**Measured inventory** (read-only, `logs/inventory-1.out`, 04:46Z):
- **HDD array:** `/mnt/usb` is **NTFS** (`ntfs3`) on `sda2`, a 36 TB USB RAID5, rotational.
- **NVMe:**
  - `/` (LUKS ext4, nvme1): 234.7 GB free;
  - `/vm` (LUKS ext4, nvme0): 1.535 TB free.
- **Memory:** 128 GiB total; MemAvailable about 24–25 GiB (root reports about 69 GiB unevictable and running GPU/VM
  guests).
- **CPU:** 32.
- **Kernel:** `dm-mod` is loaded; `dm-cache`, `dm-cache-smq`, `bcache` and `loop` are **present on disk but not loaded**.
- **Tools:** `dmsetup`, `losetup`, `tune2fs` and `zfs` are present; `lvm`, `cache_check` and `make-bcache` are
  **missing**.
- **Privileges:** no `sudo -n`, so every allocation and mapping is root's.

**Design.**
- **Durable state:** a NEW ext4 filesystem inside a NEW image file on the HDD (the origin). The NTFS filesystem is not
  reformatted, and MDBX does not run on ntfs3 directly; that combination is untested and avoided.
- **Optional cache:** dm-cache in **writethrough** mode (smq) on two NEW fixed-size image files on NVMe, placed on `/vm`.
  Putting them on `/` would leave about 35 GB free there.
  - **Why writethrough:** every write completes on the HDD origin first, so losing the cache loses no authoritative
    data.
  - **Refused:** writeback, and dm-writecache (which is writeback-only).
- **Placement:** the origin must be rotational and the cache non-rotational, checked from real sysfs (§8).

**The cap, by construction.**
- The holder's NVMe use is the **allocated** bytes of two preallocated (non-sparse) files. Their size cannot grow through
  dm-cache.
- **Example sizes:** data 197,999,984,640 + metadata 1,073,741,824 + slack 67,108,864 = **199,140,835,328 B** (≤ the
  200 GB target).
- `verify-cap` measures the holder images' **allocated** bytes **plus every path in a root-maintained shared inventory**
  (`du -sx --block-size=1`; label<TAB>path). Above **250,000,000,000** it exits 3.
- `create` and `assemble` refuse when that check fails.

**Root review findings (`ROOT-CACHE-REVIEW-0523.json`) and how they are addressed, all in source and tested through
command seams:**

1. **Mapper/mount adoption.**
   - `assemble` adopts an existing `enclave-base-holder` mapping **only** if `dmsetup table` equals the expected table
     exactly: our three loops' MAJ:MIN, size, block size, `1 writethrough smq 0`.
   - It adopts a mount only if `findmnt MAJ:MIN` equals our device's.
   - Anything else is refused and left untouched.
   - `disassemble` and `cache-loss` apply the same identity checks before removing anything.
2. **Stale cache.**
   - `cache-loss` (holder offline) removes our mapping and **zeroes the cache metadata before the origin is touched**,
     then runs a read-only fsck.
   - The next `assemble` therefore formats an empty cache.
   - `assemble` refuses to map when the origin loop is mounted without the cache (the stale-cache hazard).
   - The earlier "rewarms from empty" claim without invalidation is removed.
3. **Aggregate inventory.** The config value is now a planning estimate only. Enforcement uses **measured** bytes of
   the shared inventory.
   - **Limit (still open):** I cannot see other caches of this work (for example Sia-side), and no shared inventory
     exists yet. That is root's activation prerequisite.
   - **Filesystem overhead:** the backing filesystem's own journal and metadata are filesystem-wide and not attributable.
     The 64 MiB slack covers per-file extent metadata, which `st_blocks` already includes.
   - **No temp on NVMe:** node temp goes to `TMPDIR` on the HDD mount, and no extra image copies are made.
4. **Partial setup.**
   - `create` preflights **everything** before allocating: absent targets, media, free space with margins, and the
     planned cap.
   - It tracks only what it created or attached, and unwinds exactly that.
   - `assemble` unwinds only its new loops, mapping and mount.
   - `disassemble` **stops** at a failed unmount or unmap and detaches nothing under a live user.

**Not established.**
- **Kernel enforcement:** no root and no allocation.
- **The drill:** `drill-cache.sh` on scratch images checks that NVMe allocation is unchanged under 3× cache writes, that
  used ≤ total blocks, that the mode is writethrough, and that invalidation then origin-only fsck plus sha256 succeed.
  **It was not run.**
- **Throughput:** a 200 GB cache against 1.26 TB of extracted state is a partial read cache. Writethrough writes are
  bounded by the HDD (20 durable random 4 KiB writes/s measured at QD1). **No throughput claim** is made without a
  full-state test.

## 6. Fresh-proof and transaction gaps

- **Fresh proofs.** They become available only while this holder is synced and reachable; B fails closed otherwise. A
  single holder at one site is a single point of withholding.
  - Whether any Base peer or operator serves state proofs is UNKNOWN: snap/2 is implemented but default-off with no
    flag, and peer observations so far are inconclusive.
- **Transactions: explicitly incomplete.**
  - The holder forwards nothing by default.
  - The next step would be an explicit `txForwarding.endpoint`, which is the hosted sequencer.
  - The L1 `OptimismPortal` deposit is a separate path with different semantics (L1 gas, delayed inclusion,
    deposit-transaction encoding). It is **not** a transparent replacement for user calls without a review of those
    semantics.
  - Base P2P tx gossip is disabled in base-reth (`node.rs:1287` on current main).
- **Minipc** (root observation, 04:48Z): Windows, about 32 GiB free memory, 16 CPUs, C: NTFS 627 GB free. **No HDD array
  is visible there**, and nothing shows it is a Linux/Base-compatible host. It is not a holder candidate on this evidence.

## 7. Root preflight → activation → rollback (eventual; NOT authorized by this work)

**Preflight** (read-only):
1. Check the commit; run `holder/run-tests.sh holder` (both suites) through the queue.
2. Install the binary:
   - download the v1.5.1 tarball;
   - `sha256sum` it, expecting `6779c45d…`;
   - optionally verify the `.asc` once a Base release key is established;
   - extract it to `/opt/enclave-base-holder/bin/base` as `root:root 0755`;
   - record its sha256 in the config.
3. Run `holder.py validate CONFIG` (must pass) and `holder.py render CONFIG /root/holder-render`; review every file.
4. Confirm the flags: `base --chain mainnet rpc --help`, and check every flag in `holder.argv.json` against it.
5. Check capacity:
   - current MemAvailable ≥ `limits.memoryMaxBytes` (`preflight` refuses otherwise; today about 24 GiB is available
     against the example's 32 GiB `MemoryMax`, so this **fails now**);
   - the array has free space ≥ origin + margin;
   - `/vm` has free space ≥ cache + margin.
6. Write the shared NVMe inventory TSV listing **every** NVMe cache allocation of this work.

**Activation**, each step root-approved:
1. Run `drill-cache.sh` on empty scratch directories (one on `/vm`, one on `/mnt/usb`). It must print `DRILL PASS`.
2. Run `holder-storage.sh create`, then `verify-cap`.
3. Restore the minimal snapshot (non-resumable streaming, about 1.26 TB written to the HDD origin) into the datadir.
   - Then check the restored state root against an independent root: the listener's signed envelope, or a later L1
     ASR anchor.
4. Install the units; `systemctl start enclave-base-holder-storage enclave-base-holder`; `holder.py status`.
5. Follow test (bounded, for example 30 minutes). Measure head lag against the listener, iowait and proof latency, and
   verify `eth_getProof` in B. **That run is the HDD/cache throughput verdict.**
6. Only after that, add `b-proof-source.json`'s URL to B's `proofSources.untrusted`. That is a B config change, and B
   owns it.

**Rollback.**
1. Remove the URL from B's config.
2. `systemctl stop` both units (`disassemble` stops at the first failure).
3. To drop the cache only: `holder-storage.sh cache-loss`, then delete the two `/vm` images and their inventory lines.
4. To remove everything: also delete the origin image on `/mnt/usb`.

No existing filesystem, VM, app or admin control is touched at any step.

## 8. Tests and controls (all through `work/claude-test-queue.py`; logs in `logs/`)

| Run | Lane | Result |
|---|---|---|
| `holder-t8` | 256 | `test_holder.py` **17/17 OK**, `test_storage.py` **17/17 OK**, mutants **13/13 killed**, each by its targeted test |
| `holder-reth1` | 768 | upstream reth v2.8.0 `--dev` (`8cdd1f35…`) under `holder.Supervisor`: started → ready (`0x539`) → SIGTERM → exited 0 in 1.61 s; port released; no leftover process; peak 255 MiB (holder.py of that time; re-run on the final hash: `holder-reth2`, see §9) |
| `holder-t1`…`t7` | 256 | development runs; their failures were fixed (listed in the commits) |
| `inventory-1`, `images-1`, `fetch-1..4` | 256 | read-only inventory and metadata fetches |

**What the tests cover:**
- **Validation:** 37 refusal cases, plus the exact cap boundary: 250,000,000,000 is accepted and one byte more is
  refused.
- **Render:** exact argv; every flag is pinned in FLAGS.json; no 0.0.0.0 on any RPC; no forwarding unless configured;
  a closed env; unit directives; `bash -n`; B's committed URL policy (`rpc-identity.mjs` at `61a639f2`, run with node)
  accepts the holder URL as loopback and refuses plain http to a non-loopback host.
- **Placement:** real sysfs. `/vm` and `/` resolve through dm-crypt to NVMe (non-rotational); `/mnt/usb` resolves to the
  rotational USB RAID.
- **Lifecycle (stand-in `standin-base.py`, NOT a Base client):**
  - `READY=1` arrives over a real `NOTIFY_SOCKET`;
  - the child receives exactly the rendered argv, and exactly the closed env even when the launcher's own env carries
    `OP_RETH_SEQUENCER_HTTP` and `BASE_NODE_*`;
  - clean stop with grandchild reaping;
  - a child's exit code propagates and its group is reaped;
  - never ready → 70;
  - a tampered binary means nothing executes;
  - supervisor SIGKILL → the child dies (PDEATHSIG);
  - a SIGTERM-ignoring child is killed after the grace period;
  - preflight refuses tmpfs and NVMe datadirs and sees busy ports.
- **Storage seams** (real script, stubbed privileged commands, real fallocate/dd/du):
  - preallocated exact sizes;
  - refuses existing targets or wrong media before allocating;
  - measured-inventory cap with the exact boundary;
  - unwind on mkfs failure keeps foreign loops;
  - writethrough mapping and idempotent adoption;
  - refuses a foreign mapping or a foreign mount, and refuses an origin mounted without the cache;
  - a failure keeps pre-existing loops;
  - disassemble stops on a failed unmount or unmap and refuses a foreign mapping;
  - cache-loss zeroes metadata **before** fsck;
  - the no-cache layout.
- **Mutants:**
  - launcher: inherit-env, public-http, allow-writeback, cap-off-by-slack, no-group-reap, no-pdeathsig, trust-l1,
    verifier-port;
  - storage script: adopt-any-mapping, no-invalidate, no-unwind, continue-after-failed-umount, measured-cap-ignored.

**Not tested:** a real Base binary, real dm-cache or loop devices, real systemd install, sync, throughput, L1 outage
behaviour, or cache hit rates.

## 9. Next bounded root step

1. Review commit `HEAD` and the root-findings fixes (§5).
2. Run §7 Preflight steps 1–4 only: tarball digest, binary pin, flag/help comparison.
3. Decide the memory reservation; the example needs 32 GiB against about 24 GiB available now.
4. Write the shared NVMe inventory.
5. Only then run the scratch `drill-cache.sh` as root.

The holder stays inactive until the drill passes and the follow test measures throughput. Public L1 RPC stays a
declared dependency until root decides on a self-hosted L1 pair.

`holder-reth2` (the reth `--dev` run on the final hash, holder.py `7a5ee157…`) ran OK: started → ready (`0x539`) →
stopping → exited 0, stopped in 1.61 s, peak 229 MiB, rc 0.
