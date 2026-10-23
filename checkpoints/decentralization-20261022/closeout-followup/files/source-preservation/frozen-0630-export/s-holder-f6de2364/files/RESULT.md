# fresh-witness-supply: RESULT (2026-10-23 ~04:40Z; corrected ~05:10Z)

> **Corrections (root review, 2026-10-23).** The earlier header said 04:50Z, which was later than the actual time. The
> report actually ended about 04:40Z.
> * **Overclaim (§1/§2):** default-off snap/2 plus inconclusive peer observations do NOT prove that no maintained
>   client or peer offers witnesses. The established facts and the unknowns are stated exactly below.
> * **Sizes (§3):** 761 GB is the COMPRESSED download of the state component, not its disk size. From the pinned reth
>   selection rules applied to Base's own manifest, the `--minimal` profile downloads 820.0 GB and extracts to
>   1,258.0 GB (state alone 1,138.2 GB on disk). The archive total (5.14 TB) is not the minimal size.
> * **Sia restore (§4.5, stale):** a separate bounded whole-restore retry is live. Root reported 15,344,224,415 of
>   21,445,494,044 B restored at 04:36Z. The 12.65 GB OOM was an earlier, separate attempt. Partial bytes are not
>   full-restore proof. I did not inspect it.
> * **NVMe (§6):** superseded by the user's cache allowance (250,000,000,000 B aggregate, cache only).
> * **What supersedes this file:** RESULT-HOLDER.md supersedes §4/§6/§7 with an actual package, sizes, the L1 trace and
>   cache enforcement.

**Scope.** Fresh Base execution-state witnesses when every public RPC refuses.

**What was done.**
- Primary-source audit, plus a configuration template.
- **Not done:** no build, no deployment, no SSH, no wallet, no transaction, no chain sync, no node-hosting allocation,
  no NVMe use. No other worker's jobs were touched.
- **Network use:** three read-only document fetches through the queue (§8). No peer dials: the 32-dial budget is
  unused (§8).
- A/B/P/E were not rewritten. Nothing here is, or is presented as, a public-RPC replacement.

## 1. Answer: how close?

**Unresolved.** In the pinned and the current Base client, the one peer state interface (snap/2 serving) is
implemented but off by default, and it has no CLI flag. The peer observations made so far are inconclusive.
**Whether any operator or peer serves Base state proofs is UNKNOWN.** With the evidence available, the only established
route to a fresh proof against a current Base state root is a process that holds the full current Base state: a Base
execution node (`base rpc` / `base-reth-node`). Its minimal profile downloads 820.0 GB and extracts to 1,258.0 GB
(§3 and RESULT-HOLDER.md).

Existing work already gives three pieces:
- an independent fresh signed head over P2P (the head listener, live-verified, 52 heads in 120 s);
- local verification of any proof against that head (A/B, P);
- immutable caching of the witnesses that were used (P/E).

The missing piece is a **state holder that Enclave runs**. §4 gives its minimal architecture. It is not provisioned,
and its throughput on the permitted storage is **unmeasured**. §6 lists the exact prerequisites. Running a holder moves
part of the dependency onto **L1 endpoints** (§5); it does not remove it.

## 2. Interface audit: peer-served state, witnesses, stateless sync, retained state

**Sources.**
- Pinned: base/base v1.5.1 `5476069f`, base/reth `7134be3b`.
- **Current main, fetched 04:33Z today:**
  - base/base `569dd0f1` (committed 04:02Z); its Cargo.lock pins base/reth tag `base-v2.7.0.2` = `bbea4dcd`;
  - paradigmxyz/reth `011896b9`.
- The latest Base release is still v1.5.1.

