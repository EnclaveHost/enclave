# site-host: publish, deploy, activate and roll back (ROOT; nothing here has been executed)

Package (deliver/package/PACKAGE.json):
- **`site_host.wasm`:** sha256 `70d2728438738417383d4b78546617ecd2f1241047b35c9a2269c5bf392e52a1`, 45 611 522 bytes.
- **Embedded release:** `bafybeiex25avvxryg6vzw7d57npdliy5qtfuss3c5lrbk5i5o7tx4kzgdi` (CAR sha256 `9ff91d28…`, 45 381 289
  bytes, 763 blocks).
- **Source digest:** `622674be…` (20 files).
- **Toolchain:** nightly-2026-07-25 (pinned), `--locked`, paths remapped.
- **Reproducibility:** two builds, from two directories and two input forms, gave the identical wasm.

Contracts and chain: the CLI's own defaults, only the original, current contracts.
- Base (8453).
- Addresses are resolved at start from EnclaveAddressBook `0xab214342d5A490150A4A977063A2f88E21F80907`. The catalog
  fallback is `0x18419CA2b502D423A8de6269AEeE171a378626e3`, the registry `0x868eB7fc…`.
- No alternate or optional contract is used.

Every step below is the established `enclave` CLI flow. Signing (verified in cli/enclave.mjs, `loadKey`, `externalAccount`):
- **Hosted (default) mode.** `--signer <rpc> --from <addr>` (Frame/Clef) signs TRANSACTIONS only. Publish's upload
  token is a signed MESSAGE, and deploy's funding is EIP-3009 TYPED DATA, so in this mode both need the publishing
  wallet's key in the CLI (`ENCLAVE_KEY` or the key file) for those two steps.
- **Independent mode.** `enclave --independent … --signer <rpc> --from <addr>` uses cli/independent-signer.mjs, which
  checks and signs transactions, messages and typed data externally. It needs a reviewed independent profile, and
  publish then uses `--storage-plan … --contract-pins …`.
- `--unsigned --from <addr>` prints single transactions only. It cannot express the message/typed-data steps (the CLI
  says so: `EXTERNAL_SIGN_HINT`).
- I ran no step: no wallet prompt, broadcast, funding or spend has happened.

## 0. Status

| Item | State |
| --- | --- |
| site-host source placement (enclave-apps/site-host, patch `554a15e1…`) | **staged** (verified to apply to enclave-apps HEAD 50f93d7, no overlap with its uncommitted edits) |
| wasm package `70d27284…` | **verified**: reproducible; e2e 6/6 on four engines (section 5) |
| catalog version | not started |
| deployments, DNS/certificate/ingress, IPNS | not started |
| end-to-end decentralization | **not claimed**: the package does not prove it (section 6) |

## 1. Prerequisites (external, concrete)

1. **The release bytes.** Either the frozen `work/private-browser-final-release/release/bafybeiex…/` or any copy of
   that CID. `scripts/build.sh` refuses any other bytes.
2. **Wallets.**
   - The publishing wallet should be the EnclaveAppCatalog OWNER. A version starts Pending unless the owner
     publishes it (EnclaveAppCatalog.sol 441/451), and hosts refuse Pending versions for PUBLIC deployments
     (supervisor.js 1875-1881).
   - If another wallet publishes, the catalog owner must approve the version on the site's Apps admin page
     (`setApproval`). There is no CLI approve command.
   - Base ETH for gas, plus USDC for lease funding.
3. **Upload path for the 45.6 MB wasm.** One of:
   - (a) the default `https://ipfs.enclave.host/add-wasm`, with a token from `api.enclave.host/v1/apps/upload-token`.
     Today that name is the s3-ipfs-adapter tenant behind the DO-resolved name, and it has returned 502 when no host
     ran the adapter (windows/enclave-rt/REPORT.md);
   - (b) `--storage-plan plan.json --contract-pins <pins> --wallet`, with 2–8 non-DO s3-ipfs-adapter replicas
     (sdk/storage/replicas.mjs format), so the artifact is not pinned only behind DO.
4. **Host-side fetch.** Each serving host's `IPFS_GATEWAYS` / `IPFS_GATEWAY` / `artifact-gateways.json` must list a
   gateway that holds the CID.
   - In list mode each gateway gets at most 30 s (wasm/ipfs_fetch.py), so 45.6 MB needs ≥ ~1.6 MB/s from one of
     them. A single configured gateway gets the full 660 s.
   - The fetch is CAR-verified, so the gateway is untrusted.
