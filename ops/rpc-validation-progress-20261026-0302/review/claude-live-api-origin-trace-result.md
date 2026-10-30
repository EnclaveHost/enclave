# Live API origin trace — result (read-only, 2026-10-26)

Owner: Claude. Package: `live-api-origin-trace-20261026/` (probe scripts, `raw/*`, `SHA256SUMS`). The prior inventory (`logs/claude-current-live-consumer-inventory-result.md`) is frozen and was not changed.
Window (actual UTC): 2026-10-26T02:53:48Z – 02:58:40Z. Read-only only: no restart, no config/firewall change, no kill, no signing/sending, no test/build/queue,
no public-RPC contact. Output was whitelisted: PID, exe, parent, cgroup/unit, sha16, key **fingerprints** (public), forward specs, sanitized origins.
No private keys, env files, tokens or full command lines were read out or saved. SSH used `ConnectTimeout=10` and a bounded `timeout`.

## Answer — the process behind the 4 fronts' `127.0.0.1:30443/30080`

**The tunnel client is the Hyper-V guest VM `enclave-control` on minipc (host NUCBOX_K11). Its tunnel units are `enclave-control-tunnel-{us-west,eu-central,ap-southeast,ca-east}.service`.**
This was established from socket, key and timing evidence, not from the shared external IP. The **process inside the guest that serves 30443/30080 was NOT observed**, because guest login was refused (see Gaps).

| # | Evidence | Source (UTC) |
|---|---|---|
| 1 | On every front, :30443/:30080/:31053 are owned by the sshd session of user `enclave-control-tunnel`. Its TCP peer is `4.15.13.178`, ports eu `50063` / us-west `50154` / ca-east `50104` / ap `50060`. | `raw/*.tunnelsock.txt` 02:54:53–54Z |
| 2 | sshd journal shows `Accepted publickey for enclave-control-tunnel` on that exact peer port with **ED25519 `SHA256:AJ9e7qoY87oouCCs53DIAJVvcfKEgHNikJ83RxSvLsI`**. Times: us-west 2026-10-23T08:31:20.127Z, ca-east 08:31:20.315Z, eu-central 09:09:35.003Z, ap-southeast 09:09:35.286Z. | `raw/*.tunnelauth.txt` 02:55:27–35Z |
| 3 | Fronts restrict that key: `authorized_keys` sha16 `e6e433a1b901fae9` (identical ×4), 1 key, comment `enclave-control-tunnel-20261019`, `restrict`, `command` set, `permitlisten` only 127.0.0.1:30443/30080/31053. The sshd `Match User enclave-control-tunnel` block sets `AllowTcpForwarding remote` and `GatewayPorts no`. | same |
| 4 | The only file on the operator workstation with that fingerprint is `work/control-vm/tunnel.pub` (sha16 `8571a345231cc241`, 15 .pub files scanned). That folder documents the Hyper-V VM `enclave-control` (`create-control-vm.ps1` sha16 `796ef27a2bdf5d43`, Default Switch). `prepare-tunnel-client.sh` (sha16 `d931e8e195326254`) creates the key in the guest at `/var/lib/enclave-control-tunnel/` with the same comment. `install-tunnels.py` (sha16 `6838aab305728444`) installs the 4 `enclave-control-tunnel-<region>.service` units. | `raw/local.keysearch.txt` 02:55:55Z, `raw/doc.control-vm.txt` 02:58:15Z |
| 5 | Documented forwards: `-R 127.0.0.1:30443:127.0.0.1:30443`, `-R 127.0.0.1:30080:127.0.0.1:30080`, `-R 127.0.0.1:31053:127.0.0.1:1053`. So the targets are guest-local `:30443`, `:30080` and `:1053`. | `raw/doc.control-vm.txt` |
| 6 | minipc `Get-VM`: `enclave-control` is **Running**, started 2026-10-23T08:31:12Z, guest IPv4 `172.17.28.159` (Hyper-V Default Switch NAT). minipc booted 08:29:16Z. The first two tunnel accepts came **8 s after VM start**. | `raw/minipc.vm.txt` 02:58:16Z, `raw/minipc.keysearch.txt` 02:56:13Z |
| 7 | Host key: SSH via `ProxyJump=minipc` to `172.17.28.159` passed `StrictHostKeyChecking=yes` against the documented `work/control-vm/known_hosts` (`HostKeyAlias [127.0.0.1]:32423`). Authentication was then refused. So the host behind 172.17.28.159 holds the documented control-VM host key. | `raw/control-vm.err` ~02:58:40Z |

