#!/usr/bin/env python3
"""r7 = refs/r3/candidate c4de37a3 + the smallest source reconciliation of the r2 route-first-base defect (route's delta read as
empty because route's first state == its tip, so the lineage file was kept and route-unique lines were silently dropped).
Exact per-file results, each checked against the expected blob/edit; writes refs/r7/candidate (parent c4de37a3) in THIS
private repo only (objects via alternates to the frozen r3/src.git, never written). -> R7-RESOLUTIONS.json"""
import hashlib, json, os, subprocess, tempfile
G = ["git", "--git-dir=src.git"]
def run(*a, inp=None, env=None): return subprocess.run(G + list(a), input=inp, capture_output=True, check=True, env=env).stdout
C = run("rev-parse", "refs/r3/candidate").decode().strip(); assert C == "c4de37a3f97a3350b6e6a30fbc1f9ada66e2c91f"
show = lambda r, p: run("show", f"{r}:{p}")
res, upd = {}, {}
def take_route(p, why):
    cand, route = show(C, p), show("refs/src/route", p)
    upd[p] = route; res[p] = {"from": run("rev-parse", f"{C}:{p}").decode().strip(), "to": run("rev-parse", f"refs/src/route:{p}").decode().strip(), "rule": "route blob (route is a superset of the candidate here)", "why": why}
# 1. the defect root root hit: the Windows/host admission bundle ENTRY lost route's verified-read exports
p = "network/host-admission-node.mjs"; c = show(C, p).decode(); r = show("refs/src/route", p).decode()
assert r.startswith(c.rstrip("\n")) and r.count("\n") > c.count("\n"), "route must be the candidate plus appended exports"
take_route(p, "route appends the LeaseReader/chainAuthorityFromEnv and verified-read-client exports that windows/node/chain-reader.mjs and windows/node/chain.mjs (route, kept) import from the bundle; the candidate dropped them (r2 RA base == route tip)")
# 2. the attested client: route's pinned IMAGE-lineage guest verification + the verifyNow clock that attested-authority.mjs passes
p = "network/attested-verifier-client.mjs"
d = subprocess.run(["diff", "/dev/fd/3", "/dev/fd/4"], pass_fds=(), capture_output=True) if False else None
take_route(p, "the candidate's metal/guest/measured-control.mjs is NOT the deployed image 0235e7d9's (the composition changed it), so guests of that image must be verified with the image lineage's exact code: route's import from the pinned ./attested-guest-verify.bundle.mjs; plus verifyNow (test-only clock) that the composed attested-authority.mjs passes. The candidate->route diff is exactly these 3 hunks")
# 3. main's independent docs commit d2ea087fa (PRODUCT.md): route == origin/main; the lineage never edited it after 7752
p = "PRODUCT.md"; assert run("rev-parse", f"refs/src/route:{p}") == run("rev-parse", f"refs/src/main:{p}") and show(C, p) == show("7752a4239", p)
take_route(p, "main's independent docs (d2ea087fa); the candidate carried the 7752 base text")
# 4. measured-control-guest.md: route's two blocks describe the READY control-attestation check that the kept cli/host-independent-lifecycle.mjs (== route) implements; every lineage block kept
p = "docs/network/measured-control-guest.md"; c = show(C, p).decode(); r = show("refs/src/route", p).decode()
assert run("rev-parse", f"{C}:cli/host-independent-lifecycle.mjs") == run("rev-parse", f"refs/src/route:cli/host-independent-lifecycle.mjs")
A1 = "- **On the host.** This is the path implemented by `cli/host-independent-lifecycle.mjs`. The supervisor"
B1 = "- **On the host.** This is the default, `cli/host-independent-lifecycle.mjs` with no `control` section. The supervisor"
A2 = "`host-independent-lifecycle check` does not yet perform this verification: its `control attestation` row is\n`unknown` when an attestation URL is configured, or `missing` otherwise. Use `verifyMeasuredControl` directly;\nconfiguring a URL alone is not proof that the measured guest owns the running supervisor keys.\n"
B2 = "With the integration patch, `host-independent-lifecycle check` reports the `control attestation` row as READY only for\n`verified`.\n"
assert c.count(A1) == 1 and c.count(A2) == 1 and r.count(B1) == 1 and r.count(B2) == 1
n = c.replace(A1, B1).replace(A2, B2); upd[p] = n.encode()
res[p] = {"from": run("rev-parse", f"{C}:{p}").decode().strip(), "to": None, "rule": "2 route blocks, all lineage blocks kept", "why": "the docs must describe the kept route CLI (READY only for verified); the lineage text said the check was not implemented"}
idx = tempfile.mktemp(); env = dict(os.environ, GIT_INDEX_FILE=idx); run("read-tree", C, env=env)
for p, data in upd.items():
    b = run("hash-object", "-w", "--stdin", inp=data).decode().strip(); run("update-index", "--cacheinfo", f"100644,{b},{p}", env=env)
    if res[p]["to"] is None: res[p]["to"] = b
    assert res[p]["to"] == b
tree = run("write-tree", env=env).decode().strip(); os.unlink(idx)
man = json.dumps(res, indent=1, sort_keys=True).encode(); open("R7-RESOLUTIONS.json", "wb").write(man)
ID = dict(os.environ, GIT_AUTHOR_NAME="SteveDeFacto", GIT_AUTHOR_EMAIL="5148995+SteveDeFacto@users.noreply.github.com", GIT_COMMITTER_NAME="SteveDeFacto", GIT_COMMITTER_EMAIL="5148995+SteveDeFacto@users.noreply.github.com", GIT_AUTHOR_DATE="2026-10-26T00:00:00Z", GIT_COMMITTER_DATE="2026-10-26T00:00:00Z")
msg = f"compose: restore route-unique lines lost by the r2 route-first-base merge (r7)\n\nReconciles: {', '.join(sorted(res))}\nR7-Resolutions-Sha256: {hashlib.sha256(man).hexdigest()}\n"
c7 = run("commit-tree", tree, "-p", C, inp=msg.encode(), env=ID).decode().strip(); run("update-ref", "refs/r7/candidate", c7)
print("r7 candidate", c7, "tree", tree)
