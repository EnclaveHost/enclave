#!/usr/bin/env python3
"""ISOLATED COPY for G4 (work/challenge-host-tls-20261021/g4) of g3-final-package/make-upgrade-bundle-g3.py: identical except
ONE added shape, --add-challenge (see CHALLENGE below). Without --new-config it is the original, byte for byte in behaviour.
--new-config accepts exactly these reviewed config shapes:
  * ADD:      every existing service unchanged except its package pin (only when its manifest changed), plus services
              APPENDED for roles named with --add-role (pin = the new stage's package, which must be a new file; an added
              service-tls must say orders "held").
  * APPROVE:  --approve-orders: no file changes allowed by the caller's stages; the ONLY config change is service-tls
              orders "held" -> "approved" (root's explicit first-order gate).
  * CHALLENGE: --add-challenge: the existing service-tls (pin updated with its package) gains ONLY config.challenge
              {tlsPort, frontPort, declarationFile, release{dnsSha256, runtimeBundleSha256}}, absent before; its orders
              must stay exactly as they were and be "held". Not combinable with --approve-orders or --add-role.
Anything else in the config refuses.

Build the PINNED in-place upgrade bundle for hs2-upgrade.ps1 (work/host-service-tls-20261021/upgrade). Local, read-only
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

def strip(svc): return {k: v for k, v in svc.items() if k != 'package'}

def check_new_config(cfg, new_cfg, a, b, add_roles, approve_orders, add_challenge=False):
    """The G3 shapes (see the module doc). Returns (changed pins, added roles, orders approved)."""
    if json.dumps({k: v for k, v in cfg.items() if k != 'services'}, sort_keys=True) != json.dumps({k: v for k, v in new_cfg.items() if k != 'services'}, sort_keys=True):
        raise Refused('the new config changes something outside services')
    old_s, new_s = cfg['services'], new_cfg['services']
    if len(new_s) < len(old_s): raise Refused('the new config removes a service')
    pins, approved, challenged = {}, False, False
    if add_challenge and (approve_orders or add_roles): raise Refused('--add-challenge is not combinable with --approve-orders or --add-role')
    for o, n in zip(old_s, new_s):
        role = o['role']
        if n.get('role') != role: raise Refused(f'service order/role changed at {role}')
        rel = f'packages/{role}.package.json'
        if o['package'] != 'sha256:' + a[rel]: raise Refused(f'{role}: the live config pin is not the old stage package')
        if b.get(rel) is None: raise Refused(f'the new stage has no {rel}')
        if n['package'] != 'sha256:' + b[rel]: raise Refused(f'{role}: the new pin is not the new stage package')
        if b[rel] != a[rel]: pins[o['package']] = n['package']
        so, sn = strip(o), strip(n)
        if approve_orders and role == 'service-tls' and so != sn:
            if so['config'].get('orders', 'held') != 'held' or sn['config'].get('orders') != 'approved' or \
               {k: v for k, v in so['config'].items() if k != 'orders'} != {k: v for k, v in sn['config'].items() if k != 'orders'} or \
               {k: v for k, v in so.items() if k != 'config'} != {k: v for k, v in sn.items() if k != 'config'}:
                raise Refused('approve: the only allowed change is service-tls orders "held" -> "approved"')
            approved = True
        elif add_challenge and role == 'service-tls' and so != sn:
            oc, nc = so['config'], sn['config']
            ch = nc.get('challenge')
            if 'challenge' in oc or not isinstance(ch, dict) or {k: v for k, v in nc.items() if k != 'challenge'} != oc or \
               {k: v for k, v in so.items() if k != 'config'} != {k: v for k, v in sn.items() if k != 'config'}:
                raise Refused('challenge: the only allowed change is ADDING service-tls config.challenge')
            if oc.get('orders', 'held') != 'held': raise Refused('challenge: orders must stay "held"')
            if sorted(ch) != ['declarationFile', 'frontPort', 'release', 'tlsPort'] or not all(isinstance(ch[k], int) and 1 <= ch[k] <= 65535 for k in ('tlsPort', 'frontPort')) or \
               not isinstance(ch['declarationFile'], str) or not re.fullmatch(r'[A-Za-z]:\\.+|/.+', ch['declarationFile']) or not isinstance(ch['release'], dict) or \
               sorted(ch['release']) != ['dnsSha256', 'runtimeBundleSha256'] or not all(re.fullmatch(r'[0-9a-f]{64}', str(v)) for v in ch['release'].values()):
                raise Refused('challenge: malformed block (tlsPort, frontPort, absolute declarationFile, release pins)')
            challenged = True
        elif so != sn: raise Refused(f'{role}: the new config changes more than its package pin')
    added = []
    for n in new_s[len(old_s):]:
        role = n.get('role')
        if approve_orders: raise Refused('approve: no service may be added')
        if role not in add_roles or role in added or any(o['role'] == role for o in old_s): raise Refused(f'added service {role!r} is not allowed (--add-role, once)')
        rel = f'packages/{role}.package.json'
        if rel in a or rel not in b: raise Refused(f'added service {role}: its package must be NEW in the new stage')
        if n.get('package') != 'sha256:' + b[rel]: raise Refused(f'added service {role}: pin is not the new stage package')
        if role == 'service-tls' and n.get('config', {}).get('orders') != 'held': raise Refused('an added service-tls must say orders "held" explicitly')
        added.append(role)
    if approve_orders and not approved: raise Refused('approve: no service-tls orders "held" -> "approved" change found')
    if add_challenge and not challenged: raise Refused('challenge: no service-tls config.challenge was added')
    return pins, added, approved, challenged

def build(old_stage, new_stage, old_config, old_config_sha, old_receipt_sha, out, new_config=None, add_roles=(), approve_orders=False, add_challenge=False):
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
    added, approved, challenged = [], False, False
    if new_config is not None:
        cfg = json.loads(read(old_config).decode('utf-8'))
        new_bytes_g3 = read(new_config)
        pins, added, approved, challenged = check_new_config(cfg, json.loads(new_bytes_g3.decode('utf-8')), a, b, tuple(add_roles), approve_orders, add_challenge)
        for r in added:
            if not any(e['path'] == f'packages/{r}.package.json' for e in add): raise Refused(f'{r}: its package is not in add')
        text = new_bytes_g3.decode('utf-8')
    elif add_roles or approve_orders or add_challenge: raise Refused('--add-role/--approve-orders/--add-challenge need --new-config')
    # config: replace only the pins of packages whose manifest changed, as text (gen-config wrote JSON.stringify(cfg, null, 2))
    if new_config is None:
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
        'config': {'old': old_config_sha.lower(), 'new': hashlib.sha256(new_bytes).hexdigest(), 'changedPins': pins,
                   **({'addedServices': added} if added else {}), **({'ordersApproved': True} if approved else {}), **({'challengeAdded': True} if challenged else {})},
        'receipt': {'old': old_receipt_sha.lower()},
    }
    mpath = os.path.join(out, 'upgrade-manifest.json')
    with open(mpath, 'w', encoding='utf-8', newline='\n') as f: f.write(json.dumps(manifest, indent=1) + '\n')
    return manifest, sha_file(mpath)

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    for k in ('old-stage', 'new-stage', 'old-config', 'old-config-sha', 'old-receipt-sha', 'out'): ap.add_argument('--' + k, required=True)
    ap.add_argument('--new-config'); ap.add_argument('--add-role', action='append', default=[]); ap.add_argument('--approve-orders', action='store_true'); ap.add_argument('--add-challenge', action='store_true')
    o = ap.parse_args()
    try:
        m, h = build(o.old_stage, o.new_stage, o.old_config, o.old_config_sha, o.old_receipt_sha, o.out, o.new_config, o.add_role, o.approve_orders, o.add_challenge)
    except Refused as e:
        print(f'REFUSED: {e}', file=sys.stderr); sys.exit(1)
    print(json.dumps({'manifestSha256': h, 'id': m['id'], 'replace': [e['path'] for e in m['replace']], 'add': [e['path'] for e in m['add']],
                      'config': m['config']}, indent=1))