5. **Serving hosts.** Known non-DO Enclave hosts, all at ONE physical site and uplink, so they are not provider-failure
   independence:
   - **warden-host / metal0** (Linux, SEV-SNP): the shared tier (wasm manager + the fleet engine) and per-app SNP
     guests (guestd, direct bootstrap).
   - **minipc** (Windows, VBS/Hyper-V partition per app): the deployed 2026-10-01 CPU image (IGVM `20e63b2a…`,
     measurement `88d6ff18…`, wasmtime 48.0.1, RuntimeID `ccadb38a…`).
     - That image is admitted with `configBundleV5: true` (windows/installer/admitted-shield-policy.json).
     - The installer sets `ENCLAVE_CONFIG_BUNDLE_V5=1`, so the version's `{"release": …}` reaches the guest as
       `ENCLAVE_CONFIG`.
     - A host whose manager runs WITHOUT V5 refuses this deployment ("carries app config"). It does not serve it
       unpinned.
   - **Pixel** (Android): apps run in the pVM market (relay/pvm-market.mjs, 256 MiB component cap, recorded runtime
     wasmtime 49.0.0, Pulley interpreter). Its serve path is not in local source and is **unverified**; only a local
     Pulley approximation passed (section 5).
   - The legacy public network `5.78.85.108`: availability not established either way; it is not assumed.
   - The four DO machines stay a transport-only target and are not chosen as serving hosts.
6. **Public ingress (not provided by this package).**
   - The `<label>.app.enclave.host` names, `enclave.host` itself, the BYO-domain certificate (relay/domains.js flow
     on the dashboard), and the DNS that answers for them all still depend on the relay/DNS edge.
   - warden and minipc have private IPv4 only (outputs/decentralization-audit/non-do-ingress-local-observation.json).
   - Needed before activation: the certificate worker's Enclave-host DNS replicas, and an ingress decision (S4) for
     non-DO reachability.
7. **The site's own API.**
   - The release has no built-in network profile, so its default UI calls `api.enclave.host`. That fronts the control
     VM on minipc, still an ordinary singleton.
   - Placing the platform API/account/identity/billing is owned by Claude 7cfd0800 (work/platform-api-hosted,
     interface work/platform-api-hosted-interface.txt).
   - Until that lands, a site-host deployment serves the static site, and the API stays a singleton dependency.

## 2. Build (anyone, reproducibly)

```sh
cd enclave-apps && git apply site-host-554a15e1….patch      # or the source tree as delivered
cd site-host
CARGO_NET_OFFLINE=true scripts/build.sh --release <dir>/bafybeiex25avvxryg6vzw7d57npdliy5qtfuss3c5lrbk5i5o7tx4kzgdi
#   or: scripts/build.sh --car <path>/site.car
sha256sum dist/site_host.wasm     # must print 70d2728438738417383d4b78546617ecd2f1241047b35c9a2269c5bf392e52a1
WASMTIME=<fleet engine> scripts/test.sh <release dir>    # optional re-verification
```

Measured resources:
- **Build:** the job peaked at 704 MiB (rustc 671), about 10 s per build.
- **Serving:** ≈180–217 MiB peak RSS per `wasmtime serve` process (VmHWM; JIT engines). Median `/dashboard` latency
  3.6–4.0 ms with a new instance per request (52 ms under the Pulley interpreter).
- **Memory floor:** the instance holds the 44 MB data segment plus the largest file twice (body and range copy). Keep
  the deployment's memory ≥ 256 MiB.
  - On the shared tier, memory = cpu share × node RAM, with a 64 MiB floor (wasm_manager.py). Choose `--cpu` so the
    product is ≥ 256 MiB.
  - Per-app guests get ≥ 1024 MiB.

## 3. Publish (ROOT signs)

```sh
# P1 (optional; prerequisite 3b): replicate the artifact off DO first and verify every copy
enclave artifact publish dist/site_host.wasm --kind wasm --storage-plan plan.json --wallet        # signs per-replica upload messages: local key, or --independent --signer
enclave artifact verify  dist/site_host.wasm --storage-plan plan.json

# P2: the catalog version. The version config IS the pin; the CLI stamps `wasi` from the binary.
enclave publish dist/site_host.wasm --slug enclave-site --name "Enclave site" \
  --desc "The enclave.host website, served from one embedded, CID-verified release" \
  --mem 256 --cpu-gflops 10 --config '{"release":"bafybeiex25avvxryg6vzw7d57npdliy5qtfuss3c5lrbk5i5o7tx4kzgdi"}' \
  --wallet                             # hosted mode: the catalog owner's key in the CLI (upload message + publishVersion)
#   off-DO upload instead: add --storage-plan plan.json --contract-pins <pins>; with --independent … --signer <rpc> --from <owner>
#   the wallet never leaves Frame/Clef
# P3 (only if P2 was not signed by the catalog owner): approve enclave-site:<n> on the site's Apps admin page.
enclave apps enclave-site              # read-only: confirm the version, its CID and its approval state
```

Catalog media (logo/banner) is optional. It is published from the site's publish form (`/add-image`) and is not
needed for serving.

## 4. Deploy (ROOT signs and funds)