| Interface | In code | Default on Base | Flag | Live on Base | Evidence |
|---|---|---|---|---|---|
| **snap/2** (EIP-8189: account/storage ranges with boundary proofs, bytecodes, BALs) | implemented (server) in base/reth `7134be3b` and `bbea4dcd` | **off** | **none** in base/reth args. base/base never calls `with_snap` (pinned), and current `node.rs` has no snap | not observed (the bootnode Hello probe got TCP refusals, so it is inconclusive) | `bbea4dcd net/network/src/config.rs:239,283,564` "Default off"; `args/network.rs` has 0 snap matches |
| snap/2 in upstream reth | implemented | off | `--snap.v2`, documented "experimental" | n/a (a different chain spec; does not follow Base forks) | reth `011896b9 args/network.rs:244-247` |
| snap retention | 128 blocks (256 s now, **25.6 s after Denim**) | | | | `7134be3b blockchain_provider.rs:57` (prior audit) |
| snap/1, eth `GetNodeData` | snap/1 absent; GetNodeData returns empty | | | | prior audit §2 |
| **ress** (reth stateless witness subprotocol) | **absent**: no `crates/ress` and no Ress protocol anywhere in base/reth or base/base | | | | grep over both trees |
| **Block access lists** (EIP-7928; would let a light tracker keep selected slots fresh from authenticated per-block diffs) | engine envelopes carry an optional BAL | **not on Base**: every Base header is built with `block_access_list_hash: None`, and Amsterdam is `ForkCondition::Never` | | | base `execution/evm/src/build.rs:116`, `proof/executor/src/builder/assemble.rs:114`, `common/chains/src/chain.rs:106` |
| CL req/resp (payload by number) | not advertised | | | | prior audit §3 |
| `base-consensus` follow mode | implemented | | `--source-l2-rpc` | it follows a **source L2 RPC**, which is hosted, so it is not RPC-free | `consensus/cli/src/follow.rs` |
| Historical-proofs ExEx (`--proofs-history`: `eth_getProof`/`debug_executionWitness` at past blocks) | implemented | off | yes | an add-on **to a full node**, +872 GB in Base's snapshot | docs `run-a-node.md` "Enable Historical Proofs RPCs"; snapshot API |
| Flashblocks | implemented | | `--websocket-url` | a hosted WebSocket stream of preconfirmations. It carries no proofs, and Base's docs say apps should not connect to it directly | docs `run-a-node.md:173-177` |
| op-geth / op-reth peers | n/a | | | cannot follow Base after its Base-only forks (0x79 and others) | prior audit §2 |
| Portal network | Ethereum L1 only | | | no Base evidence | prior audit |

**Verdict.**
- **No usable maintained peer proof interface was found in the default clients.** Non-default operators are UNKNOWN.
- **The closest one is snap/2.** It is implemented but default-off with no flag on Base. Even if some operator enabled
  it, it serves only roots within 128 blocks, and a client would need a Base-correct eth Status/fork-id plus reth
  networking.
- **No proof-validation prototype was built.** The task made one conditional on a viable interface. I am not claiming
  that no Base peer anywhere serves snap; that remains **UNKNOWN**.

## 3. Facts that size an execution-state holder (measured or primary; inferences marked)

| Fact | Value | Source |
|---|---|---|
| Base state component | **761.0 GB compressed download; 1,138.2 GB extracted** (minimal profile: 820.0 GB download, 1,258.0 GB extracted; see RESULT-HOLDER.md §3) at block 52962126 (2026-10-23), reth `2.5.2-dev (7134be3)` | `https://chain.base.org/api/snapshots` (evidence `snapshots-20261023T043501Z/api-1.json`, sha256 `99634c0c…`) |
| Archive snapshot total | 5,141.4 GB | same |
| Other components (archive / `full` profile) | transactions 1278.1 / 51.1 GB; receipts 680.7 / 28.4; storage changesets 745.3 / 30.0; account changesets 139.6 / 4.1; headers 20.4 / 0.6; senders 46.2 / 1.3; rocksdb indices 597.6 (no smaller size listed); ExEx proofs 872.5 (not needed) | same |
| Snapshot profiles | `minimal` = latest state + headers + minimum history. `full` = keeps 10,064 blocks (about 5–6 h on Base). Custom pruning requires downloading the archive snapshot | docs `snapshots.md:46-52,150` |
| Vendor hardware guidance | 8+ cores, **32 GB RAM minimum (64 recommended), locally attached NVMe SSD**. Capacity = 2 × chain size + snapshot + 20 % | docs `performance-tuning.md:14-28` |
| Real Base load | **52 sequencer-signed blocks, median 162 txs/block (126–259), about 87 tx/s** | the existing head-listener run `live-20261023T013719Z/heads.jsonl` (sha256 `26292cec…`, signer-verified) |
| Permitted storage (/mnt/usb, USB RAID5, QD1) | 20 durable random 4 KiB writes/s. Reads (3,872/s) were cache-assisted on a 256 MiB file | `outputs/decentralization-audit/rpc-array-probe-20261023.json` |
| `eth_getProof` window | default 0 (latest only); maximum 28 days of 2 s blocks | base/reth `rpc-server-types/src/constants.rs:62,69` |

