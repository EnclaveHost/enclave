# Consensus memory alternatives after Nan n9 OOM

Root read-only review; no executable, build, host change, checkpoint import or consumer switch. Nan n9 proves the present Lighthouse startup exceeds its 4 GiB cgroup allowance. It does not establish a minimum memory for all consensus clients or a total-stack requirement.

## Preferred narrow investigation: Lighthouse startup lifetimes

The peer traced v8.3.2 fork-choice restoration to a cached justified state and subsequent head reconstruction. Root independently reviewed builder.rs719-732, state_cache.rs198-250 and hot_cold_store.rs1827-1898. State-cache eviction currently occurs on insertion, after reconstruction, so merely reducing capacity2 to1 may not reduce this peak. A dedicated startup-only eviction of expendable in-memory unfinalized entries is a hypothesis requiring actual source tests and native measurement. Preserve finalized state, required HDiff buffers, reusable head entries, block-map consistency, all validation and disk data. Never call the persistent HotColdDB delete operation. Structural sharing and allocator retention make freed bytes unknown. The two Loading hot state markers do not establish parallelism: ReplayFrom recursion is synchronous.

No matching complete Lighthouse source/build/dependency closure has been qualified locally. A source patch requires a separately admitted build; it cannot be injected into the existing binary by a CLI flag. Peer is preparing source-only inputs, not implementing or launching them.

## Alternative: Nimbus26.10.2

Official hardware documentation recommends4GB for running and8GB for building, but this is not a measurement under our required custody and history workload: https://nimbus.guide/hardware.html . Release26.10.2 is listed at https://github.com/status-im/nimbus-eth2/releases/tag/v26.10.2 (commit short0abc0dd). An official prebuilt binary could avoid a local client rebuild, subject to release provenance and checksum qualification. No binary was downloaded or executed.

Version-pinned conf.nim declares light-supernode (first half of column subnets) and peerdas-supernode (all); neither label alone proves our required custody_group_count>=64. rest_node_api.nim returns the actual custody metadata. rest_beacon_api.nim1540-1603 removes old blob_sidecars with410 but implements /eth/v1/beacon/blobs via column recovery, including optimistic/finalized metadata. Our retained trial-chain-service.py100/114 and541 already use custody metadata and /eth/v1/beacon/blobs, so the old endpoint removal is not by itself a compatibility blocker. Actual blobs/commitments/KZG, finalized payload agreement and memory under load remain unqualified.

Nimbus cannot directly open Lighthouse's database. Trusted-node sync requires a verified recent checkpoint or checkpoint files and a new database: https://nimbus.guide/trusted-node-sync.html . The optional trusted-block-root light-client verification still needs a trustworthy root; a new public URL is not independent authority. No checkpoint source, root, SSZ files, local export, historical coverage, disk placement or new-client native admission is qualified. Preserve the existing database and all history; do not substitute checkpoint sync for the required Base sequencing-window/blob coverage checks. Existing EL repair, paired Engine JWT, transport, sync/finality and Base gates remain for either client.

Next execution is not an unchanged Lighthouse retry. Choose a reviewed patch/build path or a fully specified alternate-client checkpoint/history path with measured resources. Neither is currently production-ready, and8GiB total remains unproven.
