# get / ipfs / sia.enclavehost.eth: current routes, authority and the minimal integration path (source review, 2026-10-22)

Read-only review of source and local reports: no SSH, RPC, secrets, wallet, build or test.

Sources:
- the native-control checkout `work/resume-after-checkpoint-20261022/native-control-attested/repo` at HEAD `ca311820`;
  every file cited below is unchanged from `8e77ff1e`, for example `relay/native-discovery.mjs` `cccd3029`;
- the control-VM scripts and snapshots under `work/control-vm/`.

Nothing was edited. Live state is inferred from the recorded scripts and snapshots; section 5 gives read-only commands
to confirm it.

## 1. What each name does today (evidence)

| | get.enclavehost.eth | ipfs.enclavehost.eth | sia.enclavehost.eth |
|---|---|---|---|
| TLS | SAN on the ONE shared native leaf from `/var/lib/enclave-native-ca/services.key` (control VM on minipc), CN api.enclavehost.eth, 7 days (`control-vm/renew-native-cert.py:10` 045ad743) | same leaf | same leaf |
| native discovery | **404 no_current_route**: `routeFor` knows only api/mcp and `<8hex>.app.enclavehost.eth` (`relay/native-discovery.mjs:8,24`; the deployed original `control-vm/native-discovery.original.mjs` is the same) | 404 | 404 |
| provider native ingress | not routed: `localRoutes` adds only api/mcp.enclavehost.eth and the provider IP (`control-vm/prepare-native-ingress.py:41`); unknown SNI stays closed (`docs/design/nan-retirement.md:150`) | not routed | not routed |
| control-TLS front (minipc) | no host route: `enclave-control-tls` copied only the api/mcp/get.**enclave.host** routes (`control-vm/stage-control-live.py:34-37`). Inserted path routes `/native/*` and `/recovery-health` match any host (`install-native-control.py:9`) | same | same |
| WebPKI twin and its handler | `get.enclave.host`: Caddy file_server over `/opt/enclave-get` (`/`, `/install.sh`, `/install.ps1`, `/host.ps1`, `/windows/*`, `/android/*`, `*.apk`; `caddy-shape.json` routes[3]) | `ipfs.enclave.host`: local gateway `127.0.0.1:8080` plus the **s3-ipfs-adapter app** `7ae476a3.app.enclave.host:443`, uploads with CORS (routes[1]); adapter deployment `0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33` | `sia.enclave.host`: indexd application API through the 4 DigitalOcean (DO) addresses, then a reverse SSH tunnel to the minipc `enclave-storage` VM (`storage-hosted-placement/inventory/current-storage-chain.json`) |

Conclusions:
- **The three .eth names are served by nothing today.** Their only presence is as SANs on a NON-attested key held on
  the minipc control VM. "Preserving exact behaviour" therefore means they stay unserved until an authenticated
  replacement exists.
- **The real dependency is a latent one, not a route.** Any client that trusts the native CA for these names would
  accept whoever holds `services.key`: one minipc VM, not bound to any app, host or lease.
- **The ENS record for enclavehost.eth carries no text keys** (`control-vm/ens-native-read.log`), so no name binding
  exists on chain either.

## 2. Authority that exists, and what is missing

| primitive | binds | usable here? |
|---|---|---|
| `network/native-control-routes.mjs` + guest `nativeControl` (37c75086, measured-control.mjs:205) | api/mcp only (`NATIVE_NAMES`) to an attested control key, the original registry row and a fresh policy decision | no: control guests only; extending `NATIVE_NAMES` would put storage/download behind the platform API role, which is wrong |
| `network/native-client.mjs` (6aca6c7e) | an explicit profile `{deploymentId (full 32 bytes), hostname}`; signed public route records filtered to THAT deployment (:92-110); lease identity; startup expectation; guest evidence; `hostAdmission` = the platform host policy for the lease host; servername/Host select only and are never proof (:253) | **yes, for apps**: proves the correct app, and the correct host under current admin policy |
| `bootstrap-replica` host role (`network/host-services/roles.mjs:100-106` eab6f55b) + `network/cold-bootstrap.mjs` (b9baa66d) | CID-addressed artifacts, sha256 + CAR digest-checked against a PINNED manifest; cold path uses no names, fleet, storage, lease relay or app | **yes, for downloads**: content is verified by hash, so no name authority is needed |
| storage-indexer descriptor (operator EIP-191 + registry + policy; `storage-indexer-host.mjs`) | replica to package and advertise URL | for indexers, configured per sia-s3 deployment, not a public name |
| service index (`network/service-index.mjs:9-12`) | nothing: untrusted candidates | must not be serving authority |
| platform host policy (`platform-host-policy.mjs:22,39`) | host admission and bans only (registryId/chipId/operator/owner/endpoint) | admission only; holds no names |
| address book / authority profile | contract bindings only | no names |

