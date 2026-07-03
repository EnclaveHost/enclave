# Cloud Provider Containers Template

A GitHub template repository for deploying a pre-built Docker image as a [Cloud Provider Container](https://docs.Cloud Provider.sh/containers/overview) (in a secure enclave)

Out of the box, this template deploys [`Cloud Provider-containers-hello-world`](https://github.com/Cloud Providersh/Cloud Provider-containers-hello-world): a tiny HTTP server that reads a `MESSAGE` env var and a `GREETING_TOKEN` secret, and responds with both.

## Deploy It

1. Click **[Use this template](https://github.com/Cloud Providersh/Cloud Provider-containers-template/generate)** → **Create a new repository**
2. In the [Cloud Provider Dashboard](https://dash.Cloud Provider.sh), open the **Secrets** tab and add `GREETING_TOKEN` with any value
3. Release a version by running the **Cloud Provider Release** workflow:
   - **CLI:** `gh workflow run Cloud Provider-release.yml -f version=v0.0.1`
   - **UI:** **Actions** tab → **Cloud Provider Release** → **Run workflow**, then enter the version
4. **Containers** → **Deploy**, select your repo and tag, and click **Deploy**

Once running, `curl https://<container-name>.<org>.containers.Cloud Provider.dev` returns:

```
MESSAGE: <value from Cloud Provider-config.yml>
GREETING_TOKEN: <present if secret exists>
```

## Use your own image

1. If you have a prebuilt image, edit `Cloud Provider-config.yml` to point at the image you want to deploy: change `image:` to your `<repo>@sha256:<digest>`, adjust `env`/`secrets`/`shim` for your container, then release a new version.
2. If you have your own code in a private repo, [`Cloud Provider-containers-hello-world`](https://github.com/Cloud Providersh/Cloud Provider-containers-hello-world) shows the build-and-publish side and can be added to an existing repository.
3. If you have your own code in a public repo, use the simple [`Cloud Provider-public-containers-template`](https://github.com/Cloud Providersh/Cloud Provider-public-containers-template) for an all-in-one-repo example. Since the `Cloud Provider-config.yml` has to be public, public app code can live in the same repo as the config.

## Updating

Edit `Cloud Provider-config.yml`, commit, then release a new version (`gh workflow run Cloud Provider-release.yml -f version=v0.0.2`, or via the **Actions** tab). Then click **Update** in the dashboard. Each release creates an auditable record in the Sigstore transparency log.

## CPU-only enclaves

The repo ships two enclave flavors, and the partition rule between them is strict: **CPU-only enclaves run only CPU deployments; GPU-enabled enclaves run only GPU deployments.**

- `Cloud Provider-config.yml` — the GPU flavor (supervisor + MPS daemon + GPU worker + wasm-manager). Deployments buy a share of an H200.
- `Cloud Provider-config.cpu.yml` — the CPU flavor (supervisor + wasm-manager only, `GPU_COUNT=0`). Deployments buy a share of the node's vCPU+RAM at the CPU rate; GPU resource fields are refused with a 422.

To spin one up:

1. Release the CPU flavor: `gh workflow run Cloud Provider-release-cpu.yml -f version=v0.0.1-cpu` (CPU versions must end in `-cpu`; the workflow pins the supervisor digest into `Cloud Provider-config.cpu.yml` and measures that config). `scripts/release.sh` repins image digests into **both** configs.
2. In the Cloud Provider dashboard, deploy the `-cpu` release with the same secrets (`SECRET`, `ADMIN_TOKEN`, `REGISTRY_PRIVATE_KEY` — use a distinct registry EOA per enclave).
3. The enclave self-registers in NanRegistry like any other; callers tell the flavors apart from `/availability` (`gpu: false`).

How the partition is enforced:

- **HTTP deploys**: the supervisor sizes and prices `resources.share` against the node on a CPU enclave, against the card on a GPU enclave, and rejects requests for the other flavor.
- **On-chain deploys**: `NanDeployments.create(...)` takes a `gpu` flag (CPU deployments are priced from `cpuPricePerSec6`, GPU from `pricePerSec6`); each enclave's claim loop only adopts deployments matching its own flavor.
- **Apps**: catalog apps that need the GPU interface declare `"gpu": true` in `wasm/apps/catalog.json`; the wasm-manager refuses to launch them on a node with `NODE_HAS_GPU=0`. Apps without the flag are CPU-only and run on either flavor's wasmtime, but are placed per the deployment's flavor.

Verification caveat: verifiers that check against this repo's *latest* release (the `Cloud Provider-cli` default) will see the GPU flavor's measurement — verify CPU enclaves against their matching `-cpu` release explicitly.

## Documentation

For the full configuration reference, secrets management, debug mode, and more:

**[docs.Cloud Provider.sh/containers](https://docs.Cloud Provider.sh/containers/overview)**

## Support

- [Documentation](https://docs.Cloud Provider.sh)
- [Email Support](mailto:contact@Cloud Provider.sh)
