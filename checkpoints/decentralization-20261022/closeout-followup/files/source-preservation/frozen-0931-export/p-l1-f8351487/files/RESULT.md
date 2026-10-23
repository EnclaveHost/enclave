# Self-hosted L1 execution + beacon source for the Base holder (RESULT, 2026-10-23)

**Status: DECISION-READY SOURCE PACKAGE. Nothing is activated.**
- **Not done:** no download of new binaries, no sync, no allocation, no SSH, no wallet, no production change, no push.
- **Ownership:** S's holder tree, E's transaction work, B, A, C and F were not edited.
- **Commits:** repo `work/rpc-l1-source-package`, author SteveDeFacto; final pins in §8.

## 1. Why this is needed (S's evidence, not re-derived)

- **Base exits without L1:** the official `base` v1.5.1 (`9c44836d`) answers `eth_chainId 0x2105` 1.3 s after start, then
  **exits 1 at 5.8 s** when L1 is unreachable (S `logs/bp-off1.out`). A reachable chain ID is therefore not readiness.
- **Light verification is not enough:** a light verifier cannot supply execution data or beacon blobs (prior audit). Base
  derivation needs both continuously.

This package supplies them from a **standard, maintained, non-validating Ethereum mainnet pair**:
- **Execution:** reth.
- **Consensus:** Lighthouse.

It is not a proxy, and it does not remove the need for an L1 node: it *is* the L1 node.

## 2. Exactly what Base v1.5.1 asks of L1

Traced in the vendored source `base/base 5476069f`, read-only at `rpc-priority/vendor-inspect/base-v1.5.1`.

**Execution JSON-RPC:**

| Method | Called from |
|---|---|
| `eth_chainId`, `eth_blockNumber` | `providers/chain_provider.rs` |
| `eth_getBlockByNumber`: `latest`, `finalized` (polled; null is skipped) and by number | `l1_watcher/blockstream.rs`, `service/node.rs:544-553` |
| `eth_getBlockByHash`, header and full | `chain_provider.rs:168,252`; header hash re-verified when `trust_rpc=false` |
| `eth_getBlockReceipts` by hash | `chain_provider.rs:218` |
| `eth_getLogs` with `{address: SystemConfig, blockHash}` | `l1_watcher/actor.rs:273` |
| `eth_getStorageAt(SystemConfig, 0x65a7…1c08, {blockHash})`: the unsafe signer at startup | `cli/src/p2p.rs:475,574` |
| `eth_call`: upgrade-signal reads, non-gating in `metrics-only` | `upgrade-signal/src/contract.rs` |

**Beacon API:**

| Path | Notes |
|---|---|
| `/eth/v1/config/spec` | `SECONDS_PER_SLOT` |
| `/eth/v1/beacon/genesis` | |
| **`/eth/v1/beacon/blobs/{slot}?versioned_hashes=…`** | The ONLY blob path. `beacon_client.rs:16-22,191`. 404 means the slot is missed, so Base resets. Base verifies the KZG versioned hash itself. |

**Base mainnet rollup values** (`chains/config.rs`):
- `l1_chain_id` 1;
- `seq_window_size` 3600;
- `channel_timeout` 300 (50 after Granite);
- SystemConfig `0x73a7…4072`;
- batch inbox `0xff…8453`.

## 3. The pair and why

