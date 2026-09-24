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
| **Scheduling** | `considerClaim` (`supervisor.js:9167`); relay fleet-AND of features (`api-relay.js:1461-1637`); autoscaler (`scripts/autoscale.mjs:109`) | guestd `/health` states what a tenant does NOT get (`supports`: gpu, secrets, egress, config, ports all false) | a claim gate: a tier box claims only deployments that ask for the tier and need nothing it refuses, and a non-tier box refuses tier deployments. The relay needs a per-box tier list, not an AND. The autoscaler must not read tier demand as Tinfoil demand |
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
   verifier obtains the expected measurement. *Progress:* the image was NOT reproducible from its bundle. It carried
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
   loopback-only. The node-CVM-to-host bridge must be authenticated.
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
| C2 | guestd `/prefetch`, and the catalog-version to bundle mapping. **Decision needed:** publish bundles in the catalog, or derive them deterministically from the component and policy | not started |
| C3 | supervisor, behind `ISOLATION_BACKEND=snp-guest-per-app` (default off): VMMGR_URL to guestd, `CLAIM_READY` widening, a `considerClaim` gate from guestd's `supports`, and a per-deployment attestation endpoint returning the GUEST's own document; tested through the existing `*_SELFTEST` hooks | not started |
| C4 | data path: a ciphertext splice from the relay SNI route to the guest forwarder for this backend; guest-front certificates | not started |
| C5 | relay: a per-app policy module (null unless configured), a new hub mode, per-box tier eligibility outside `TENANT_COMPUTE_MODES`, the `relay/deploy.sh` module list, tests | not started |
| C6 | clients: the envelope namespace in site/CLI/MCP; a CLI verifier lifting the judge's checks, with measurement recomputation from the pinned domain release | not started |
| C7 | an authenticated node-CVM-to-host bridge for guestd (vsock) | not started |
| C8 | the staging acceptance run above, with its evidence file | blocked on C2-C7 |
