# Enclave RPC host units (Warden)

User units for the SEV-SNP RPC enclave on this host, installed to `~/.config/systemd/user/`
(the user manager runs at boot: `loginctl enable-linger steven`, `Linger=yes`).

| Unit | Runs | At boot |
| --- | --- | --- |
| `enclave-rpc-snp-prod-r12` | `launch.py prod-r12.json`: the measured r12 guest (Enclave RPC 1.2.0; online discard and a daily fstrim of its chain disks), HOST_DATA = the owner's deployment | `default.target` |
| `enclave-rpc-snp-disk-guard-r12` | `disk_guard.py`: logs /vm free space, its loss rate and each chain disk's reclaimable space every 10 min; warns under 250 GiB or 7 days; under 150 GiB with ≥50 GiB reclaimable starts the offline trim; under 100 GiB otherwise stops the guest once | pulled in by the guest unit |
| `enclave-rpc-snp-offline-trim-r12` | `offline_trim.py`: stops the guest, returns the blocks its ext4 freed to /vm, starts it (held stopped if a check fails after a punch); at most once a day | started by the guard or by hand |
| `enclave-rpc-snp-lan-forward-r1` | socat 192.168.8.249:18443 → the guest's attested front, control VM (192.168.8.238) only | `default.target` |
| `enclave-rpc-snp-local-proxy-r12` | plain-HTTP view of the attested L1 EL (:18645) and beacon (:15052) for host tools | `default.target` |
| `enclave-rpc-snp-runner` | `runner.mjs runner-prod.json`: holds and renews the EnclaveDeployments lease | `default.target` |

The node services run from a self-contained release, `~/.local/share/enclave-rpc-snp/releases/<sha>/`
(`git archive` of `rpc/snp` and `relay/snp-verify.mjs`, plus `npm install viem@<pinned>`), not from a
working tree. `launch.py`, `disk_guard.py` and `offline_trim.py` are installed beside the launch configs and must match
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
