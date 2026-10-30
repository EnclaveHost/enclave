# Node payload review: chain_service.py, stage_node_units.py, stage_backend.py, provision_vm.py, node-payload/

Scope: static read only. No live operations, builds, or private files. Compared against the reviewed
`work/rpc-hdd-client-recovery-20261023/p/l1pair/l1pair.py` (+ RUNBOOK.md) and `s/holder/holder.py`.
`node-payload/chain_service.py` is byte-identical to `chain_service.py`.

Times used below: L1 reth snapshot 1792861874 = 2026-10-24T17:11Z. Base snapshot 1792886410 = 2026-10-25T00:00Z.
CL anchor slot 15508320 (epoch 484635) = 1792923863 = 2026-10-25T10:24Z.

## CRITICAL

### C1. The Base snapshot is older than the L1 blob coverage, so Base derivation can never advance safe/finalized
- `stage_backend.py:236` pins Base snapshot `1792886410` (00:00Z). `node-payload/chain.json` anchors the CL at
  10:24Z, which is about 10.4 h later.
- The reviewed l1pair RUNBOOK (lines 185-189, and `LABELS['blobs']` in l1pair.py:472) says a semi-supernode serves
  `/eth/v1/beacon/blobs` only for blocks it received itself, which here means the anchor and later. Backfill does
  not supply columns. So the order must be: start the pair first, then pick a Base snapshot whose
  `safe-head L1 origin − 3600` falls inside that coverage.
- Here every batch blob posted from about 2026-10-24T12:00Z (origin − 3600) to 10:24Z is unavailable locally.
  `base rpc` would only follow unsafe gossip. `latest` would look healthy while `safe`/`finalized` stay frozen at
  the snapshot.
- `chain_service.py:47-59` `l1_ready()` does not check blobs or custody, so nothing catches this.
- **Fix:**
  - Keep the current L1 pair and anchor, and start the CL as soon as the EL is up.
  - Stop the current Base download now. It competes for the same QD1 USB HDD as the L1 download.
  - Re-pin `MANIFESTS['base']` to a Base snapshot taken at least 12 h plus margin after 10:24Z, so the first
    candidate is at or after about 2026-10-26T00:00Z. Before accepting it, check that its safe-head origin − 3600
    is at or after slot 15508320 (the margin is only about 1.6 h, so verify, don't assume).
  - Also port the reviewed `ready --need-from-block/--need-blobs-from-slot` checks into `l1_ready()`. That means
    `/eth/v1/node/identity` custody_group_count ≥ 64, plus `/eth/v1/beacon/blobs/{slot}` returning all
    commitments for the holder's safe-head origin − 3600, plus `eth_getBlockReceipts` at that block.
  - Re-check base readiness by safe-head lag, not just process start.

### C2. CL resume detection uses a path Lighthouse never creates, so every restart is gated on anchor age
- `chain_service.py:86` checks `cl/beacon/hot_db`. Lighthouse's hot DB is `beacon/chain_db` (with `freezer_db`
  and `blobs_db` beside it). That check is always false, so every CL start re-runs lines 87-94.
- Line 88 then asserts `stateTime` < 14 days. After **2026-11-08T10:24Z**, any CL restart (OOM, crash, guest or
  host reboot, VM unit restart) fails permanently. It retries every 60 s forever (`StartLimitIntervalSec=0`).
  `l1_ready()` then fails, and Base goes down with it.
