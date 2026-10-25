#!/usr/bin/env python3
"""Stage pinned chain clients for the isolated RPC VM; never contact or change production.

The generated download services operate only on new, mounted chain volumes. They do
not start serving RPC, alter consumers, or overwrite existing chain state.
"""
import argparse
import hashlib
import json
import pathlib
import shutil

HERE = pathlib.Path(__file__).resolve().parent
WORK = HERE.parent
PINS = {
    'base': (WORK / 'fresh-witness-supply/staging/base-v1.5.1-20261023T053947Z/base',
             '9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f'),
    'reth': (WORK / 'rpc-l1-source-package/bin/reth-v2.8.0',
             '8cdd1f35e00558a40ff19001752c4b4fa3ea885c88d1c704348ba88248f6d250'),
    'lighthouse': (WORK / 'rpc-l1-source-package/bin-staging/lighthouse-v8.3.2/lighthouse',
                   '11b7bca8df09b3f985a03a72f241ef9e011c99332fe86677b654947eaa1e9e96'),
}
MANIFESTS = {
    'base': 'https://mainnet-v2-snapshots.base.org/1792886410/manifest.json',
    'l1': 'https://snapshots-r2.reth.rs/reth-1-archive-stable-26263563-1792861874/manifest.json',
}

def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--binary-dir', type=pathlib.Path, help='directory containing base, reth, lighthouse with the exact pinned digests')
    p.add_argument('--out', type=pathlib.Path, required=True)
    p.add_argument('--base-mount', default='/srv/enclave-base-holder')
    p.add_argument('--l1-mount', default='/srv/enclave-l1-pair')
    a = p.parse_args()
    if a.binary_dir:
        for name, (_, pin) in list(PINS.items()):
            PINS[name] = (a.binary_dir / name, pin)
    for m in (a.base_mount, a.l1_mount):
        assert m.startswith('/srv/') and all(c.isalnum() or c in '/_-' for c in m), 'unsafe mount'
    assert a.base_mount != a.l1_mount
    assert not a.out.exists(), 'refusing existing payload directory'
    for name, (src, expected) in PINS.items():
        assert digest(src) == expected, f'{name} binary digest mismatch'
    a.out.mkdir(parents=True)
    (a.out / 'bin').mkdir()
    (a.out / 'units').mkdir()
    for name, (src, expected) in PINS.items():
        dst = a.out / 'bin' / name
        shutil.copyfile(src, dst)
        dst.chmod(0o755)
        assert digest(dst) == expected
    meta = {'format': 'enclave-rpc-production-bootstrap/v1',
            'binaries': {name: pin for name, (_, pin) in PINS.items()},
            'snapshotManifests': MANIFESTS,
            'mounts': {'base': a.base_mount, 'l1': a.l1_mount},
            'servingProduction': False,
            'nvmeCacheBytes': 0}
    (a.out / 'manifest.json').write_text(json.dumps(meta, indent=2) + '\n')
    # Fixed upstream selections. No --force, --prune-unlisted or implicit latest.
    commands = {
        'base': '/opt/enclave-rpc/bin/base snapshot download --chain base --with-txs-distance 140000 --with-receipts-distance 140000 --with-state-history-distance 140000',
        'l1': '/opt/enclave-rpc/bin/reth download --chain mainnet --with-txs-distance 140000 --with-receipts-distance 140000 --with-state-history-distance 140000',
    }
    for role, mount in meta['mounts'].items():
        user = 'rpcbase' if role == 'base' else 'rpcl1el'
        ordering = '\nRequires=enclave-rpc-l1-snapshot.service\nAfter=enclave-rpc-l1-snapshot.service' if role == 'base' else ''
        unit = f'''[Unit]
Description=Enclave {role} pinned snapshot bootstrap (not production readiness)
Wants=network-online.target
After=network-online.target{ordering}
RequiresMountsFor={mount}
ConditionPathIsMountPoint={mount}
ConditionPathExists=!{mount}/snapshot-complete
StartLimitIntervalSec=0

[Service]
Type=oneshot
User={user}
Group={user}
Environment=HOME={mount}/data TMPDIR={mount}/tmp
WorkingDirectory={mount}
ExecStartPre=/usr/bin/mountpoint -q {mount}
ExecStart={commands[role]} --manifest-url {MANIFESTS[role]} --datadir {mount}/data --download-concurrency {8 if role == 'base' else 2} --resumable=true -y
ExecStartPost=/usr/bin/sync -f {mount}/data
ExecStartPost=+/usr/bin/touch {mount}/snapshot-complete
ExecStartPost=+/usr/bin/sync -f {mount}/snapshot-complete
TimeoutStartSec=infinity
TimeoutStopSec=120
KillMode=control-group
MemoryMax=4G
MemorySwapMax=0
Restart=on-failure
RestartSec=60
OOMScoreAdjust=700
TasksMax=1024
LimitNOFILE=65536
Nice=10
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths={mount}/data {mount}/tmp
PrivateTmp=yes
UMask=0027

[Install]
WantedBy=multi-user.target
'''
        (a.out / 'units' / f'enclave-rpc-{role}-snapshot.service').write_text(unit)
    install = '''#!/bin/bash
set -euo pipefail
test "$(id -u)" = 0
test ! -e /opt/enclave-rpc/manifest.json
for u in rpcl1el rpcl1cl rpcbase; do
  id "$u" >/dev/null 2>&1 || useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin "$u"
done
install -d -m 0755 /opt/enclave-rpc/bin
install -m 0755 bin/* /opt/enclave-rpc/bin/
install -m 0644 manifest.json /opt/enclave-rpc/manifest.json
'''
    for role, mount in meta['mounts'].items():
        user = 'rpcbase' if role == 'base' else 'rpcl1el'
        install += f'mountpoint -q {mount}\ninstall -d -m 0750 -o {user} -g {user} {mount}/data {mount}/tmp\nchown root:root {mount}\nchmod 0755 {mount}\n'
    install += 'install -m 0644 units/* /etc/systemd/system/\nsystemctl daemon-reload\n'
    (a.out / 'install.sh').write_text(install)
    (a.out / 'install.sh').chmod(0o755)
    print(json.dumps(meta, indent=2))

if __name__ == '__main__':
    main()
