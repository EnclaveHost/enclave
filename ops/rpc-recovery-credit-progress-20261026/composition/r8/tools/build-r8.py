#!/usr/bin/env python3
"""r8 = refs/r7/candidate + the root-qualified consumer Windows commit e4f507d6b (base aebf4c932, receipt sha 70d39eaa) where it
reconciles EXACTLY; the Windows chain-authority core is NOT composed (BLOCK: two different tested authority designs).
Private repo only. -> refs/r8/candidate-partial, R8-RESOLUTIONS.json"""
import hashlib, json, os, subprocess, tempfile
G = ["git", "--git-dir=src.git"]
def run(*a, inp=None, env=None): return subprocess.run(G + list(a), input=inp, capture_output=True, check=True, env=env).stdout
R7, E, A = "refs/r7/candidate", "refs/src/consumers-windows", "refs/src/consumers-seam"
assert run("rev-parse", E).decode().strip() == "e4f507d6b7259ae5ceae7c89033d80c9b9074908" and run("rev-parse", f"{E}^").decode().strip().startswith("aebf4c932")
RC = "../../logs/windows-authority-e4f507d6b-root-receipt.out"
assert hashlib.sha256(open(RC, "rb").read()).hexdigest() == "70d39eaa4bd3b84edd8aa2566cb458087fef30814200e547bed754a98fe2ce48" and open(RC).read().rstrip().endswith("## rc=0")
show = lambda r, p: run("show", f"{r}:{p}")
blob = lambda r, p: run("rev-parse", f"{r}:{p}").decode().strip()
def m3(p):
    with tempfile.TemporaryDirectory() as d:
        fs = []
        for n, r in (("o", R7), ("b", A), ("t", E)): f = os.path.join(d, n); open(f, "wb").write(show(r, p)); fs.append(f)
        x = subprocess.run(["git", "merge-file", "-p", "--diff3", *fs], capture_output=True); return x.returncode, x.stdout.decode()
def hunks(text, fn):
    out, i, L, n = [], 0, text.split("\n"), 0
    while i < len(L):
        if L[i].startswith("<<<<<<< "):
            s = {"o": [], "b": [], "t": []}; c = "o"; i += 1
            while not L[i].startswith(">>>>>>> "):
                if L[i].startswith("||||||| "): c = "b"
                elif L[i] == "=======": c = "t"
                else: s[c].append(L[i])
                i += 1
            out += fn(n, s); n += 1
        else: out.append(L[i])
        i += 1
    return "\n".join(out)
res, upd = {}, {}
CORE = {"windows/node/chain.mjs", "windows/node/host.mjs", "windows/node/network-enroll.mjs", "windows/node/agent.mjs", "test/windows-chain-authority-runtime.test.mjs"}
BUNDLES = {"windows/node/host-admission.bundle.mjs", "metal/guest/host-policy.bundle.mjs"}
for p in run("diff", "--name-only", A, E).decode().split():
    if p in CORE:
        res[p] = {"rule": "BLOCK: not composed (Windows chain-authority core; two tested designs)", "kept": blob(R7, p) if p != "test/windows-chain-authority-runtime.test.mjs" else None, "e4f": blob(E, p)}; continue
    if p in BUNDLES:
        res[p] = {"rule": "REGENERATE (job rebuilds from composed sources; interim r7 bytes)", "kept": blob(R7, p), "e4f": blob(E, p)}; continue
    if blob(R7, p) == blob(A, p):
        upd[p] = show(E, p); res[p] = {"rule": "e4f (r7 == aebf: only e4f changed it)"}; continue
    rc, t = m3(p)
    if rc == 0: upd[p] = t.encode(); res[p] = {"rule": "clean three-way on aebf (r7 + e4f)"}; continue
    if p == "network/enclave-network-host.mjs":
        r = hunks(t, lambda n, s: s["t"]); why = "both hunks e4f: ownerSignatureReader generalizes r7's identical inline rule (pinned -> quorum reader; explicit verifier -> the agent's verifier LeaseReader), additionally requiring reader.agreed"
    elif p == "network/privacy-agent.mjs":
        def f(n, s):
            assert n == 0 and s["t"][0].lstrip().startswith("paid=") and s["o"][1].lstrip().startswith("if(stopping)"); return [s["t"][0]] + s["o"][1:]
        r = hunks(t, f); why = "union: e4f's createPaidNetwork with chainVerifier (paid settlement under the verifier) + r7's startup-cancellation check and agent line (wallet)"
    else: raise SystemExit(f"undecided conflict {p}")
    assert "<<<<<<<" not in r and ">>>>>>>" not in r
    upd[p] = r.encode(); res[p] = {"rule": "reviewed hunks", "why": why}
idx = tempfile.mktemp(); env = dict(os.environ, GIT_INDEX_FILE=idx); run("read-tree", R7, env=env)
for p, data in upd.items():
    b = run("hash-object", "-w", "--stdin", inp=data).decode().strip(); run("update-index", "--add", "--cacheinfo", f"100644,{b},{p}", env=env); res[p]["result"] = b
tree = run("write-tree", env=env).decode().strip(); os.unlink(idx)
man = json.dumps({"e4f": "e4f507d6b7259ae5ceae7c89033d80c9b9074908", "receiptSha256": "70d39eaa4bd3b84edd8aa2566cb458087fef30814200e547bed754a98fe2ce48", "files": res}, indent=1, sort_keys=True).encode()
open("R8-RESOLUTIONS.json", "wb").write(man)
ID = dict(os.environ, GIT_AUTHOR_NAME="SteveDeFacto", GIT_AUTHOR_EMAIL="5148995+SteveDeFacto@users.noreply.github.com", GIT_COMMITTER_NAME="SteveDeFacto", GIT_COMMITTER_EMAIL="5148995+SteveDeFacto@users.noreply.github.com", GIT_AUTHOR_DATE="2026-10-26T00:00:00Z", GIT_COMMITTER_DATE="2026-10-26T00:00:00Z")
msg = (f"compose: reconcile the root-qualified Windows consumer commit e4f507d6b where exact (r8, PARTIAL)\n\nPartially-Applied-From (NOT a merge): consumers-windows fix/rpc-relay-consumers-20261025 e4f507d6b7259ae5ceae7c89033d80c9b9074908\n"
       f"Root-Receipt-Sha256: 70d39eaa4bd3b84edd8aa2566cb458087fef30814200e547bed754a98fe2ce48\nR8-Resolutions-Sha256: {hashlib.sha256(man).hexdigest()}\nStatus: Windows chain-authority core NOT composed (BLOCK)\n")
# ONE parent (r7): e4f is NOT recorded as merged, because its Windows core is not composed (a later merge must still bring it)
c = run("commit-tree", tree, "-p", R7, inp=msg.encode(), env=ID).decode().strip(); run("update-ref", "refs/r8/candidate-partial", c)
for p, r in sorted(res.items()): print(f"{r['rule'][:66]:68} {p}")
print("r8 partial", c, "tree", tree)