- Every restart also re-hashes the 339 MB state file and requires the anchor files to stay on disk forever.
- Lighthouse itself ignores checkpoint flags when a DB exists ("Refusing to checkpoint sync … database already
  exists"). The age/hash gate is the wrapper's own.
- **Fix:** test `Path(datadir,'beacon','chain_db').is_dir()`. Better, match l1pair's explicit `resume` mode: have
  root write a marker after the first successful `l1-ready`, and only enforce age/hash and pass the anchor flags
  when the marker is absent. Add a negative test where chain_db exists and stateTime is 15 days old, and expect a
  start.

## HIGH

### H1. The `.path` units restart services that were stopped by hand, so stop/rollback does not hold
- `stage_node_units.py:54-64` creates `PathExists=` units. While `snapshot-complete` exists, systemd re-triggers
  the service whenever it goes inactive. So `systemctl stop enclave-base-holder.service` (or `enclave-l1-el`)
  starts it again right away.
- **Fix:** document and script the stop order: stop `X.path` first, then `X.service`. Alternatively, drop the
  `.path` units and enable the service with `ConditionPathExists={mount}/snapshot-complete`. Same for rollback in
  the provision_vm docstring (lines 22-24).

### H2. All chain clients run as one user with RW over the shared L1 mount, and the readiness marker is user-writable
- `stage_node_units.py:30-31,45` runs el, cl and base all as `rpcnode`.
- CL `ReadWritePaths=/srv/enclave-l1-pair` gives the network-facing Lighthouse write access to reth's DB
  (`/data`), to `anchor/`, and to `snapshot-complete`.
- `stage_backend.py:322` `chown rpcnode:rpcnode {mount}` makes the ext4 root user-owned. `stage_backend.py:293`
  writes the marker as rpcnode.
- Because the processes share a uid, any one can signal the others.
- **Fix:**
  - Mount roots: `root:root 0755`.
  - Users: `rpcl1el`, `rpcl1cl`, `rpcbase`. Give both L1 users a shared group for the JWT only.
  - Per-side RW: EL gets `ReadWritePaths=/srv/enclave-l1-pair/data /srv/enclave-l1-pair/tmp-el`. CL gets
    `…/cl …/tmp-cl`. `anchor/` stays root-owned 0755 with 0644 files.
  - Marker: write it as root with `ExecStartPost=+/usr/bin/touch …`.
  - This matches the reviewed network layout, which uses `rw = data + tmp` only (l1pair.py:367).

### H3. The snapshot-complete marker is not durable relative to the snapshot data
- `stage_backend.py:293` touches the marker without syncing. The `.path` unit starts the client immediately.
  After a power loss or QEMU kill in the next ~30 s, the marker inode can be committed while delalloc data of the
  last downloaded segments is not. The client would then start on short or zeroed static files. The stack is
  ext4 → qcow2 → ntfs3 → USB with no FUA.
- **Fix:** run `ExecStartPost=/usr/bin/sync -f {mount}/data`, then the root `touch`, then
  `sync -f {mount}/snapshot-complete`. Note: these ExecStartPost changes only reach a unit that hasn't completed
  yet. If a download has already finished, its marker was written the old way: either run `sync -f` on the data
  dir before any client starts, or make sure no unclean stop happened between the marker and the next sync.

## MEDIUM

### M1. Memory caps do not fit the guest, and the host side has thin headroom
- Guest: MemoryMax 16 + 12 + 32 = 60 GiB of 64 GiB (`stage_node_units.py:19`). There is no `MemoryHigh` and no
  reserve for the kernel, slab and dentries of 7 TB of ext4. Both snapshot downloaders have 4G each
  (`stage_backend.py:297`), and the l1 downloader can overlap with base.
- Under pressure, the guest-global OOM killer, not the cgroups, picks the victim (likely base or reth).
- **Fix (guest):** keep the sum of MemoryMax ≤ 56 GiB (for example base 28, el 16, cl 12). Add
  `MemoryHigh=` about 90% of each Max. Add `OOMScoreAdjust` so CL survives over Base.
- Host: `provision_vm.py:60` MemoryMax = 64 GiB prealloc + 2 GiB. With `cache.direct=False`
  (`provision_vm.py:269`), host page cache and dirty pages for 7 TB qcow2 I/O are charged to that cgroup. With a
  QD1 USB disk, dirty writeback under 2 GiB headroom can stall I/O or memcg-OOM QEMU, which is an unclean guest
  power-off.
- **Fix (host):** either `cache.direct=true` (test O_DIRECT on ntfs3 first), or raise headroom to ≥ 6 GiB and add
  `MemoryHigh`.

### M2. The qcow2 L2 cache is far too small for multi-TB random-read databases
- The images use 64 KiB clusters with QEMU's default L2 cache (≤ 32 MiB, covering about 256 GiB). Random reads
  by mdbx over 4 TB and 3.1 TB images cause extra HDD seeks on every miss.
- The images already exist, so the cluster size can't change.
- **Fix:** in `blockdev()` (`provision_vm.py:267-271`) add `"l2-cache-size"`: about 512 MiB for l1 and about
  400 MiB for base. Budget that into M1's host headroom. The argv sha is in the manifest, so this needs a new
  manifest and unit render (it's a reviewed change, not a hot edit).

### M3. No ordering between the chain units, and the Base gate fails through restart loops
- CL has no `After=enclave-l1-el.service`. The reviewed l1pair uses `After=… enclave-l1-el.service` (l1pair.py:363).
- Base has no ordering on L1. At shutdown all three stop in parallel. At boot, Base fails `l1_ready()` every 60 s
  for the whole L1 sync, which can take hours to days, and re-hashes its binary each time.
- **Fix:**
  - CL: `After=enclave-l1-el.service`, with no `Wants=`, because Wants would start the EL before its marker exists.
  - Base: `After=enclave-l1-el.service enclave-l1-cl.service`.
  - Move `l1_ready()` into a separate `ExecStartPre=` that polls with a bounded loop, or use `RestartSec=300`.

### M4. Prune profile is assumed, not verified
- `chain_service.py:70-71` and the base branch rely on the `reth.toml` written by `download`. If it is missing or
  default, the node starts with archive prune config over a pruned DB.
- The reviewed holder preflight requires this (`holder.py:715-726`: `reth.toml` present, sender_recovery=full,
  and transaction_lookup=full for minimal).
- **Fix:** before exec, assert `{datadir}/reth.toml` exists. For base, require
  `[prune.segments] sender_recovery="full"` and `transaction_lookup="full"`. For L1, require the receipts,
  account and storage history distances to be ≥ 140000.
- Also confirm that `base snapshot download --chain base` (`stage_backend.py:273`) produces the same chain spec as
  `base --chain mainnet rpc` (`chain_service.py:98`). The reviewed holder only uses `--chain mainnet`.

### M5. Snapshot downloader never retries
- `stage_backend.py:286` is `Type=oneshot` with no `Restart=`. A network drop hours into a multi-TB download
  leaves the unit failed until someone notices or the guest reboots.
- **Fix:** `Restart=on-failure`, `RestartSec=300`, `StartLimitIntervalSec=0`. Downloads are already
  `--resumable=true`.

## LOW

- **L1. Payload drift.** `node-payload/install.sh:16` writes `token_hex(32)+'\n'`, but the generator
  (`stage_node_units.py:80`) writes no newline. The generated payload does not come from the current source.
  Regenerate into a fresh dir, diff, and review the regenerated bytes. Pick one form and match the reviewed
  `check_jwt` (32 bytes of hex).
- **L2. Non-atomic install.** `node-payload/install.sh` is not atomic. A failure after line 8 leaves
  `chain.json` in place, so a re-run stops at line 4. Make the steps idempotent or document cleanup.
  `jwt.hex` is created with O_EXCL, which is good.
- **L3. Unneeded host forwards.** The host forwards `l1-el` and `l1-cl` (`provision_vm.py:77-78`) expose reth
  `eth_sendRawTransaction` (pool admit only) and Lighthouse POST and `/lighthouse/*` endpoints to every host-local
  user. Leave them out until a named consumer needs them. The only data consumer is `base-rpc`.
- **L4. Partial readiness gate.** `l1_ready()` (`chain_service.py:47`) has no EL genesis-hash check, no CL
  GVR/spec/version check, and no custody check. The reviewed `ready()` has all of them (l1pair.py:735-778).
  Port them along with C1.

## Verified OK
- No public execution RPC dependency. Base uses `--l1-eth-rpc` and `--l1-beacon` on 127.0.0.1 only. There is no
  `--rpc.forwarding-endpoint`. The env is whole and clean (no `OP_RETH_SEQUENCER_HTTP`), and
  `BASE_NODE_L1_TRUST_RPC=false` is set. The base argv matches the reviewed `holder.py:350-364` flag for flag.
- The chain units carry `IPAddressDeny=10.0.2.2/32`. All RPC binds are loopback in the guest, and SSH allows no
  TCP forwarding.
- Disk script: serial and size are pinned, the head and tail of each disk must be blank before mkfs, there is no
  `nofail` and no `-F`, mount points are `chattr +i`, and the fstab entry is `noauto` but pulled in by
  `RequiresMountsFor`.
- The checkpoint has ≥ 2 independent observations, files are sha-pinned, and the anchor is on an epoch boundary
  (15508320 = 484635·32). `stateTime` = genesis + 12·slot is correct.
