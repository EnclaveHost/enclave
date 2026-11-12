# Enclave RPC host units (Warden)

User units for the SEV-SNP RPC enclave on this host, installed to `~/.config/systemd/user/`
(the user manager runs at boot: `loginctl enable-linger steven`, `Linger=yes`).

| Unit | Runs | At boot |
| --- | --- | --- |
| `enclave-snpvm-manager` | `vm-manager.mjs ~/.config/enclave/snpvm.json` on 127.0.0.1:8099: launches the deployment's measured guest when metal0's supervisor claims it (transient unit `enclave-rpc-snp-guest`), adopts a running one when restarted, and with `certs` configured has the relay issue the guest's certificate for its app name | `default.target` |
| `enclave-rpc-snp-disk-guard-fleet` | `disk_guard.py` for `enclave-rpc-snp-guest`: the same log and floor as the r12 guard, no offline trim (the guest's lifecycle is metal0's) | `default.target` |
| `enclave-rpc-snp-local-proxy-r13` | the plain-HTTP view pinned to r13's measurement; replaces `-r12` at the r13 cutover (`ops/rpc-snp-prod-r7/release-r13/finish.sh`) | `default.target` once enabled |
| `enclave-rpc-snp-prod-r12` | `launch.py prod-r12.json`: the measured r12 guest (Enclave RPC 1.2.0; online discard and a daily fstrim of its chain disks), HOST_DATA = the owner's deployment | disabled since 2026-11-12 (rollback) |
| `enclave-rpc-snp-disk-guard-r12` | `disk_guard.py`: logs /vm free space, its loss rate and each chain disk's reclaimable space every 10 min; warns under 250 GiB or 7 days; under 150 GiB with ≥50 GiB reclaimable starts the offline trim; under 100 GiB otherwise stops the guest once | pulled in by the guest unit |
| `enclave-rpc-snp-offline-trim-r12` | `offline_trim.py`: stops the guest, returns the blocks its ext4 freed to /vm, starts it (held stopped if a check fails after a punch); at most once a day | started by the guard or by hand |
| `enclave-rpc-snp-lan-forward-r1` | socat 192.168.8.249:18443 → the guest's attested front, control VM (192.168.8.238) only | `default.target` |
| `enclave-rpc-snp-local-proxy-r12` | plain-HTTP view of the attested L1 EL (:18645) and beacon (:15052) for host tools | `default.target` |
| `enclave-rpc-snp-runner` | `runner.mjs runner-prod.json`: holds and renews the EnclaveDeployments lease | disabled since 2026-11-12 (rollback) |

Since 2026-11-12 the deployment is a fleet app: metal0 claims and renews the lease and has the manager launch the
guest, so the dedicated guest unit and the runner stay installed but disabled. Starting either beside the fleet guest
would contend for the chain disks or for the lease.

The node services run from a self-contained release, `~/.local/share/enclave-rpc-snp/releases/<sha>/`
(`git archive` of `rpc/snp` and `relay/snp-verify.mjs`, plus `npm install viem@<pinned>`), not from a
working tree. A release the manager runs with `certs` needs the whole `relay/` directory (`relay/certs.js` and what
it imports) and `windows/`, as `19572bf2c` has. `launch.py`, `disk_guard.py` and `offline_trim.py` are installed beside the launch configs and must match
`rpc/snp/` byte for byte.

Install: copy the units, `systemctl --user daemon-reload`, `systemctl --user enable <unit>`.

Replacing a running `systemd-run` (transient) unit of the same name: a transient unit shadows the
file and refuses `enable`, and stays loaded while another unit references it. Stop the service and
everything that references it (the guard's `PartOf=`), `systemctl --user reset-failed`,
`daemon-reload`, and check `systemctl --user show <unit> -p FragmentPath` names the file before
starting it. Stopping the guest costs Base a few thousand blocks of replay, and public Ethereum (no fallback
provider) is down until the guest's L1 answers again (~11 min for the offline trim on 2026-11-08).

The offline trim keeps its record in `~/.local/state/enclave-rpc-snp/offline-trim-r12.json`. After a failed
run the guest stays stopped and the guard will not trim again: inspect the record and the disks, then
`python3 -I ~/.local/share/enclave-rpc-snp/offline_trim.py … --force` or start the guest by hand.

A new image changes the measurement in `enclave-rpc-snp-local-proxy-*` and `runner-prod.json`, and
the image path in the launch config; give the units the new revision's name.

r12 replaced r11 on 2026-11-10 07:54Z on the same chain disks (deployment 0x5ff56a4d…454f, Enclave RPC
1.2.0, measurement 220e5ec0…1159). The r11 units stay installed in `~/.config/systemd/user/` but disabled
(their source is at the parent of the commit that recorded the r12 cutover) for rollback, which also needs
`prod-r11.json`, `runner-prod.json.pre-r12` and the gateway's `config.deployment.json.pre-r12`. Rolling
back to r11 gives up the guest's online discard and daily fstrim, so the disk guard's offline trim returns.

r13 (Enclave RPC 1.3.0, measurement f3e72089…4b5c) is launched by the manager, not by a unit of its own: the
manager unit names release `19572bf2c`, and `~/.config/enclave/snpvm.json` binds the deployment to the r13 image.
Both change in one step, `ops/rpc-snp-prod-r7/release-r13/host-prepare.sh manager`, which keeps the r12 unit and
config beside them (`*.r12`) for `rollback-manager`. Until that step has run on the host, the installed manager unit
is the r12 one (release `51b949df5292`).
