# Live control-guest inventory — result (read-only, 2026-10-26)

Owner: Claude. Package: `live-control-guest-inventory-20261026/` (probe scripts `probe-guest{,2,3,4,5}.sh`, `raw/*`, `SHA256SUMS`).
The prior trace (`logs/claude-live-api-origin-trace-result.md`) is frozen and was not changed. Window (actual UTC): 2026-10-26T03:00:43Z – 03:02:40Z.
Read-only only: no restart, no config/permission change, no SSH mutation, no test/build/queue, no transaction. Probe output was whitelisted: PID, unit, exe, sha16, package name/version, origins (scheme://host:port), variable **names**.
No values of credentials, keys, tokens or env files were printed or saved. No full command lines were printed. Systemd credential contents were not read.

## Access used (documented, existing)
- **Source:** the documented operational SSH shape in `work/control-vm/{control-backup-inventory,cutover-api,stage-config,…}.py` (line 3–5): `ssh -p32423 -o UserKnownHostsFile=work/control-vm/known_hosts -i /home/steven/.ssh/minipc controladmin@127.0.0.1`.
  - Identity fingerprint (public): `SHA256:xZXbkxIirCJxpqEHA2/cMgJPgWjzypuMYwN89Q5lmyg`.
  - No key contents were read.
- **Route:** the documented local forward `127.0.0.1:32423` was not listening (`raw/local.32423.txt` 03:00:57Z). I therefore reached the same guest through the documented `minipc` alias:
  - `ProxyJump=minipc` → `controladmin@172.17.28.159:22`, the guest IP reported by minipc's `Get-VM` in the frozen trace;
  - `IdentitiesOnly`, `HostKeyAlias=[127.0.0.1]:32423`, and `StrictHostKeyChecking=yes` against `work/control-vm/known_hosts`;
  - the host key matched, and the guest reported hostname `enclave-control`.
- **Guest:** `enclave-control`, booted 2026-10-23 08:31:15 UTC. `sudo -n` is available and was used only for the reads listed below.

## Tunnel units — actual state (`raw/control-vm.txt` 03:01:22Z)
| Unit | State | MainPID | Active since (UTC) | NRestarts | Forwards |
|---|---|---|---|---|---|
| `enclave-control-tunnel-us-west.service` | active/running | 782 | 2026-10-23 08:31:17 | 0 | `-R 127.0.0.1:30443:127.0.0.1:30443`, `-R 127.0.0.1:30080:127.0.0.1:30080`, `-R 127.0.0.1:31053:127.0.0.1:1053` |
| `enclave-control-tunnel-ca-east.service` | active/running | 779 | 2026-10-23 08:31:17 | 0 | same |
| `enclave-control-tunnel-eu-central.service` | active/running | 11373 | 2026-10-23 09:09:33 | **215** | same |
| `enclave-control-tunnel-ap-southeast.service` | active/running | 11372 | 2026-10-23 09:09:33 | **215** | same |

The active-since times match the fronts' sshd accepts (08:31:20Z / 09:09:35Z). eu-central and ap-southeast restarted 215 times before the 09:09 session stuck. The cause was not investigated.

## Processes behind 30443 / 30080 / 1053 (`raw/control-vm.txt`, `raw/control-vm.caddy.txt` 03:01:39Z, `raw/control-vm.upstreams.txt` 03:01:59Z)
| Guest port | Process | Unit (since, UTC) | Executable | sha16 | Source / version |
|---|---|---|---|---|---|
| 127.0.0.1:30443, :30080 | `caddy` pid 777 | `enclave-control-tls.service` (2026-10-23 08:31:17), user `enclave-control-tls` | `/usr/bin/caddy` v2.11.4 | exe `b7105518e3ed1c07` | config `/etc/enclave-control-tls/caddy.json` sha16 `e080ca28646a4374` (servers `control`=30443, `redirect`=30080) |
| 127.0.0.1:1053 tcp+udp (+ `*:8153`) | node pid 105063 | `enclave-dns.service` (2026-10-25 19:15:05) | `/usr/bin/node` exe `93956de2e5948047` | `/opt/enclave-dns/dns-relay.js` `4f6bd80dab575183` | package `nan-relay` 0.1.0; no git |

### Caddy routing on 30443 (route table only)
- **`api.enclave.host`** paths `/rpc/base`, `/rpc/base-sepolia`, `/rpc/ethereum` → `127.0.0.1:8190`.
- **`*`** path `/native/*` → `127.0.0.1:8187`.
- Everything else → `127.0.0.1:8100`:
  - `api.enclave.host`, all other paths;
  - **`mcp.enclave.host`**;
  - `api.`/`mcp.enclavehost.eth`;
  - `*.app.enclave.host`;
  - `62.238.4.214` (nan) paths `/v1/*`, `/health`, `/enclaves`, `/availability`, `/route`, `/t/*`, `/mcp`. Its `/native/*` path goes to 8187.

### Upstream processes
| Port | Process | Unit (since, UTC) | Script | sha16 | Version |
|---|---|---|---|---|---|
| **8100 (the live API/MCP relay)** | node pid **102144** | **`enclave-api-relay.service`** (2026-10-25 19:13:25), user `enclave-api-relay` | `/opt/nan-relay/api-relay.js` | **`481f00410b87f30e`** | package `nan-relay` **0.1.0**, no git, 127 files, newest 2026-10-23T01:12 |
| 8190 (`/rpc/*` gateway) | node pid 101767 | `enclave-rpc-gateway.service` (2026-10-25 19:12:37), user `enclave-rpc-gateway` | `/opt/enclave-rpc/gateway.mjs` | `3b23200d8e77565d` | single file, no git, mtime 2026-10-25T19:12 |
| 8187 (`/native/*`) | node pid 828 | `enclave-native-discovery.service` (2026-10-23 08:31:17) | `/opt/enclave-recovery/discovery.mjs` | `67c7b39a9e79374a` | no git |

All node processes run `/usr/bin/node` with exe sha16 `93956de2e5948047`.

## Chain-authority selection (`raw/control-vm.authority.txt` 03:02:25Z, `raw/control-vm.gateway.txt` 03:02:40Z)
**None of the guest services uses the explicit chain authority, and there is no local verifier in the guest.**
- **Listeners:** the guest's loopback/any listeners are only 22, 1053, 8153, 8100, 8187, 8190, 30080 and 30443.
- **No `ENCLAVE_CHAIN_*` anywhere:** `ENCLAVE_CHAIN_AUTHORITY`, `ENCLAVE_CHAIN_VERIFIER` and `ENCLAVE_CHAIN_TX_BACKEND` are absent from the process environments of 8100, 8190, 8187 and 1053. `api-relay.js` and `gateway.mjs` contain 0 references to `ENCLAVE_CHAIN_AUTHORITY` or `chain-authority`.
- **API relay (pid 102144), process env, origins only:**
  - `BASE_RPC` = `http://127.0.0.1:8190`, and `SESSIONS_RPC` = `http://127.0.0.1:8190`. Both point at the guest gateway.
  - `SESSIONS_PUBLIC_RPC` = `https://api.enclave.host`.
  - `SECRETS_RELEASE_CATALOG_RPCS` has 3 origins, all public: `base-rpc.publicnode.com`, `base-mainnet.public.blastapi.io`, `base.gateway.tenderly.co`.
  - `CUSTODY_CHAIN_ID=8453`.
  - Another chain-related variable name, `HOST_SPONSOR_VERIFIER_KEY`, is present. Its value was not read.
- **RPC gateway (pid 101767):**
  - Its environment has only `CREDENTIALS_DIRECTORY`. The unit uses systemd `LoadCredential`/`SetCredential`, whose contents were not read.
  - The source contains public-RPC origins: `mainnet.base.org`, `base-rpc.publicnode.com`, `base.drpc.org`, `sepolia.base.org`, `base-sepolia-rpc.publicnode.com`, `eth.drpc.org`, `ethereum-rpc.publicnode.com`.
  - It allows methods including `eth_getProof`, `eth_getLogs` and `eth_sendRawTransaction`.
  - Live outbound peer: one external IP (not attributed to any provider from the IP alone) plus loopback.
- **Effective mode:** legacy RPC. The API relay reads chain state through the guest gateway at :8190, which proxies to public or credentialed upstream RPCs. The gateway has no proof-backed verifier.

## Concrete cutover targets
1. **Live API/MCP relay:**
   - `enclave-api-relay.service`, `/opt/nan-relay/api-relay.js` (sha16 `481f00410b87f30e`, nan-relay 0.1.0), on the Hyper-V VM `enclave-control` (minipc/NUCBOX_K11, 172.17.28.159).
   - Chain inputs: `BASE_RPC`/`SESSIONS_RPC` → `127.0.0.1:8190`, plus `SECRETS_RELEASE_CATALOG_RPCS` (3 public origins).
2. **`/rpc/*` gateway:** `enclave-rpc-gateway.service`, `/opt/enclave-rpc/gateway.mjs` (sha16 `3b23200d8e77565d`). This is the read/send backend the relay uses, and where a verifier/tx-backend split would go.
3. **Ingress:** `enclave-control-tls.service` caddy route table. **Transport:** 4 `enclave-control-tunnel-<region>` units.
4. **DNS:** `enclave-dns.service` `dns-relay.js` on :1053, which the fronts reach at :31053.

## Missing / not observed
- **Exact source commit:** none of `/opt/nan-relay`, `/opt/enclave-rpc`, `/opt/enclave-recovery` or `/opt/enclave-dns` has `.git` or a version file. The identity is by sha16 and package version only.
- **Gateway upstream selection:** its credentialed upstream (systemd credentials) was intentionally not read. Which of the in-source origins are active is not proven.
- **Restart cause:** the 215 restarts of the eu-central and ap-southeast tunnel units were not investigated, and their journals were not read.
- **Documented forward:** the documented local forward `127.0.0.1:32423` is not running on warden-host. Access was via `ProxyJump=minipc`, with the same documented identity and host key.

Custody v2 stays REFUSED; lease consumers stay on HOLD. No PASS is claimed for anything.