```sh
# D1, warden (shared tier: wasm manager + fleet engine 49.0.0). Public by default.
enclave deploy enclave-site:<n> --cpu <share with share*nodeRAM >= 256 MiB> --fund <usd>   # create (tx) + EIP-3009 fund (typed data)
# then steer and pin it to warden (strict: other hosts refuse it). There is no CLI flag for the pin:
enclave move <deployment-id> <warden name from `enclave availability`>     # claim hint ("a steer, not a lock")
#   dashboard: the deployment's Placement → warden, no fallback  (envelope {"placement":{"hostId":"0x<warden>"}})

# D2, minipc (Windows Hyper-V partition per app, deployed 48.0.1 image with config bundle V5)
enclave deploy enclave-site:<n> --isolation hyperv-partition-per-app --cpu <share> --fund <usd>
#   the CLI refuses unless a live host advertises that tier; only that tier's runners claim it

enclave status <id>                     # claimed by the intended host, Running
```
Signing for D1/D2 follows the rules at the top. In hosted mode the owner's key in the CLI signs, or `--signer` for the
create transaction. `deploy --unsigned --from <owner>` prints the create transaction alone and stops; funding is then
`enclave fund <id> --usdc <usd>` with a key that can sign typed data.

Window between funding and the D1 pin: any admitted shared-tier host may claim it first. The claim hint and the pin
narrow this; the CLI cannot set the pin at create. A host that would claim must still pass every platform gate
(admission, catalog approval, host policy).

## 5. Verification evidence (deliver/package-job.log, one queued job, rc=0)

| Engine (exactly what serves it) | e2e | /dashboard median | peak RSS |
| --- | --- | --- | --- |
| fleet engine wasmtime 49.0.0 ac0772970: `/bin/wasmtime` of `ghcr.io/enclavehost/enclave-wasmtime@sha256:13bce266…` (the image `wasm/Dockerfile.wasm` pins), wasm-manager serve flags | 6/6 | 3.6 ms | 212 MiB |
| deployed Windows/m3 guest runtime wasmtime 48.0.1 7bac2c277 (sha256 `b77aecdb…`, from the build root of IGVM `20e63b2a…`), the 2026-10-01 domexec call (`serve -S cli -C cache=n --env ENCLAVE_CONFIG`, no `/config`, no memory flag) | 6/6 | 3.6 ms | 175 MiB |
| current-main m3/m2 domexec call (`-W threads,shared-everything-threads,…,memory64,component-model-memory64`) on the 49.0.0 guest runtime (`3a905020…`) | 6/6 | 4.0 ms | 181 MiB |
| Pulley interpreter, local wasmtime 49.0.3 (an APPROXIMATION of the Android pVM, not its runtime) | 6/6 | 52 ms | 203 MiB |

Further checks:
- **Input validation:** the superseded release's CAR, a truncated CAR and the superseded release directory were each
  refused against `release.lock.json`. Nothing was written.
- **Imports:** wasi:io/cli/clocks/filesystem/random@0.2.12, wasi:http/types@0.2.9, export incoming-handler@0.2.6.
  Wasmtime 47–49 ship WASI 0.2.12 and match same-minor versions in either direction (wasmtime-environ names.rs
  `alternate_lookup_key`).
- **Not re-run:** the native Rust suite (tests/site.rs, 9/9 on the earlier toolchain), because the source is
  unchanged. The new toolchain's artifact is what all four e2e runs exercised.

## 6. Activation (ROOT) and what it still does not prove

1. P1–P3, then D1/D2.
2. Probe each `https://<label>.app.enclave.host/`:
   - `/.well-known/site-host` must name `bafybeiex…`;
   - `/`, `/dashboard`, `/js/boot.js`, `/install.sh` and a 404 must match the DO Caddy's bytes and headers.
3. DNS/certificate/ingress (prerequisite 6): add the site-host fronts to the `enclave.host` answer set ALONGSIDE DO;
   mint the certificate in the site-host TEE (BYO-domain flow).
4. IPNS: `site/deploy.sh publish-plan` → the owner's setConfig of the publisher to `/ipfs/bafybeiex…`.
5. Only after an isolated all-DO-down drill passes: remove the site's Caddy root from the DO machines (WireGuard only).

**Not proven:**
- serving through hosts at one site and uplink, behind the relay/DNS edge, is not provider-failure independence;
- the static site is not the API (prerequisite 7).

## 7. Rollback

| Step | Rollback |
| --- | --- |
| P1 | Nothing to undo; replica pins can be pruned. |
| P2/P3 | Leave the version unused, or have the catalog owner delist it. A version only serves its own CID. |
| D1/D2 | `enclave refund <id>` (cancel; the remaining funds return). Or `enclave upgrade <id> enclave-site:<previous>` for a later release. |
| Pin | `enclave config set <id> '{"release":"<other>"}'` stops that deployment serving (503); it never switches content. |
| DNS | Remove the site-host fronts from the answer set. The DO Caddy root stays in place until step 5 and is kept 48h after. |
| IPNS | `site/deploy.sh publish-plan` back to the previous CID (production `bafybeig3rai3tyo…`). |
| Previous artifacts | The production release `bafybeig3…` (work/logo-site-hotfix/final) and the frozen superseded release `bafybeiffe…` stay on disk. The earlier site-host wasm `c561f4ec…` (floating nightly) is superseded and not to be published. |
