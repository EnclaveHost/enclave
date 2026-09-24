# Per-app isolation on enclave.host: the path from this branch to a live deployment

Written 2026-09-24 on `isolation/portable-runtime-jit`, from a read of the production code (supervisor.js, metal/,
relay/, contracts/, site/, cli/, wasm/) and from what this branch has built and run. **Nothing here is deployed.**
No production relay, registry, ledger or host was touched. Not independently reviewed.

## The vehicle: one SNP guest per app (M4a), not planes (M4b)

The per-app isolation that is measured on this hardware today is **M4a**: each app in its own SEV-SNP guest, the
contract bundle inside that guest's measured image (verifying AmdSev firmware, `kernel-hashes=on`), TLS terminated
by the guest's own front, `report_data` binding the TLS key, the AppID and the runtime identity. Separate guests are
separate ASIDs and memory-encryption keys. `isolation/m4/test-m4.sh` passed 13/13 twice on the planes kernel. M4a
needs **no planes, no SVSM and no host change**, so the second-plane blocker (precondition 4) does not gate it.

**M4b (one app per SVSM plane) stays lab-only.** It is blocked on precondition 4 (`m4/HOST-CHANGE-PLAN.md`). A
single M4b plane is still one app per guest, so it adds nothing over M4a for isolation *between* apps. No M4b
evidence is used below as a claim about isolation between apps.

## Where production is today

On a metal node, **every app runs as a `wasmtime serve` process inside ONE node CVM**:
- `metal/enclave-metal.mjs` launches one guest.
- Inside it, `supervisor.js` runs the claim loop, billing and proofs, and drives `wasm/wasm_manager.py` over the
  `/vms` contract.

The boundaries between apps are the Wasm sandbox, the process and a cgroup. No production code imports anything
from `isolation/`. An SNP guest cannot launch SNP guests, so per-app guests must be launched **from the host**.

## Stage by stage

| stage | exists today | built in this branch | missing |
|---|---|---|---|
| **Deployment creation** | `EnclaveDeployments.create` (`contracts/EnclaveDeployments.sol:570`); the options envelope `configCid` (≤4096 B) is the only per-deployment requirement channel; site `deploy.js:36`, CLI `enclave.mjs:1759`, MCP `mcp.js:1037` | - | an envelope namespace to REQUIRE the tier, e.g. `{"isolation":{"require":"snp-guest-per-app"}}`. Old runners already refuse unknown namespaces (`supervisor.js:1981`), which fails closed. Client flags in site/CLI/MCP. **Identity mapping:** catalog versions name a bare component CID; this backend needs a contract bundle (AppID = sha256 of the bundle), and no mapping exists |
| **Host admission** | the hub verifies one node CVM at tunnel attach (`relay/tunnel.js:402-506`); policies are env-gated and null by default (`relay/api-relay.js:145-156`, `vbs-policy.mjs`, `pvm-cpu-tier.mjs`) | - | a per-app policy module (null unless configured), a NEW hub mode (not `snp`, so existing rules cannot admit it), kept out of `TENANT_COMPUTE_MODES` (`api-relay.js:1402`) until reviewed. Per-app evidence is per deployment at provision time, not per box at attach |
| **Scheduling** | `considerClaim` (`supervisor.js:9167`); relay fleet-AND of features (`api-relay.js:1461-1637`); autoscaler (`scripts/autoscale.mjs:109`) | guestd `/health` states what a tenant does NOT get; the supervisor's claim gate (`isolationClaimVerdict`, off unless `ISOLATION_BACKEND` is set) enforces it and the scope | a claim gate: a tier box claims only deployments that ask for the tier and need nothing it refuses, and a non-tier box refuses tier deployments. The relay needs a per-box tier list, not an AND. The autoscaler must not read tier demand as Tinfoil demand |
| **App launch** | the supervisor's `/vms` seam (`supervisor.js:3316` spawn, `3416` stop, `3057` list, `6368` alive, `3105` lease), which the supervisor marks "IMPLEMENT THESE for your CVM launch mechanism" | **guestd** (`isolation/m4/guestd`), the host-side manager speaking that contract. It launches one M4a guest per contract bundle, and reports `running` only after the M4a judge attested the guest as that app. It refuses GPU, secrets, egress, config, extra ports, unknown fields, bare components and catalog CIDs | connectivity from the node CVM's supervisor to the host's guestd (loopback-only today; needs an authenticated vsock bridge like the shielded worker's), `PROVISION_BACKEND`/`VMMGR_URL` wiring, `/prefetch`, and catalog CID to bundle fetch |
| **Attested identity** | the node CVM's shared quote (`supervisor.js:3460-3565`); no per-app id or measurement anywhere | per guest: M4a front binds TLS key + AppID + runtime identity; guestd's measurement is predicted from the bundle and must equal an independent prediction (`test-guestd.sh` G3) | a **published, reproducible domain release** (kernel, verifying firmware, dominit, front, runtime set, cmdline) so a verifier can recompute the expected measurement from a bundle |
| **Verified client connection** | site verification checks the node CVM against a repo release (`site/js/core/verify.js`), with **no app id and no per-app measurement**; app TLS terminates in the SHARED supervisor (`supervisor.js:7553-7779`); `/x/:id` proxies plain HTTP to loopback (`4435`) | the lab client and judge (`isolation/m2/client.mjs`, `judge.mjs`) implement every check; `test-guestd.sh` G4 uses them from outside guestd | a production verifier (CLI first, browser later) with the judge's checks and key pinning; a data path that **splices ciphertext** from the relay's SNI route to the guest front, with no plaintext hop; certificates for the guest's own front |
| **Lifecycle / cleanup** | supervisor: `stopContainer`, crash budget, `reconcileInstances` (`3139`), dead-man `vouchTenants`, lease-end release | guestd: `contract.Lifecycle` (exactly one reclamation; a delete during start is honoured when start finishes), a dead-man lease with the wasm-manager's semantics, guest death reported `failed`, boot sweep of a previous run's guests, SIGTERM teardown, workdir scrub | guest RAM/ASID accounting in the supervisor's pool reconciler |
| **Upgrade / rollback** | `switchTenantVersion` prefetches before stopping (`supervisor.js:8349`); app rollback = `setAppRef` to an older version; host agent `metal/update.mjs` keeps `dist.prev` | - | guestd `/prefetch`; the domain release pinned in `metal/dist/manifest.json`; a per-app measurement changes with every version, so the verifier's expectation must follow the version |

