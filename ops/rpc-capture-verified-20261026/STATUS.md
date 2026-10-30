# Verified live capture and current RPC work — October26
Actual capture/r3 passed45 tests with zero skipped. Source663038c89c9f3767eb441082700c0a08bc8aea7e48643b32c80bddff64c2a3ad.
Root independently verified unmodified live0252 initial capture using that tested code: PASS. Evidence Base anchor52878960, output root57ca3d54..., finalized L1block26273917. This is Helios-relative authentication from own Ethereum backend, no SNP and no production cutover. Verification performed offline03:07; original capture02:54. It does not refresh chain state; a new capture/recheck is required at later activation.
Separate ordinary Python import bug remains: loader creates __pycache__, breaking strict file set. Real reanchor/r5 ran19 tests17pass2fail; prior95 regressions reused with exact unchanged source. Integration fix under preparation, not in this qualification.
MCP/r4 comparator17passed but real artifacts refuse legitimate unresolved library bytecode; setup20, not73-test pass. Newr5 pending.
Composition/r11 preflight fails artifact-copy directory shape before tests. r12 preparation pending; no test waiver.
Actual live API mapped to enclave-control VM: Caddy30443→API8100 /opt/nan-relay/api-relay.js, RPCgateway8190, DNS1053. Alllegacy publicly-backed chain reads; no localverifier installed. Source inventory and immutablepatch preserved, no live changes.
All HOLD flagsfalse. Ethereumhealthy, Base downloading53.7%currentbatch at02:58 with additionalarchives/sync/authentication/history/blobs/readiness pending.
Outer SHA256SUMS covers publishedfiles. Clones/binaries/caches omitted; inner manifests canrefer to originalworkspaceinputs. No secrets orkeys intentionally included. Normal gitpush scan required.