**HDD-only feasibility.**
- **Status:** unsupported by the vendor and unbenchmarked at state scale. It is not a measured impossibility.
- **Inference, not measured:**
  - 761 GB of state is far beyond the RAM available on any authorized machine, so cold state reads land on the device;
  - at about 87 tx/s, the per-block random I/O of a B-tree state database is very likely beyond a QD1 USB RAID5 that
    sustains 20 durable random writes/s.
- **Why no bounded test can settle it:** the decisive measurement needs a restored state of ≥ 0.8 TB on the device
  (§6). A benchmark against an empty or small database would not show it.

## 4. Minimal Enclave-hostable architecture (only where evidence supports it)

```
 Base P2P gossip ──► enclave-base-head-listener ──► signed head (number, hash, stateRoot, timestamp)
                                                       │  independent of the holder
 Base devp2p (blocks) ─┐                               ▼
 L1 exec + beacon ─────┼─► base-reth-node + base-consensus ──► eth_getProof @ signed head ──► Enclave verifier (A/B, P)
 (declared dependency) ┘     (state holder, untrusted)             loopback / Enclave-internal     │ fail-closed on
                                                                                                   │ mismatch or staleness
                                       Sia-S3 (optional, immutable): consumed witnesses + signed envelopes (P/E);
                                       optional state snapshot for cold restore — never on the start path
```

**1. State holder.**
- **What it runs:** stock `base-reth-node` (base/base, unmodified) with the `minimal` snapshot profile: state, headers,
  minimum history. The historical-proofs ExEx stays off.
- **RPC exposure:** loopback or Enclave-internal only, API `eth,net,web3`, with `--rpc.eth-proof-window` a few blocks
  wide (template: `config/state-holder.env.example`).
- **What it must keep:** the full current state trie (761 GB and growing) and execution of every block (about 87 tx/s
  today). Base's Denim fork (2026-11-05) moves to 200 ms blocks.
- **What it does not need:** transaction or receipt history beyond the minimum, and no archive.

**2. Trust.**
- The holder is **untrusted for correctness**. Every value is checked against the sequencer-signed `stateRoot` that the
  head listener obtained on its own, over P2P.
- A lagging, forking or lying holder can only **withhold**. The verifier then fails closed, under the same freshness
  rule as A/B: verified block timestamp and monotonic block.

**3. Freshness.** Proofs are requested at the signed head's number. A holder behind the head, or one returning a
different block hash, is refused.

**4. Cold-bootstrap cycle avoidance.** The holder runs as a **host-level service** (a systemd unit), not as a
lease-paid Enclave app.
- **Why not an app:** metal app partitions lack a persistent writable volume, and the lease→RPC→lease loop would be
  circular.
- **Its start path needs only:** local disk, Base P2P and the L1 endpoints. It needs no Sia, no lease and no Enclave
  RPC.
- **Sia-S3 depends on leases, which depend on RPC.** It is therefore used only for optional writes, never as a start or
  read prerequisite.

**5. Sia's role (immutable backup only).**
- **What it stores:** the consumed witnesses and signed head envelopes (already designed in P/E), and optionally a
  periodic state snapshot so that cold restore need not use Base's snapshot server.
