# Production consumer inventory: current placement vs the "DigitalOcean = minimal WireGuard only" constraint (read-only, 2026-10-26 11:52Z)

**Stage:** `production-consumer-inventory-20261026T1150-stage/`, containing `probes/probe-do.sh`, `raw/{us-west,ca-east,ap-southeast,eu-central}.txt` and `SHA256SUMS`.

**What was done:**
- **Fresh live access:** ONE bounded read-only SSH probe per DigitalOcean droplet, using the existing aliases at 11:52:11–14Z, plus a public DNS/HTTPS `/health` check at 11:52:49Z.
- **Probe output:** whitelisted only. Unit ActiveState/enabled/MainPID, the executable or script path and sha16, WireGuard interface names, non-loopback listen sockets, and **only** the `rpc`/`relay`/`region`/`kind`/`roles`/`chainAuthority` fields of provider configs. No env, argv, keys or credentials.
- **Not touched:** no SSH to minipc/NUCBOX or the control VM (whose jump host is minipc), because experiments may be active there; those rows reuse the 02:46–03:02Z evidence. No restart, config change, wallet action, build, test, queue job or commit.

**Evidence reused (not redone):**
- `logs/claude-current-live-consumer-inventory-result.md` (fronts and Windows, 02:46–02:50Z);
- `logs/claude-live-control-guest-result.md` (control VM, 03:00–03:02Z);
- `logs/claude-production-config-inventory.md` (RPC guest);
- `logs/claude-consumer-final-readiness.md` (source verifier status).

**Process continuity:** every DigitalOcean MainPID at 11:52Z equals the 02:46Z PID, so the 02:46Z script paths and hashes still identify those processes.

**Replaced as stale:** the earlier `claude-production-cutover-current-plan-result.md` (its 12b/8250 pins and the "4 VPS directory providers" framing) is **superseded by this file**.

## 1. Constraint evidence
- **The machines are DigitalOcean (exact):** `docs/design/enclave-network-status.md` at source 5f0e0117c (row last changed 8b16d4097, 2026-10-13) lists "4 DigitalOcean Droplets: sfo3 134.199.235.187, tor1 146.190.246.39, sgp1 165.245.191.129, fra1 134.209.248.172".
  - `~/.ssh/config` maps these exact IPs to `us-west`, `ca-east`, `ap-southeast` and `eu-central`.
  - The live `provider.json` `region` field reads sfo3/tor1/sgp1/fra1.
- **The user's constraint:** DigitalOcean = minimal WireGuard only, and actual services run on Enclave hosts/apps.
- **Public origins resolve only to DigitalOcean:** `api.enclave.host`, `mcp.enclave.host` and `enclave.host` resolve **only** to those 4 droplet IPs. At 11:52:49Z `/health` returned api 200, mcp 200 and `enclave.host` 404.

## 2. DigitalOcean droplets: actual units at 11:52Z (identical on all 4 unless noted)
| Unit (all active+enabled) | Process (path, from 02:46Z, same PID) | Public listen | Constraint verdict |
|---|---|---|---|
| `enclave-network-provider` | node `/opt/enclave-network/native-recovery-464cad3/provider.mjs` (ca-east: `hs-transport-39d1513b/wg-provider.mjs`). WireGuard interfaces `wg-guard` and `wg-exit` | udp 51820/51821, tcp 51822, :443/:80 SNI router | **Allowed core** (WireGuard guard/exit). The SNI ingress and control API are borderline: they are part of the provider design doc. It also holds an `rpc` list of 3 public Base RPCs (mainnet.base.org, publicnode, drpc), with `chainAuthority` = null in every config file, including 7–8 `*.before-*` backups per host |
| `enclave-custodian` | `/opt/enclave-custodian/current/custodian.mjs` sha16 07e2a066 → `custodian-20261014…-09895e649` | — | **VIOLATION**: a custody service runs on DigitalOcean. Its signing role is not inspected here (no key or config read) |
| `enclave-public-directory` | `/opt/enclave-directory/runtime-37366ab/enclave-directory.mjs` | tcp 8188/8189 | **VIOLATION**: directory/route-map service |
| `enclave-route-dns` + `enclave-dns-front` (dnsdist) | `/opt/enclave-route-dns/caa-e8fe12132621/dns.mjs`; `/usr/bin/dnsdist` | `<ip>:53` tcp+udp | **VIOLATION**: an authoritative DNS front on DigitalOcean. The control VM's dns-relay is also reached via tunnel :31053 |
| `enclave-bootstrap-gateway` | `/opt/enclave-retained/cc96aad/server.mjs` | — | **VIOLATION** |
| `enclave-bootstrap-tls` + `caddy` | `/usr/bin/caddy` (bootstrap-tls: no script) | caddy 127.0.0.1:8080/8443 | **VIOLATION** (local TLS/HTTP serving) |
| `enclave-lease-relay` (**eu-central only**) | `/opt/enclave-lease-relay/current` → `releases/94f4ebdf…` | — | **VIOLATION**: a lease relay (transaction submission). us-west keeps the same release dir, but no unit runs |
| sshd reverse tunnel `enclave-control-tunnel` (127.0.0.1:30443/30080/31053) | from the control VM (02:49Z/03:01Z evidence) | loopback only | Transport into the Enclave host; acceptable as plumbing |

