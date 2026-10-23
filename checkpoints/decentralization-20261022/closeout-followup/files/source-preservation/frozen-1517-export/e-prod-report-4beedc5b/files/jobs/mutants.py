# Mutation controls for chain.js waitReceipt's drop check: each mutant must make test/site-wallet-receipt-drop.test.mjs FAIL.
# Applied in place one at a time; the file is restored from its original bytes after each (and on any exit).
import subprocess, sys, os
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "repo"))
F = "site/js/core/chain.js"
A = "    if (!seen && i >= DROP_AFTER && !PROFILE_SENT.has(String(hash).toLowerCase())){\n"
M = {
  "D1-profile-sent-not-exempt": (A, "    if (!seen && i >= DROP_AFTER){\n"),
  "D2-wallet-never-consulted": (A, "    if (false){\n"),
}
orig = open(F).read()
killed = 0
try:
  for name, (a, b) in M.items():
    assert orig.count(a) == 1, name
    open(F, "w").write(orig.replace(a, b))
    r = subprocess.run(["timeout", "-k", "5", "240", "node", "--test", "--test-force-exit", "test/site-wallet-receipt-drop.test.mjs"], capture_output=True, text=True)
    fails = [l for l in r.stdout.splitlines() if l.startswith("not ok")]
    print(name, "rc", r.returncode, "KILLED" if r.returncode != 0 else "SURVIVED")
    for l in fails: print("  ", l)
    killed += r.returncode != 0
finally:
  open(F, "w").write(orig)
print("killed", killed, "of", len(M))
d = subprocess.run(["git", "diff", "--stat", F], capture_output=True, text=True).stdout
print("restored:", d or "clean")
sys.exit(0 if killed == len(M) and not d else 1)