- **Snapshot restore is not proven.** It is TB-scale, and its restore time is **unmeasured** for that size. A separate
  21.4 GB bounded retry is live; I did not inspect it, and its partial bytes are not a full-restore proof.
- **What a Sia object proves:** availability of what it stores, never freshness or canonicality.

**6. Availability.**
- One holder is a single point of withholding.
- The authorized hardware is one site, so a second holder would not add site independence.

## 5. Dependencies that remain or move

| Dependency | Status |
|---|---|
| **L1 execution RPC + L1 beacon (blob sidecars)** | **Required.** `base-consensus` takes `l1_eth_rpc` and `l1_beacon` as required arguments (`consensus/cli/src/l1.rs:17-40`), and Base's docs require "your own L1 RPC" (`run-a-node.md:69-84`). This **moves part of the dependency to L1 providers**. The L1 provider market is larger, and L1 data can be checked against beacon light-client headers (nimbus LC, prior audit P3); `BASE_NODE_L1_TRUST_RPC=false` is the shipped default. Self-hosting L1 means another TB-class node, with the same storage issue. **UNVERIFIED:** whether the validator keeps applying gossiped unsafe blocks during an L1 outage. The only `L1OriginUnavailable` reset found is on the sequencer path (`actors/sequencer/build.rs:148`). |
| Base P2P (EL block sync, CL gossip) | Required. Default-served headers, bodies and receipts; the head listener is live-verified. |
| Initial state | Base's hosted snapshot server (`chain.base.org` / `mainnet-v2-snapshots.base.org`), **one time**. After the restore, verify the restored state root against an independent root (§7, step 3). A Sia copy can replace this server for later restores (§4.5). Sync from genesis over P2P is untested. |
| Transaction submission | Hosted sequencer (`RETH_SEQUENCER_HTTP`; Base is the sole orderer), or an L1 `OptimismPortal` deposit. P2P tx gossip is dropped by base-reth (`node.rs:1287 tx_gossip_disabled = true`, still on current main). Broadcast ≠ inclusion. |
| Signer rotation, settled root | Unchanged (pinned signer; L1 AnchorStateRegistry path, prior audit). Admin controls are unchanged. |

## 6. Exact prerequisites (evidence-based; none authorized by this work)

1. **Storage device for about 0.8–1.4 TB+ of state, with growth** (minimal profile; whether the 598 GB rocksdb indices
   are needed is UNKNOWN). Durable state must not move onto NVMe. Since the user's allowance, an NVMe CACHE of at most
   250,000,000,000 B aggregate is permitted (RESULT-HOLDER.md §5).
   - The only permitted device measured so far is the USB RAID5 array (§3), and its suitability is the open risk.
   - If HDD fails, the evidence-backed alternative is dedicated non-NVMe SSD-class storage. That is a **purchase /
     human decision**, not authorized here.
2. **Host:** 8+ cores and **≥ 32 GB RAM to spare**.
   - The workstation reported about 25 GB MemAvailable during this session.
   - The storage VM has 3.9 GB, so it is unsuitable.
   - The minipc's capacity was not read.
3. **Authorization for a one-time multi-TB download** (Base `minimal` snapshot) and for a node-hosting allocation on
   the chosen device. Both are currently forbidden without review.
4. **An L1 endpoint decision** (§5): named L1 execution and beacon providers, or a self-hosted L1 node (a separate
   prerequisite).
5. **The decisive measurement**, after items 1–3: restore the snapshot, let the node follow head for a bounded period,
   and record head lag, I/O wait and proof latency (§7). Until that measurement exists, there is **no throughput claim**.

## 7. Validation recipe (root-run, only after §6 is authorized)

1. **Restore:** `base-reth-node download --minimal --chain base --datadir <device>`. Record the manifest block and the
   component sizes.
2. **Start** the node under its own systemd unit, with the template settings: loopback RPC, a locally generated JWT,
   the L1 endpoints and the proof window.
