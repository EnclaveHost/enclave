# Enclave: VM-first platform and console

Status: **proposal, 2026-11-24, revised 2026-11-25**. Nothing here is deployed by this document.
Source facts were first read from `main` at `8615b6938`; the revision re-read `main` at
`a1a8a0415` and enclave-apps `main` at `93aba2f` and is marked where it changed something.
The consolidation this waited for has landed (section 7, step 0) and step 1 is in progress; its
host side is on `main`, has booted test VMs on metal0 outside any lease (2026-11-25), and is
deployed nowhere.

## 1. The idea in one paragraph

Today Enclave is a platform for Wasm apps from a catalog, with a whole-VM path bolted on for
Enclave RPC and kvm-box. This proposal inverts that. The only thing the platform leases is an
**instance**: a measured confidential VM. Everything else is either a capability attached to an
instance (volume, network, secret, Shield GPU) or a **service**: a shared, metered endpoint that
anyone can operate by running a published image on an instance, with a console module that drives
it. Wasm does not disappear. It moves inside the guest, where it
becomes the packaging format for small services, and stops being something the host, the ledger
or the console has to know about.

The contracts, the market, the lease, the network and the verifiers stay. What goes is the second
runtime, the second host agent, the second catalog, and the app-store shaped UI.

## 2. What exists that this is built on

| Finding | Where | Consequence |
|---|---|---|
| A whole-VM runtime already exists: catalog runtime `sev-snp-vm`, deployment option `snpVm` | `network/snp-vm-app.mjs`, `rpc/snp/vm-manager.mjs`, `metal/snpvm-supervisor-patch.py` | The instance primitive is a generalisation, not a new build |
| The supervisor talks to every launcher through one contract: `/vms` over `guestd-control/1` | `supervisor.js` `vmReq`, `isolation/m4/guestd`, `windows/vbslike/manager/control.mjs` | Backends are already drivers behind one seam |
| A Wasm app on metal0 is already one SNP guest running `wasmtime serve` behind an in-guest front | `isolation/m2/dominit.c`, `isolation/m2/front` | "Wasm app" is already "a VM image plus a component"; only the host still treats it specially |
| The ledger records an opaque catalog reference, shares, ports and options | `contracts/EnclaveDeployments.sol` `create()` | Instances fit the live ledger. **No contract migration is needed for v1** |
| The catalog version carries a free-form `config` JSON, including `runtime`, `image.rootHash` and `snp.measurements` | `EnclaveAppCatalog`, `snpVmExpectation()` | The catalog can serve as the image registry as it is |
| Owner-committed startup packages (hash on the ledger, bytes delivered by anyone) | `isolation/m2/bootstrap`, `docs/design/decentralized-architecture.md` | This is "user data" for instances, already designed fail-closed |
| The console can already run with the hosted API turned off | `site/js/core/api.js` independent mode, `independent-chain.js` | Chain plus direct-to-instance management is a proven path, not a hope |
| *(2026-11-25)* A whole-VM front in Go: boot document, fresh report per nonce, certificate exchange, protected-port tunnels, in front of any app on the guest's loopback | `isolation/m2/vmfront`, `isolation/m2/tunnel` (`2a2da5faa`) | The guest agent for whole-VM images has a starting point that is not the RPC front |
| *(2026-11-25)* The desktop as one SNP guest: verity root under a tmpfs overlay, a read-only model disk, booted on metal0 outside any lease with the predicted measurement | enclave-apps `kvm-box/vm` (`5e887ea`), `launch.py` `roDisks` | The Desktop family exists on the SNP path as a prototype, and its builder is the seed of the image builder. It has no GPU: "a whole VM has no route to a host's GPU workers yet" |
| *(2026-11-25)* Authenticated encryption for snapshot objects over plain S3, with a context that binds app, owner, deployment, bucket and object | enclave-apps `snapshot-crypto` (format `EVMSNAP1`), used by risc-box | The snapshot object format for volumes exists. It wraps state someone else serialises; it is not a VM snapshot by itself |
| *(2026-11-25)* Uploads authorised by the active session (`api.upload`), bound to a deployment | CLI 1.8.0 `enclave upload`, s3-ipfs-adapter 0.5.6 | The account-and-session pattern the service kit needs is in use, and it is the path for publishing an image by content address |

Three things the survey shows are **not** there yet and that this design depends on:

1. **Persistent instance storage.** kvm-box is RAM only, in all three of its forms. Enclave RPC's
   disks are bound by hand by the host operator per deployment. There is no general volume.
2. **A general-purpose base image.** Images today are purpose-built (RPC, desktop, app guest).
3. **A finished general GPU.** Decided 2026-11-24: an instance needs full CUDA support through
   Shield. The mechanism exists and is further along than the rest of this list: the Shield
   Compute compiler in `kvm-box/shield-compute` gives the guest a logical GPU with CUDA/HIP and
   OpenCL frontends, and a Mesa OpenGL/Vulkan driver is in progress in `kvm-box/shield-graphics`
   (both on enclave-apps `main` since `0d63827`, 2026-11-24). Its own acceptance ledger is still open. Section 5.4.

## 3. Model

Five nouns. The console, CLI, SDK and MCP all use the same five.

