# Live consumer inventory — result (read-only, 2026-10-26)

Owner: Claude. Package: `live-consumer-inventory-20261026/` (probe scripts + `raw/*` outputs + `SHA256SUMS`).
Window (actual UTC): 2026-10-26T02:46Z – 02:50:21Z. Read-only only: no service/config change, no restart, no kill, no RAM/firewall change,
no signing/sending, no public-RPC contact, no tests/builds/queue/commits. Output is whitelisted: exe path, PID, unit/task, sha256 (first 16 hex),
version, authority mode, sanitized origin (scheme://host:port). No env files, keys, tokens, cookies or full command lines were printed or saved.

## 1. Live API relay — where `api.enclave.host` / `mcp.enclave.host` actually terminate

| Hop | Finding | Evidence (UTC) |
|---|---|---|
| Public :443/:80 on all 4 fronts | `enclave-network-provider.service`, node, `/opt/enclave-network/native-recovery-464cad3/provider.mjs` sha16 `464cad341e4a816a` (eu-central pid 220286) | `raw/{eu-central,us-west,ca-east,ap-southeast}.txt` 02:46Z |
| Provider config | `/etc/enclave-network/provider-pinned-8b37c37.json` sha16 `bfeec2bd3fc22fd2`; `localRoutes` maps `api.enclave.host`, `mcp.enclave.host`, `api.enclavehost.eth`, `mcp.enclavehost.eth` → `127.0.0.1` tls `30443` / http `30080`; `relay=https://api.enclave.host` | `raw/eu-central.provider.txt` 02:47:14Z (eu-central only) |
| Provider's own chain list | `rpc` = `https://mainnet.base.org`, `https://base-rpc.publicnode.com`, `https://base.drpc.org` (public RPC list; NOT the verifier authority) | same |
| 127.0.0.1:30443/30080 (+31053) on all 4 fronts | **not a local service**: `sshd` reverse-forward of login session user `enclave-control-tunnel`, RemoteHost `4.15.13.178`, sessions started 2026-10-23 08:31:20Z (us-west, ca-east) / 09:09:35Z (eu-central, ap-southeast) | `raw/*.upstream.txt` 02:48:40Z, `raw/*.tunnel.txt` 02:49:03–05Z |
| Tunnel egress | `4.15.13.178` is the **same public egress as this operator workstation** (`warden-host`) — own SSH session to eu-central shows RemoteHost `4.15.13.178` | `raw/eu-central.ownsession.txt` 02:50:21Z |
| Route map (`127.0.0.1:8188/v1/network/routes`, `enclave-public-directory` `runtime-37366ab`) | transport `enclave-network`; 1 label `ef514ed3`; 1 deployment `0xef514ed3af4e891d…b238` (version 2, two httpsRoutes port 443); 11 pending ids | `raw/eu-central.upstream.txt` 02:48:41Z |

**Conclusion:** the live API/MCP relay process runs at the site behind `4.15.13.178` (same site as warden-host/minipc) and reaches the fronts through
an `enclave-control-tunnel` reverse SSH tunnel. The cutover's real public target is therefore the 4 fronts' `localRoutes` → `:30443/:30080`, fed by that tunnel.

**Still UNKNOWN (stated, not assumed):** which box/process holds the tunnel client and serves 30443.
- minipc (NUCBOX_K11): **0** ssh/autossh/plink processes (`raw/minipc.2.txt`, `raw/minipc.3.txt` 02:50:20Z) → not an OpenSSH-client tunnel there. A non-OpenSSH
  implementation (e.g. inside node pid 5180 `control\windows\vbslike\manager\main.mjs` or `shielded-worker.exe` pid 9364) was **not ruled out**.
- warden-host (local): no `ssh`/`autossh` process whose args contain `30443` (caveat: an ssh-config `RemoteForward` alias would not match); only `enclavedns.service` running (`raw/local.tunnel.txt` 02:49:06Z).
- `warden` and `storage` SSH aliases unreachable (no route / timeout, 02:46Z) — **not inspected, not evidence of absence**. `nan`: no node processes, `/opt/nan-relay` inactive per prior refresh.
- Whether 30443 lands in the SNP deployment `0xef514ed3…` was not proven; the deployment ids above are the authorized metadata to resolve it.

## 2. Windows node processes (alias `minipc` = host **NUCBOX_K11**; i.e. "minipc" and "nucbox" are the same box)

Evidence: `raw/minipc.txt` 02:49:21Z, `raw/minipc.2.txt` 02:49:56Z, `raw/minipc.3.txt` 02:50:20Z. Runtime `C:\Program Files\Enclave\runtime\node\node.exe` for all.

| PID | Launcher | Script | sha16 | Started (UTC) | Loopback listens |
|---|---|---|---|---|---|
| 4716 | task `\Enclave\Node` (SYSTEM) → cmd 16272 `run-node.cmd` | `C:\Program Files\Enclave\control\windows\node\agent.mjs` (pkg `enclave-windows-node` 0.1.0) | `76cac35597133132` | 2026-10-23T19:19:10Z | 9600, 9610, 9621 |
| 4552 | task `\Enclave\Relay` (SYSTEM) → cmd 3756 `run-relay.cmd` | `C:\Program Files\Enclave\lease-relay\releases\74d09e01…bc64\lease-relay.mjs` | `74d09e015c375e9…` | — | 8549 |
| 5180 | cmd 10316 | `C:\Program Files\Enclave\control\windows\vbslike\manager\main.mjs` | `c051724ba86e4007` | 2026-10-23T19:18:15Z | 8091, 8092 |
| 16008 | cmd 21328 | `C:\Program Files\Enclave\network\privacy-agent.mjs` | `cfb69370a00dea14` | 2026-10-23T19:18:43Z | 51280, 55916, 55937, 55940, 56111, 60561 |
| 3552 / 6868 | ppid 2752 / child of 3552 | `C:\ProgramData\Enclave\network-checker\run-checker.mjs` / (no script arg) | `34d223e8cb126f02` / — | 2026-10-23T08:29:30Z | — |

Also: task `enclave-host-services-hs2` = Ready (not running), `hostsvc-supervisor.exe`; service `EnclaveDNS` Running.
Launcher files: `run-node.cmd` sha16 `0fdc3699228c9d7a`, `run-relay.cmd` sha16 `d2e71e463e561c19`.

### Chain authority selection on the live Windows node — **legacy, no verifier**
- Live `control\windows\node\chain.mjs` sha16 `b257fcf64e7e0f44`: does **not** contain `ENCLAVE_CHAIN_AUTHORITY`, does contain `BASE_RPCS` → the running node
  is a pre-chain-authority build; the prepared windows-chain-authority candidate is **not deployed**.
- `C:\ProgramData\Enclave\node-config.cmd` sha16 `67192775312d507a` (mtime 2026-10-23T10:09:28Z): 27 `set` vars, **none** chain-related
  (no `BASE_RPCS`, `ENCLAVE_CHAIN_*`) → mode = legacy default RPC list compiled into chain.mjs (its values were not read).
- `C:\ProgramData\Enclave\lease-relay\relay-config.cmd` sha16 `08312c832aea80ff` (mtime 2026-10-21T07:41:23Z): 10 vars; chain-related = `LEASE_RELAY_RPCS`
  (name only; its origins were not extracted — key was outside this run's whitelist).
- Machine/User-scope env: no chain-authority vars printed.

## 3. Cutover targets this gives the plan
1. Fronts ×4: `enclave-network-provider` `native-recovery-464cad3` + `provider-pinned-8b37c37.json` (`rpc` = 3 public origins; `localRoutes` api/mcp → tunnel :30443/:30080).
2. API/MCP relay origin: behind `enclave-control-tunnel` from `4.15.13.178` — host/process **UNRESOLVED** (next read-only step: on each site box, list listeners/processes owning outbound :22 to the 4 front IPs, whitelisted).
3. Windows NUCBOX_K11: Node = `agent.mjs` pid 4716 (task `\Enclave\Node`, legacy chain.mjs, no authority vars); Relay = `lease-relay.mjs` pid 4552 (task `\Enclave\Relay`, `LEASE_RELAY_RPCS`).
4. Linux fronts also run lease-relay (eu-central only), custodian, bootstrap-gateway, route-dns, public-directory (`raw/*.txt`).

Custody v2 stays REFUSED; lease consumers stay on HOLD. Nothing here is a PASS of any test.
