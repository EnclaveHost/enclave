#!/usr/bin/env python3
"""r10 = r9 candidate 82ec7d45 + consumer 12b41d459 (credit page read authority: exactly its 4 files, root 0228/0230/0232) + the
reconciliation of the ONE real r9 candidate regression (attested-route-composition test 1): the provider's local-verifier mode
(verifier lineage e0dfe98aa, attested-chain-verifier.test.mjs:366) is kept, but host services under it are REFUSED - in r9 they
fell into the quorum branch and read the policy through a different authority (mixed). Private repo -> refs/r10/candidate."""
import hashlib, json, os, subprocess, tempfile
G = ["git", "--git-dir=src.git"]
def run(*a, inp=None, env=None): return subprocess.run(G + list(a), input=inp, capture_output=True, check=True, env=env).stdout
R9, CR, O = "refs/r9/candidate", "refs/src/consumers-credit", "refs/src/consumers-ownercli"
assert run("rev-parse", R9).decode().strip() == "82ec7d455cc6e9957c1500f6e58ffde557093392"
assert run("rev-parse", CR).decode().strip() == "12b41d4592f4a8d216c827b1bccc8f4d79b51c07" and run("rev-parse", f"{CR}^").decode().strip() == run("rev-parse", O).decode().strip()
CF = run("diff", "--name-only", O, CR).decode().split()
assert CF == ["scripts/build-site.mjs", "site/credit/credit.js", "site/js/core/read-authority.js", "test/credit-read-authority.test.mjs"], CF
show = lambda r, p: run("show", f"{r}:{p}").decode()
upd, why = {}, {}
for p in CF:
    if p != "test/credit-read-authority.test.mjs": assert run("rev-parse", f"{R9}:{p}") == run("rev-parse", f"{O}:{p}"), p   # untouched by the composition
    upd[p] = show(CR, p); why[p] = "consumer 12b41d459 exactly (root 0228 12/12, 0230 both credit bundle modes, 0232 applied); r9 had b6ac's blob"
def rep(s, a, b, n=1):
    assert s.count(a) == n, (a[:90], s.count(a)); return s.replace(a, b)
p = "network/wg-provider/attested-authority.mjs"; a = show(R9, p)
a = rep(a, "bad('chainVerifier (a local verifier) is not used with chainAuthority \"attested-verifier\": remove it');",
        "bad('chainVerifier is not used with chainAuthority \"attested-verifier\" (a local verifier is a different authority): remove it');")
a = rep(a, "  const env = hostServicesPolicyEnv(hostServices);\n  if (!env) return null;\n",
        "  const env = hostServicesPolicyEnv(hostServices);\n  if (!env) return null;\n"
        "  // ONE explicit authority: under the provider's LOCAL verifier the policy branch below would read through the policy's own RPC\n"
        "  // quorum (a different authority than the provider's leases and registry). Refused, never mixed; quorum and attested-verifier\n"
        "  // keep their own complete policy paths.\n"
        "  if (chainAuth.mode === 'verifier') bad('host services with chainAuthority \"verifier\": the platform host policy would read through a different authority than the provider (its own RPC quorum) - never mixed: use chainAuthority quorum or attested-verifier for a provider with host services');\n")
upd[p] = a; why[p] = "chainVerifier refusal text restored to route's wording; host services under the local-verifier provider mode REFUSED (r9 routed them to the quorum branch = mixed authority)"
p = "network/enclave-network-host.mjs"; e = show(R9, p)
e = rep(e, "fetch=globalThis.fetch,now=Date.now,log=()=>{}}){", "fetch=globalThis.fetch,now=Date.now,log=()=>{},challengeOptions={}}){")
upd[p] = e; why[p] = "restores route's createNetworkHost challengeOptions={} parameter (r8 took e4f's copy of the signature line inside the ownerSignatureReader hunk; route code at :223 uses it -> 'challengeOptions is not defined' in challenge-front-managed test 2)"
p = "test/attested-route-composition.test.mjs"; t = show(R9, p)
t = rep(t, "  assert.throws(() => providerChainAuthority({ rpc: ['https://a.example', 'https://b.example'], chainAuthority: 'verifier' }), /quorum or attested-verifier/);",
        "  // INTENTIONAL API CHANGE (r10 composition): the verifier lineage's LOCAL-verifier provider mode (e0dfe98aa;\n"
        "  // attested-chain-verifier.test.mjs:366) is kept. Without its verifier it still refuses; a provider with host services may not use it.\n"
        "  assert.throws(() => providerChainAuthority({ rpc: ['https://a.example', 'https://b.example'], chainAuthority: 'verifier' }), /needs chainVerifier/);\n"
        "  assert.throws(() => providerChainAuthority({ rpc: ['https://a.example', 'https://b.example'], chainAuthority: 'local' }), /quorum, verifier or attested-verifier/);")
