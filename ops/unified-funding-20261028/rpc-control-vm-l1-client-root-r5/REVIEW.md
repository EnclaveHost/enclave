# Prepared EL-only Control trial r5

Prepared only; no syntax check, test, remote contact, native launch, COW creation, admission, commit or deployment performed. Root owns review, checks, current admission and execution. No active Nan input changed.

Derived from executed Control r4. Fresh r5 local/remote directories, service/slice/socket names, mount, export nonce and prospective private COW. Existing r4 and original are untouched. Runner refuses absent or expired root admission bound to PINS.json and scope `actual-l1-el-only-bounded-client-r5`; no admission is supplied.

Only EL is launched, with an explicit start_client and wrapper CLI restriction. Lighthouse is omitted from payload uploads. Both exact retained Control account mappings and all original ownership/provenance checks are preserved; reserved CL unit is checked absent and cleanup still checks it, but it is never launched. RPC sampling only contacts EL loopback18645, requires a bounded successful JSON-RPC eth_blockNumber envelope with canonical hex quantity, and never calls the paired readiness gate. Success means EL RPC startup and graceful bounded shutdown only, with paired=false, syncVerified=false and productionReady=false.

Unchanged: Reth binary, low-memory arguments, original/proposed TOML bytes and stage-only comparison, history/proof/retention flags, immutable parent identity/locks, fresh COW7GiB stop/8GiB hard limit, local300GB disk/27648MiB memory floors, client2304MiB + attachment128MiB + guardian128MiB, zero swap, control1536MiB residual after seven existing services' remaining cap growth, 90s sample window, cleanup protocol and no automatic retry. Added exact prior r4 terminal/cleanup proof before execution; r2 retained-account provenance remains separately required.

The r4 UUID/findmnt implementation is retained because this is the smallest EL-only differential on the previously functioning Control host, not the Nan idmapped filesystem path. Current boot/tool/account identities and memory headroom require root's fresh observation. An RPC listener alone is not chain identity, synchronization, proof availability, consensus pairing or production readiness.

Root review should check generated component concatenation, mount consistency across helper/top manifest/payload manifest/disks, only-el launch and sampling, unchanged Reth settings, exact budgets, prior cleanup binding, and final hashes. These are proposed validation targets, not tests reported as passed.
