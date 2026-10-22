#!/usr/bin/env python3
"""make-pins.py LIVE.json OUT.json [--run-shield-sha SHA --run-shield-sets JSON] -- local. Pins for migrate-local-config.ps1 from root's
names-and-hashes read: every source/hook file sha256 and the exact (name, value sha256) list of run-node.cmd's set lines, in order.
run-shield.cmd and shield-config.local.cmd were NOT in the 2026-10-22 live read: they stay UNPINNED unless given (the plan then
REFUSES). Extra entries (generated-file customizations) are only those compare-config.r2.py classifies as blocking: none live."""
import argparse, json, pathlib
a = argparse.ArgumentParser(); a.add_argument('live'); a.add_argument('out'); a.add_argument('--run-shield-sha'); a.add_argument('--run-shield-sets', default=None)
a.add_argument('--shield-local-sha', default=None); o = a.parse_args()
live = json.loads(pathlib.Path(o.live).read_text())
files = {f: live[f]['sha256'] for f in ('run-node.cmd', 'node-config.local.cmd') if live.get(f, {}).get('present')}
# a reader r2 read (config-names-read.r2.py) also covers the Shield launcher and its hook: pinned from it ("absent" when absent)
for f in ('run-shield.cmd', 'shield-config.local.cmd'):
    if f in live: files[f] = live[f]['sha256'] if live[f].get('present') else 'absent'
if o.run_shield_sha: files['run-shield.cmd'] = o.run_shield_sha
if o.shield_local_sha: files['shield-config.local.cmd'] = o.shield_local_sha
sources = {'run-node.cmd': [{'name': s['name'], 'valueSha256': s['valueSha256']} for s in live['run-node.cmd']['sets']]}
if o.run_shield_sets is not None: sources['run-shield.cmd'] = json.loads(o.run_shield_sets)
elif live.get('run-shield.cmd', {}).get('present'): sources['run-shield.cmd'] = [{'name': s['name'], 'valueSha256': s['valueSha256']} for s in live['run-shield.cmd']['sets']]
pins = {'format': 'enclave-local-config-pins/v1', 'from': o.live, 'files': files, 'sources': sources, 'extra': [],
        'unpinned': [f for f in ('run-shield.cmd', 'shield-config.local.cmd') if f not in files]}
pathlib.Path(o.out).write_text(json.dumps(pins, indent=1) + '\n'); print(json.dumps(pins, indent=1))
