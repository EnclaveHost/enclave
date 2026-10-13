#!/usr/bin/env python3
"""Permit browser reads of public /ipfs/* content without changing upload policy.

Run on the gateway host. Backs up and validates Caddy before reloading it.
"""
from pathlib import Path
import datetime
import shutil
import subprocess

path = Path('/etc/caddy/Caddyfile')
original = path.read_text()
start = original.index('ipfs.enclave.host {')
end = original.index('\n}', start)
block = original[start:end]
marker = '\t@gwread path /ipfs/*\n'
addition = ('\theader @gwread {\n'
            '\t\tAccess-Control-Allow-Origin "*"\n'
            '\t\tdefer\n'
            '\t}\n')
if addition in block:
    print('Public IPFS read CORS is already configured.')
else:
    assert block.count(marker) == 1, 'Expected one public IPFS read matcher'
    updated = original[:start] + block.replace(marker, marker + addition) + original[end:]
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = path.with_name('Caddyfile.before-ipfs-read-cors-' + stamp)
    shutil.copy2(path, backup)
    backup.chmod(0o600)
    path.write_text(updated)
    check = subprocess.run(['caddy', 'validate', '--config', str(path)], capture_output=True)
    if check.returncode:
        path.write_text(original)
        raise SystemExit('Caddy validation failed; original configuration restored.')
    reload = subprocess.run(['systemctl', 'reload', 'caddy'])
    if reload.returncode:
        path.write_text(original)
        subprocess.run(['systemctl', 'reload', 'caddy'], check=True)
        raise SystemExit('Reload failed; original configuration restored and reloaded.')
    print('Public IPFS read CORS enabled; signed-upload policy unchanged.')
