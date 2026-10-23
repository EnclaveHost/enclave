"""Mutation check for attest-control.mjs and check-attestation-verdict.py: each mutant weakens one rule; tests must FAIL.
The copies live BESIDE this folder (work/.attest-mut-*) so ../custody-recipient-restore-20261023/repo resolves exactly as for
the real file; the UNMUTATED copy runs first and must PASS (attest-mutants-1 ran in /tmp, where every copy failed: invalid)."""
import shutil, subprocess, sys, tempfile
from pathlib import Path
A = Path(__file__).resolve().parent
MUT = {
 'attest-control.mjs': {
  'nonce-binding-optional': [("const required = Object.fromEntries(REQUIRED_CHECKS.map((k) => [k, checks[k] === true ? 'PASS' : checks[k] === false ? 'FAIL' : 'UNAVAILABLE']));",
                              "const required = Object.fromEntries(REQUIRED_CHECKS.map((k) => [k, checks[k] === true || k === 'binding' ? 'PASS' : checks[k] === false ? 'FAIL' : 'UNAVAILABLE']));")],
  'unavailable-counts-as-pass': [("checks[k] === false ? 'FAIL' : 'UNAVAILABLE']));", "checks[k] === false ? 'FAIL' : 'PASS']));")],
  'leak-chip-id': [("    chipIdSha256: chipId ? sha(Buffer.from(chipId, 'hex')) : null,", "    chipIdSha256: chipId ? sha(Buffer.from(chipId, 'hex')) : null, chipId,")],
  'leak-raw-in-public': [("    rawSha256: rawBody ? sha(Buffer.from(JSON.stringify(rawBody))) : null,", "    rawSha256: rawBody ? sha(Buffer.from(JSON.stringify(rawBody))) : null, raw: rawBody,")],
  'raw-world-readable': [("{ mode: 0o600, flag: 'wx' }); fs.chmodSync(rawFile, 0o600);", "{ mode: 0o644, flag: 'wx' });")],
  'image-pin-unchecked': [("if (sha(fs.readFileSync(path.join(t.image, f))) !== h) throw", "if (false) throw")],
 },
 'check-attestation-verdict.py': {
  'accept-limited': [("    if v.get('status') != 'verified' or v.get('admissionSafe') is not True:", "    if False:")],
  'skip-required': [("        if req.get(k) != 'PASS':", "        if req.get(k) == 'FAIL':")],
  'skip-time': [("    if attached_at is not None and str(v.get('at', '')) <= attached_at:", "    if False:")],
 },
}
def run(fname=None, s=None):
    d = Path(tempfile.mkdtemp(prefix='.attest-mut-', dir=A.parent))
    try:
        for x in ['common.py', 'attest-control.mjs', 'check-attestation-verdict.py', 'apphealth.py', 'guestrows.py']: shutil.copy(A / x, d / x)
        shutil.copytree(A / 'tests', d / 'tests', ignore=shutil.ignore_patterns('__pycache__')); shutil.copytree(A / 'evidence', d / 'evidence', ignore=shutil.ignore_patterns('private'))
        if fname: (d / fname).write_text(s)
        r1 = subprocess.run(['node', '--test', '--test-concurrency=1', 'tests/attest-control.test.mjs'], cwd=d, capture_output=True, text=True)
        r2 = subprocess.run([sys.executable, '-m', 'unittest', 'tests.test_verdict_check'], cwd=d, capture_output=True, text=True)
        return r1.returncode, r2.returncode
    finally: shutil.rmtree(d)
c = run(); print('control (unmutated):', c); assert c == (0, 0), 'the unmutated copy must pass'
bad = 0
for fname, muts in MUT.items():
    src = (A / fname).read_text()
    for name, subs in muts.items():
        s = src
        for a, b in subs: assert a in s, (name, a[:50]); s = s.replace(a, b)
        r1, r2 = run(fname, s)
        killed = r1 != 0 or r2 != 0; bad += not killed
        print(('KILLED  ' if killed else 'SURVIVED'), fname, name, (r1, r2))
print('survived', bad); sys.exit(1 if bad else 0)
