#!/usr/bin/env python3
"""Baseline (unmutated) then one source mutant at a time; each must make its target suite FAIL. Every mutated file is restored
from a byte copy on exit (also on error). Each node --test run has its own wall-clock bound."""
import subprocess, sys, shutil, os, time
R = '/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-issuer-implementation/repo'
ROLE, ISS, LIB = 'metal/guest/platform-api-role.mjs', 'metal/guest/native-issuer.mjs', 'metal/guest/native-certificate.mjs'
ROLE_T, LEAF_T = 'test/platform-api-native-issuer.test.mjs', 'test/native-certificate-leaf.test.mjs'
MUTANTS_ALL = [
  ('M1 relay env: final NATIVE_CA filter removed', ROLE_T, [(ROLE, '    for (const k of Object.keys(env)) if (isNativeCaCredential(k)) delete env[k];\n', '')]),
  ('M2 servedLeaf: signature/issued-by not checked', ROLE_T, [(ISS, 'leaf.checkIssued(ca) && leaf.verify(ca.publicKey) && ', '')]),
  ('M3 barrier: run/credentials hold not checked', ROLE_T, [(ISS, '    const holds = () => live() && credentialsDigest() === run.digest;', '    const holds = () => true;')]),
  ('M4 barrier: admission not decided again', ROLE_T, [(ISS, "    if (!again || again.admit !== true || !again.host || lc(again.host.operator) !== v.identity.operator) throw", '    if (false) throw')]),
  ('M5 archive: a half-written sink counts', ROLE_T, [(ROLE, 'then((r) => r.every((x) => x.status === "fulfilled"))', 'then((r) => r.some((x) => x.status === "fulfilled"))')]),
  ('M6 pins: null SPKI accepted at install and socket', LEAF_T, [
     (LIB, "  if (typeof spkiSha256 !== 'string' || !SPKI_HEX.test(spkiSha256)) throw new Error('the attested key digest (64 lowercase hex) is required: nothing is sent unpinned');", "  if (false) throw new Error('x');"),
     (LIB, "  if (s.peerSpkiSha256 !== spkiSha256) { s.destroy();", "  if (spkiSha256 && s.peerSpkiSha256 !== spkiSha256) { s.destroy();"),
     (LIB, "  if (typeof spkiSha256 !== 'string' || !SPKI_HEX.test(spkiSha256)) return Promise.reject(new Error('install refused: the attested key digest (64 lowercase hex) is required'));", '')]),
]
MUTANTS_ALL.append(('M3b barrier: neither the run hold nor the live step after the re-decision', ROLE_T, [
  (ISS, '    const holds = () => live() && credentialsDigest() === run.digest;', '    const holds = () => true;'),
  (ISS, "    let again;\n    try { again = await d.decideHost(v.identity.registryId, { chipId: v.identity.chipId ?? null }); } catch (e) { throw new Error(`platform host policy unreadable at install: ${short(e)}`); }\n    step();\n",
        "    let again;\n    try { again = await d.decideHost(v.identity.registryId, { chipId: v.identity.chipId ?? null }); } catch (e) { throw new Error(`platform host policy unreadable at install: ${short(e)}`); }\n")]))
ONLY = os.environ.get('ONLY', '')
MUTANTS = [m for m in MUTANTS_ALL if not ONLY or m[0].split(' ')[0] in ONLY.split(',')]
def run(test, bound):
  t0 = time.time()
  p = subprocess.run(['timeout', '-k', '5', str(bound), 'node', '--test', '--test-concurrency=1', '--test-force-exit', test], cwd=R, capture_output=True, text=True)
  lines = [l for l in p.stdout.splitlines() if l.startswith(('ok ', 'not ok ', '# pass', '# fail'))]
  return p.returncode, lines, round(time.time() - t0)
backups = {}
def restore():
  for f, b in backups.items(): shutil.copyfile(b, os.path.join(R, f))
  backups.clear()
try:
  rc, lines, s = run(ROLE_T, 240); print(f'BASELINE {ROLE_T} exit={rc} {s}s', *lines, sep='\n  ', flush=True)
  if rc != 0: print('BASELINE FAILED: mutants not run'); sys.exit(1)
  if os.environ.get('SKIP_LEAF_BASELINE') != '1':
   rc, lines, s = run(LEAF_T, 120); print(f'BASELINE {LEAF_T} exit={rc} {s}s', *lines, sep='\n  ', flush=True)
   if rc != 0: print('BASELINE FAILED: mutants not run'); sys.exit(1)
  bad = 0
  for name, test, edits in MUTANTS:
    for f, a, b in edits:
      path = os.path.join(R, f)
      if f not in backups: backups[f] = path + '.mutant-orig'; shutil.copyfile(path, backups[f])
      src = open(path).read()
      if src.count(a) != 1: print(f'{name}: pattern not found exactly once in {f}'); restore(); sys.exit(2)
      open(path, 'w').write(src.replace(a, b))
    rc, lines, s = run(test, 240)
    restore()
    killed = rc != 0
    bad += 0 if killed else 1
    print(f"{'KILLED' if killed else 'SURVIVED'} {name} ({test} exit={rc} {s}s)", *[l for l in lines if l.startswith(('not ok', '# pass', '# fail'))], sep='\n  ', flush=True)
  print('MUTANTS', 'ALL KILLED' if bad == 0 else f'{bad} SURVIVED'); sys.exit(1 if bad else 0)
finally:
  restore()
  for f in [ROLE, ISS, LIB]:
    o = os.path.join(R, f + '.mutant-orig')
    if os.path.exists(o): os.remove(o)