## Security gates: what blocks a live deployment

None of these is waived by the tests in this branch.

1. **Client verification.** A user must be able to verify THEIR app's guest before sending data: the AMD chain,
   the TCB floor, the measurement recomputed from their bundle and the pinned domain release, the AppID, and the TLS
   key binding. The production verifier checks none of the per-app parts. Without it, "isolated per app" is a claim
   no user can check.
2. **Measurement publication.** The domain release must be pinned and reproducible, and it must be documented how a
   verifier obtains the expected measurement. *Built (2026-09-24):* `domain-release.sh`, `expected-measurement.sh`.
   Reconstruction from a pinned release reproduces live SNP measurements. The release still has to be PUBLISHED
   (for example, content-addressed and signed) before a remote user can use it. *Progress:* the image was NOT reproducible from its bundle. It carried
   the bundle file's mode, the builder's uid/gid and the host's library modes, so guestd's first hardware run failed
   the independent check. That is fixed (`e280abf3`). The measurement is now a function of the bundle and this host's
   kernel, firmware, front, init and runtime. Those template inputs are not yet published as a release, so a remote
   verifier still cannot recompute it.
3. **Verifying firmware.** guestd refuses any firmware not pinned in `m4/verifying-firmware.txt`. *Side finding, not
   acted on:* production metal boots its node CVM with the distro OVMF (`metal/enclave-metal.mjs:35`,
   `build-image.mjs:647`). This project measured that firmware as NOT verifying the kernel hash table
   (`m4/evidence/firmware-0a-2026-09-24.txt`). If metal's file is that firmware, metal0's measurement does not
   establish which initrd booted.
4. **No plaintext hop.** TLS must terminate in the guest front. Today's app-zone TLS terminates in the shared
   supervisor.
5. **Refused features stay refused.** Owner secrets, config, egress, extra ports, volumes and GPU are refused by
   guestd, and the claim gate must refuse such deployments before a lease is taken. Secrets need attested in-guest
   delivery (the guest fetches them with its attested key) before any secrets-bearing app can use this tier.
6. **An authenticated control channel.** The `/vms` contract has no authentication, which is why guestd is
   loopback-only. The node-CVM-to-host bridge must be authenticated. *Built (2026-09-24):* `guestd-control/1`,
   end-to-end between the supervisor and guestd, so any bridge carries only authenticated, replay-proof traffic.
   Still missing: key delivery into the node CVM, and the bridge itself.
7. **Independent review** of guestd, the claim gate, the data path and the verifier. The reviewer is unavailable
   today.
8. **Steven's decisions:** turning on a new tier policy on the production relay, registering a host for it, merging
   supervisor changes to main (a push to main is a fleet release), and giving a staging host the RAM (metal0 was
   turned off to free it).

## The smallest truthful staging acceptance test

Staging means warden-host with `relay/local-hub.mjs` and no production registry, ledger or relay env. It passes
only if **all** of these hold, each scored from files a reader can check:

1. The PRODUCTION supervisor code, with the tier flag on, provisions ONE deployment through its normal provisioning
   path (not a hand-made POST) onto guestd, which launches it as its own SNP guest.
