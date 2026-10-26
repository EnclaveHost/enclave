#!/usr/bin/env python3
"""install_closure.py (production-capture-closure-stage; PREPARED, NOT run): ROOT-ONLY install of the A1 capture closure ON THE RPC GUEST,
from <stage>/bundle (tools/assemble_bundle.py), with the reviewed journaled installer (install/installer_core.py = r6-ops-fixes-r2
install_verified.py, pinned below): every bundle file and tree file is checked against install/MANIFEST.json BEFORE any write, the commit is
journaled, and any failure rolls back exactly. Dry run by default; --commit only with root's passing qualification of THIS stage
('## capture-closure rc=0' and '## capture-closure SHA256SUMS <sha of this stage's SHA256SUMS>'). Installs bytes only: the review flags
(A1_CAPTURE_REVIEWED etc.) stay False and activation remains install_verified.py activate after qualification."""
import argparse, datetime, hashlib, importlib.util, json, os, pathlib, sys
HERE = pathlib.Path(__file__).resolve().parent; ST = HERE.parent; BUNDLE = ST / 'bundle'
CORE_SHA256 = '356e64c3776c9cd3a7dc790de044c23d93b9aa91cb71ad50ef6d41f611308c13'
sha = lambda b: hashlib.sha256(b).hexdigest()
def main(argv):
    ap = argparse.ArgumentParser(); ap.add_argument('--qualification', required=True); ap.add_argument('--rc', required=True)
    ap.add_argument('--commit', action='store_true'); ap.add_argument('--replace', action='store_true'); a = ap.parse_args(argv)
    if os.geteuid() != 0:
        print('REFUSED: root only'); return 2
    core = (HERE / 'installer_core.py').read_bytes()
    if sha(core) != CORE_SHA256:
        print('REFUSED: installer_core.py is not the reviewed r6-ops-fixes-r2 installer'); return 1
    spec = importlib.util.spec_from_file_location('installer_core', HERE / 'installer_core.py'); IV = importlib.util.module_from_spec(spec); spec.loader.exec_module(IV)
    try:
        sums = (ST / 'SHA256SUMS').read_bytes()
        for line in sums.decode().splitlines():
            want, rel = line.split(None, 1)
            if sha((ST / rel.lstrip('*')).read_bytes()) != want:
                IV.refuse(f'stage file {rel} differs from SHA256SUMS')
        out = pathlib.Path(a.qualification).read_text(errors='replace').splitlines()
        if pathlib.Path(a.rc).read_text().strip() != '0' or '## capture-closure rc=0' not in out or f'## capture-closure SHA256SUMS {sha(sums)}' not in out:
            IV.refuse('no passing root qualification of THIS stage')
        m = json.loads((HERE / 'MANIFEST.json').read_bytes())
        for t in m['trees']:
            t['src'] = str(BUNDLE / t['src'])
        ops, plan = IV.preflight(m, replace=a.replace, include_wrapper=False, include_units=False, stage=BUNDLE)
        result = IV.commit(ops, datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')) if a.commit else 'dry-run (nothing written)'
    except (IV.Refused, OSError, KeyError, ValueError) as e:
        print(json.dumps({'ok': False, 'refused': str(e)})); return 1
    print(json.dumps({'ok': True, 'commit': a.commit, 'result': result, 'plan': plan}, indent=1)); return 0
if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