| | Execution | Consensus |
|---|---|---|
| Client | **reth v2.8.0**, commit `05ba4812`. **Already present** (official tarball `809bfe0f…` = GitHub asset digest; binary `8cdd1f35…`; self-reports `Reth Version: 2.8.0`, `Commit SHA: 05ba4812…`) | **Lighthouse v8.3.2**, commit `a376defa`, published 2026-10-23T00:41Z. **Not downloaded**: tarball digest `ea914e93…`, `.asc` `4c4ce326…`, PGP `15E6 6D94 1F69 7E28 F493 81F4 2641 6DC3 F306 74B0`. Needs glibc ≥ 2.34. |
| Why this version | Latest reth. Mainnet Amsterdam is not scheduled; v2.7/v2.8 only schedule Sepolia/Hoodi | Latest stable. "Mainnet users do not need to upgrade" vs v8.3.x. Gloas is **not scheduled on mainnet** (`config.yaml` `GLOAS_FORK_EPOCH` = 2^64-1), so a future mainnet fork means a re-pin of BOTH (Lighthouse says v9 will be needed) |
| Mode | `--full --prune.receipts.distance 140000` | `--semi-supernode`, `--prune-blobs true`; the margin is configurable |
| APIs | HTTP `eth,net,web3` on 127.0.0.1; engine `authrpc` on 127.0.0.1 with JWT; `--ipcdisable` | HTTP on 127.0.0.1; engine client to reth over loopback with the same JWT |
| No sending path | `--disable-tx-gossip`, `--txpool.disable-transactions-backup` | no validator client, builder or keys |

**Why the non-default choices are required, not tuning:**

- **Receipts.**
  - Pinned reth docs (`pruning.mdx`) and source (`args/pruning.rs:73`): `--full` keeps receipts, and therefore
    `eth_getBlockReceipts`/`eth_getLogs`, for **only 10,064 blocks (~33.5 h)**.
  - Base re-derives from its safe head's L1 origin minus the sequencing window. That window can lie days back after a
    holder restore or outage.
  - Blobs exist on L1 P2P for 4096 epochs = 131,072 slots (~18.2 d; `MIN_EPOCHS_FOR_DATA_COLUMN_SIDECARS_REQUESTS`).
  - So receipts are kept for **≥ 140,000 blocks (~19.4 d) = blob window + 3,600 + margin**, and receipts never expire
    before the blobs they pair with.
  - `--prune.receipts.distance` overrides only the receipts segment of `--full` (`pruning.rs:259-305`). The real binary
    persisted exactly that (§5).
  - `--minimal` (receipts 64 blocks) is refused.
- **Custody.**
  - Lighthouse book (`advanced_blobs.md`): after Fulu "a full node will not be able to serve blobs". Only
    `--semi-supernode` (half the columns, enough to reconstruct) or `--supernode` can, and only "for blobs since using
    the flag for a max of 18 days".
  - So a default beacon node **cannot** serve Base. Custody is required, and the gate checks custody groups ≥ 64.
- **Hidden external defaults, made explicit and refused:**
  - **reth `--nat` defaults to `any`.** For `any`/`upnp`/`publicip`, reth fetches `https://ipinfo.io/ip`,
    `https://icanhazip.com` and `https://ifconfig.me` (`crates/net/nat/src/lib.rs:38,244`). The package renders
    `--nat none` or `extip:<IP>` and refuses the others.
  - **Lighthouse UPnP** defaults on; the package renders `--disable-upnp`.
  - **Checkpoint URL:** never defaulted, and genesis sync is refused (`--allow-insecure-genesis-sync`: "DO NOT use on
    mainnet!").
  - **Genesis state:** Lighthouse's mainnet genesis state is embedded (`genesis.ssz.zip`, git blob `28405c78`), so
    `--genesis-state-url` is never used. Its genesis time `1606824023` and validators root `0x4b363db9…` were parsed from
    that artifact.
  - **DNS discovery** (EIP-1459) is an explicit boolean; the example disables it (built-in bootnodes plus discv4/v5).

## 4. Package (`l1pair/`)

- **`l1pair.py`** commands:
  - `validate`, `render`;
  - `preflight`;
  - `run-el`, `run-cl`;
  - `ready` (the data gate);
  - `checkpoint-inspect`.
- **Reuse, no parallel framework:**
  - **Library** (`vendor/holder/`): S's FINAL immutable source (`fresh-witness-supply` `959e56fd`, root-reviewed budget
    v2: shared ledger plus rounding fix; includes root's `c3efff41` and `fd0134d` unwind fixes and `b1b6f184`;
    byte-identical, `VENDOR.json` pins), imported as a library for:
    - `Supervisor`: own process group, PDEATHSIG, SIGTERM then SIGKILL, `sd_notify`;
    - `backing_disks` (sysfs HDD/NVMe placement) and `port_in_use`;
    - `validate_storage`: origin bounds, writethrough-only cache, 250 GB aggregate cap;
    - `only()`: unknown and credential-named fields are refused.
  - **Storage script:** S's `holder-storage.sh.in`, **byte-identical**, rendered with `NAME=enclave-l1-pair`. The pair and
    the holder never adopt each other's mappings. A cache is admitted, allocated and verified only through S's
    `budget.py` against the ONE canonical ledger `/etc/enclave-rpc-cache/nvme-cache-budget.json`. That ledger holds fixed
    reservations charged at `maxBytes`, per-host shares, cap 250e9 and target 200e9.
