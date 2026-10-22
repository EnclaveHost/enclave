#!/usr/bin/env python3
"""check-release.py - would THIS Windows release, auto-installed by \\Enclave\\Update on minipc, carry every candidate and
live file exactly? Local only; reads JSON manifests; never builds, publishes or contacts a host.

Models the PUBLISHED installer exactly (main 7752a423: update-host.ps1 e0d9df1c lines 85-111, DeltaBundle 48-60;
install-host.ps1 e3f8ff5f lines 114-145):
  - install only if [version](new) > [version](installed)  (update-host: `-le` -> exit 0);
  - DELTA if the changed files (new sha != installed-manifest sha, or not in the kept bundle) are <= 400 and <= 60 MB, else
    FULL (or when no installed bundle is kept: --no-kept-bundle);
  - DELTA: copy files whose sha differs FROM THE INSTALLED MANIFEST (never from the bytes on disk), remove installed-manifest
    paths (runtime|control|network|tuna|bin|guest|tray) the new release drops, keep everything else on disk as it is;
  - FULL: delete Program Files\\Enclave entirely, lay down runtime|control|network|bin|guest|tray + the 3 top-level files;
  - EVERY install stops all \\Enclave\\ tasks but Update, kills every Program Files\\Enclave process, restarts only Card,
    Shield, Node, Network.
  check-release.py --installed M --new N --required R.json [--on-disk D.json] [--no-kept-bundle]
R: {release path: sha256} that must hold after the update. D: {release path: sha256} actually on disk where it differs
from M (in-place hotfixes / overlays / PUT files). Exit 0 = the release keeps every required file exactly (or is not
installed at all); 1 = a required file would be wrong, missing, deleted or mixed; 2 = usage.
"""
import argparse, json, sys

INPF = ('runtime/', 'control/', 'network/', 'bin/', 'guest/', 'tray/')
TOP = ('manifest.json', 'uninstall-host.ps1', 'update-host.ps1')
NOT_RESTARTED = 'every other \\Enclave\\ task (e.g. enclave-host-services-hs2, Relay, NetworkChecker) stays STOPPED: install-host restarts only Card/Shield/Node/Network'


def load(p):
    with open(p, encoding='utf-8-sig') as f: return json.load(f)


def ver(s):
    try: return tuple(int(x) for x in str(s).split('.'))
    except ValueError: return None


def vgt(a, b):   # .NET [version] ordering: missing components compare as -1 (2026.10.21 > 2026.10.20.1, 2026.10.20 < 2026.10.20.1)
    a, b = list(a), list(b); n = max(len(a), len(b)); a += [-1] * (n - len(a)); b += [-1] * (n - len(b)); return a > b


def judge(installed, new, required, on_disk, kept_bundle=True):
    I = {e['path']: e for e in installed['files']}; N = {e['path']: e for e in new['files']}
    vi, vn = ver(installed['version']), ver(new['version'])
    out = {'installedVersion': installed['version'], 'newVersion': new['version']}
    if not vi or not vn: return {**out, 'decision': 'UNREADABLE version: update-host throws, nothing installed'}, 0
    if not vgt(vn, vi): return {**out, 'decision': 'NOT INSTALLED: the new version is not newer (update-host exits 0)'}, 0
    disk = {p: e['sha256'] for p, e in I.items()}; disk.update(on_disk)
    changed = [e for p, e in N.items() if p.startswith(INPF) and (I.get(p, {}).get('sha256') != e['sha256'])]
    mb = sum(int(e.get('bytes', 0)) for e in changed)
    mode = 'FULL' if (not kept_bundle or len(changed) > 400 or mb > 60 * 1024 * 1024) else 'DELTA'
    out.update({'decision': 'INSTALLED', 'mode': mode, 'changedFiles': len(changed), 'changedMB': round(mb / 1048576, 1), 'tasks': NOT_RESTARTED})
    after = {}
    if mode == 'FULL':
        for p, e in N.items():
            if p.startswith(INPF) or p in TOP: after[p] = e['sha256']
        out['deletedOutsideRelease'] = sorted(p for p in disk if p not in after)      # e.g. host-services\\hs2 and PUT files
    else:
        after = dict(disk)
        for e in changed: after[e['path']] = e['sha256']
        for p in TOP:
            if p in N: after[p] = N[p]['sha256']
        gone = [p for p in I if p.startswith(INPF + ('tuna/',)) and p not in N]
        for p in gone: after.pop(p, None)
        out['removedByDelta'] = len(gone)
    bad, rows = 0, {}
    for p, want in sorted(required.items()):
        got = after.get(p)
        if got == want: state = 'OK' + ('' if (p in N and N[p]['sha256'] == want) else ' (kept from disk, NOT in the release: mixed tree)')
        elif got is None: state = 'MISSING/DELETED'
        elif p in N and N[p]['sha256'] == got: state = 'WRONG: the release carries another version'
        else: state = 'WRONG: a stale on-disk copy remains (mixed tree)'
        if not state.startswith('OK') or 'mixed' in state: bad += 1
        rows[p] = {'want': want[:8], 'after': (got or 'absent')[:8], 'inRelease': (N.get(p, {}).get('sha256') or 'absent')[:8], 'state': state}
    out['required'] = rows; out['failures'] = bad
    return out, (1 if bad else 0)


def main():
    a = argparse.ArgumentParser(); a.add_argument('--installed', required=True); a.add_argument('--new', required=True)
    a.add_argument('--required', required=True); a.add_argument('--on-disk'); a.add_argument('--no-kept-bundle', action='store_true')
    o = a.parse_args()
    res, rc = judge(load(o.installed), load(o.new), load(o.required), load(o.on_disk) if o.on_disk else {}, not o.no_kept_bundle)
    print(json.dumps(res, indent=1)); sys.exit(rc)


if __name__ == '__main__':
    main()
