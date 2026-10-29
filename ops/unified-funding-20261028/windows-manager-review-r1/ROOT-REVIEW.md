# Windows manager candidate review, October 29

Status: not deployable. The complete censorship-resistance goal remains active. No production files, services, wallets, apps or journals changed.

Claude ran on the required verified Max account once, then hit its fixed 1800-second deadline (rc124). It left 140 files, 24 changed/new; the immutable author-delivery manifest is 315c67609014b620aa028889456d728663e3995a6ef39ce0b312cea814045fed. All 417 input pins remained unchanged; collection found no writes outside candidate. The final guard entry uses fileURLToPath: the earlier provisional pathname bug was corrected by the author before collection.

## Executed evidence

Root verified every frozen file, assembled the five exact r18 dependencies specified in PACKAGING-WINDOWS-PERMIT.json, and kept source byte-identical throughout tests. Initial full author suite: 33 tests, 29 pass, 4 fail, zero skips. Two failures are the TEST splice helper dereferencing a removed manager record; a corrected helper must preserve the original request identity and still test actual denied new connections. Two router cases fail because os.tmpdir is tmpfs, which the production journal deliberately rejects. Repeating only the three router cases with a fresh owned persistent TMPDIR passed all three without source changes. That is 31 distinct authored checks passing; two still need helper correction and rerun. Do not count the repeated route parser twice.

Three independent root checks all fail against the same source:
1. During asynchronous release, the physical exclusion stays held, but retained journal methods still admit a new assignment. Admission must be revoked before awaiting withdrawal while cleanup retains the physical owner capability.
2. A negative-generation lifecycle row with a valid log hash chain is accepted on cold replay. Hash-chain integrity is not schema/transition validation. The test title says authenticated; that wording does not establish external authentication. This is a local malformed-state test, not a demonstrated remote exploit.
3. An expired guard registration throws after persisting armed state; it has no live timer, and sessionEnded/stop leave it armed. This proves orphaned guard bookkeeping, not a production VM escape: no VM was launched in this test.

Actual owned logs/file writes are used, with explicitly TEST in-process exclusion on Linux. The author suite also uses real separate guard/manager processes, real HTTP/control MAC and signatures, but TEST inventory, chain authority, backend and clocks. No Windows, Hyper-V, Base-finality or full independent-hosting qualification follows.

Runs: root unit1d150410074b4aa89948684eace7799a (3FAIL, terminal/Main0); author0d8d066881d646f6aeb0e905088530d2 (29PASS4FAIL, terminal/Main0); persistent-routerfe989dc9af7a4532ace068cf6ec771c9 (3PASS, terminal/Main0). Shared queue and pressure guards, CPU1/noSwap/floor27648, owned network namespace. Root/router256MiB/220RSS; author512MiB/450RSS, inner peak258MiB/minavailable34370. No owned test remains active. Failed evidence is retained.

## Required implementation still missing

The production authority factory unconditionally throws and main uses null authority; the Windows journal requires an EXLOCK constant that the actual installed Node24.16.0 does not export. A proposed owned numeric-flag test is not authorized or executed yet. No fallback lock has been accepted. Actual independent verified authority must work; a disabled capability is not completion.

Protected scope currently admits only derivations1/5, refusing GPU, desktop, secrets, ports, volumes and command sockets. Full supported-workload boundaries, actual supervisor allow/hold and isolation-client attachment wiring, a positive composite-router stage, portable dependency pins, actual hardware enforcement and fenced migration are still required. Guard/manager simultaneous death and host-administrator trust remain explicit limitations. Additional source concerns (ingress acknowledgment despite close failure and hung cleanup after guard loss) require tests and repair. No weakening of proofs, legacy behavior, owner authority or workload scope is authorized.

This package stores the 24 authored deltas and five vendored modules, plus exact manifests, test drivers and results. Reconstruct the remaining unchanged119-entry seed using the pinned archive described by PACKAGING-WINDOWS-PERMIT.json; source-pins.json identifies the full assembled tree. Existing external viem2.53.1 dependencies are required; dependency-observation.json is not a vendored closure. The executed tree is U/windows-manager-root-review-r1. Nothing here is a standalone install artifact.