| Noun | Is | On chain today as |
|---|---|---|
| **Provider** | A machine offering capacity at its own price, with a protection class it can prove | `EnclaveRegistry` host |
| **Image** | A measured bootable artefact: kernel, initrd, command line, dm-verity root hash, firmware hash, and the launch measurement per vCPU count | `EnclaveAppCatalog` version with `runtime: sev-snp-vm` |
| **Instance** | A lease on one VM booted from one image, sized in vCPU, memory and Shield GPU share | `EnclaveDeployments` deployment |
| **Volume** | An encrypted block device whose key is released only to an attested instance of its owner | New. Key release reuses custody; see 5.3 |
| **Service** | A shared, metered endpoint: an image, the descriptor it serves, and a console module | Image in the catalog; endpoints in `EnclaveServiceIndex`; usage in a new settlement contract |

### 3.1 Protection class is part of the instance type

An instance type names its backend's guarantee, the way a cloud names CPU families. It is not a
tier label a host reports about itself; it is derived from verified evidence exactly as
`computeEligible` does now.

| Class | Backend | What is established | Who stays trusted |
|---|---|---|---|
| `c` confidential | SEV-SNP guest (QEMU) | Memory encryption, AMD-signed report, measured launch | AMD, physical bus attacks out of scope |
| `s` shield | VBS-isolated Hyper-V partition | Per-partition isolation, TPM-quoted host boot, signed partition report; host-memory exclusion demonstrated box-local only | Microsoft, the hypervisor, the machine's owner |
| `p` pVM | Android protected VM | pVM attestation, CPU only | Device vendor |

The GPU is a separate attribute of the instance type (section 5.4), with its own evidence: a
confidential CPU says nothing about the card attached to it.

`PRODUCT.md`'s claims policy carries over unchanged: the class, the GPU and their limits appear
next to the instance type in the launch flow, not in a distant doc.

### 3.2 Images

Four image families cover everything in scope.

- **base**: minimal Linux plus the guest agent. Boots, attests, applies the owner's startup
  package, mounts volumes. This is the EC2-style general-purpose instance.
- **desktop**: base plus the kvm-box desktop and Sunshine. Reached with
  `enclave connect --gamestream`.
- **runner**: base plus wasmtime. Runs one or more Wasm components named in the startup package.
  This is the direct successor of the M4a app guest.
- **appliance**: a purpose-built image where a runner will not do. Enclave RPC is the one today.

The SNP launch measurement depends on the vCPU count, and the current code requires a version to
publish measurements for exactly one count. The image record must instead carry a table of
measurements keyed by vCPU count, one row per offered size. That is a `config` JSON change, not a
contract change.

User-built images are possible in principle (anyone can publish to the catalog) but catalog
approval is mandatory moderation today and stays so. The intended path for customisation is the
base image plus a startup package and a volume, which needs no approval because the measured part
is still a platform image.

### 3.3 Services: shared and metered from day one

**Decided 2026-11-24.** A service is a multi-tenant endpoint you sign up to and pay for by use,
the way you use S3 or Filebase. You do not launch a VM to get a bucket.

A service is three things:

- an **image** (usually the runner image plus Wasm components) whose measurement is published in
  the catalog;
- a **descriptor** it serves at `/.well-known/enclave-service`: name, version, API kind (S3, git,
  DNS, MCP, JSON-RPC, JSON), the meters it charges on, its price sheet, its service key, and the
  settings the console may read and write;
- a **console module**.

Anyone may run an approved service image on an instance they lease, and advertise the endpoint in
`EnclaveServiceIndex` (ownerless, already deployed). The console lists the endpoints for a
service, verifies each one's attestation against the catalog's measurements in the browser, and
shows price and location. Enclave runs the first endpoint of each service; nothing in the design
makes it the only one. This is what the "region" selector means for a service.

What makes a shared service acceptable on a confidentiality platform is that **the tenant trusts
the measured code, not the operator**. The operator leases the instance and collects the revenue
but cannot read tenant data, and the tenant can check which code is serving them before sending
anything. That is the product difference from an ordinary multi-tenant cloud service, and the
console should lead with it.

**Tenancy rules**, implemented once in the service kit (5.7), not per service:

1. **Identity.** A tenant is an account (wallet or passkey). Requests carry an Enclave session
   or SSO token, or a service-native credential (S3 access key, git token, API key) that the
   service issued to that account inside the enclave.
2. **Enrolment.** The console or CLI verifies the endpoint, then sends the tenant's data key
   encrypted to the attested service key. Protocol clients that cannot attest (an S3 SDK, git)
   rely on that one-time check plus the endpoint's in-guest TLS key.
3. **Keys.** Every tenant's data is sealed under that tenant's key. The key is the tenant's, not
   derived from an operator secret, so the same tenant can enrol at another operator's endpoint.
4. **Isolation.** For `wasi:http` services the runner instantiates the component per request
   with only that tenant's context, so a bug in service code cannot reach another tenant's key.
   Long-running services (the S3 and DNS servers) enforce tenancy in the shared crate and do not
   get that property; they need the closer review.
5. **Metering.** Usage is counted inside the enclave by measured code and settled on chain (5.8).
6. **Quotas and abuse.** Per-tenant rate and storage limits; a tenant's budget on chain is the
   hard stop.

What the existing apps need for this, from the survey: Notes, Scheduler and MCP Gateway already
separate users by SSO token. Object Storage has one flat credential list where every credential
reaches every bucket. IPFS has one bucket and one shared key per deployment. IPNS has one name
per deployment. DNS and Depot are one tenant per deployment. So most of the porting work is in
the storage services, which are also the ones everything else depends on.

