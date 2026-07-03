# Tinfoil Containers Template

A GitHub template repository for deploying a pre-built Docker image as a [Tinfoil Container](https://docs.tinfoil.sh/containers/overview) (in a secure enclave)

Out of the box, this template deploys [`tinfoil-containers-hello-world`](https://github.com/tinfoilsh/tinfoil-containers-hello-world): a tiny HTTP server that reads a `MESSAGE` env var and a `GREETING_TOKEN` secret, and responds with both.

## Deploy It

1. Click **[Use this template](https://github.com/tinfoilsh/tinfoil-containers-template/generate)** → **Create a new repository**
2. In the [Tinfoil Dashboard](https://dash.tinfoil.sh), open the **Secrets** tab and add `GREETING_TOKEN` with any value
3. Release a version by running the **Tinfoil Release** workflow:
   - **CLI:** `gh workflow run tinfoil-release.yml -f version=v0.0.1`
   - **UI:** **Actions** tab → **Tinfoil Release** → **Run workflow**, then enter the version
4. **Containers** → **Deploy**, select your repo and tag, and click **Deploy**

Once running, `curl https://<container-name>.<org>.containers.tinfoil.dev` returns:

```
MESSAGE: <value from tinfoil-config.yml>
GREETING_TOKEN: <present if secret exists>
```

## Use your own image

1. If you have a prebuilt image, edit `tinfoil-config.yml` to point at the image you want to deploy: change `image:` to your `<repo>@sha256:<digest>`, adjust `env`/`secrets`/`shim` for your container, then release a new version.
2. If you have your own code in a private repo, [`tinfoil-containers-hello-world`](https://github.com/tinfoilsh/tinfoil-containers-hello-world) shows the build-and-publish side and can be added to an existing repository.
3. If you have your own code in a public repo, use the simple [`tinfoil-public-containers-template`](https://github.com/tinfoilsh/tinfoil-public-containers-template) for an all-in-one-repo example. Since the `tinfoil-config.yml` has to be public, public app code can live in the same repo as the config.

## Updating

Edit `tinfoil-config.yml`, commit, then release a new version (`gh workflow run tinfoil-release.yml -f version=v0.0.2`, or via the **Actions** tab). Then click **Update** in the dashboard. Each release creates an auditable record in the Sigstore transparency log.

## CI/CD (push-to-main deploys)

Every push to `main` runs `.github/workflows/deploy.yml`, which diffs against the
last successfully deployed commit and deploys only what changed:

| what changed | what happens |
|---|---|
| `site/**` | scp + IPFS publish to the site box (`site/deploy.sh`) |
| `relay/**` | scp + systemd restart on the relay box (`relay/deploy.sh`) |
| `contracts/<Name>.sol` | that contract deploys to Base (`scripts/deploy-*.mjs`), **after a one-click approval** on the `contract-deploy` environment; addresses are wired into both tinfoil configs + the site and committed back |
| `Dockerfile` / `supervisor.js` / `package*.json` | a new Tinfoil release (supervisor is built by `tinfoil-release.yml`) |
| `worker/**`, `mps-daemon/**`, `wasm/**` | changed sidecar images are built + digest-repinned (`scripts/release.sh`), then a Tinfoil release |
| `tinfoil-config*.yml` (non-`image:` lines) | a new Tinfoil release (config is part of the measurement) |

Releases are auto-versioned (latest `vX.Y.Z` tag, patch-bumped) and dispatch the
existing `tinfoil-release.yml` — plus `tinfoil-release-cpu.yml` when the CPU
flavor is affected (supervisor/wasm-manager/config; worker and mps are GPU-only).
A registry redeploy automatically cascades into a deployments redeploy (claims
are gated to the registry).

Deliberately still manual:

- **Approving contract deploys** — redeploys mint fresh addresses and on-chain
  state (registry entries, deployment balances) does not migrate. Approve or
  reject under the run's **Review deployments** prompt; rejecting skips the
  contract jobs and the rest of the pipeline continues on the next push.
- **Updating the running enclaves** — after a release publishes, click
  **Update** in the [Tinfoil dashboard](https://dash.tinfoil.sh) (no public API).

One-time setup on a new machine/repo: `scripts/ci-setup.sh` (SSH deploy key,
repo secrets/vars, the `contract-deploy` environment), then set
`DEPLOYER_PRIVATE_KEY` on that environment. The local `scripts/hooks/pre-push`
site-deploy hook predates this pipeline and is now redundant — disable it with
`git config --unset core.hooksPath` if you don't want pushes deploying the site
twice.

## CPU-only enclaves

The repo ships two enclave flavors, and the partition rule between them is strict: **CPU-only enclaves run only CPU deployments; GPU-enabled enclaves run only GPU deployments.**

- `tinfoil-config.yml` — the GPU flavor (supervisor + MPS daemon + GPU worker + wasm-manager). Deployments buy a share of an H200.
- `tinfoil-config.cpu.yml` — the CPU flavor (supervisor + wasm-manager only, `GPU_COUNT=0`). Deployments buy a share of the node's vCPU+RAM at the CPU rate; GPU resource fields are refused with a 422.

To spin one up:

1. Release the CPU flavor: `gh workflow run tinfoil-release-cpu.yml -f version=v0.0.1-cpu` (CPU versions must end in `-cpu`; the workflow pins the supervisor digest into `tinfoil-config.cpu.yml` and measures that config). `scripts/release.sh` repins image digests into **both** configs.
2. In the Tinfoil dashboard, deploy the `-cpu` release with the same secrets (`SECRET`, `ADMIN_TOKEN`, `REGISTRY_PRIVATE_KEY` — use a distinct registry EOA per enclave).
3. The enclave self-registers in NanRegistry like any other; callers tell the flavors apart from `/availability` (`gpu: false`).

How the partition is enforced:

- **HTTP deploys**: the supervisor sizes and prices `resources.share` against the node on a CPU enclave, against the card on a GPU enclave, and rejects requests for the other flavor.
- **On-chain deploys**: `NanDeployments.create(...)` takes a `gpu` flag (CPU deployments are priced from `cpuPricePerSec6`, GPU from `pricePerSec6`); each enclave's claim loop only adopts deployments matching its own flavor.
- **Apps**: catalog apps that need the GPU interface declare `"gpu": true` in `wasm/apps/catalog.json`; the wasm-manager refuses to launch them on a node with `NODE_HAS_GPU=0`. Apps without the flag are CPU-only and run on either flavor's wasmtime, but are placed per the deployment's flavor.

Verification caveat: verifiers that check against this repo's *latest* release (the `tinfoil-cli` default) will see the GPU flavor's measurement — verify CPU enclaves against their matching `-cpu` release explicitly.

## Documentation

For the full configuration reference, secrets management, debug mode, and more:

**[docs.tinfoil.sh/containers](https://docs.tinfoil.sh/containers/overview)**

## Support

- [Documentation](https://docs.tinfoil.sh)
- [Email Support](mailto:contact@tinfoil.sh)
