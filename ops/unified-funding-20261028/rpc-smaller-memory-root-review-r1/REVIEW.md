# Smaller-memory owned RPC: source and captured-evidence review

**Significant reduction is plausible, but no smaller combined Base+L1 size is qualified.** The64GiB figure is preallocated VM memory, not a measured client minimum. Removing unused allocation, controlling concurrency and placing Base's active database on suitable storage are candidates for measurement. Dropping a cgroup limit alone does not establish a working node.

This is PREPARE ONLY. No image mount, database read, remote request, author, test, build or runtime change occurred. P below is /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025. The source/pin inventory is separate from current runtime assurance. The Base/Reth vendor RAM guidance supplied by root is not independently revalidated here.

## Exact captured configuration

Root's captured status at2026-10-30T05:24:55Z has VM and guard inactive/Main0, old manifest SHAa28432151c9a24bd207d9adaab401ca4e24a9cdc39807489f12c3000b0936441,64GiB guest,66GiB host MemoryMax,16GiB host reserve and8vCPUs. The pinned launcher uses prealloc=on and requires MemAvailable >=82GiB before starting, before separately accounting for other pending commitments. The captured available memory was34,756,760kB, about33.15GiB; neither64GiB nor32GiB guest plus2GiB overhead plus16GiB floor fits that snapshot. It is not current admission evidence.

The October28 offline OS inventory's three installed unit-fragment hashes exactly match P/node-payload-v4/units:

| Role | Source command and limits | Configured High / Max |
|---|---|---|
| L1 execution | chain_service.py el -> pinned reth node; local18645, engine18651; RPC max-connections64 |14 /16GiB|
| L1 consensus | chain_service.py cl -> pinned Lighthouse beacon_node; local15052, target-peers100, semi-supernode, blob pruning settings |9 /10GiB|
| Base execution and derivation | chain_service.py base -> integrated pinned base rpc; local18545/19545, local L1 EL+beacon dependencies, RPC max-connections64, eth-proof-window1800 |25 /28GiB|

All three set MemorySwapMax=0, Restart=on-failure with300s delay, TasksMax4096 and LimitNOFILE65536. The54GiB sum is **ceilings**, not measured consumption. The source is integrated Base, not a separately configured op-node in this payload. Lighthouse readiness explicitly expects8.3.2; historical audit/logs identify Reth2.8.0 and Base1.5.1 built on base-v2.5.2.8. Current binary/config bytes must still be verified before a run; the current task did not read the image. Unit fragment identity alone is not full installed wrapper/defaults identity.

No explicit database-cache size flags or thread-budget flags appear in this wrapper. QEMU uses cache.direct=false and no-flush=false; host page cache, guest page cache and process anonymous memory need separate accounting. nvme.cacheBytes=0 in the manifest is not proof that client/OS caches are zero. mmap address space or virtual-size totals are not a memory requirement. Lower memory.high/max can create reclaim/throttling/OOM instead of useful savings.

Preserve the wrapper's actual readiness boundaries: local L1 execution and consensus genesis/spec pairing, current non-optimistic sync, safe/finalized freshness, execution payload/header equality, custody_group_count>=64 and actual blob serving. Keep --semi-supernode and BASE_NODE_L1_TRUST_RPC=false. Reducing custody/blob reconstruction or bypassing authenticated ownership/secret-release source checks is not a memory optimization.

The captured snapshot downloader override raises concurrency from8 to16. This affects download/decompression workload and is unrelated to the64 RPC connection limit. A completed restored database should not have a downloader running alongside qualification.

## What memory was actually measured

P's older output sync-0413/guest.out reports L1 EL+CL active, Base downloader activating, **Base holder inactive**. Guest memory then:64,302MiB total,12,652 used,48,755 cache,51,649 available, no swap. sync-post-trim-0501/l1-health.json separately records non-syncing/non-optimistic L1 consensus and safe/finalized headers. These are historical L1/downloader observations, not Base RPC/proof/catch-up measurements and not current readiness. They do not prove a16GiB combined node or even sustained L1 recovery under that cap.

Missing measures: per-role anonymous/file memory and peak under restart/catch-up; guest and host cache/reclaim/PSI/OOM events; Base execution/derivation steady state and catch-up; proof/log/receipt concurrency and latency; disk IOPS/latency and sync-rate interaction; actual client default cache/thread settings; queue/concurrent workload commitments; current L1 origin blob/history coverage and Base safe/finalized progress. A free-memory snapshot cannot replace them.

## Storage and startup blockers precede a memory trial

OS and L1 are on NVMe at /vm/enclave-volumes/rpc-production/{os,l1-origin}.qcow2. Base is on the rotational USB array at /mnt/usb/enclave-rpc-production/base-origin.qcow2. The restore receipt attests1,138,166,333,440 database bytes retained on USB; it is not a live DB/readiness proof. It supersedes the older audit's statement that Base data was deleted. OS/L1 USB copies are not the authoritative files.