- **Validation refuses:**
  - **Chain and pins:**
    - any network other than mainnet, or any client other than reth/Lighthouse;
    - a wrong release, commit, asset digest or binary pin, or a placeholder;
    - a wrong chain or version is also caught at preflight (`--version`) and by the gate (spec, genesis, version).
  - **APIs and retention:**
    - admin, debug, trace, txpool or miner APIs;
    - receipts below 140,000;
    - custody other than semi-supernode or supernode.
  - **Network:**
    - NAT `any`/`upnp`/`publicip`;
    - implicit DNS discovery;
    - loopback P2P;
    - duplicate ports, or ports used by co-resident services (B 8545; holder 18545/19545/30303/9200/9222/9223).
  - **Storage:**
    - a JWT secret path outside `/etc`;
    - mount `/`, a system tree, `/tmp`, `/vm` (NVMe) or the array root;
    - an origin image not on `/mnt/usb` or under 1.5 TB;
    - **overlap with any co-resident service path** (holder mount, image dir, cache dir, config);
    - any NVMe cache that is writeback, exceeds the 250e9 aggregate, or **exceeds the 200e9 target** together with the
      declared holder share;
    - undeclared other caches.
  - **Checkpoint and limits:**
    - genesis sync;
    - a checkpoint URL without explicit one-time acknowledgement;
    - a checkpoint with fewer than 2 distinct provenance observations, a mismatching root, an epoch before Fulu, or files
      inside the beacon datadir;
    - undeclared co-resident memory.
- **Preflight (read-only):**
  - binary pins, `--version` and **every rendered flag in each binary's own help**;
  - glibc ≥ 2.34;
  - the mount is a real mount point, not on `/`, and not the same filesystem as any co-resident service;
  - HDD placement via sysfs, or HDD+NVMe when cached;
  - preallocated (non-sparse) cache images;
  - the JWT secret's mode, shape and owner;
  - the checkpoint file: sha256, mainnet genesis validators root, epoch boundary, epoch matches wss, block not newer than
    state, ≤ 14 days old (an operational bound), not from the future;
  - **MemAvailable ≥ both MemoryMax + the co-resident reservation**;
  - free ports.
- **Units:**
  - `Type=notify`, `KillMode=mixed`;
  - `MemoryMax`/`MemoryHigh`, `MemorySwapMax=0`, `TasksMax`, `LimitNOFILE`;
  - `ProtectSystem=strict`, `ReadWritePaths` set to the pair mount only, `PrivateTmp`/`PrivateDevices`;
  - a closed child env: `PATH`, `LANG`, `HOME`, `TMPDIR` on the HDD mount;
  - `Requires` the storage unit;
  - CL after EL.
- **Readiness:**
  - **Process:** the EL's `eth_chainId` is `0x1`; the CL's beacon API answers with mainnet genesis and deposit chain 1.
  - **DATA gate** (`ready`, 13 checks, all required):
    - EL: chain, genesis hash, not syncing, head lag ≤ 120 s, finalized ≤ 1 h, optionally receipts from block N;
    - CL: validators root, spec (deposit chain 1, 12 s, Fulu 411392), version v8.3.2, not syncing/optimistic/EL-offline,
      custody ≥ 64;
    - **pair**: the CL head payload is the EL's block at that height;
    - **blobs**: a blob-carrying slot serves all its blobs at `/eth/v1/beacon/blobs/{slot}` (or `--need-blobs-from-slot S`).