**Net:** apart from WireGuard, the droplets run 6–7 service units each. That breaks the stated constraint, and nothing in the current activation plan moves them.

## 3. Consumer rows (verified = evidence named; unknown = not inspected)
| Consumer | Live placement | Release/ref | Chain backend now (public fields only) | Local verifier | Enclave app binding | Status |
|---|---|---|---|---|---|---|
| Public ingress `api`/`mcp.enclave.host` | DigitalOcean provider SNI → tunnel → control VM caddy `enclave-control-tls` :30443 | caddy 2.11.4 | n/a | n/a | Caddy routes `*.app.enclave.host` to 8100 (02:49Z evidence); 1 deployment `0xef514ed3…` version 2 in the route map | verified 03:01Z; health 200 at 11:52Z |
| API/MCP relay | control VM `enclave-control` (Hyper-V on NUCBOX_K11) `enclave-api-relay` :8100 | `/opt/nan-relay/api-relay.js` sha16 481f0041, nan-relay 0.1.0, **no git ref** | `BASE_RPC`/`SESSIONS_RPC` → gateway :8190; `SECRETS_RELEASE_CATALOG_RPCS` = 3 public | **none** (no `ENCLAVE_CHAIN_*`) | runs in the control VM, **not** as an Enclave app | verified 03:02Z (stale 9 h) |
| `/rpc/*` gateway | control VM `enclave-rpc-gateway` :8190 | `/opt/enclave-rpc/gateway.mjs` sha16 3b23200d, no git | public and credentialed upstreams (credentials not read) | none | control VM | verified 03:02Z. **This is the immediate RPC-replacement point** |
| Native MCP / discovery | control VM `enclave-native-discovery` :8187 | `/opt/enclave-recovery/discovery.mjs` sha16 67c7b39a | unknown | none | control VM | verified 03:01Z |
| Guest MCP | unknown | — | — | — | — | **unknown** (not inspected) |
| DNS relay | control VM `enclave-dns` :1053 | `dns-relay.js` sha16 4f6bd80d | n/a | n/a | control VM; DigitalOcean dnsdist fronts it | verified 03:01Z |
| Fronts' provider chain reads | DigitalOcean ×4 | provider 464cad3 (ca-east 39d1513b) | 3 public RPCs, `chainAuthority` null | none | n/a | **verified 11:52Z** |
| Custody v1 | DigitalOcean ×4 `enclave-custodian` | 09895e649 (2026-10-14) | unknown | unknown | not an Enclave app | verified running 11:52Z; **violation** |
| Custody v2 | metal0 host `enclave-custodian-v2.service` (warden-host, local SNP guest; qemu pid 3817658) | custodian-v2-9d43e63e8 | public-only by design | refused under the verifier | SNP guest on an Enclave host | running locally (ps 04:2x). **REFUSED for production** |
| Lease relay | eu-central (DigitalOcean) + NUCBOX `\Enclave\Relay` | DigitalOcean 94f4ebdf; Windows 74d09e01 | `LEASE_RELAY_RPCS` (name only) | none | not an app | **HOLD**; the DigitalOcean copy is a violation |
| Windows node agent | NUCBOX_K11 `\Enclave\Node` | agent.mjs sha16 76cac355; chain.mjs b257fcf6 is legacy (`BASE_RPCS`, no authority) | compiled-in public list | none | Enclave host itself | verified 02:49Z |
| Writer (relay writer, Claude50) | **not deployed** | writer v3: root job `root-writer-v3-1273` rc 0 (04:37) | — | needs the reader `9dd20e76` | — | qualified offline; the **120 s freshness question is unresolved** |
| Paid provider (Claude370) | **not deployed**; the provider is still in local mode, needing `cfg.rpc` | latest receipt `root-paid-r5-full-1278` **rc 1 "INVALID: patch does not apply"** (04:52) | — | — | — | **not qualified** (if root has re-run since, I did not find the receipt) |
| Lifecycle (deployment lifecycle/runner) | not deployed | excluded from the reader compositions | — | — | — | not composed |
| Control (control VM itself) | NUCBOX Hyper-V `enclave-control` | no git refs | — | none | — | verified 03:01Z |
| Site credit (browser) | browser | `site/credit/credit-config.json` | 4 public RPCs, quorum 2 (endpoint trust) | n/a | n/a | source evidence only |
| Base RPC guest (owned) | T710/T500 workstation VM `enclave-rpc-production` | holder disabled, Base extraction in progress | own L1/Base | reader v3 tree `9dd20e76` qualified offline; nothing installed | not an app | **not serving** |

