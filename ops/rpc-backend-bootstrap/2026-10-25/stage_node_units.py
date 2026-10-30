#!/usr/bin/env python3
"""Generate the VM's chain services. Does not install, start, or sign anything."""
import json
import argparse
import pathlib
import shutil

HERE = pathlib.Path(__file__).resolve().parent
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--sequencer-forwarding', action='store_true', help='Enable submission to Base mainnet sequencer; not a read source')
p.add_argument('--out', type=pathlib.Path, default=HERE / 'node-payload')
p.add_argument('--anchor', type=pathlib.Path, default=HERE.parents[1] / 'outputs/rpc-production-final-20261025/anchor.json')
p.add_argument('--observations', type=pathlib.Path, default=HERE.parents[1] / 'outputs/rpc-production-final-20261025/l1-finality-observations.json')
a = p.parse_args()
OUT = a.out
assert not OUT.exists()
OUT.mkdir()
(OUT / 'units').mkdir()
shutil.copyfile(HERE / 'chain_service.py', OUT / 'chain_service.py')
anchor = json.loads(a.anchor.read_text())
anchor['stateTime'] = 1606824023 + 12 * anchor['slot']
observations = json.loads(a.observations.read_text())
assert len(observations) >= 2
assert all(o['finality']['data']['finalized'] == {'epoch': str(anchor['epoch']), 'root': anchor['root']} for o in observations)
anchor['observations'] = observations
(OUT / 'chain.json').write_text(json.dumps({'checkpoint': anchor, 'txForwarding': {'endpoint': 'https://mainnet-sequencer.base.org' if a.sequencer_forwarding else None}, 'baseBootstrap': {'coverageVerified': False, 'reason': 'Select a snapshot whose required origin blobs are available locally before activation.'}}, indent=2) + '\n')
for name, side, role, memory in [('enclave-l1-el', 'el', 'l1', 16), ('enclave-l1-cl', 'cl', 'l1', 10), ('enclave-base-holder', 'base', 'base', 28)]:
    mount = '/srv/enclave-l1-pair' if role == 'l1' else '/srv/enclave-base-holder'
    user = {'el': 'rpcl1el', 'cl': 'rpcl1cl', 'base': 'rpcbase'}[side]
    data = mount + ('/cl' if side == 'cl' else '/data')
    tmp = mount + ('/tmp-cl' if side == 'cl' else '/tmp')
    ordering = {'el': '', 'cl': ' enclave-l1-el.service', 'base': ' enclave-l1-el.service enclave-l1-cl.service'}[side]
    unit = f'''[Unit]
Description=Enclave own-chain {side} on dedicated HDD volume
Wants=network-online.target
After=network-online.target{ordering}
RequiresMountsFor={mount}
StartLimitIntervalSec=0

[Service]
Type=exec
User={user}
Group={user}
ExecStart=/usr/bin/python3 -I /opt/enclave-rpc/chain_service.py {side}
Restart=on-failure
RestartSec=300
TimeoutStopSec=600
KillMode=control-group
KillSignal=SIGINT
MemoryMax={memory}G
MemoryHigh={int(memory * .9)}G
OOMScoreAdjust={500 if side == "base" else 100}
MemorySwapMax=0
TasksMax=4096
LimitNOFILE=65536
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths={data} {tmp}
PrivateTmp=yes
UMask=0027

[Install]
WantedBy=multi-user.target
'''
    (OUT / 'units' / (name + '.service')).write_text(unit)
    if side != 'cl':
        (OUT / 'units' / (name + '.path')).write_text(f'''[Unit]
Description=Start {name} only after its pinned snapshot is complete
RequiresMountsFor={mount}

[Path]
PathExists={mount}/snapshot-complete
Unit={name}.service

[Install]
WantedBy=multi-user.target
''')
install = '''#!/bin/bash
set -euo pipefail
test "$(id -u)" = 0
test ! -e /etc/enclave-rpc/chain.json
mountpoint -q /srv/enclave-l1-pair
mountpoint -q /srv/enclave-base-holder
getent group rpcjwt >/dev/null || groupadd --system rpcjwt
for u in rpcl1el rpcl1cl; do usermod -a -G rpcjwt "$u"; done
install -d -m 0755 -o root -g root /etc/enclave-rpc
install -m 0644 chain.json /etc/enclave-rpc/chain.json
install -m 0755 chain_service.py /opt/enclave-rpc/chain_service.py
install -d -m 0750 -o rpcl1cl -g rpcl1cl /srv/enclave-l1-pair/cl /srv/enclave-l1-pair/tmp-cl
install -d -m 0755 -o root -g root /srv/enclave-l1-pair/anchor
python3 - <<'PY'
import os,secrets
p='/etc/enclave-rpc/jwt.hex'
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o640)
with os.fdopen(fd,'w') as f:
    f.write(secrets.token_hex(32)); f.flush(); os.fsync(f.fileno())
PY
chown root:rpcjwt /etc/enclave-rpc/jwt.hex
chmod 0640 /etc/enclave-rpc/jwt.hex
install -m 0644 units/* /etc/systemd/system/
systemctl daemon-reload
systemd-analyze verify units/*.service units/*.path
'''
    # Anchor files are transferred and checked separately before CL start.
(OUT / 'install.sh').write_text(install)
(OUT / 'install.sh').chmod(0o755)
print(OUT)
