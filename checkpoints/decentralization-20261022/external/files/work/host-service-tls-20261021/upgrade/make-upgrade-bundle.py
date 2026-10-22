#!/usr/bin/env python3
"""Build the PINNED in-place upgrade bundle for hs2-upgrade.ps1 (work/host-service-tls-20261021/upgrade). Local, read-only
inputs; nothing remote. Prepared for root review.

  make-upgrade-bundle.py --old-stage <r3 extracted stage> --new-stage <new extracted stage>
                         --old-config <read-only copy of the live config\\host-services.json> --old-config-sha <hex>
                         --old-receipt-sha <hex of the live config\\install-receipt.txt> --out <new bundle dir>

What it derives, from the two stages' STAGE-SHA256SUMS only:
  replace    program files (bin/, packages/, windows/, STAGE-SHA256SUMS, ACTIVATION-WINDOWS.txt) whose sha differs
  add        program files only in the new stage (e.g. packages/service-tls.*)
  unchanged  program files with the same sha (asserted by the helper, never written)
  config     the live host-services.json with ONLY the changed packages' pins replaced, as text, byte-exact otherwise
It REFUSES (nothing written):
  - a removed program file;
  - a changed windows/stop.ps1, start.ps1, health.ps1 or common.ps1 (the helper runs them across the swap);
  - a changed data/bootstrap-manifest.json (data is never touched);
  - a changed config/supervisor.template.json (supervisor.json is never touched);
  - an old config whose pins are not the old stage's packages, or a pin that does not occur exactly once.
"""
import argparse, hashlib, json, os, re, shutil, sys

PROGRAM = re.compile(r'^((bin|packages|windows)/[A-Za-z0-9._-]+|STAGE-SHA256SUMS|ACTIVATION-WINDOWS\.txt)$')
PINNED_SCRIPTS = ('windows/stop.ps1', 'windows/start.ps1', 'windows/health.ps1', 'windows/common.ps1')

class Refused(Exception): pass

def read(p):
    with open(p, 'rb') as f: return f.read()

def sha_file(p):
    return hashlib.sha256(read(p)).hexdigest()

def sums(stage):
    out = {}
    for line in read(os.path.join(stage, 'STAGE-SHA256SUMS')).decode('utf-8').splitlines():
        m = re.fullmatch(r'([0-9a-f]{64})  (.+)', line)
        if not m: raise Refused(f'malformed STAGE-SHA256SUMS line in {stage}: {line!r}')
        rel = m.group(2)
        if sha_file(os.path.join(stage, rel)) != m.group(1): raise Refused(f'{stage}: {rel} does not match its STAGE-SHA256SUMS')
        out[rel] = m.group(1)
    # the sums file and the activation text are installed program files too (install.ps1 copies both)
    out['STAGE-SHA256SUMS'] = sha_file(os.path.join(stage, 'STAGE-SHA256SUMS'))
    return out

