# Enclave

**Compute that cannot see your data.** Enclave is a verifiable compute platform built around one architecture: one portable app bundle and one versioned domain contract; an OS-independent hardware-isolation security contract (per-app hardware isolation, the ordinary host operating system excluded by a smaller measured trusted layer, measured identity, attestation, key and traffic binding, fail-closed verification, lifecycle cleanup); **Enclave Shield**, our protection technology for machines without confidential-computing hardware, which combines hardware-enforced per-app CPU isolation that keeps the ordinary host OS out of every app's domain, on every operating system, with masked, verified GPU offload for any GPU outside a confidential boundary, whatever processor sits beside it; and confidential hardware, which adds protection from the machine's operator and memory encryption without changing the app contract. Pick an app from the catalog, sign in with a passkey, pay by card, and it runs on a host that proved its level with verified evidence when it attached. Today that means confidential hardware (AMD SEV-SNP CPUs + NVIDIA confidential computing on the hosted fleet, and self-hosted confidential servers): TLS terminates inside the enclave and the whole chain of trust, from the CPU's attestation quote down to the exact commit of this repo that built the running image, can be verified from a browser before you send the service a byte. Billing is per second, from card credit or, if you prefer, directly from a wallet. The architecture, the isolation contract property by property, and a dated engineering note on what has been demonstrated live at https://enclave.host/develop#architecture (source: `site/develop.html`); the per-app hardware isolation research lives under `isolation/`.