- **Holder fragment:** `holder-l1-fragment.json`:
  - holder `l1` = `http://127.0.0.1:18645/`, `http://127.0.0.1:15052/`, `trustRpc: false`;
  - checked against S's own committed URL policy (`H.l1_url`, which accepts it as self-hosted loopback);
  - S applies it.

## 5. Tests

All runs went through `work/claude-test-queue.py` (16 GiB floor; at most one large lane plus small 256 MiB lanes), offline
in `unshare -rn` with loopback brought up. Digest: `TEST-EVIDENCE.txt`; full logs are in `logs/`.

| Run | What | Result | Peak |
|---|---|---|---|
| **reth-4** | **REAL official reth v2.8.0** (`8cdd1f35`) under `l1pair.py run-el`, mainnet, empty datadir | **PASS** (see below) | 290 MiB |
| **base-3** | **REAL official base v1.5.1** (S's staged `9c44836d`, read-only) under S's FINAL launcher, `l1.executionRpc` = the REAL reth above, `l1.beacon` = a LABELLED stand-in | **PASS**: alive the full 120 s, `0x2105` at 1.5 s | 565 MiB |
| **unit-6** | unit suite on `l1pair.py` `3635472d` | **19/19 OK** (about 60 subtests) | 256 lane |
| **mut-4** | 20 launcher mutants on `3635472d` | **20/20 killed** | 256 lane |
| **scan-4** | crypto-key scanner + gitleaks over all commits; gitleaks over `evidence/` | see `logs/scan-4.out` | |
| rhelp-1, fetch-1..5, inv-1 | the binary's own help (offline), pinned primary sources, read-only inventory | rc 0 | ≤ 54 MiB |

**reth-4 measured, on the real binary** (reth-3 on the previous S pin gave the same values):
- ready 0.5 s after the launcher started;
- `eth_chainId 0x1`, `net_version 1`, genesis `0xd4e56740…8fa3`;
- **every Base L1 execution call answered on `eth,net,web3`:**
  - `eth_blockNumber`;
  - `eth_getBlockByNumber` (latest, finalized → `null` without a CL, `0x0`);
  - `eth_getBlockByHash` (header and full);
  - `eth_getBlockReceipts`;
  - `eth_getLogs` with `{blockHash, address: SystemConfig}`;
  - `eth_getStorageAt(SystemConfig, signer slot, {blockHash})`;
  - `eth_call`.
- **Refused on HTTP** (-32601): `admin_`, `debug_`, `txpool_`, `trace_`, `miner_` and `engine_` methods.
- **Engine API:** a valid HS256 JWT gets 200 (capabilities include `engine_newPayloadV5` and `engine_getBlobsV4`). No JWT,
  a wrong key and a stale `iat` all get **401**.
- **Listeners:** HTTP and engine **127.0.0.1 only**. The only wildcard listener is the configured P2P port. No IPC socket.
- **Persisted `reth.toml` prune segments = the rendered ones:**
  - `receipts {distance: 140000}`;
  - `sender_recovery full`;
  - account/storage history 10,064;
  - bodies before 15,537,394 (Paris);
  - no `transaction_lookup` pruning.
- **The DATA gate is CLOSED** (negative control: the chain ID answers, but the node is not a usable source):
  - `el.chainId` and `el.genesis` pass;
  - `el.syncing`, `el.head` (lag about 56 years), `el.finalized` (null) and all 8 CL/pair/blob checks fail.
- **SIGTERM:** exit 0 in 1.67 s, no leftover listener.
- **Datadir:** 4.3 GB apparent but **1.5 MB allocated** (sparse MDBX).

**base-3** (base-2 on the previous S pin: identical outcome): the official Base v1.5.1 under S's final launcher `959e56f`. **Reference:** with L1 unreachable, S's bp-off1 exited
1 at 5.8 s. **Here it:**
- stayed alive for the full 120 s observation and answered `0x2105` at 1.5 s;
- logged no L1 retry exhaustion and no "Retrying L1 latest block number lookup";
- **read the unsafe signer from the real reth** ("returned zero unsafe block signer (L1 may still be syncing), falling
  back to built-in/genesis signer block_number=0"; zero because SystemConfig does not exist at the genesis block);
- requested `/eth/v1/beacon/genesis` and `/eth/v1/config/spec` from the stand-in;
- started derivation, received the L1 head (genesis), and skipped derivation, as expected without a synced L1.

**What these tests do NOT show:** sync, peers, a live head, Lighthouse behaviour, blob serving, derivation progress, HDD
throughput, or any mainnet independence. The beacon side of base-3 is a stand-in.

**Failures during development, disclosed:**
- **unit-1:** S's `only()` refuses credential-named fields; renamed to `engineAuthPath`.
- **unit-2:** loopback down in the netns; check count; test arithmetic.
- **reth-2:** a REAL launcher bug: `run-el` refused to start without the Lighthouse binary. Fixed in `5ccee19`; each unit
  now pins only its own binary.
- **base-1:** a TEST-HARNESS bug: base's `engine.ipc` under the long scratch path exceeded `sun_path` (107 bytes).
  Production `/srv/enclave-base-holder/data` is short.
- **scan-1/2:** gitleaks flagged 13 `generic-api-key` matches in the raw GitHub release-API JSON for Lighthouse. 7 are
  Sigma Prime's **public PGP fingerprint**; the other 6 sit among GitHub API metadata fields. They are not secrets. The raw
  responses were replaced by `RELEASES-EXTRACT.json` (with the originals' sha256 kept), and the unpublished commit was
  amended.
- **reth-1:** never started: the background time limit was reached while the large lane was held by another worker.
- **Re-pins:** root handoffs moved the vendored S source `08f2efe` → `6b9dae92` → `959e56f` (shared budget ledger v2).
  Unit, mutants and both real-binary tests were rerun on the final pin (unit-6, mut-4, reth-4, base-3).

**Tested vs source-only:**

| Piece | Status |
|---|---|
| reth flags, persisted prune config, loopback/engine/JWT behaviour, Base's L1 execution methods, supervisor start/ready/stop | **TESTED on the real binary** (offline, genesis only) |
| Base startup L1 dependency met by the self-hosted execution side | **TESTED with real Base + real reth**; beacon side is a stand-in |
| Lighthouse flags | **SOURCE-ONLY** (pinned `help_bn.md`/`cli.rs` at `a376defa`). `preflight` re-checks against the installed binary's help |
| Readiness-gate logic, every check | stand-in servers (labelled); each check individually breaks the gate. Against real reth: closes for the right reasons |
| Checkpoint header parsing | real mainnet genesis `BeaconState` (from Lighthouse's embedded zip) + labelled synthetic prefixes |
| Storage script | S's reviewed script byte-identical; `bash -n`; constants only. Its kernel drill has not run (S §5) |
| Sync time, HDD throughput, RAM under load, blob serving, P2P | **NOT TESTED** (no sync authorized) |

## 6. Capacity envelope and the remaining external decision

Sources are pinned docs; **estimates are labelled.**

**Disk** (durable, HDD array only; a new origin image of 4 TB in the example):

| Component | Basis | Planned |
|---|---|---|
| reth full (V2 storage) | **1.02 TB measured by reth at block 24,396,823** (`storage.mdx`). Mainnet is now about block 26.2M (**estimate**: 22.7M at 2025-06-23 per `system-requirements.mdx`, + ~7,150/day). Growth since is **not measured**; at the V1 docs' implied ~1 GB/day, **estimate ~1.2–1.3 TB now** | 1.6 TB, including ~1 year of growth |
| extra receipts (140,000 vs 10,064 blocks) | **not measured** (`reth db stats` after sync) | ≤ 100 GB budget (**estimate**) |
| Lighthouse chain + freezer, non-archive | not stated in pinned docs. The 418 GiB in `advanced_database.md` is the **archive** (all historic states) upper bound | 250 GB (**estimate**) |
| data columns, semi-supernode (≈ 1× blob bytes) | **bound** = 21 blobs × 128 KiB × 131,072 slots = **360.8 GB** at max blobs in every slot (`BLOB_SCHEDULE` max 21). 240.5 GB at 14/slot. Supernode = 2× (721.6 GB bound) | 400 GB |
| **Pair total** | | **~2.3 TB** of a 4 TB image; the array had 35.99 TB free at S's 04:46Z inventory, minus the holder's 3.1 TB |

**RAM:**
- **Vendor figures:**
  - reth: "8GB+" full node, "at least 16GB" recommended;
  - Lighthouse: "32 GB RAM" for BN + EL + VC, with "16 GB … rather limited".
- **Example MemoryMax:** EL 16 GiB + CL 12 GiB = **28 GiB**, plus the holder's 32 GiB co-resident = **60 GiB**.
- **Measured available:** root (05:07Z) observed **~24 GiB MemAvailable**, with GPU guests configured at 64,281M + 6,144M
  that must be preserved.
- **So preflight FAILS today by design.** Even the pair alone (28 GiB) exceeds the current MemAvailable.

**IO:**
- reth: "At least 1.2TB (TLC NVMe recommended)" for a full node; static files *may* sit on "SATA SSD/HDD" via
  `--datadir.static-files`.
- Lighthouse: "2 TB solid state drive"; the FAQ allows only the freezer DB on HDD.
- The array is a USB RAID5 (S measured ~20 durable random 4 KiB writes/s at QD1).
- **An L1 full sync from genesis plus tip-following with all MDBX/LevelDB state on this HDD is vendor-unsupported and
  unmeasured.** It is the most likely blocker.
- An NVMe writethrough cache (S's design) accelerates reads only and never holds durable data.

**NVMe cache share:**
- The hard cap is 250,000,000,000 bytes across all caches of this work.
- S's example plan is 199,140,835,328 bytes.
- What remains: **0.86 GB under the 200 GB host share/target.** The 50 GB between target and cap is unassigned (S ledger
  note).
- The pair defaults to **no cache** and then reserves **nothing** in the ledger, so there is no per-package duplicate
  allowance.
- A pair cache requires its OWN ledger reservation (`validate` refuses the holder's id, a non-canonical ledger, a cache
  without a ledger, and a ledger without a cache). The aggregate, share and target are enforced by `budget.py` at
  admit/allocate/verify. A 45 GiB pair cache renders its reservation entry; tested.

**Network:** Lighthouse recommends 100/20 Mb/s and reth 24 Mb/s+; the semi-supernode adds column traffic. This is on S4's
single uplink. **Not measured.**

**Remaining external decisions** (exactly; root and human):
1. **D1, durable L1 state medium.**
   - The human rule is HDD-only for node hosting, and the vendors require SSD/NVMe. Either:
     - (a) accept an HDD trial gated by a bounded follow test (sync rate, head lag ≤ 120 s, iowait); or
     - (b) the human authorizes a non-NVMe SSD (a purchase, not authorized here) or an explicit NVMe exception for
       execution MDBX only, with static files on HDD; or
     - (c) keep the public L1 dependency (declared) until (a) or (b).
   - **No silent lowering:** the package keeps HDD placement enforced and does not pretend the cache solves it.
2. **D2, memory.**
   - 28 GiB for the pair (60 GiB with the holder) against ~24 GiB available today.
   - Decide which non-GPU workload yields memory, or a different host. Lowering MemoryMax below the vendor figures is not
     proposed.
3. **D3, cache share.** Either none (the default), or root reduces the holder's ledger reservation and adds a pair reservation.
4. **D4, anchor.** One state and block pair plus ≥ 2 independent root observations, after which the node exports its own.
5. **D5, Lighthouse binary download.** A 31 MB tarball, digest-checked. Also decide whether to establish the Sigma Prime
   PGP key.

## 7. Trust, bootstrap and blob-availability requirements

- **Cold bootstrap without a permanent provider:**
  - Lighthouse `--checkpoint-state`/`--checkpoint-block` (files) plus `--wss-checkpoint root:epoch`
    (`config.rs:556-651` → `ClientGenesis::WeakSubjSszBytes`).
  - The anchor is a **one-time trust input**, cross-checked by ≥ 2 recorded observations.
  - After the first sync, the pair **exports its own finalized checkpoints** (RUNBOOK §5), so later cold starts need no
    external party.
  - The execution side needs no anchor: it executes every block from genesis via P2P.
  - **A hosted checkpoint URL is only an explicit, acknowledged, one-time option**, never a default or a runtime
    dependency.
- **What a stale offline checkpoint cannot prove:**
  - the current head or finality;
  - the absence of a long-range fork beyond the weak-subjectivity period;
  - blob availability;
  - execution state.
- **How stale is too stale:**
  - Lighthouse backfills only to the weak-subjectivity point ("approximately 5 months");
  - columns are requestable for only 4096 epochs (~18 d);
  - so an older anchor may be **unsyncable**, not just weaker.
  - The launcher's 14-day refusal is an operational bound, not a spec value.
- **Blob availability:**
  - The pair serves blobs only from its own start onward, for ≤ 18 days (with `--prune-blobs true` and margin 0;
    `--blob-prune-margin-epochs` extends that at a storage cost).
  - **Order:** start and sync the pair FIRST. Choose or restore the Base snapshot only when the gate passes with
    `--need-from-block <holder safe-head L1 origin − 3600>` and `--need-blobs-from-slot <its slot>`.
  - A Base snapshot older than the pair's blob coverage needs a blob archive. That is not provided here and is not
    claimed.
- **Transactions (E's interface):**
  - This pair offers **reads only** (receipts, logs, calls), with which E's forced-inclusion flow can *verify*
    OptimismPortal deposits.
  - It has **no sending path**: tx gossip is off and there are no keys.
  - An L1 submission route remains E's design. Enabling broadcast here would be a reviewed config change (removing
    `--disable-tx-gossip`), not a default.

## 8. Final pins, deployment, rollback, gates

**Source:**
- repo `work/rpc-l1-source-package`, branch `main`;
- **commit `1260cdcb202a93b383fb78303a8068d6ac01b309`** holds the final source and tests; the RESULT/evidence commit follows it;
- not pushed.

| File | sha256 |
|---|---|
| `l1pair/l1pair.py` | `3635472db151f3d1dd576e0850f15f00f16d87f2ff00e6d1d9cb96a1df0ae975` |
| `l1pair/PINS.json` | `46deaf02b28a96d2806a71de21b7559cdaa657f3dd718bfd5623ab4b91810d6a` |
| `l1pair/vendor/VENDOR.json` (S `959e56fd` byte-identical: `holder.py` `c73a4351…`, `budget.py` `529e155f…`, `holder-storage.sh.in` `eb6a209d…`) | `a2bcc3aabff16977e29e84ed46b1734028ec58c66dbc8c4523ae1bcf62accefa` |
| `l1pair/l1pair.example.json` (refused until pins are recorded) | `ad3a100b3137217e…` |
| `l1pair/RUNBOOK.md` | `864ff263a487d79d…` |
| tests: `test_l1pair.py` / `test_reth_offline.py` / `test_base_l1_offline.py` / `realrig.py` / `mutate.py` | `e129dce2…` / `60ef25b1…` / `9ef5d9d7…` / `a3c26785…` / `35c60ff6…` |

**Existing client pin evidence:**
- **reth v2.8.0:**
  - the tarball `809bfe0f…` equals the GitHub asset digest (`RELEASES-EXTRACT.json`);
  - the binary is `8cdd1f35…`;
  - the binary's own `--version` says `Reth Version: 2.8.0`, `Commit SHA: 05ba48120a0c…` (= tag `v2.8.0`, `trees-*/reth-v2.8.0-commit.json`);
  - `node --help` was captured offline (`evidence/reth-help-*`).
- **Lighthouse v8.3.2:**
  - tag commit `a376defa…`;
  - asset digest `ea914e93…`, `.asc` `4c4ce326…`;
  - pinned source files: `evidence/sources/SHA256SUMS`;
  - **no binary present.**
- **Base:** S's staged `9c44836d…`, used read-only.

**Deployment** (root; RUNBOOK §0–8, each step root-approved):

| Step | Action |
|---|---|
| 0 | Settle D1–D5 (§6) |
| 1 | Install reth from the existing tarball; download and digest-check Lighthouse; record its sha256 |
| 2 | Service user; JWT secret generated locally (0640 `root:enclave-l1`) |
| 3 | Config: `validate`, `render`, review |
| 4 | Storage: S's script (`create`, `verify-cap`, `assemble`); no cache and no ledger reservation by default |
| 5 | Anchor files with sha256, wss and ≥ 2 provenance observations; `checkpoint-inspect` |
| 6 | `preflight` (refuses today on memory: D2); start EL then CL |
| 7 | `ready` gate with `--need-from-block` / `--need-blobs-from-slot` covering the holder's safe-head L1 origin minus 3600 |
| 8 | Only then, S applies `holder-l1-fragment.json` and follows its own §7 |

**Rollback** (RUNBOOK §9):
1. S reverts the holder's `l1`.
2. Stop CL, then EL, then storage. `disassemble` refuses foreign devices and stops at the first failure.
3. If a cache exists: `cache-loss`.
4. To remove everything: delete the image, `/etc/enclave-l1-pair` (with the JWT secret) and `/opt/enclave-l1-pair`.

No existing service, VM, filesystem, wallet or admin control is touched.

**Gates for root** (all must hold before the holder uses the pair):
- **G1:** D1 decided. If HDD is chosen, a bounded follow test after sync: head lag ≤ 120 s sustained, measured iowait.
- **G2:** D2 decided, and `preflight` passes on CURRENT MemAvailable with the co-resident reservation.
- **G3:** ONE canonical shared ledger, `/etc/enclave-rpc-cache/nvme-cache-budget.json` (S `budget.py` v2, root-reviewed
  at `959e56f`), with fixed reservations ≤ 250e9 and target 200e9. The L1 pair stays at no cache, with no reservation,
  unless the ledger is rebalanced.
- **G4:** Lighthouse binary digest-checked and pinned; `preflight` flag/help check passes.
- **G5:** anchor provenance recorded (≥ 2 distinct sources); after the first start, `checkpoint.mode` is set to `resume`.
- **G6:** `ready` exits 0, including `--need-blobs-from-slot` covering the holder's derivation start.
- **G7:** E's submission route stays separate. This pair never sends.

**Not claimed:**
- no mainnet sync and no deployment;
- no RPC/provider independence demonstrated (the pair would remove the *L1 RPC* dependency only once G1–G6 hold);
- no blob archive beyond 18 days;
- no fresh Base witness supply; that still needs the holder.

## Update 2026-10-23: binary closure (additive; the text above is the reviewed baseline `83805a1`)

See `RESULT-BINARY-CLOSURE.md`. In short:
- **Lighthouse v8.3.2:** downloaded under root authorization, its signature verified against the officially stated
  fingerprint, extracted safely and pinned (`11b7bca8…`).
- **Real tests:** real-Lighthouse refusal, wrong-JWT counter-control and engine pairing with real reth all pass (lh-3).
- **`execution.txBroadcast`:** a new opt-in, default `disabled`, tested on two offline reth peers (txb-4).
  - Both modes ADMIT a pre-signed tx locally; only opt-in propagates.
  - reth refuses wrong-chain-ID and over-fee-cap txs, but ACCEPTS replay-unprotected legacy txs and has no recipient
    allowlist.
- **E handoff:** `HANDOFF-TO-E-L1-TX-BROADCAST.md`.