t = rep(t, "  assert.throws(() => providerHostPolicyRuntime(hs({ platformHostPolicyRpcs: ['https://a.example', 'https://b.example'] }), auth, { stateDir: tmp }), /platformHostPolicyRpcs is not used/);",
        "  assert.throws(() => providerHostPolicyRuntime(hs({ platformHostPolicyRpcs: ['https://a.example', 'https://b.example'] }), auth, { stateDir: tmp }), /platformHostPolicyRpcs is not used/);\n"
        "  const lvAuth = providerChainAuthority({ rpc: ['https://a.example', 'https://b.example'], chainAuthority: 'verifier', chainVerifier: 'http://127.0.0.1:1/' });\n"
        "  assert.equal(lvAuth.mode, 'verifier');\n"
        "  assert.throws(() => providerHostPolicyRuntime(hs(), lvAuth, { stateDir: tmp }), /never mixed/, 'host services under the local verifier: refused, the policy is never read through another authority');\n"
        "  assert.equal(providerHostPolicyRuntime(null, lvAuth, { stateDir: tmp }), null, 'no host services: nothing to refuse');")
upd[p] = t; why[p] = "route coverage kept; the verifier-mode line adapted (INTENTIONAL API CHANGE marker) and extended: an unknown mode refuses, host services under the local verifier refuse (never mixed)"
idx = tempfile.mktemp(); env = dict(os.environ, GIT_INDEX_FILE=idx); run("read-tree", R9, env=env); res = {}
for p, data in sorted(upd.items()):
    b = run("hash-object", "-w", "--stdin", inp=data.encode()).decode().strip(); run("update-index", "--add", "--cacheinfo", f"100644,{b},{p}", env=env)
    res[p] = {"result": b, "r9": run("rev-parse", f"{R9}:{p}").decode().strip() if subprocess.run(G + ["cat-file", "-e", f"{R9}:{p}"]).returncode == 0 else None, "why": why[p]}
tree = run("write-tree", env=env).decode().strip(); os.unlink(idx)
man = json.dumps({"base": "82ec7d455cc6e9957c1500f6e58ffde557093392", "credit": "12b41d4592f4a8d216c827b1bccc8f4d79b51c07", "files": res}, indent=1, sort_keys=True).encode()
open("R10-RESOLUTIONS.json", "wb").write(man)
ID = dict(os.environ, GIT_AUTHOR_NAME="SteveDeFacto", GIT_AUTHOR_EMAIL="5148995+SteveDeFacto@users.noreply.github.com", GIT_COMMITTER_NAME="SteveDeFacto", GIT_COMMITTER_EMAIL="5148995+SteveDeFacto@users.noreply.github.com", GIT_AUTHOR_DATE="2026-10-26T00:00:00Z", GIT_COMMITTER_DATE="2026-10-26T00:00:00Z")
msg = (f"compose: consumer credit 12b41d459 + one provider authority (no mixed host policy under the local verifier) (r10)\n\n"
       f"Composed-From: consumers fix/rpc-relay-consumers-20261025 12b41d4592f4a8d216c827b1bccc8f4d79b51c07\nR10-Resolutions-Sha256: {hashlib.sha256(man).hexdigest()}\n")
c = run("commit-tree", tree, "-p", R9, "-p", CR, inp=msg.encode(), env=ID).decode().strip(); run("update-ref", "refs/r10/candidate", c)
for p, r in sorted(res.items()): print(f"{p:46} {r['why'][:90]}")
print("r10 candidate", c, "tree", tree)