The rebind stage records changed USB filesystem/device and Base inode929, but current captured installed manifest still names old inode3221. Staged manifestd73dcb68… is explicitly NOT installed. Reducing memory does not solve this identity mismatch. Moving active Base DB to NVMe might make lower-cache operation practical, but needs the storage owner's verified capacity/copy/identity plan; this review performs no copy or benchmark and promises no speedup.

Captured OS boot inventory has both snapshot services enabled/unmasked, Lighthouse enabled, L1 execution path-trigger linked/unmasked and forwarding sockets enabled. Base holder and retention are not boot-linked but also not masked; not-linked does not mean impossible to trigger. Inventory explicitly excludes runtime generators/kernel-cmdline masks/non-Enclave pulls. bootSnapshotSafe=false.

The existing maintenance attempt used an8GiB guest/10GiB cap with data disks detached. It failed BlockingIOError(Errno11), with success=false, empty console, final owned unit gone/PID gone. This is **not** evidence that masking succeeded or that a smaller node worked. Prior QMP backlog/failed-connection hypotheses remain unproven. Do not rerun that unchanged attempt or normally boot the image assuming autostarts were disabled.

## Changes worth qualifying, in order

1. Establish controlled startup after fixing the specific maintenance failure and verifying target masks/paths. Avoid concurrent snapshot/retention/download work. Preserve resident apps and all restored state.
2. Measure L1 and Base separately. If co-location cannot fit, placing L1 EL+CL on another owned qualified host can reduce this machine's budget; it does not eliminate L1 memory or permit public fallback. Preserve authenticated transport, chain/readiness checks and historical data access.
3. Review actual pinned client cache/thread controls and bounded request concurrency. Start from measured cache and anonymous peaks; do not invent supported flags or lower peer/blob settings blindly. No per-client cache saving is quantified yet.
4. Compare an admitted smaller guest against that measured workload. Lazy allocation may reduce initially resident unused guest RAM, but demand can grow to its full size; it cannot justify overcommit or a lower floor. Retain a hard envelope and host guard. The old48/32GiB staging helper is only configuration tooling, not performance qualification; its16GiB mode is download-only with L1 disabled.

## Smallest bounded qualification plan — not launched

First finish source/identity and mask repair review with **no DB attached**; the old failed maintenance artifact is a diagnostic input, not a retry command. Root must separately authorize any new OS-maintenance mutation. Preserve its backup and prove boot consumers cannot start unexpectedly.

For a later client trial, admit one exact role/config/data identity and one bounded window at a time. Choose the initial envelope from measured peaks plus reviewed overhead; this evidence cannot select a safe combined16/24/32GiB value. Require host available memory >= trial's full hard envelope +16GiB reserve + outstanding commitments and any stricter existing guest/test floor. No app eviction, swap, unguarded lazy-allocation oversubscription or cap reduction to force admission.

Use a proposed30-minute maximum per initial phase, samples every10s, no automatic retries. Separate L1 recovery/steady state, Base recovery/derivation, then actual read-only application traffic and eth_getProof at the required1800-block window; begin concurrency1, then a separately admitted bounded increase only if measured headroom permits. Record host/VM/per-role memory.current/peak/stat/events, RSS/PSS split, PSI, IO latency, sync/head/safe/finalized drift and request outcomes. Abort gracefully before the floor margin is exhausted, on OOM, stalled progress or sustained unacceptable pressure/latency. Retain failed evidence, never count timeout as completion. Do not forcibly kill a writable DB as a routine memory-control mechanism.

A short trial can reject an unsafe profile; promotion also needs catch-up completion, representative load and sustained stability across a later separately admitted soak. Preserve existing history: wrapper minimum140000-block transaction/receipt/account/storage/body history and1800 proof window, plus the larger reviewed bootstrap origin/blob/header coverage. Do not shorten retention or rerun snapshot finalization to save memory. The retained selection-r4 source documents that snapshot reruns can delete outputs/rewrite MDBX; pruning/downloading are not part of this plan.

Those configured windows are NOT sufficient proof of complete ownership/session history. Root's current census requirement starts at ledger birth52515705; the captured restore head53273964 is758259 blocks later, already far beyond140000. Verify creation transaction/receipt/block membership, complete relevant event logs and required historical code/state across that actual interval, including older factory/session evidence where needed. A1800-block eth_getProof window does not establish historical state proofs at ledger birth. Inventory what the restored DB, static files and separately preserved authenticated history actually contain before deciding how to serve those reads. Preserve their data and provenance; no pruning, assume-empty logs, recent-only census, trust downgrade or substitution of incomplete history as full coverage. Catching up to current head alone does not qualify this RPC for the existing migration/ownership consumers.

**Conclusion:** first eliminate unwanted concurrency and measure Base on its restored storage. A reduced allocation may be achievable, but present evidence supports no numeric minimum or immediate safe small-VM launch. This preparation must not delay the coordinator's app-recovery work.