def build(old_stage, new_stage, old_config, old_config_sha, old_receipt_sha, out):
    if sha_file(old_config) != old_config_sha.lower(): raise Refused('the old config copy is not the pinned sha')
    if not re.fullmatch(r'[0-9a-f]{64}', old_receipt_sha.lower()): raise Refused('old receipt sha must be 64 hex')
    a, b = sums(old_stage), sums(new_stage)
    for rel in ('data/bootstrap-manifest.json', 'config/supervisor.template.json'):
        if a.get(rel) != b.get(rel): raise Refused(f'{rel} changes: this helper never touches data or supervisor.json')
    removed = [r for r in a if PROGRAM.match(r) and r not in b]
    if removed: raise Refused(f'program files removed: {removed} (the helper never deletes)')
    for s in PINNED_SCRIPTS:
        if a.get(s) != b.get(s): raise Refused(f'{s} changes: the helper runs the installed stop/start/health across the swap')
    replace = [{'path': r, 'old': a[r], 'new': b[r]} for r in sorted(b) if PROGRAM.match(r) and r in a and a[r] != b[r]]
    add = [{'path': r, 'new': b[r]} for r in sorted(b) if PROGRAM.match(r) and r not in a]
    unchanged = [{'path': r, 'sha': a[r]} for r in sorted(a) if PROGRAM.match(r) and b.get(r) == a[r]]
    # config: replace only the pins of packages whose manifest changed, as text (gen-config wrote JSON.stringify(cfg, null, 2))
    text = read(old_config).decode('utf-8')
    cfg = json.loads(text)
    pins = {}
    for svc in cfg['services']:
        role = svc['role']
        rel = f'packages/{role}.package.json'
        if rel not in a: raise Refused(f'the old stage has no {rel}')
        if svc['package'] != 'sha256:' + a[rel]: raise Refused(f'{role}: the live config pin is not the old stage package')
        if b.get(rel) is None: raise Refused(f'the new stage has no {rel}')
        if b[rel] != a[rel]: pins[svc['package']] = 'sha256:' + b[rel]
    for old_pin, new_pin in pins.items():
        needle = f'"package": "{old_pin}"'
        if text.count(needle) != 1: raise Refused(f'pin {old_pin} does not occur exactly once')
        text = text.replace(needle, f'"package": "{new_pin}"')
    new_cfg = json.loads(text)
    for svc in new_cfg['services']:
        if svc['package'] != 'sha256:' + b[f"packages/{svc['role']}.package.json"]: raise Refused('config rewrite check failed')
    if json.dumps({**cfg, 'services': [{k: v for k, v in s.items() if k != 'package'} for s in cfg['services']]}, sort_keys=True) != \
       json.dumps({**new_cfg, 'services': [{k: v for k, v in s.items() if k != 'package'} for s in new_cfg['services']]}, sort_keys=True):
        raise Refused('the config rewrite changed something other than package pins')
    # bundle
    if os.path.exists(out): raise Refused(f'{out} exists')
    os.makedirs(os.path.join(out, 'config'))
    for e in replace + add:
        dst = os.path.join(out, 'files', *e['path'].split('/'))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(os.path.join(new_stage, *e['path'].split('/')), dst)
        if sha_file(dst) != e['new']: raise Refused(f'copy of {e["path"]} mismatch')
    new_bytes = text.encode('utf-8')
    with open(os.path.join(out, 'config', 'host-services.json'), 'wb') as f: f.write(new_bytes)
    manifest = {
        'format': 'enclave-hs2-upgrade/v1', 'label': 'hs2',
        'id': f"hs2-{a['STAGE-SHA256SUMS'][:8]}-to-{b['STAGE-SHA256SUMS'][:8]}",
        'scripts': {s: a[s] for s in PINNED_SCRIPTS if s in a},
        'replace': replace, 'add': add, 'unchanged': unchanged,
        'config': {'old': old_config_sha.lower(), 'new': hashlib.sha256(new_bytes).hexdigest(), 'changedPins': pins},
        'receipt': {'old': old_receipt_sha.lower()},
    }
    mpath = os.path.join(out, 'upgrade-manifest.json')
    with open(mpath, 'w', encoding='utf-8', newline='\n') as f: f.write(json.dumps(manifest, indent=1) + '\n')
    return manifest, sha_file(mpath)

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    for k in ('old-stage', 'new-stage', 'old-config', 'old-config-sha', 'old-receipt-sha', 'out'): ap.add_argument('--' + k, required=True)
    o = ap.parse_args()
    try:
        m, h = build(o.old_stage, o.new_stage, o.old_config, o.old_config_sha, o.old_receipt_sha, o.out)
    except Refused as e:
        print(f'REFUSED: {e}', file=sys.stderr); sys.exit(1)
    print(json.dumps({'manifestSha256': h, 'id': m['id'], 'replace': [e['path'] for e in m['replace']], 'add': [e['path'] for e in m['add']],
                      'config': m['config']}, indent=1))