### Hosts ruled out (with evidence), and why the shared egress was not used as proof
- **warden-host** (operator workstation, 192.168.8.249, up since 2026-10-10):
  - The only established sockets to front `:22` are 4 `/usr/bin/ssh` mux masters. They started 2026-10-26T02:46:05–17Z (this audit's own sessions) and have no `-R`, no RemoteForward and no tunnel user. All 9 sockets to front IPs were attributed to a process.
  - The four local qemu guests hold slirp sockets to the fronts only on `:443`, never `:22`:
    - `enclave-metal` (SNP, started 10-24);
    - `enclave-custodian-v2` (started 10-14);
    - `enclave-rpc-production-vm` (started 10-25);
    - `kvm-box-desktop` (started 10-24).
  - `kvm-box-controller` was started 2026-10-24, after the tunnel sessions began.
  - Source: `raw/local.est.txt` 02:54:00Z, `raw/local.ssh-qemu.txt` 02:54:55Z.
- **ssh_config RemoteForward:** none in the local `~/.ssh/config`, `/etc/ssh/ssh_config` or `/etc/ssh/ssh_config.d`, and none in `ssh -G` for any alias (`raw/local.aliases.txt`, `raw/local.sshcfg-remoteforward.txt`). On minipc, the `ssh_config` and `.ssh/config` files are absent or unreadable.
- **minipc host OS:**
  - None of its 12 established sockets to front IPs is on `:22`. They are `:443` and `:8188`, from node `agent.mjs` pid 4716, `privacy-agent.mjs` pid 16008 and the network-checker pid 6868.
  - It has 0 ssh/plink processes.
  - Guest traffic is NATed by Hyper-V, so it does not appear in the host's socket table. That is consistent with rows 1–6 (`raw/minipc.est.txt` 02:54:12Z).

## Cutover target (concrete)
- **Origin:** the Hyper-V VM `enclave-control` on NUCBOX_K11 (minipc), guest IP `172.17.28.159`, autostart on.
- **Tunnel units:** `enclave-control-tunnel-<region>.service` (user `enclave-control-tunnel`, key fingerprint `SHA256:AJ9e7q…vLsI`).
- **Exposed on the fronts:** guest `127.0.0.1:30443/30080` serves `api.`/`mcp.enclave.host` and the `.eth` names, via `localRoutes` in `provider-pinned-8b37c37.json`. Guest `127.0.0.1:1053` is exposed as front `:31053`.
- **Front side to keep or change:** `enclave-network-provider` `native-recovery-464cad3`, the `enclave-control-tunnel` account, and the `permitlisten` limits.

## Gaps — recorded as MISSING, not as absent
- **Guest process, version and chain authority are unknown.** The listener on guest `:30443/:30080/:1053` (PID, exe, unit, script hash) and its `ENCLAVE_CHAIN_*`/`BASE_RPCS` selection were **not observed**. `controladmin@172.17.28.159` rejected this workstation's default key (`Permission denied (publickey)`). Per instructions, no other key was searched for or extracted. Next step: rerun `live-api-origin-trace-20261026/probe-guest.sh` (read-only, whitelisted) with the operator's documented control-VM admin key, or through the operator.
- **Tunnel unit state inside the guest** (ActiveState, MainPID) was not observed. Unit names come only from the documented installer, matched by the key fingerprint and timing.
- **`warden` (10.0.100.9) and `storage` (10.241.113.248):** "No route to host" at 2026-10-26T02:54:22Z and 02:54:25Z. Not inspected.
- **minipc config search:** the `Select-String` step of `probe-win-key.ps1` timed out (rc 124) after 3 .pub files had been scanned, none matching. That step's results are absent.
- **The 11 pending deployment ids and SNP deployment `0xef514ed3…`** (from the frozen inventory) were not tied to the guest. No route evidence was found linking them to `:30443`.

Custody v2 stays REFUSED; lease consumers stay on HOLD. No PASS is claimed for anything.
