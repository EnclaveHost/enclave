#!/usr/bin/env python3
"""Negative control: each mutant removes ONE guarantee in a scratch copy (network/ and test/ copied, the rest symlinked,
node --preserve-symlinks); the named test file must FAIL. The unmutated copy must PASS. Restores before each mutant."""
import os, shutil, subprocess, sys, pathlib
HERE = pathlib.Path(__file__).resolve().parent; TREE = HERE / 'tree'; MUT = HERE / 'mut'
if MUT.exists(): shutil.rmtree(MUT)
MUT.mkdir()
for e in TREE.iterdir():
    if e.name in ('network', 'test'): shutil.copytree(e, MUT / e.name, symlinks=True)
    else: (MUT / e.name).symlink_to(e)
ST, RH, DECL, PROV, G1 = 'network/host-services/service-tls.mjs', 'network/challenge-replica-host.mjs', 'network/challenge-front-declaration.mjs', 'network/wg-provider/provider.mjs', 'network/host-service-transport.mjs'
T_ST, T_MF, T_PR = 'test/service-tls.test.mjs', 'test/challenge-front-managed.test.mjs', 'test/wg-provider-host-services.test.mjs'
MUTANTS = [
  ('R1a the file entry of the chain is not checked (directory-only trust)', ST, "    if (last && !c?.exists) break;                                   // absent file: a normal startup, nothing to trust yet\n", "    if (last) break;\n", T_ST),
  ('R1b a link at the file path is followed', ST, "      if (pre.isSymbolicLink() || !pre.isFile()) fail('the declaration file is a link or not a regular file');\n", "", T_ST),
  ('R1c ancestors are not checked', ST, "    const last = i === n - 1, what = last ?", "    if (i < n - 2) continue; const last = i === n - 1, what = last ?", T_ST),
  ('R2a Windows: any principal may read the proof key', ST, "    if (readers.length) fail(", "    if (false) fail(", T_ST),
  ('R2b POSIX: a world-readable declaration is accepted', ST, "  if (mode & 0o004) fail(", "  if (false) fail(", T_ST),
  ('R3a Windows: a cached verdict survives a replaced file', ST, "if (force || !verified || verified.identity !== identity || now() - verified.at >= refreshMs) {", "if (force || !verified || now() - verified.at >= refreshMs) {", T_ST),
  ('R3b POSIX: trust is checked only by the preflight, not on each read', ST, "      if (who) posixPathTrust(file, fsx, who);\n", "", T_ST),
]
def run(test):
    r = subprocess.run(['node', '--preserve-symlinks', '--test', '--test-concurrency=1', '--test-timeout=60000', test], cwd=MUT, capture_output=True, text=True, timeout=900)
    fails = [l for l in r.stdout.splitlines() if l.startswith('not ok')]
    return r.returncode, fails
results = []
rc, fails = run(T_ST)
print(f'CONTROL unmutated: service-tls rc={rc}', flush=True)
ok = rc == 0
for name, f, a, b, test in MUTANTS:
    p = MUT / f; orig = p.read_text()
    assert orig.count(a) == 1, (name, orig.count(a))
    p.write_text(orig.replace(a, b))
    try: rc, fails = run(test)
    finally: p.write_text(orig)
    killed = rc != 0
    print(f'{"KILLED" if killed else "SURVIVED"} {name}: rc={rc} failing={[x[:110] for x in fails][:3]}', flush=True)
    ok = ok and killed
shutil.rmtree(MUT)
print('MUTANTS', 'ALL KILLED, CONTROL PASSES' if ok else 'NOT OK'); sys.exit(0 if ok else 1)