**Dedicated** is the same image with a tenant list of one, on an instance the user leases
themselves. It is a deployment choice, not a second code path.

Honest limits to carry into the console copy: a tenant's stored data sits on the operator's
storage contracts (for Sia, the operator's account pays the hosts), so leaving an operator is an
export and import until storage accounts can be tenant-owned; and an operator can stop serving.

## 4. Console

Rename the dashboard to **Console**, served at `console.enclave.host`, still static and
IPFS-published. The marketing site keeps `enclave.host` and gets smaller.

### 4.1 Shell

The layout is the familiar cloud console one, which replaces the current 1200 px single column:

- **Top bar**: service menu, global search across resources, provider and class selector (the
  "region" control), balance, account.
- **Left rail**: the current service's resource types.
- **Main**: resource list, then resource detail with tabs. Create flows are full pages, not modals.
- **Home**: running resources, spend rate, recent activity, verification status.

The visual language in `DESIGN.md` (dark, monospace for the machine, jade means verified) stays;
only the layout rules change. Verification is the one thing a generic cloud console lacks and it
should be structural here: every resource row carries its attestation state, and the detail page
has a Verify tab that runs the check in the browser.

### 4.2 Service catalog

| Category | Console service | Built from | State today |
|---|---|---|---|
| Compute | **Instances** | `sev-snp-vm` path, guestd, vm-manager | Works for one hand-bound app |
| Compute | **Desktops** | kvm-box, `enclave connect --gamestream` | 0.9.x published; release gates open; on enclave-apps `main` since 2026-11-24 |
| Compute | **Images** | `EnclaveAppCatalog` | Catalog exists; image families do not |
| Compute | **Shield GPU** (logical GPU: CUDA, OpenCL, OpenGL/Vulkan) | `shielded/`, `ggml-shielded`, `kvm-box/shield-compute`, `kvm-box/shield-graphics` | Runs in the kvm-box desktop VM; lives inside one app; acceptance ledger open |
| Storage | **Volumes** and snapshots | `isolation/m2/encvol`, custody | File-level volumes exist; block volumes do not |
| Storage | **Object Storage** (S3 on Sia) | sia-s3 | 0.1.10 on local branch `sia-s3/fix-shard-topology`, not on `main`; small PUTs are slow |
| Storage | **IPFS** (pinning, gateway, IPNS names) | s3-ipfs-adapter, ipns-publisher | Both mature; adapter runs `ipfs.enclave.host` |
| Networking | **DNS** (resolver, hosted zones, ENS) | enclavedns | 0.1.3 |
| Networking | **Domains and Certificates** | in-guest ACME, `relay/certs.js`, `domains.js` | Live |
| Networking | **Network** (routes, BYO WireGuard, IPv6, WAF) | `network/` | Live |
| Web3 | **RPC** (Ethereum, Base) | `rpc/` | Not production-ready by its own README |
| Developer | **Depot** (git) | depot | 0.1.3, the most mature storage app |
| Developer | **Scheduler** | cron | 0.1.3 on branch `fix/cron-cas-retry-20261014`, not on `main` |
| Developer | **MCP Gateway** | api-mcp-adapter | Stateless, tested |
| Developer | **Notes** | jot | 0.3.2 |
| AI | **Inference** | eyesoff-ai on Shield GPU | Live (eyesoff.ai) |
| Security | **Secrets** | custody v2, SecretVault | Live, two generations |
| Security | **Access** (passkeys, wallets, session keys, SSO) | `sdk/sessions`, EST1 | Live |
| Account | **Billing** | CreditVault, USDC funding | Live |
| Market | **Marketplace** (third-party images) | catalog, featured, reviews | Live as the app store |
| Provider | **Provider console** | `host-ui/`, registry | Separate panel today |

The fifteen RAM-only demo apps and the toy apps are not services. They move to an examples
directory and leave the product surface.

### 4.3 What is reused and what is replaced

Reused as is: `site/js/core/*` (chain reads, wallet, sessions, pricing, API client, verify),
`EnclaveElement`, the soft-nav router, the token CSS, `fleet-list` (becomes the provider table),
the billing components.

Replaced: `components/deployments/deployments.js` (4,287 lines, every tab built as HTML strings in
one file) and `pages/apps.js` (store, publish and the only deploy flow in one 2,004-line file).
Their panel logic is extracted into per-resource pages; the monoliths are not ported.

Each service is one console module: a manifest (id, category, image reference, resource types)
and its pages. Adding a service does not touch the shell.

## 5. Platform

```
                 Base: Registry · Catalog(images) · Deployments(leases) · Vaults
                                        ▲
        console / cli / sdk / mcp ──────┤ (chain + direct attested connections)
                                        ▼
  ┌──────────────────────── provider machine ────────────────────────┐
  │  node agent: market loop · network agent · Shield GPU broker     │
  │        │ /vms (guestd-control/1)                                 │
  │  driver: qemu-snp │ hyperv-vbs │ avf-pvm                         │
  │        ▼                                                         │
  │  instance = image + guest agent (TLS key, attestation, ACME,     │
  │             startup package, volumes, egress policy)             │
  │             └ workload: OS │ desktop │ wasm components │ appliance│
  └──────────────────────────────────────────────────────────────────┘
                                        ▲
              Enclave network: guard → exit circuits, route records
```

### 5.1 Node: one agent, drivers behind `/vms`

Today there are two host agents with their own claim loops (`supervisor.js`, 13.4k lines, and
`windows/node/host.mjs`, 4.5k lines), plus a 7k-line Python Wasm manager, guestd, vm-manager and
the WMI launcher.

Target: one **node agent** containing the market loop (claim, renew, release, proof, metering),
the network agent and the Shield GPU broker, and one **driver** per backend that implements
`/vms`. The market loop is extracted from `supervisor.js`, not rewritten: it holds a year of
fixes about leases, grace periods and RPC failure handling. The SNP driver is guestd generalised
with vm-manager's rules (running only after attestation; never reap a stateful VM on silence).
The Hyper-V driver is the existing `wmi-launcher`.

What vm-manager needs to become general: fetch and verify the image by content address instead of
a path the operator typed, allocate slots from capacity (guestd's `pool.go` already does this),
and attach volumes by identity. The first two are written (branch `platform/instance-primitive`:
a `pool` in the manager's config, a slot per unbound deployment, the supervisor's claim gate
reading the pool from `/health`, and `rpc/snp/image-fetch.mjs`); none of it has booted a VM on a
host.

**The Hyper-V driver is not last (revised 2026-11-25).** The first draft left Hyper-V parity to
the retirement step and started on SNP alone. But the desktop with the Shield GPU runs on the
Shield host (`nucbox-k11-4`, native desktop SVN25 and SVN26), and the SNP whole VM has no worker
channel. An instance that uses its Shield GPU therefore exists first behind the Hyper-V driver.
Mapping an instance onto the native desktop's existing admission is step 2 of the path, so the
two drivers grow up together under one `/vms` contract instead of one being ported to the other
at the end.

**One verifier, and evidence that is refreshed in one place (pulled forward).** From the
2026-11-18 microcode update until 2026-11-24, metal0 rejected every per-app guest because guestd
judged them with its own copy of the VCEK, dated September, which nothing refreshed
(`200725229`; a boot-time refresh, `scripts/host/refresh-vcek.sh`, now keeps it). Checked on
2026-11-25 for the instance pool: vm-manager judges a front through `rpc/snp/attested-fetch.mjs`
and `relay/snp-verify.mjs`, which looks the VCEK up at AMD by the report's own chip and reported
TCB, so the pool does not share that fault. The network agent does: it admits a whole-VM app
offline against the host's held copy (`network/snp-vm-app.mjs`, `kds: false`), the same copy
guestd uses. So the fault is one held copy with three readers and one refresher, not several
copies, and the gate on step 1 is narrower than first written: a pool instance is offered on a
host only after its network agent has admitted a whole-VM guest since the host's last TCB change.
The single verifier library of section 6 stays a consolidation target and is not a blocker.

`wasm/wasm_manager.py`, the runtime-set builds, `PROVISION_BACKEND`, and catalog bundle
derivations V1 to V7 have no role once a Wasm service is a runner image.

### 5.2 Guest: one agent in every image

`isolation/m2/front` already generates the TLS key in the guest, binds it into the report, serves
the attestation endpoint, runs ACME, tunnels declared ports, talks to custody and mounts
encrypted volumes. It becomes the guest agent baked into every image family. `metal/guest/agent.mjs`
is a second implementation of the same job and folds into it.

Since `2a2da5faa` there is a third: `isolation/m2/vmfront`, the whole-VM contract of the RPC
front in Go, sharing the protected-port code with the per-app front through `isolation/m2/tunnel`.
That is the right direction and the guest agent grows from it: vmfront is the part every image
needs (key, report, certificate, tunnels), and the per-app front's custody, ACME and volume code
move beside it as packages instead of staying inside one binary that also knows about Wasm.

**`isolation/vmboot` is the image layer (`a1a8a0415`, 2026-11-25).** The front moved there
(`vmboot/front`) with a report source per platform, `sev-snp` or `shield`, behind the same
endpoints, together with the init (`vm-init.c`, disks found by label, the root read-only under an
overlay, then `/vm/start`) and `build_boot.py`, which wraps one app image (`APP.json`, `root.img`,
`root.verity`: one root hash) with the kernel, initramfs and launch identity of a platform. This
is section 3.2's image model as code, and it settles how the two drivers share images: **an image
family is an app image; a host type is a wrapper.** The base, desktop, runner and appliance
families are therefore built as `enclave-vm-app/1` images on this layer, not with a builder of
their own. Both wrappers are built, and the Shield one booted the same image on nucbox-k11-4
(2026-11-25). A catalog version lists the one root hash with a launch identity per platform
(`snp.measurements`, `shield.launch`), and the host agent's probe and `enclave connect` judge
either platform's whole-VM document (`network/snp-vm-app.mjs`, `network/shield-vm-app.mjs`); the
Shield verifier has run on synthetic reports only, and the Shield node still refuses whole-VM
deployments, which is what step 2 needs first. What the layer does not
have yet and this design adds to it: the startup package, a writable encrypted volume in place of
the tmpfs overlay, and a published manifest with content ids for `rpc/snp/image-fetch.mjs`.

The startup package (already specified: at most 128 KiB, hash committed by the owner on the
ledger, no fallback) is the instance's user data. For the runner image it names the components
to run and their config.

### 5.3 Volumes

This is the largest genuinely new piece.

- A volume is a host-local block device, encrypted in the guest (dm-crypt), whose key is released
  by custody to an attested instance owned by the volume's owner. The host stores ciphertext only.
- A base-image instance gets a measured read-only root plus an encrypted writable overlay volume,
  so it behaves like a normal server that keeps its state while its launch stays measured.
- A volume lives on one provider. Moving an instance means a **snapshot**: the guest streams the
  encrypted volume to Object Storage, and a new instance elsewhere restores it. This makes Object
  Storage a dependency of mobility and is the reason to build it early.
- Loss of a provider loses any volume not snapshotted. The console must say so on the volume page.

Revised 2026-11-25, two things make this smaller than first written:

- **The snapshot object format exists.** `snapshot-crypto` (`EVMSNAP1`: 1 MiB authenticated
  records, a key derived per save, a context binding owner, deployment, bucket and object) is
  what a volume snapshot is written in. What it does not give: a monotonic revision, so an old
  authentic snapshot can be replayed. The volume's current snapshot revision therefore has to be
  recorded where the owner controls it (the startup package or the ledger's options), not trusted
  from storage.
- **A volume snapshot is disk state only.** Resumable CPU and RAM state is a different thing.
  risc-box has it because it owns its machine serialiser; the native desktop does not
  (`kvm-box/guest/native/SNAPSHOTS.md`: not implemented, not qualified), and SEV-SNP guest
  migration is not attempted here. Restore means boot the image and attach the restored volume.

Object Storage is also less of a single point than first recorded: sia-s3 0.2.0 replicates
buckets across several indexers with a write quorum and recovers its index from pinned metadata
(`sia-s3/REPLICATION.md`). Whether those indexers have independent operators is the deployer's to
establish, so the console states the replica set of an endpoint instead of calling it replicated.

### 5.4 Shield GPU: one logical GPU in every instance

**Requirement (2026-11-24): full CUDA support in an instance, on Shield-protected backends.**

The instance never receives a physical card. It sees a **logical GPU** implemented inside the VM,
and a compiler decides where each piece of work runs:

```
  CUDA / HIP source ── cucc (chipStar, pinned) ──┐
  OpenCL program ───────────────────────────────┼─▶ SPIR-V ─▶ Shield compiler (LLVM pass:
  OpenGL / Vulkan shader ── patched Mesa ICD ───┘            secrecy, bounds, alias, numeric contract)
                                                                  │
                         proven lowering ◀────────────────────────┴──────────▶ everything else
                 masked FIELD_GEMM on the host's                      trusted CPU inside the VM
                 untrusted GPU, verified in the VM                    (PoCL / Mesa software path)
```

This is what makes "general" and "the card is untrusted" compatible. Every program runs and gets
a correct result; only work with a proven masking and verification contract leaves the VM;
nothing is ever sent to the card in plaintext; an unknown kernel is run locally or refused, never
forwarded. The design is the user's existing one. This document adopts it as the platform's GPU
and does not change its rules.

**What exists**, read from the source and its ledgers, not re-run here:

| Piece | Where | Demonstrated |
|---|---|---|
| Masked exact products, pads, verification | `shielded/`, Shield core C | Production inference path |
| Graph compiler and channel | `shield-compute/compiler.py`, `channel.py` | Unit and fault-injection tests |
| OpenCL logical device | `shield-compute/opencl` (patched PoCL, SVM frontend) | Host integration modes and selected Khronos SVM tests; llama.cpp and sd.cpp run through it with a Q8 contract |
| **CUDA/HIP frontend** | `shield-compute/hip` (chipStar v1.2.1, LLVM 18) | Ordinary CUDA source compiles with `cucc` and runs in the SNP desktop guest; the integer GEMM family is recognised structurally and offloaded masked with verified exchanges; six upstream CUDA/HIP programs pass on the CPU path; ten fault and lifecycle modes pass |
| OpenGL/Vulkan driver | `kvm-box/shield-graphics` | Affine integer transforms extracted from real shaders and offloaded; Firefox WebGL and Moonlight work with rendering local; selected Vulkan and GL CTS groups on the CPU path |
| Monitoring and accounting | `shield-compute/monitor` | Verified exchange and MAC counters per job |

**What "full CUDA" still needs.** These are stated by the component's own READMEs and
`IMPLEMENTATION.md`, whose acceptance checklist is open:

1. **Prebuilt CUDA binaries.** The frontend compiles source. It does not load PTX or cubins, so
   a stock PyTorch wheel or any binary built against NVIDIA's runtime does not run today. Full
   support needs a driver-API front (`libcuda` surface: contexts, modules, streams, events) and a
   PTX-to-IR path into the same compiler.
2. **The CUDA libraries.** cuBLAS and cuDNN are where real workloads spend their time and where
   matrix semantics are still visible, which makes them the best lowering targets. They need
   Shield implementations, not NVIDIA's binaries.
3. **Lowering coverage.** Offload today is the integer GEMM family, the Q8 model path and affine
   transforms. Everything else runs on the VM's CPU: correct, not accelerated. Coverage grows one
   proven rewrite at a time.
4. **Floating point.** Offload is exact field arithmetic over bounded integers. Float workloads
   need an explicit numeric contract per lowering (the Q8 work is the template); bitwise IEEE
   equivalence with a physical card is not on offer.
5. **Speed.** The ledger records masked execution slower than the CPU path for the measured
   Stable Diffusion fixture, and pad preparation costs trusted CPU time. Compatibility is the
   near claim; acceleration is per workload and must be measured before it is stated.
   *Revised 2026-11-25:* for quantised language models this is now measured. The standard OpenCL
   route was about fifty times slower than the natively integrated engine; the direct route
   (`opencl/Q8_DIRECT.md`) brings it to 91–94% of native on Qwen 0.5B and 3B, and the 27B runs
   on the live desktop (native SVN26). So an unmodified llama.cpp in an instance is expected to
   run at close to the native engine's speed. That result is for the Q8 model path through
   OpenCL. It says nothing yet about Stable Diffusion, about CUDA source through `cucc`, or about
   anything outside the recognised GEMM family.
6. **Public operands.** Offload needs one operand approved as public (model weights, by digest).
   Fully private products stay local by design.

So the honest product statement is: **every CUDA program runs protected; how much of it runs on
the card is reported, per job, from verified counters.** That report belongs in the console (a
coverage view on the GPU page: offloaded, local, refused) and is a better promise than a device
name, which the HIP README itself warns proves nothing.

**What the platform has to do.**

- Promote Shield Compute out of the kvm-box app into a maintained package (`shield/compute`,
  `shield/graphics`) beside `shielded/`, with its pinned sources and ledger. Today the
  platform's GPU lives inside one app's directory in the other repository.
- Ship the logical GPU in every image family: the toolchain (`cucc`, OpenCL ICD, Mesa ICD), the
  protected local service, and the policy for public operands, all inside the measured image.
- Add the channel to the `/vms` driver contract: a byte channel from the guest service to the
  host's worker (vsock on SNP, hv_sock on Hyper-V, the existing `shielded-bridge`), and nothing
  else. No device node, no passthrough. Admission keeps failing closed on unverified GPU
  evidence. The Hyper-V side of this exists and is live; the SNP side does not (`kvm-box/vm`
  starts no Shield service for that reason), so on SNP the channel is new work in `launch.py`
  and vm-manager and an instance there has a CPU-only logical GPU until it lands.
- Bill it as today: `gpuMilli` share of the host's worker. The share buys offload capacity; the
  local CPU path is paid for by the instance's vCPUs, so GPU-heavy instance types need more of
  both.
- Make public-operand approval an owner action with a place in the model: the owner approves
  weight digests for an instance (startup package or console), and the guest service enforces it.

**Confidential-mode cards.** A card operating in a supported confidential mode sits inside the
boundary and can be passed through whole; the product rule already says so, and the `nvidia-cc`
evidence path survives in the supervisor, `enclave attest` and the site. That is an optional
second instance type for providers who own such hardware. It is not the answer to this
requirement and nothing above depends on it.

### 5.5 Market and chain

The ledger, registry, catalog, proof of time, session vaults and custody are used as deployed.
A deployment is an instance; a catalog version is an image. The naming in the ABI stays "app" and
"deployment"; the SDK presents instance and image. **No ledger migration.** Contract consolidation
(three ledger sources, overlapping payment paths, four gas-sponsorship mechanisms, two custody
generations) is worth doing but is a separate governance decision behind a Trezor cutover and the
EIP-170 limit. This redesign must not wait on it.

Shared services add **one new standalone contract** for usage settlement (5.8). It holds its own
escrow and does not bind into the ledger, so it needs a deployment and an address-book entry, not
a migration.

### 5.6 What stays centralised, and what this changes

The control API (`relay/`, serving `api.enclave.host`) today carries account auth, billing, cert
issuance, the route map and DNS, the fleet tunnel, MCP, and the market's evidence verdicts. This
design does not remove those. It does stop adding to them: service management goes from console
to instance directly, and instance lifecycle already has a chain-only path. `relay/` is renamed
to what it is (control), and the open independence gaps in
`docs/design/decentralized-architecture.md` stay open and tracked there.

### 5.7 Service kit

One Rust crate, `enclave-service`, and the runner that hosts it. It replaces what the survey
found copied between apps (`httpd.rs` identical in 15, a SigV4 client written five times, SSO
verification ported four times, config and API-key gates in every app) and adds what shared
tenancy needs:

- HTTP serving, egress, config, health, the service descriptor;
- authentication: Enclave session, SSO token, issued credentials; SigV4 verification;
- tenant context: namespace, sealed per-tenant key, quotas;
- an S3 client, since most services keep their state in Object Storage as tenants themselves;
- the meter and the receipt signer.

A service is then its own logic plus a manifest of meters. The runner image runs several
components in one instance, so an operator can serve Notes, Scheduler, MCP Gateway and DNS from
one VM over loopback, which also removes today's rule that apps reach each other only over
public HTTPS.

### 5.8 Usage settlement

The pattern already exists on chain. `EnclaveConnectivity` settles paid bandwidth with an owner
authorization (price cap, budget, expiry) and cumulative receipts signed by a key held in the
host's enclave; it was exercised in production on 2026-10-13. Service usage follows the same
shape in a new contract, working name `EnclaveMetering`:

- **Authorize.** The tenant deposits USDC and signs
  `{serviceKey, measurement, priceSheetHash, budget, expiry}`. The tenant has verified in the
  console that `serviceKey` lives in an instance with that measurement, so no on-chain attestor
  is involved.
- **Meter.** The service counts usage per tenant inside the enclave against the price sheet the
  tenant signed. It reads the tenant's remaining budget through an RPC quorum and stops serving
  at the limit.
- **Settle.** The service signs `{tenant, authNonce, cumulativeAmount, statementHash, issuedAt}`.
  Anyone may submit it. The contract pays the operator the increase, never more than the budget,
  and never goes backwards. The itemised statement behind the hash is available to the tenant
  from the service.
- **Leave.** The tenant revokes; after a short settlement window the unspent deposit returns.

The contract knows nothing about gigabytes, requests or tokens. Units and prices live in the
price sheet and the measured meter, which keeps the contract small and lets services add meters
without a deployment. A platform share and a publisher share can be taken at settlement the way
the ledger splits runner pay today.

The service key must survive restarts and be shared by an operator's replicas, so it is held by
custody and released only to the same measurement. Card customers hold credit in the credit
vault rather than USDC; funding an authorization from credit is an integration item, and until
it exists shared services are wallet-first.

The trust statement: the tenant trusts the measured meter to count honestly, exactly as they
trust the measured service with their data, and the signed budget caps the damage either way.

## 6. Consolidation

| Area | Now | Target |
|---|---|---|
| Runtimes the host knows | Wasm manager, app guest, whole VM, retired GPU worker | VM only |
| Host agents | `supervisor.js`, `windows/node/host.mjs` | One node agent |
| Launchers | wasm_manager, guestd, vm-manager, wmi-launcher | One driver per backend behind `/vms` |
| GPU | `shielded/`, `wasm/ggml-shielded`, `kvm-box/shield-compute`, `kvm-box/shield-graphics` | One `shield/` package: core, compute, graphics |
| In-guest fronts | `m2/front`, `vmboot/front`, `rpc/snp/front.py`, `metal/guest/agent.mjs`, kvm-box controller | One guest agent, grown from `vmboot/front` and `m2/tunnel` |
| Image builders | `rpc/snp/build_image.py`, `kvm-box/vm/build_image.py`, the native desktop recipes, the app-guest image | App images on `isolation/vmboot`, one wrapper per host type |
| Desktop builds | kvm-box two-guest broker, native NucBox profile, whole SNP VM | One desktop image family, one build per backend |
| Verifiers | `verifier/` plus `relay/{snp,vbs,hvnode,pvm,shield,avf}-*`, and a copy of platform evidence in guestd and in vm-manager | One library and one refreshed evidence store, used by drivers, node, control, CLI and console |
| Catalogs | Baked-in and on-chain | On-chain, as the image registry |
| UI | Marketing site with an app store and a deployments monolith | Console with per-service modules |
| Service code | `httpd.rs` identical in 15 apps, SigV4 client written 5 times, SSO ported 4 times, tenancy per app | One `enclave-service` crate with tenancy and metering |
| Repositories | enclave and enclave-apps (sia-s3 and cron reached its `main` on 2026-11-24) | One repository; services in `services/` with the crate |
| `ops/` | 43,764 tracked files, 971 MB of dated evidence and frozen source copies | An evidence archive outside the source tree |

Removed outright: `mps-daemon/`, the retired serving half of `worker/` (its confidential-card
evidence reader is kept), `isolation/m1`, the M3 planes research, the `tools/`
probes, TUNA remnants, one-off root scripts. Each removal preserves source and provenance per
`AGENTS.md`; none of this is authorised by this document.

## 7. Path

Each step ends in something that runs. Nothing here is activated in production by merging.

0. **Consolidation: landed 2026-11-24.** kvm-box (with Shield Compute and graphics), sia-s3
   0.2.0 and cron are on enclave-apps `main`; what did not land is recorded per branch in
   `CONSOLIDATION-20261124.md` and `ops/branch-triage-20261124` and does not block this path. The
   Enclave L2 work was parked off `main` (`l2/parked-20261124`): nothing here builds on it, and
   the design already assumed Base. Still to do: merge enclave-apps into this repository as
   `services/` with history kept. That is a mechanical step and is scheduled with step 3, when
   the first code that spans both trees is written.
1. **Instance primitive on SNP.** *In progress, branch `platform/instance-primitive`.* Done
   there: slot allocation from a pool and the claim gate; sizes (a launch measurement per vCPU
   count, the deployment's `snpVm` option names one and may raise memory); images fetched by
   content address (`image.manifest`, every byte checked, the lease left unclaimed until the
   image is on disk). On `main` from others: the whole-VM front (`vmfront`) and read-only disks.
   Tried on metal0, 2026-11-25, outside any lease: a second manager on its own port, beside the
   live one, with a two-slot pool and a 3.7 MB test image wrapped by `isolation/vmboot`. The
   pool fetched the image from a gateway, booted it at 2 and at 4 vCPUs (each with its own
   measurement, memory as asked), refused a third VM, a size over its limit and a wrong
   measurement or deployment, kept both slots across a manager restart, and gave a slot back
   on delete. The network agent's check, with the certificate the host holds, accepted both
   guests, so the evidence gate of section 5.1 passes on this host today. Two faults were found
   and fixed in source: the run directory's name put QEMU's control socket past a UNIX socket
   address, and a pooled guest that ignores the power button held its slot for the 7 minutes a
   bound VM is given to stop. One was found and not fixed: the pool's verifier looks the chip's
   certificate up at AMD once per process, and AMD refuses repeated lookups, so a manager that
   restarts while refused reports its instances as starting until AMD answers; the copy the
   host already holds should be its fallback. An image must power off on the power button to
   stop in under 20 seconds.
   Left: the base image (an app image on `isolation/vmboot` with the
   startup package), `enclave vm create | ls | connect | stop`, and the evidence check
   of section 5.1. Proof: a base instance on metal0, launched by the manager under a lease, that
   a fresh client verifies and connects to.
2. **Desktop instance with its Shield GPU, on the Shield host.** Moved up from the last step.
   The Hyper-V driver maps an instance of the desktop family onto the native desktop's existing
   admission, with its Shield worker channel, and moves to the `isolation/vmboot` Shield wrapper
   when that exists, so the desktop is one app image on both host types. On SNP it is the
   `kvm-box/vm` image today, CPU only until step 7. Proof: a desktop leased as an instance on `nucbox-k11-4`, verified by
   a fresh client, running a model through the logical GPU with verified exchanges counted; and
   the same `enclave vm` commands working against both hosts.
3. **Runner image and service kit.** Wasm services as a VM image, several components per
   instance; the `enclave-service` crate with tenancy, authentication (the session pattern of
   `enclave upload`) and the meter. Proof: two accounts use one Notes endpoint, neither can read
   the other's notes, and the Wasm manager is not involved.
4. **Usage settlement.** `EnclaveMetering` with tests on a local chain, then a test network. The
   stateless RPC gateway is the first metered service because it needs no storage, and since
   images r16 and r17 its guest needs 24 to 32 GiB, which makes it cheap to host. Proof: a
   tenant authorizes a budget, uses the endpoint, the operator settles, the tenant revokes and is
   refunded the remainder. Mainnet deployment is a separate governance action.
5. **Console shell, Instances, Object Storage.** New shell on the existing core libraries;
   Instances; endpoint discovery and in-browser verification; Object Storage as the first shared
   storage service with per-tenant buckets, credentials and keys. The old dashboard stays up
   beside it. The shell and the Instances page depend only on steps 1 and 2 and are built
   alongside steps 3 and 4, not after them.
6. **Volumes and snapshots.** Encrypted volumes with custody key release; snapshots to Object
   Storage in the `snapshot-crypto` format with an owner-held revision. Proof: an instance
   restored on a second provider from a snapshot.
7. **Shield GPU as a platform package.** Promote Shield Compute and graphics into the platform
   tree; ship the logical GPU in base and desktop images; add the worker channel to the SNP
   driver; coverage view in the console; close the kvm-box release gates. Proof: an unmodified
   CUDA source program is compiled and run inside a fresh base instance with verified masked
   exchanges recorded, and a corrupted worker reply retires the service without releasing
   output. After that, and not blocking the platform, in this order: Shield cuBLAS and cuDNN
   with wider lowering, then the driver-API and PTX front for prebuilt binaries.
8. **Remaining services on the kit.** IPFS and IPNS, DNS, Depot, Scheduler, MCP Gateway,
   Inference, each as an image plus a console module.
9. **Retire.** One node agent over the two drivers, then remove the Wasm manager, the old
   dashboard and the second catalog.

Steps 1, 2 and 5 are the shortest route to something a user can see: an instance, a desktop with
a protected GPU, and a console to start them from. Step 4 is small but touches money and
governance. Steps 6 and 7 carry the most engineering risk, less than first written: the snapshot
format exists, and the speed of the masked path is measured for language models. Object Storage
is first among the storage services because the others keep their state in it; its known weakness
(a lone small PUT takes about 45 seconds and a full slab on Sia) has to be fixed there, and
packing small objects across tenants is one thing sharing makes easier.

## 8. Decisions

All settled as of 2026-11-24. The first three are the user's; the rest were left to this design.

1. **GPU.** Full CUDA through Shield's compiler; the physical card stays untrusted. After source
   compatibility ships in instances, cuBLAS and cuDNN come before the PTX front.
2. **Services are shared and metered from day one.** Dedicated is the same image with one tenant.
3. **Contracts.** The live ledger, registry and catalog are used unchanged. One new standalone
   contract for usage settlement.
4. **Custom images.** The base image plus a startup package and volumes is the customisation
   path. Third-party images go through the moderated Marketplace. Unmoderated bring-your-own
   images are not offered, because catalog moderation is mandatory platform policy.
5. **Shield-class general instances are offered**, labelled with their class. Shield hosts are
   the consumer-hardware supply the whole Shield strategy exists for, and the claims policy
   already requires the limits to sit beside the instance type. Restricting them would leave the
   general-purpose product on a single SNP machine.
6. **One repository.** enclave-apps merges into `services/` after consolidation, history kept.
   The shared crate, the runner and the images are built and versioned together; a service
   release is still its own catalog publication.
7. **First services.** RPC gateway to prove metering, Object Storage as the first real shared
   service, then Notes on top of it to prove one service consuming another.
8. **Both backends from the start (2026-11-25).** The instance contract is proven on SNP and on
   the Shield host in consecutive steps, because the protected GPU is live only on the second.
   Hyper-V is not a port made at the end.
9. **Platform evidence has one refresher, and admission is seen to work after a TCB change
   (2026-11-25).** This follows from the six days metal0 refused its own guests. It is a check
   on a host before its pool is offered, not a rewrite of the verifiers.