- **Site / app store / dashboard:** https://enclave.host
- **Developer guide + API reference:** https://enclave.host/develop (OpenAPI spec: [site/openapi.json](site/openapi.json))
- **REST API:** https://api.enclave.host/v1 (CORS-enabled; drive it from a browser)
- **Deployed apps:** `https://<id>.app.enclave.host` (the deployment id's first 8 hex chars), TLS terminated in-enclave — or **your own domain**, with its certificate minted inside the enclave too ([docs/custom-domains.md](docs/custom-domains.md))

## Getting started: a passkey and a card

No wallet, seed phrase, browser extension or crypto is needed to use Enclave.

1. **Sign in with a passkey** at [enclave.host](https://enclave.host): Face ID, Touch ID, Windows Hello, a password manager or a security key. On a computer without a passkey, **Use your phone** shows a QR code that you approve on your phone.
2. **Add credit by card.** Payment goes through hosted Stripe Checkout, and your balance is shown in dollars.
3. **Deploy** from any app's card with a dollar budget. You can top up, suspend, resume, change the version or cancel from the dashboard. Cancelling returns unused runtime to your credit.

The platform pays all network fees. Refunds are handled by support and go back to the original card through Stripe ([docs/billing-runbook.md](docs/billing-runbook.md) §3, §6). In the terminal, `enclave login` signs the CLI in to the same account through your phone or browser ([cli/README.md](cli/README.md)).

How credit works underneath: your credit is held in a credit vault, a contract on Base that only your passkey can authorize. It can be spent only on Enclave compute: there is no withdrawal path and no admin key, so neither you nor the company can move it anywhere else. The balance is capped at $2,000. **Register a second passkey**: a lost passkey cannot be recovered by anyone, because a recovery path would mean the company holds your funds.

### Prefer a wallet?

Any Ethereum wallet works too, paying in USDC or ETH on Base, and agents use one with scoped [wallet sessions](https://enclave.host/develop#docs-sessions). A wallet gives you direct on-chain ownership of each deployment. It is also still required for the following, which credit deployments don't support yet:

- live logs and the in-browser attestation view;
- secrets and custom domains;
- config overrides;
- deploying apps that charge a publisher fee, and publishing your own apps.

## How it works

1. **Apps are Wasm components** (`wasi:http`). Anyone publishes to the on-chain app store (`EnclaveAppCatalog` on Base): the bytes go to IPFS addressed by CID, the listing, versions, and resource specs live on-chain. A version may declare an hourly publisher fee (capped on-chain, immutable per version, covered by approval): deployers see it in the rate up front and the publisher's cut of every funding forwards straight to their wallet, non-custodially. The enclave image ships no deployable apps; everything it runs is fetched by CID and hash-verified inside the enclave.
2. **Deployments are on-chain work items** (`EnclaveDeployments`: create → fund → claim → lease). A deployment references a catalog **version** (`catalog://<appId>/<versionIndex>`), the immutable wasm + config + ports record the catalog owner approved. Funding comes from card credit (the customer's credit vault creates and funds the record when they deploy) or directly in USDC (EIP-3009) or ETH. It is metered per second; top up to extend, stop anytime.
3. **Enclaves claim the work.** Each enclave self-registers in `EnclaveRegistry`, polls for funded work it can serve, claims it, and runs the app. How apps on one machine are kept apart from each other depends on the host type (see [Tenant isolation](#tenant-isolation-by-host-type) below).
4. **Every layer attests.** A release is built from this repo's release tag; the enclave's launch measurement covers the code it runs, the enclave proves that measurement in an attestation quote over the verifier's own nonce, and TLS keys never leave it. The site and CLI (`enclave attest`) check the quote client-side before connecting.

Beyond plain web apps: GPU inference via `wasi-nn` (ONNX, GGUF through a bundled llama.cpp backend, and image diffusion through a stable-diffusion.cpp backend, on an MPS-capped GPU slice), attested read-only **model volumes** mounted at `/models` (dm-verity images; the attestation commits to the exact weight bytes), raw TCP/UDP services behind an SNI relay, and per-deployment dedicated IPv6 (inbound and outbound).

## Tenant isolation, by host type

"The TEE protects tenants from the host" and "tenants are protected from each other" are separate properties. Which boundary sits between two customers on the same machine depends on the host:

| host type | boundary between two customers' apps |
|---|---|
| **Enclave Shield hosts** (Windows) | **A separate VM per app.** Every market deployment runs in its own Hyper-V partition (`windows/vbslike/manager`), and market scope refuses any other placement (`windows/node/host.mjs`). Separation between apps is enforced by the hypervisor, not a process boundary. These hosts do not yet exclude their own operator: the launcher that signs the report runs in the root partition. |
| **pVM phone hosts** | **A separate protected VM per app** (`relay/pvm-app-attest.mjs`, backend `avf-pvm-per-app`). CPU only. |
| **Confidential servers** (SEV-SNP, e.g. metal0) | **A separate SEV-SNP guest per app.** The node's own confidential VM runs the control plane only; `isolation/m4/guestd` launches every app in its own SNP guest on the same machine, the app's TLS ends inside that guest, and the node serves only deployments that require this isolation. App-vs-app separation is enforced by the processor, and each guest is also protected from the host and its operator. The node side is `metal/` (`isolation.backend: "snp-guest-per-app"`), the guest side `isolation/m4/guestd`. |
| **Shared-VM hosts** (the original hosted fleet, retired 2026-10; none serving today) | **Shared confidential VM, separate process per app.** The hardware boundary is around the whole VM and protects every tenant from the host. Inside it, each app is its own `wasmtime` process with a loopback wall between apps, so a sandbox escape in one app would reach the others on that VM. This is the original design. |

**GPU sharing.** Tenant code never runs on the GPU. A Wasm app reaches the card only through the platform's own `wasi-nn` backends (llama.cpp, ONNX Runtime, stable-diffusion.cpp), so no device pointer or kernel crosses the boundary (raw PTX submission is refused). A GPU outside a confidential boundary is used only through Enclave Shield's masked, verified offload (`shielded/`). NVIDIA MPS appeared only in the retired shared-VM GPU flavors, where it divided capacity; it was not an isolation boundary there, and NVIDIA does not present it as one.

Every host serving today runs one VM per app. The shared-VM model applied only to the retired hosted flavors.

## Repository layout

| path | what it is |
|---|---|
| `supervisor.js` | the in-enclave service: REST API, deployment lifecycle, metering, attestation endpoints |
| `wasm/` | wasm-manager sidecar: the wasmtime sandbox that runs tenant apps, incl. `wasi-nn` inference (ONNX Runtime + llama.cpp/GGUF + stable-diffusion.cpp) on MPS-capped GPU slices |
| `worker/` | GPU worker: per-tenant MPS-capped GPU processes for raw PTX submission |
| `mps-daemon/` | NVIDIA MPS control daemon (fractional GPU shares) |
| `shielded/` | the GPU offload component of **Enclave Shield**: inference on an *untrusted* GPU, where activations and KV cache never leave the trusted domain in plaintext. Required for any card outside a confidential boundary, on any host; the large-model performance research on it is a separate line of work with unpublished numbers. Engine code exists (CUDA and Vulkan workers here, the TEE-side ggml backend under `wasm/ggml-shielded/`) and runs on one self-hosted confidential server; not on the hosted fleet ([docs](docs/shielded-inference.md)) |
| `isolation/` | per-app hardware isolation research: the backend-neutral app-domain contract (`contract/`), and milestones M1 to M4 with their evidence scripts; M4a (one SEV-SNP guest per app, `m4/guestd`) runs in production on metal0; M4b is design. Where a milestone also runs the same image on ordinary KVM, that run is a control for the confidential path, not a product tier: there is no ordinary-Linux host backend, and none is built or listed unless a hardware-enforced, measured boundary excludes the host OS |
| `windows/` | the Windows host: the live VBS-enclave node (`node/`, `vbs/`), and the partition-per-app backend built on Hyper-V partitions with the same guest image as Linux (`vbslike/`): the isolation manager the Windows host installer runs for every market deployment |
| `contracts/` | Solidity on Base: `EnclaveRegistry`, `EnclaveAppCatalog`, `EnclaveDeployments`, and for card customers `EnclaveCreditVault` (passkey-signed, closed-loop credit) |
| `relay/` | SNI relay + dedicated-IP relay (TLS passthrough to enclaves, IPv6 ingress/egress) + the API gateway with the MCP server for coding agents (`mcp.enclave.host`) |
| `egress.js` / `net-guard.mjs` | outbound egress shim and network guard |
| `site/` | the enclave.host static site, published to IPFS (LWC-style web components, soft-nav router; `npm run build:site`) |
| `cli/` | the `enclave` CLI (deploy, fund, attest-verify from a terminal) |
| `enclaves/` | the release's enclave config (`cpu/config.yml`): supervisor environment + image pins a metal guest is built from |
| `scripts/` | build, release, and CI setup |
| `test/` | `npm test` (node --test) |

## Resources: apps declare specs, deployments buy shares

**Apps** declare their exact resource specs in the on-chain catalog (EnclaveAppCatalog): `vramMb` + `gpuGflops` of one GPU card (both 0 = CPU-only app) and `memMb` + `cpuGflops` of the node (compute in GFLOPS = 1/1000 TFLOPS). Every deployment references a catalog version (`catalog://<appId>/<versionIndex>`); the enclave image ships no deployable apps.

**Deployments** buy exactly TWO shares, the only two settings on the deploy page:

- **`gpuShare`** (0–100%): a slice of ONE GPU card. VRAM and compute move together: the same fraction caps both (MPS compute % + VRAM cap). 0 = CPU-only app.
- **`cpuShare`** (1–100%): a slice of the node's vCPU+RAM. The wasm guest's memory cap is that slice of the node's RAM.

The app's specs set the **minimum shares**: each pool's floor is the spec divided by the server's spec, taking the **larger** of the memory and compute axes, rounded up to the whole percent. Server specs on today's fleet: card = 141 GB / 989 TFLOPS (VRAM is probed from the card at boot via `nvidia-smi memory.total`, `GPU_VRAM_GB` is only the fallback; compute via `GPU_TFLOPS`); node = 64 GB / ~1000 GFLOPS (`NODE_RAM_GB`/`NODE_GFLOPS`; CPU compute is denominated in GFLOPS because a whole node is only ~1/1000 of a card). Each axis floors on its own hardware: the two shares are **independent** (ledger schema 13). Earlier ledgers also required **`gpuShare >= cpuShare` whenever `gpuShare > 0`**, which lifted a GPU app's GPU minimum to its CPU minimum and forced CPU-heavy apps to over-buy card; clients still apply that lift when the live ledger predates 13. Runners enforce the minimums at deploy and claim time; the site's deploy page floors its two dials at them.

The leftovers are the point: a tenant buying 100% GPU + 10% CPU leaves 90% of that node's CPU/RAM rentable by CPU-only apps. Pricing is additive: `rate = gpuShare × cardRate + cpuShare × nodeRate`, per second. The current rates live on-chain in `EnclaveDeployments` and are shown live on [enclave.host](https://enclave.host).

Routing: GPU work (`gpuShare > 0`) runs **only** on GPU-enabled enclaves. CPU-only work is served by CPU-only enclaves first; GPU enclaves bid on it only after a grace window (`CPU_CLAIM_GRACE_SEC`, default 120s) and only out of leftover CPU pool.

## Releases (operators)

`enclaves/cpu/config.yml` is the release's enclave config: the supervisor's non-secret environment (`GPU_COUNT=0`, CPU-enclave mode, the contract addresses) and the digest pin of the wasm-manager image. A release is a `vX.Y.Z-cpu` tag plus its GitHub Release, cut by `.github/workflows/release-cpu.yml`, which also builds `ghcr.io/enclavehost/enclave-supervisor:vX.Y.Z-cpu`. Metal boxes follow it: `metal/update.mjs` takes the newest `-cpu` release and builds the guest image at that tag (`metal/build-image.mjs`), health-gated with rollback; see [metal/README.md](metal/README.md) to run one. The GPU flavors (`enclaves/gpu`, `enclaves/gpu8`) and their hosted fleet were retired on 2026-10-14.

How the routing is enforced:

- **Deploys**: the supervisor floors `resources.{gpuShare, cpuShare}` at the app's spec-derived minimums and refuses `gpuShare > 0` on a CPU enclave. The two shares are otherwise independent — a GPU app may buy more node than card. CPU-only requests are served on either flavor from the node's CPU pool.
- **On-chain**: `EnclaveDeployments.create(appRef, gpuMilli, cpuMilli, ...)` takes the two shares in 1/1000ths (the contract bounds each and prices both additively; from schema 13 they are independent of one another). GPU enclaves only adopt `gpuMilli > 0` work; CPU-only work goes to CPU enclaves first, with GPU enclaves as a delayed fallback (`CPU_CLAIM_GRACE_SEC`). Each runner re-derives the app's minimum shares from its catalog specs (via `cidStatus`) and skips under-provisioned deployments.
- **Apps**: catalog apps declare exact specs on-chain on four axes: `vramMb`/`gpuGflops`/`memMb`/`cpuGflops` (EnclaveAppCatalog, returned by `cidStatus`). Those specs only set minimum shares; GPU-needing apps are refused on nodes with `NODE_HAS_GPU=0`.

## CI/CD (push-to-main deploys)

Every push to `main` runs `.github/workflows/deploy.yml`, which diffs against the
last successfully deployed commit and deploys only what changed:

| what changed | what happens |
|---|---|
| `site/**` | scp + IPFS publish to the site box (`site/deploy.sh`) |
| `relay/**` | scp + systemd restart on the relay box (`relay/deploy.sh`) |
| `contracts/<Name>.sol` | that contract deploys to Base (`scripts/deploy-*.mjs`), **after a one-click approval** on the `contract-deploy` environment; addresses are wired into `enclaves/cpu/config.yml` + the site and committed back |
| `Dockerfile` / `supervisor.js` / `package*.json` | a new release (`release-cpu.yml` builds the supervisor image, tags `vX.Y.Z-cpu` and publishes the GitHub Release) |
| `wasm/**` | the wasm-manager image is built + digest-repinned (`scripts/release.sh`), then a release |
| `metal/**` (code) | a new release (metal boxes build the guest image at the tag) |
| `enclaves/cpu/config.yml` (non-`image:` lines) | a new release (the supervisor environment is part of the guest image) |

Releases are auto-versioned (the latest `vX.Y.Z` / `vX.Y.Z-cpu` tag, patch-bumped,
released as `-cpu`) and dispatch `release-cpu.yml`. Running enclaves need nothing
from CI: each metal box pulls the newest `-cpu` release on its own timer
(`metal/update.mjs`), stages the new image beside the live one, and rolls back if
it does not come back healthy. A registry redeploy automatically cascades into a
deployments redeploy (claims are gated to the registry).

Deliberately still manual:

- **Approving contract deploys:** a CI deploy mints a fresh, empty contract at
  a new address and moves no state by itself. Approve or reject under the run's
  **Review deployments** prompt; rejecting skips the contract jobs and the rest
  of the pipeline continues on the next push. A live contract is replaced only
  by a migration (`scripts/migrate-contract.mjs`): every record, balance and
  rate cap is imported into the new revision and diffed field by field against
  the source before it is sealed. The platform re-backs refundable escrow, and
  only then does governance point the address book at it. The 2026-10-12 ledger
  cutover moved all 74 records. Customer credit vaults are
  separate contracts that never move: a factory rotation changes only the
  addresses of new vaults.

One-time setup on a new machine/repo: `scripts/ci-setup.sh` (SSH deploy key,
repo secrets/vars, the `contract-deploy` environment), then set
`DEPLOYER_PRIVATE_KEY` on that environment. The local `scripts/hooks/pre-push`
site-deploy hook predates this pipeline and is now redundant; disable it with
`git config --unset core.hooksPath` if you don't want pushes deploying the site
twice.

## Development

- `npm test` runs the supervisor/contract test suite (`test/*.test.mjs`).
- `npm install` also points `core.hooksPath` at `.githooks/`: the pre-commit and pre-push hooks refuse cryptocurrency private keys (Ethereum/Bitcoin hex, WIF, xprv, BIP39 seed phrases, keystore JSON) and, when [gitleaks](https://github.com/gitleaks/gitleaks) is on your PATH, provider tokens too. GitHub's own push protection never sees a raw wallet key, so the hook is the real block; `.github/workflows/secret-scan.yml` is the backstop. A confirmed false positive is bypassed with `--no-verify`.
- `npm run build:site` bundles the site into `site/dist/` (Tailwind + esbuild + build-time component prerender). `site/` itself is valid unbundled ES modules; serve it raw for dev, or `npm run watch:site` for CSS. Site URLs are extensionless (`/apps`, `/dashboard`): `site/_redirects` rewrites them on the DNSLink/subdomain IPFS gateway, and the router always fetches the real `.html` files, so soft navigation works on any dumb static server; only a HARD reload of a pretty URL needs rewrite support (use `npx serve site`, or just hit the `.html` path; the router re-prettifies the bar).
- `site/deploy.sh` builds and publishes the site to the box and IPFS (the IPNS gateway caches ~5 min). CI does this automatically on push.

## Documentation & support

- App developers: the guide and API reference live on the site at https://enclave.host/develop
- Coding agents: MCP server at `https://mcp.enclave.host` (Streamable HTTP) exposing the full platform surface as tools; state changes come back as unsigned Base transactions, keys stay with the agent (`claude mcp add --transport http enclave https://mcp.enclave.host`)

## License

Enclave is commercial, proprietary software. The source is published so anyone
can audit it and verify that the running enclave images match this repo — see
[LICENSE](LICENSE) for exactly what that permits (reading, auditing, local
verification builds, and using the CLI against the hosted service) and what it
doesn't (production use, redistribution, or running your own service from it).
Third-party components (`site/vendor/`, upstream patches, build-time
dependencies) remain under their own licenses — attribution and license
copies for everything distributed with the built artifacts live in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) (regenerate with
`node scripts/build-notices.mjs` after dependency changes).
