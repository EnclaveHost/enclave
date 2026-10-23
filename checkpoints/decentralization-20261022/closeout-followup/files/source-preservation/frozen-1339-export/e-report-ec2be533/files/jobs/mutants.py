# Mutation controls for profile-broadcast.js: each mutant must make test/site-wallet-profile-broadcast.test.mjs FAIL.
# Applied in place one at a time; the file is restored from git after each (and on any exit).
import subprocess, sys, os
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "repo"))
F = "site/js/core/profile-broadcast.js"
M = {
  "M1-no-field-check": ('    if ((got[k] === null ? null : typeof got[k] === "bigint" ? got[k] : lower(got[k])) !== want[k])\n', '    if (false)\n'),
  "M2-fallback-to-wallet-broadcast": ('      throw new BroadcastError("your wallet does not sign a transaction without broadcasting it itself', '      return provider.request({ method: "eth_sendTransaction", params: [request] }); throw new BroadcastError("your wallet does not sign a transaction without broadcasting it itself'),
  "M3-no-signer-check": ('  if (!/^0x[0-9a-f]{64}$/.test(who || "") || "0x" + who.slice(26) !== lower(from))\n', '  if (false)\n'),
  "M4-unknown-reported-as-refused": ('  if (unanswered){\n', '  if (false){\n'),
}
orig = open(F).read()
killed = 0
try:
  for name, (a, b) in M.items():
    assert orig.count(a) == 1, name
    open(F, "w").write(orig.replace(a, b))
    r = subprocess.run(["timeout", "-k", "5", "240", "node", "--test", "--test-force-exit", "test/site-wallet-profile-broadcast.test.mjs"], capture_output=True, text=True)
    fails = [l for l in r.stdout.splitlines() if l.startswith("not ok")]
    print(name, "rc", r.returncode, "KILLED" if r.returncode != 0 else "SURVIVED", *fails, sep="\n  ")
    killed += r.returncode != 0
finally:
  open(F, "w").write(orig)
print("killed", killed, "of", len(M))
print("restored:", subprocess.run(["git", "diff", "--stat", F], capture_output=True, text=True).stdout or "clean")
sys.exit(0 if killed == len(M) else 1)
