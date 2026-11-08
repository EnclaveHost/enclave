# Enclave RPC host units (Warden)

User units for the SEV-SNP RPC enclave on this host, installed to `~/.config/systemd/user/`
(the user manager runs at boot: `loginctl enable-linger steven`, `Linger=yes`).

| Unit | Runs | At boot |
| --- | --- | --- |
| `enclave-rpc-snp-prod-r11` | `launch.py prod-r11.json`: the measured r11 guest (Enclave RPC 1.1.0), HOST_DATA = the owner's deployment | `default.target` |
| `enclave-rpc-snp-disk-guard-r11` | `disk_guard.py`: logs /vm free space, its loss rate and each chain disk's reclaimable space every 10 min; warns under 250 GiB or 7 days; under 150 GiB with ≥50 GiB reclaimable starts the offline trim; under 100 GiB otherwise stops the guest once | pulled in by the guest unit |
| `enclave-rpc-snp-offline-trim-r11` | `offline_trim.py`: stops the guest, returns the blocks its ext4 freed to /vm, starts it (held stopped if a check fails after a punch); at most once a day | started by the guard or by hand |
| `enclave-rpc-snp-lan-forward-r1` | socat 192.168.8.249:18443 → the guest's attested front, control VM (192.168.8.238) only | `default.target` |
| `enclave-rpc-snp-local-proxy-r11` | plain-HTTP view of the attested L1 EL (:18645) and beacon (:15052) for host tools | `default.target` |
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

The offline trim keeps its record in `~/.local/state/enclave-rpc-snp/offline-trim-r11.json`. After a failed
run the guest stays stopped and the guard will not trim again: inspect the record and the disks, then
`python3 -I ~/.local/share/enclave-rpc-snp/offline_trim.py … --force` or start the guest by hand.

A new image changes the measurement in `enclave-rpc-snp-local-proxy-*` and `runner-prod.json`, and
the image path in the launch config; give the units the new revision's name.

r11 replaced r10 on 2026-11-06 23:08Z on the same chain disks. The r10 units stay installed in
`~/.config/systemd/user/` but disabled (their source is at the parent of the r11 commit) for rollback,
which also needs `runner-prod.json.pre-r11` and the gateway's `config.deployment.json.pre-r11`.