Nothing here is SNP- or node-authority proof.

## 4. Minimal deployment order (root executes; each step is gated on the previous one)
0. **Keep everything that runs now.** Fix the guard risk first: the RPC VM's `/vm` margin is about 90 GB above the guard's shutdown threshold (`logs/claude-nvme-capacity-review.md`).
1. **Owned Base RPC serving:** extraction complete → coverage gate (deadline ≈2026-10-28 16:00Z) → install the reader **9dd20e76** stack (finality r14-witness) → readiness → `fwd-base-rpc` serves host :28545. Checkpoint 2e8502e6 expires 2026-11-01 19:22Z.
2. **Immediate RPC replacement at one point:** the control VM gateway (`enclave-rpc-gateway` :8190). Add the owned Base upstream, keep the public upstream as fallback, and soak.
   - **Missing:** a host→control-VM path to :28545 (workstation → NUCBOX Hyper-V). No such route was observed.
   - **Missing:** a gateway release with a git ref; the current one is an unversioned single file.
3. **API relay to verifier mode:** `ENCLAVE_CHAIN_AUTHORITY=verifier` plus a loopback `TX_BACKEND`. The source supports this at 64156dcd/5f0e0117c, but the release is unversioned nan-relay 0.1.0, so a built package from the combined candidate is **missing**.
4. **Move the DigitalOcean services onto Enclave hosts/apps,** one at a time, each with a fallback: directory, route-dns/dnsdist, bootstrap-gateway/tls/caddy, custodian, then the eu-central lease relay (on HOLD).
   - **Missing:** target Enclave app or host packages for each; only `network/host-services/packages/*` exist (directory-replica, route-dns, credit-vault-submitter and others are baseline-stale and must be regenerated).
   - **Missing:** a placement decision for public DNS :53 and ingress, if the droplets must carry WireGuard only. Today all public names resolve to the droplets.
5. **Strip the providers down:** remove the providers' `rpc` list, or move them to `attested-verifier` mode (KVM/root-owned). Then remove the stale `*.before-*` configs only after backup.
6. **Writer and paid:** compose on `9dd20e76` once root qualifies them (paid r5 is currently INVALID; writer 120 s freshness is open). Regenerate the bundles as listed in `logs/claude-reader-v3-composition.md`.
7. **Windows node and lease relays:** the chain-authority build is not deployed. Lease relays stay on HOLD until released.

**Signing that needs exact evidence before any move** (not gathered; no keys read):
- the custodian's and lease relay's key use on DigitalOcean;
- `HOST_SPONSOR_VERIFIER_KEY` on the control VM;
- paid settlement keys on NUCBOX.

## 5. Rollback locations known
| Component | Rollback location |
|---|---|
| Provider configs | `/etc/enclave-network/provider*.before-{bootstrap-tls,control-routes,storage-20261019,directories,removing-nan-directory}.json` on each droplet, plus `provider-pinned-8b37c37.hs-a1.json` (ca-east) |
| Custodian | the `/opt/enclave-custodian/current` symlink → dated release dirs `custodian-20261014…` |
| Lease relay | `/opt/enclave-lease-relay/releases/94f4ebdf…` (eu-central; a us-west copy is idle) |
| RPC guest | the install journal `/var/lib/enclave-rpc/install-journal/` (per `claude-production-config-inventory.md`); `chain_service.py.pre-f47545b53` |
| Control VM | **no versioned releases** (single files, no git). A rollback snapshot is **missing**; `work/control-vm/control-backup-inventory.py` exists but its result was not checked here |
| USB recovery copies | `/mnt/usb/enclave-rpc-production/{l1-origin,os}.qcow2` and `enclave-cold-recovery/` |

## 6. Explicit unknowns
- Control VM, NUCBOX and guest MCP state after 03:02Z (minipc not contacted on purpose).
- The `warden`/`storage` aliases (unreachable at 02:46Z) and nan (62.238.4.214; no node processes at the prior refresh).
- The gateway's active credentialed upstreams.
- Custodian v1 key and chain usage.
- Whether deployment `0xef514ed3…` is the SNP app behind 30443.
- The writer 120 s freshness resolution.
- The current paid r5 status beyond the rc 1 receipt.
