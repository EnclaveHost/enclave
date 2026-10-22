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
  ('M1 port 80 forwards the challenge name (plaintext push)', ST, "      if (!port) return reply(sock, 404, 'Not Found');           // the challenge origin: https only, no plaintext API\n", '', T_ST),
  ('M2 no proof of the front key', ST, "        if (!why) why = await proveFront(doc.proofKey);\n", '', T_ST),
  ('M3 declaration for any host', DECL, "  if (doc.hostId !== expect.hostId) return 'declared for another host';\n", '', T_ST),
  ('M4 managed front may bind publicly', RH, "hostPort(c.front.listen, 'front.listen', {loopback: true}), zone: c.front.managed.zone", "hostPort(c.front.listen, 'front.listen'), zone: c.front.managed.zone", T_MF),
  ('M5 a stopped front keeps established connections', ST, "if (connections) for (const s of chal.sockets) s.destroy();", '', T_ST),
  ('M6 provider grants the challenge name without opt-in', PROV, "...(hs.challenge===true?[hostChallengeName(runner,hs.zone)]:[])", "...[hostChallengeName(runner,hs.zone)]", T_PR),
  ('M7 managed front answers any Host', RH, "if (host !== cfg.front.name) { req.resume(); return send(421, {error: 'misdirected request'}); }", '', T_MF),
  ('M8 halt does not declare stopped', RH, "serving = false; stoppedFor = why; declare('stopped', why);", "serving = false; stoppedFor = why;", T_MF),
  ('M9 the certificate omits the challenge origin', ST, "certNames = [...tlsRoles.map((r) => all[r]), ...(chalName ? [chalName] : [])];", "certNames = tlsRoles.map((r) => all[r]);", T_ST),
  ('M10 G1 does not expect the challenge name in the grant', G1, "this.granted = [...Object.values(all), ...(chal ? [chal] : [])];", "this.granted = Object.values(all);", T_ST),
]
def run(test):
    r = subprocess.run(['node', '--preserve-symlinks', '--test', '--test-concurrency=1', '--test-timeout=60000', test], cwd=MUT, capture_output=True, text=True, timeout=900)
    fails = [l for l in r.stdout.splitlines() if l.startswith('not ok')]
    return r.returncode, fails
results = []
rc, fails = run(T_ST); rc2, f2 = run(T_MF); rc3, f3 = run(T_PR)
print(f'CONTROL unmutated: service-tls rc={rc} managed rc={rc2} provider rc={rc3}', flush=True)
ok = rc == 0 and rc2 == 0 and rc3 == 0
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