3. **Restored-state check:** at the snapshot block N, the restored `stateRoot` must equal an independent root:
   - the sequencer-signed envelope for N, if the listener captured it;
   - otherwise a later L1 `AnchorStateRegistry` anchor root (OutputRootV0 commits to `stateRoot`).
   On a mismatch, discard the data.
4. **Follow test (bounded, e.g. 30 min):** run the head listener and the holder together. Pass criteria:
   - for each signed head, the holder's `eth_getBlockByNumber` hash equals the listener's;
   - lag is ≤ the verifier's freshness bound (60 s);
   - `eth_getProof` for AddressBook `addr["registry"]` verifies in A/B against the listener's `stateRoot`.
   Record the lag distribution, `iostat` await and proof latency. **This is the HDD verdict.**
5. **Withholding test:** stop the holder (`SIGSTOP`). The verifier must refuse, not serve stale data. Resume it, and
   it must recover.
6. **No public RPC anywhere:** the witness-gateway upstream list contains only the holder. The test asserts that public
   Base RPC hosts are unreachable for the verifier process (the `unshare`/egress allowlist pattern from P).

## 8. What actually ran here (terminal results)

Every run went through `work/claude-test-queue.py`, in the 256 MiB lane, as separate allocations:

| Job | Result |
|---|---|
| `jobs/fetch-upstream.sh` (`logs/fetch-1`) | exit 0, peak 22 MiB. 11 requests, all HTTP 200: base/base main and releases, Cargo.lock, `node.rs`, base/reth `bbea4dcd` network config and args, reth main network config and args, docs `llms.txt`. Hashes in `evidence/upstream-20261023T043317Z/SHA256SUMS`. |
| `jobs/fetch-docs.sh` (`logs/fetch-2`) | exit 0. Docs `performance-tuning`, `snapshots` and `run-a-node` (.md), all 200. `evidence/docs-20261023T043421Z/SHA256SUMS`. |
| `jobs/fetch-snapshots.sh` (`logs/fetch-3`) | exit 0. `chain.base.org/api/snapshots` returned 200 (5,312 B); `mainnet-v2-snapshots.base.org/api/snapshots` returned 404. `evidence/snapshots-20261023T043501Z/SHA256SUMS`. |
| Offline greps | Read the vendored pinned trees (`/tmp/rpa-src/base-full` = base/base `5476069f`, `basereth-full` = base/reth `7134be3b`) and the existing head-listener run. |
| Peer discovery / dials | **Not used (0 of 32 dials).** No existing tool can enumerate Base **execution-layer** peers: the head listener's maintained `Discv5Driver` forwards only `opstack` CL ENRs, and the Go Hello probe dials a fixed allowlist whose 10 bootnodes refused TCP. A Hello that advertised snap would still not prove Base-chain proof serving. A probe would therefore not have clarified availability. |
| Builds / tests | None. There was no viable peer interface to prototype (§2), and the holder needs no new code. |

**Files** (`work/fresh-witness-supply/`):
- `RESULT.md`
- `config/state-holder.env.example`: a template. Its inputs are for an Enclave launcher that is not written yet.
  Upstream's entrypoint binds 0.0.0.0, uses CORS `*` and ships a sample JWT, so it must not be used as-is.
- `jobs/*.sh`, `logs/`, `evidence/` (all fetched bytes, with SHA256SUMS).

## 9. Next root action

1. **Decide whether a Base execution-state holder is acceptable** under the user's constraints. That is the only path
   with current clients. The decisions are §6 items 1–4: the device (no NVMe), RAM, a multi-TB download, and the L1
   endpoints.
2. **If yes:** authorize the §7 measurement on the chosen device. Its result is the throughput and HDD verdict. Only
   after it is green, write the small launcher that consumes the template and wire the witness gateway to the holder
   as its sole upstream.
3. **If no:** fresh witnesses stay dependent on third-party RPC availability. Verification already removes trust in
   that data. The user should be told plainly that this gap remains open.
