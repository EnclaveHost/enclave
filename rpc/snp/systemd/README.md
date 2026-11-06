# Enclave RPC host units (Warden)

User units for the SEV-SNP RPC enclave on this host, installed to `~/.config/systemd/user/`
(the user manager runs at boot: `loginctl enable-linger steven`, `Linger=yes`).

| Unit | Runs | At boot |
| --- | --- | --- |
| `enclave-rpc-snp-prod-r11` | `launch.py prod-r11.json`: the measured r11 guest (Enclave RPC 1.1.0), HOST_DATA = the owner's deployment | `default.target` |
| `enclave-rpc-snp-disk-guard-r11` | `disk_guard.py`: stops the guest once before /vm falls under 100 GiB | pulled in by the guest unit |
| `enclave-rpc-snp-lan-forward-r1` | socat 192.168.8.249:18443 → the guest's attested front, control VM (192.168.8.238) only | `default.target` |
| `enclave-rpc-snp-local-proxy-r11` | plain-HTTP view of the attested L1 EL (:18645) and beacon (:15052) for host tools | `default.target` |
| `enclave-rpc-snp-runner` | `runner.mjs runner-prod.json`: holds and renews the EnclaveDeployments lease | `default.target` |

The node services run from a self-contained release, `~/.local/share/enclave-rpc-snp/releases/<sha>/`
(`git archive` of `rpc/snp` and `relay/snp-verify.mjs`, plus `npm install viem@<pinned>`), not from a
working tree. `launch.py` and `disk_guard.py` are installed beside the launch configs and must match
`rpc/snp/` byte for byte.

Install: copy the units, `systemctl --user daemon-reload`, `systemctl --user enable <unit>`.

Replacing a running `systemd-run` (transient) unit of the same name: a transient unit shadows the
file and refuses `enable`, and stays loaded while another unit references it. Stop the service and
everything that references it (the guard's `PartOf=`), `systemctl --user reset-failed`,
`daemon-reload`, and check `systemctl --user show <unit> -p FragmentPath` names the file before
starting it. Stopping the guest costs Base a few thousand blocks of replay.

A new image changes the measurement in `enclave-rpc-snp-local-proxy-*` and `runner-prod.json`, and
the image path in the launch config; give the units the new revision's name.

r11 replaced r10 on 2026-11-06 23:08Z on the same chain disks. The r10 units stay installed in
`~/.config/systemd/user/` but disabled (their source is at the parent of the r11 commit) for rollback,
which also needs `runner-prod.json.pre-r11` and the gateway's `config.deployment.json.pre-r11`.
