#!/usr/bin/env python3
"""Stage a launcher RE-PIN for the ALREADY INSTALLED v2 enclave-rpc-production (installs nothing; root reviews + runs).

  python3 -I repin_stage.py --launcher NEW_provision_vm.py --accept-launcher-sha SHA256 --out NEW_EMPTY_DIR

Reads (read-only) the installed manifest, launcher and both unit files; refuses unless they are the consistent installed
v2 (launcher sha == manifest pin, both units == the OLD launcher's renders). The new manifest differs ONLY in
files.launcher; the QEMU argv render must still equal the manifest's qemuArgv pin, and the new launcher's unit renders
must equal the old launcher's renders of the new manifest (templates unchanged, only the manifest sha moves).
Writes into --out: provision_vm.py, manifest.json, both units, install.sh (VM+guard stopped, old shas checked, backup,
install, daemon-reload, verify; starts nothing), rollback.sh, SHA256SUMS."""
import argparse, hashlib, importlib.util, json, os, sys

STATE = os.path.expanduser('~/.local/state/enclave-rpc-production')


def refuse(msg):
    print(f'REFUSED: {msg}', file=sys.stderr)
    sys.exit(2)


def sha(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


INSTALL = r'''#!/bin/bash
# repin_stage.py: launcher re-pin {old_l} -> {new_l} for the installed v2. ROOT REVIEWS FIRST. uid {uid}, never root.
# Backs up, installs launcher+manifest+both units, daemon-reloads, verifies. Never starts/stops a unit or touches a disk.
set -euo pipefail
umask 077
STAGE={stage}
STATE={state}
UNITDIR={unitdir}
BK="$STATE/backup-repin-{bk}"
[ "$(id -u)" = {uid} ] || {{ echo "run as uid {uid}"; exit 1; }}
for u in {vm_unit} {guard_unit}; do
  s=$(systemctl --user show -p ActiveState --value "$u"); p=$(systemctl --user show -p MainPID --value "$u")
  case "$s" in inactive|failed) ;; *) echo "$u is $s: stop the VM first"; exit 1;; esac
  [ "$p" = 0 ] || {{ echo "$u MainPID $p"; exit 1; }}
done
(cd "$STAGE" && sha256sum -c --quiet SHA256SUMS)
echo "{old_m}  $STATE/manifest.json" | sha256sum -c --quiet -
echo "{old_l}  $STATE/provision_vm.py" | sha256sum -c --quiet -
echo "{old_vu}  $UNITDIR/{vm_unit}" | sha256sum -c --quiet -
echo "{old_gu}  $UNITDIR/{guard_unit}" | sha256sum -c --quiet -
mkdir -m 0700 "$BK"
cp -a "$STATE/manifest.json" "$STATE/provision_vm.py" "$UNITDIR/{vm_unit}" "$UNITDIR/{guard_unit}" "$BK/"
(cd "$BK" && sha256sum manifest.json provision_vm.py {vm_unit} {guard_unit} > SHA256SUMS && sha256sum -c --quiet SHA256SUMS)
install -m 0500 "$STAGE/provision_vm.py" "$STATE/.provision_vm.py.new" && mv -f "$STATE/.provision_vm.py.new" "$STATE/provision_vm.py"
install -m 0600 "$STAGE/manifest.json" "$STATE/.manifest.json.new" && mv -f "$STATE/.manifest.json.new" "$STATE/manifest.json"
install -m 0644 "$STAGE/{vm_unit}" "$UNITDIR/.{vm_unit}.new" && mv -f "$UNITDIR/.{vm_unit}.new" "$UNITDIR/{vm_unit}"
install -m 0644 "$STAGE/{guard_unit}" "$UNITDIR/.{guard_unit}.new" && mv -f "$UNITDIR/.{guard_unit}.new" "$UNITDIR/{guard_unit}"
for f in provision_vm.py manifest.json; do cmp "$STAGE/$f" "$STATE/$f"; done
for f in {vm_unit} {guard_unit}; do cmp "$STAGE/$f" "$UNITDIR/$f"; done
systemctl --user daemon-reload
if ! /usr/bin/python3 -I "$STATE/provision_vm.py" verify > "$BK/verify-after-install.json"; then
  echo "verify FAILED after install: run $STAGE/rollback.sh"; exit 1
fi
echo "re-pinned launcher {new_l} (backup $BK). Nothing started."
'''
ROLLBACK = r'''#!/bin/bash
# Restores the files backed up by install.sh (VM+guard must be stopped). Starts nothing.
set -euo pipefail
STATE={state}
UNITDIR={unitdir}
BK="$STATE/backup-repin-{bk}"
[ "$(id -u)" = {uid} ] || {{ echo "run as uid {uid}"; exit 1; }}
for u in {vm_unit} {guard_unit}; do
  s=$(systemctl --user show -p ActiveState --value "$u")
  case "$s" in inactive|failed) ;; *) echo "$u is $s: stop the VM first"; exit 1;; esac
done
(cd "$BK" && sha256sum -c --quiet SHA256SUMS)
install -m 0500 "$BK/provision_vm.py" "$STATE/provision_vm.py"
install -m 0600 "$BK/manifest.json" "$STATE/manifest.json"
install -m 0644 "$BK/{vm_unit}" "$UNITDIR/{vm_unit}"
install -m 0644 "$BK/{guard_unit}" "$UNITDIR/{guard_unit}"
systemctl --user daemon-reload
/usr/bin/python3 -I "$STATE/provision_vm.py" verify > "$BK/verify-after-rollback.json"
echo "rolled back to launcher {old_l}. Nothing started."
'''


def main(argv):
    ap = argparse.ArgumentParser(prog='repin_stage.py')
    ap.add_argument('--launcher', required=True)
    ap.add_argument('--accept-launcher-sha', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--state', default=STATE)
    a = ap.parse_args(argv)
    new_l = sha(a.launcher)
    if new_l != a.accept_launcher_sha:
        refuse(f'{a.launcher} sha256 {new_l} != --accept-launcher-sha')
    man, old_path = os.path.join(a.state, 'manifest.json'), os.path.join(a.state, 'provision_vm.py')
    with open(man) as f:
        mtext = f.read()
    m = json.loads(mtext)
    old, new = load(old_path, 'pv_installed'), load(a.launcher, 'pv_repin')
    if not old.is_v2(m) or old.canonical(m) != mtext:
        refuse('installed manifest is not a canonical v2 manifest')
    msha, old_l = old.sha256_text(mtext), sha(old_path)
    if old_l != m['files']['launcher']:
        refuse('installed launcher differs from its manifest pin')
    p = m['paths']
    for path, text in ((p['unitPath'], old.render_unit(m, msha)), (p['guardUnitPath'], old.render_guard_unit(m, msha))):
        with open(path) as f:
            if f.read() != text:
                refuse(f'{path} differs from the installed launcher render')
    if new.sha256_text(new.canonical(new.qemu_argv(m))) != m['files']['qemuArgv']:
        refuse('the new launcher renders a different QEMU argv: not a launcher-only re-pin')
    m2 = json.loads(mtext)
    m2['files']['launcher'] = new_l
    new.validate_v2(m2)
    mtext2 = new.canonical(m2)
    msha2 = new.sha256_text(mtext2)
    units = {new.UNIT: new.render_unit(m2, msha2), new.GUARD_UNIT: new.render_guard_unit(m2, msha2)}
    if units != {old.UNIT: old.render_unit(m2, msha2), old.GUARD_UNIT: old.render_guard_unit(m2, msha2)}:
        refuse('unit templates changed between launchers: not a launcher-only re-pin')
    os.mkdir(a.out, 0o700)
    files = {'manifest.json': mtext2, **units}
    for n, t in files.items():
        with open(os.path.join(a.out, n), 'x') as f:
            f.write(t)
    with open(a.launcher, 'rb') as s, open(os.path.join(a.out, 'provision_vm.py'), 'xb') as d:
        d.write(s.read())
    if sha(os.path.join(a.out, 'provision_vm.py')) != new_l:
        refuse('staged launcher copy differs')
    fmt = dict(stage=os.path.abspath(a.out), state=p['stateDir'], unitdir=os.path.dirname(p['unitPath']), uid=m['uid'],
               vm_unit=new.UNIT, guard_unit=new.GUARD_UNIT, bk=msha2[:12], old_l=old_l, new_l=new_l, old_m=msha,
               old_vu=sha(p['unitPath']), old_gu=sha(p['guardUnitPath']))
    for n, t in (('install.sh', INSTALL), ('rollback.sh', ROLLBACK)):
        with open(os.path.join(a.out, n), 'x') as f:
            f.write(t.format(**fmt))
        os.chmod(os.path.join(a.out, n), 0o700)
    with open(os.path.join(a.out, 'SHA256SUMS'), 'x') as f:
        for n in sorted(os.listdir(a.out)):
            if n != 'SHA256SUMS':
                f.write(f'{sha(os.path.join(a.out, n))}  {n}\n')
    print(json.dumps({'staged': a.out, 'oldLauncher': old_l, 'newLauncher': new_l, 'oldManifest': msha,
                      'newManifest': msha2, 'qemuArgvSha256': m2['files']['qemuArgv'],
                      'next': f'root reviews, then (VM + guard stopped) {a.out}/install.sh'}, indent=1, sort_keys=True))


if __name__ == '__main__':
    main(sys.argv[1:])