**Missing.**
- **No admin-authoritative mapping from `ipfs` / `get` / `sia` to a deployment or manifest exists.** The service index,
  policy, book and authority profile carry none. The discovery service on minipc is the thing being removed, so it
  cannot be the authority.
- The only existing admin-controlled roots that can carry such a mapping without a new contract or trust root:
  - **the ENS name `enclavehost.eth`**, owned by the administrator. It already decides the site through its contenthash.
    It would carry either a site release that ships the pinned profiles, or text records.
  - **the owner's signed release channel** for downloads. Per `windows-release-train` memory this channel is not
    published yet and the owner release key is absent.

## 3. Minimal integration path per name (existing primitives; NO code until root review)

### ipfs.enclavehost.eth → the s3-ipfs-adapter app (an Enclave app already)

**Serving.**
- Use the existing native client with the profile `{deploymentId: 0x7ae476a3…ce33, hostname: "ipfs.enclavehost.eth" or
  the label name}`. It reaches the adapter guest on whichever admitted host holds its current lease, verified by lease,
  route records, guest evidence and fresh platform policy.
- No native-CA leaf is needed in this path: the native client authenticates the guest, not a CA name. So no new CA
  issuance authority is required.

**Binding.** The administrator publishes the profile (deployment id + expected app) through the ENS site release, which
is already admin-controlled.

**Source work needed (for review).**
- One reader in the native-client entry point: read the profile from the verified site release, and refuse on mismatch.
- No change to `service-index.mjs`, so the bundle pins hold.

**Not acceptable.** Serving `https://ipfs.enclavehost.eth` to plain browsers through the native CA. That needs a
native-CA leaf bound to the adapter guest's attested key, the `nativeControl` pattern for Shield app guests. It does not
exist, would be new code, and needs the CA holder's issuance (the `ca.key` on the control VM) under that binding.
Defer it.

### get.enclavehost.eth → bootstrap-replica artifacts

**Serving.**
- Clients fetch by CID from any admitted `bootstrap-replica` (HS2 on nucbox already serves its manifest:
  `outputs/decentralization-audit/host-services-r5-activation.json`), verified against the pinned manifest. This
  avoids the discovery/storage cycle: `notCold` covers discovery, storage adapters, lease relays and apps.

**Path behaviour.** Keeping `/install.sh`, `/install.ps1`, `/host.ps1`, `/windows/*`, `/android/*` and `*.apk`
requires a path → CID manifest signed by the release owner. That is the unpublished signed channel; its key is absent,
which is a **hard prerequisite**, not new design. Until then the name stays unserved, as today.

### sia.enclavehost.eth → no public replacement

- **Indexer endpoints are per-deployment configuration** (`$SIAS3_REPLICAS`, owner secret) plus operator-signed,
  policy-admitted descriptors.
- **No client resolves an indexer by a public name.** Mapping one public name to one indexer would recreate the single
  authority.
- Keep it unserved.

## 4. Smallest concrete next step (root, live; no new code)

1. Drop `get`, `ipfs` and `sia.enclavehost.eth` from the shared services leaf at its next renewal: the SAN line of
   `renew-native-cert.py:10`.
   - Nothing routes these names, so behaviour is unchanged.
   - It removes the minipc-held, unattested key's power over them.
   - api/mcp follow the native-control worker's attested path.
2. Decide the binding root for ipfs: an ENS site release that ships the pinned native profile (recommended; an
   existing admin authority). Root then reviews the one small reader in section 3.
3. Publish the signed release channel. Its owner key is a prerequisite for `get`.

Activation criteria for ipfs. All three must hold:
- the native client resolves through ≥ 2 non-DO admitted hosts;
- route records match deployment `0x7ae476a3…`;
- an admin ban of the lease host makes the route refuse.

Moving the minipc proxy, or DO, does not count as completion.

## 5. Read-only confirmations for root (live; no change)

- `curl -s 'https://<provider-ip>/native/resolve?name=get.enclavehost.eth'` (also for ipfs and sia): expect 404
  `no_current_route`.
- On a provider: `jq '.localRoutes|keys' /etc/enclave-network/provider-pinned-8b37c37.json`: expect no
  get/ipfs/sia.enclavehost.eth.
- On the control VM:
  - `jq '[..|.host?|select(.)]' /etc/enclave-control-tls/caddy.json`: expect no `.enclavehost.eth` host route for the three.
  - `openssl x509 -noout -ext subjectAltName -in /var/lib/enclave-control-tls/native/services.pem`: expect the five SANs.

## Governance and limits

- Admin controls are kept: platform policy bans apply to every route, and the binding root (ENS / release key) is
  admin-held.
- No new contract, trust root or immutable bypass.
- Advertiser labels and generic host checks are never treated as proof of the app.
- Live state is inferred from the 2026-10-19 snapshots and scripts until section 5 is run.
