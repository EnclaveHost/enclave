#!/usr/bin/env python3
"""Stage 3: merge the ROOT-PASSED consumer seam aebf4c932 (81ba66853..: 920a5911d deep CLI, 1bdf5c432 exec mode, aebf4c932
verifier-bound lease reads) onto refs/r3/stage2 with git's real three-way (exact base 81ba66853) and explicit resolutions
for its 4 conflicts. -> refs/r3/candidate, SEAM-RESOLUTIONS.json. Private src.git only."""
import hashlib, json, os, re, subprocess, tempfile
G = ["git", "--git-dir=src.git"]
def run(*a, inp=None, env=None, ok=False):
    r = subprocess.run(G + list(a), input=inp, capture_output=True, env=env)
    if r.returncode and not ok: raise SystemExit(r.stderr.decode())
    return r.stdout
SEAM = run("rev-parse", "refs/src/consumers-seam").decode().strip(); assert SEAM == "aebf4c9321279c37afce863c2bd6144a96128cea"
RCPT = "../../logs/lease-seams-aebf4c932-root-receipt.out"; RS = hashlib.sha256(open(RCPT, "rb").read()).hexdigest()
assert RS == "f6c5369b274de4364e779044c56bc840eb4c0e6a17816a6ffe46972556f69dfd" and SEAM[:9] in open(RCPT).read() and open(RCPT).read().rstrip().endswith("## rc=0")
o = run("merge-tree", "--write-tree", "--no-messages", "--name-only", "refs/r3/stage2", "refs/src/consumers-seam", ok=True).decode().split("\n")
tree, conflicts = o[0], [x for x in o[1:] if x]
def hunks(p):
    with tempfile.TemporaryDirectory() as d:
        fs = []
        for n, r in (("o", "refs/r3/stage2"), ("b", "81ba66853"), ("t", "refs/src/consumers-seam")):
            f = os.path.join(d, n); open(f, "wb").write(run("show", f"{r}:{p}")); fs.append(f)
        return subprocess.run(["git", "merge-file", "-p", "--diff3", *fs], capture_output=True).stdout.decode()
def resolve(text, fn):
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
def pinned(n, s):   # union: the seam's comment and message, the lineage's local-verifier assertions
    assert n == 0
    o = [x for x in s["o"] if not x.startswith("  // (plus `authority`")]
    return s["t"][:2] + [s["t"][3] if x.strip() == 'assert.equal(plain.authority, "rpc-quorum");' else x for x in o]
def measured(n, s): assert n == 0; return s["t"]
rec = {}
P1, P2 = "test/lease-pinned-relay-config.test.mjs", "test/metal-measured-control.test.mjs"
t1 = resolve(hunks(P1), pinned); t2 = resolve(hunks(P2), measured)
code = "\n".join(re.sub(r'"(?:[^"\\]|\\.)*"|'+r"'(?:[^'\\]|\\.)*'|`[^`]*`", '""', l.split("//")[0]) for l in t2.split("\n"))
for name in ("GPU", "CUSTODY"):   # the dropped lineage constants must not be used as identifiers elsewhere (comments/strings ignored)
    assert not re.search(rf"(?<![A-Za-z0-9_$]){name}(?![A-Za-z0-9_$])", code), f"{name} still referenced"
rec[P1] = "union: seam's authority comment + assertion message, lineage (433f04fa1) local-verifier selection and refusal assertions"
rec[P2] = "seam's per-line exactly-once check of the SAME reviewed lines (f04efa124 GPU, a7fc374f4 custody v1/v2) replaces the lineage's block form; stricter"
B1, B2 = "metal/guest/lease-gas-conduit.bundle.mjs", "metal/guest/lease-gas-conduit.bundle.mjs.manifest.json"
REG = "REGENERATE: node scripts/build-metal-lease-gas.mjs (from network/lease-gas-conduit.mjs) after the merge; interim = the root-passed seam's bytes"
for p in (B1, B2): rec[p] = REG
idx = tempfile.mktemp(); env = dict(os.environ, GIT_INDEX_FILE=idx); run("read-tree", tree, env=env)
def put(p, data): b = run("hash-object", "-w", "--stdin", inp=data).decode().strip(); run("update-index", "--add", "--cacheinfo", f"100644,{b},{p}", env=env); return b
res = {P1: put(P1, t1.encode()), P2: put(P2, t2.encode()), B1: put(B1, run("show", f"refs/src/consumers-seam:{B1}")), B2: put(B2, run("show", f"refs/src/consumers-seam:{B2}"))}
assert sorted(res) == sorted(conflicts), conflicts
t = run("write-tree", env=env).decode().strip(); os.unlink(idx)
man = json.dumps({"seam": SEAM, "receipt": RCPT, "receiptSha256": RS, "base": run("rev-parse", "81ba66853").decode().strip(), "conflicts": {p: {"result": res[p], "rationale": rec[p]} for p in res}}, indent=1).encode()
open("SEAM-RESOLUTIONS.json", "wb").write(man)
ID = dict(os.environ, GIT_AUTHOR_NAME="SteveDeFacto", GIT_AUTHOR_EMAIL="5148995+SteveDeFacto@users.noreply.github.com", GIT_COMMITTER_NAME="SteveDeFacto", GIT_COMMITTER_EMAIL="5148995+SteveDeFacto@users.noreply.github.com", GIT_AUTHOR_DATE="2026-10-26T00:00:00Z", GIT_COMMITTER_DATE="2026-10-26T00:00:00Z")
msg = (f"compose: merge fix/rpc-relay-consumers-20261025 aebf4c932 (reviewed lease seams, rpc-runtime-composition stage 3, r3)\n\n"
       f"Composed-From: consumers-seam fix/rpc-relay-consumers-20261025 {SEAM}\nRoot-Receipt-Sha256: {RS}\nSeam-Resolutions-Sha256: {hashlib.sha256(man).hexdigest()}\n")
c = run("commit-tree", t, "-p", "refs/r3/stage2", "-p", "refs/src/consumers-seam", inp=msg.encode(), env=ID).decode().strip(); run("update-ref", "refs/r3/candidate", c)
print("candidate", c, "tree", t, "conflicts", conflicts)