2. A client connects through the hub by the deployment's host name. TLS terminates in the guest. The client verifies
   the chain, the TCB, the measurement recomputed from the bundle and the pinned release, the AppID and the key
   binding, and does so BEFORE it sends one real request, which is served.
3. A second deployment runs at the same time in a second guest. Each client REFUSES the other's guest.
4. Ending the lease (or an owner stop) tears the guest down. The client's next connection fails closed, and no unit,
   forwarder or workdir remains.
5. Negatives:
   - a deployment with secrets, config or GPU is not claimed by the tier box;
   - a tier deployment is not claimed by a non-tier box;
   - a substituted bundle does not attest.

What it would NOT show: isolation from a malicious host kernel beyond what SNP gives each guest; any property of
planes; production readiness.

## Commits, in order

Each is tested and disabled by default.

| # | commit | state |
|---|---|---|
| C1 | guestd: the `/vms` contract over M4a guests, launch + verify, lifecycle, lease, refusals | **built in this branch** (`61578689`): 12 unit tests (race detector); `test-guestd.sh` 7/7 on hardware, `m4/evidence/guestd-2026-09-24.txt` |
| C1b | measured images reproducible from the bundle: modes, owner and times normalised (`pack-initrd.sh`) | **built** (`e280abf3`), found by guestd's first hardware run failing G3/G4; `test-image-repro.sh` 4/4 |
| C2 | the catalog-version to bundle mapping, and guestd `/prefetch` | **built**: `contract/catalog` (`enclave-catalog-bundle/1`, spec and incompatibilities in `contract/catalog/DERIVE.md`), matched against an independent Python reference; guestd resolves `ipfs://` + `derive` through an immutable, digest-verified store using the platform's own CAR verifier. **Open:** which policy the supervisor pins per catalog version (`DERIVE.md` item 4) |
| C3 | supervisor, behind `ISOLATION_BACKEND=snp-guest-per-app` (default off): the `isolation` envelope namespace (parsed ONLY on a tier box), a `considerClaim` gate (the deployment must ask; the manager's `/health` must say it IS guestd; GPU, config, secrets, ports and volumes are refused), a surfaced `error` when a running deployment's requirement changes, and `/availability` stating the tier and `fullService:false` | **gate built**: `test/isolation-claim-gate.test.mjs` 9/9; all 43 supervisor-driving test files 452/454 (the 2 skips pre-exist). **Transport built (default off):** with the flag set, the supervisor's `vmReq` reaches guestd ONLY over `guestd-control/1` (`guestd/supervisor-transport.mjs`), fails closed without a private pairing key or against an unauthenticated manager, and never repeats a mutating call on an unsigned 401 (a launch is reconciled by name; DELETE, lease and prefetch are declared idempotent). Tested by `guestd/transport_test.go`, driving the supervisor's own `vmReq` through `GUESTD_TRANSPORT_SELFTEST`; flag-off supervisor suites unchanged (452/454, the same 2 skips). **Still missing:** the bridge across the CVM boundary, key delivery, the derivation record on spawn (needs a published per-version policy), and a per-deployment attestation endpoint returning the GUEST's own document |
| C4 | data path: a ciphertext splice from the relay SNI route to the guest forwarder for this backend; guest-front certificates | not started |
| C5 | relay: a per-app policy module (null unless configured), a new hub mode, per-box tier eligibility outside `TENANT_COMPUTE_MODES`, the `relay/deploy.sh` module list, tests | not started |
| C6 | clients: the envelope namespace in site/CLI/MCP; a CLI verifier lifting the judge's checks, with measurement recomputation from the pinned domain release | **verifier half built**: `m4/domain-release.sh` pins every image input under one release id; `m4/expected-measurement.sh` reconstructs a guest's measurement from the release and a bundle, and reproduced BOTH live measurements of the guestd hardware run (`test-domain-release.sh` 6/6). **Missing:** publishing a release, the envelope flag in site/CLI/MCP, and a browser verifier |
| C7 | an authenticated node-CVM-to-host channel for guestd | **protocol built** (`guestd-control/1`, `m4/guestd/auth.go`): a pairing key per guestd; a handshake bound to a per-start instance id and single-use nonces, with mutual proof; every request MAC'd over session, sequence, method, target and body, with a 64-wide anti-replay window; every answer signed; sessions expire and a restart forces a new handshake; lab mode without a key refuses the handshake. The supervisor-side client is `control-client.mjs`: single-flight handshake, an immutable session per request, bounded time and bytes, no blind resends (a reported concurrent-handshake race is fixed, and its regression test still fails against the preserved old client). Tests: 11 Go tests plus JS interop, and `test-guestd-control.sh` 6/6 on the real binary. **Missing:** delivering the key into the node CVM (production), a transport bridge (vsock or slirp to loopback), and the supervisor using the client |
| C8 | the staging acceptance run above, with its evidence file | blocked on C2-C7 |
