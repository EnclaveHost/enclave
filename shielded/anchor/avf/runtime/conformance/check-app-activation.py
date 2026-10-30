#!/usr/bin/env python3
"""check-app-activation.py <dir> -- the installed client's EXPLICIT ACTIVATION against the real Pixel 10 VM
(cpu/app-activation-run.sh; client/DESIGN.md "Activation"; LAB, not production). Exit 0 only when:
  - the artifacts are the announced ones: the launcher is the accepted 0.3.0, the lab next-version artifact is the
    deterministic lab-next.mjs derivation, and both manifests sign exactly it (release key + a policy countersignature);
  - staging ran nothing; `activate` recorded exactly the staged record; afterwards EVERY run was answered by 0.3.1 (the
    running identity: clientVersion from inside the activated bytes), complete against the real VM, including a run with a
    marker planted on the launcher, a newer policy, and a policy-key rotation committed by the delegated client (the
    retired key then refused);
  - the active file tampered in place, then missing: refused at launch with {expected, found}, nothing else ran, nothing
    was sent, no state changed; the same artifact could not overwrite the wrong file, a manifest countersigned by the
    retired key could not repair it, the successor's could; each repair ran again as 0.3.1;
  - an older policy through 0.3.1 at the end is refused as a rollback: the floor survived every failure;
  - the VM served exactly the released requests; no private key and no plaintext appear in the results or logs.
Device MEASUREMENTS (tokens, first-token and total times) are printed apart from the checks: they describe this run on this
phone, not a property the checks establish; the host tests with a fake VM are separate evidence and are not counted here."""
import base64, json, os, re, sys
d = sys.argv[1]
fails = []
def expect(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok: fails.append(what)
def rd(n):
    p = os.path.join(d, n)
    return open(p, errors="replace").read() if os.path.exists(p) else ""
def js(n):
    try: return json.loads(rd(n) or "null")
    except Exception: return None
def lines(label): return [json.loads(l) for l in rd(f"{label}.jsonl").splitlines() if l.startswith("{")]
def rc(label):
    t = rd(f"{label}.rc").strip(); return int(t) if t else None
def res(label): return next((x["result"] for x in reversed(lines(label)) if "result" in x), {})
def last(label, key): return next((x[key] for x in reversed(lines(label)) if key in x), {})
def state(snap): return js(f"state-{snap}.json") or {}
def staged(snap): return js(f"staged-{snap}.json") or {}
def inode(snap, name):
    for l in rd(f"install-{snap}.txt").splitlines():
        p = l.split(" ", 3)
        if len(p) == 4 and p[3] == name: return {"inode": int(p[0]), "size": int(p[1]), "mode": p[2]}
    return None
def complete(r, n=24): return r.get("complete") is True and r.get("tokens") == n and r.get("status") == 200
def manifest(n):
    m = js(n) or {}
    try: return json.loads(base64.b64decode(m.get("manifest", "")))
    except Exception: return {}

BASE = "fad5ba229c5dbbb339aa6d3d505e31c6a07eaaabadbe2431533cf882fb0f6aa4"; COMMIT = "0f4c79fdc90d3bf80575a7822f18c3059fe481af"
NEXT = "ed82869d033964081b2dcb45dd9ae8b238db79693f3ff10cf1cdfef510bde84c"; V = "0.3.1"
nx = js("lab-next.json") or {}; tam = js("tampered.json") or {}
pk, rk, sk = js("policy-key.json") or {}, js("release-key.json") or {}, js("successor-key.json") or {}
FILE = f"pvm-client-{V}-{NEXT}.mjs"
expect(nx.get("version") == V and nx.get("sha256") == NEXT and nx.get("base", {}).get("sha256") == BASE,
       f"the lab next-version artifact is the lab-next.mjs derivation of the accepted 0.3.0: {V} {NEXT[:16]}… from {BASE[:16]}…")
m1, m2 = manifest(f"manifest-{V}.json"), manifest(f"manifest-{V}-rotated.json")
for n, m, pol in [("original", m1, pk.get("key")), ("rotated", m2, sk.get("key"))]:
    expect(m.get("artifactSha256") == NEXT and m.get("version") == V and m.get("size") == nx.get("size") and m.get("sourceCommit") == COMMIT
           and m.get("releaseKey") == rk.get("key") and m.get("policyKey") == pol, f"the {n} manifest signs exactly that artifact (source {COMMIT[:12]}), countersigned by the {'successor' if n == 'rotated' else 'original'} policy key")
REC = {"version": V, "sha256": NEXT, "size": nx.get("size"), "file": FILE, "sourceCommit": COMMIT}
inst = js("cli-install.json") or {}
expect(rc("cli-install") == 0 and inst.get("anchor", {}).get("policyKeyFp") == pk.get("fingerprint") and inst.get("anchor", {}).get("releaseKeyFp") == rk.get("fingerprint"),
       "installed with the lab anchors (policy and release key fingerprints)")

r = res("base-stream"); expect(complete(r) and r.get("clientVersion") == "0.3.0" and r.get("policySerial") == 1, f"0.3.0 (the launcher itself): 24 tokens complete under policy 1")
u = last("update", "update"); expect(rc("update") == 0 and u.get("ok") and u.get("version") == V and u.get("staged", "").endswith(FILE), "the next-version artifact staged from the untrusted carrier, under its content-addressed name")
s1 = state("1-staged")
expect(s1.get("state", {}).get("staged") == REC and s1.get("state", {}).get("active") is None and staged("1-staged").get("staged", {}).get("bytesMatch") is True,
       "staged = exactly the signed record (version, sha256, size, file, sourceCommit); nothing active")
r = res("staged-not-active"); expect(complete(r) and r.get("clientVersion") == "0.3.0", "staged but not active: still answered by 0.3.0 (staging runs nothing)")
a = last("activate", "activate"); s2 = state("2-activated")
expect(rc("activate") == 0 and a.get("ok") and a.get("version") == V and a.get("sha256") == NEXT and a.get("gen") == s1.get("gen", -9) + 1 and "already" not in a,
       f"activate: ok, {V} {NEXT[:16]}…, one generation ({a.get('gen')})")
expect(s2.get("state", {}).get("active") == REC and s2.get("state", {}).get("staged") == REC, "active == staged == the signed record")

ACTIVE_RUNS = ["active-stream", "active-whole", "planted-marker", "active-policy-2", "rotate-3", "successor-4", "retired-5", "repaired-stream", "repaired-2-stream", "rollback"]
for label, ser in [("active-stream", 1), ("planted-marker", 1), ("active-policy-2", 2), ("rotate-3", 3), ("successor-4", 4), ("repaired-stream", 4), ("repaired-2-stream", 4)]:
    r = res(label); ls = lines(label)
    ci = next((i for i, x in enumerate(ls) if "committed" in x), None); ri = next((i for i, x in enumerate(ls) if "result" in x), None)
    expect(complete(r) and r.get("clientVersion") == V and r.get("policySerial") == ser and ci is not None and ri is not None and ci < ri,
           f"{label}: answered by {V}, 24 tokens complete against the real VM under policy {ser}; its policy committed before anything was sent")
r = res("active-whole"); expect(r.get("status") == 200 and r.get("clientVersion") == V and '"token":' in (r.get("body") or ""), f"active-whole: a whole-mode sealed answer, by {V}")
s3b = state("3b-rotated")["state"] if state("3b-rotated") else {}
r = res("retired-5"); expect(r.get("step") == "policy" and r.get("sent") is False and "anchor does not name" in (r.get("refused") or "") and r.get("clientVersion") == V,
       "after the rotation, a policy under the retired key: refused by 0.3.1, nothing sent")
expect(s3b.get("serial") == 4 and s3b.get("policyFp") == sk.get("fingerprint") and s3b.get("nextPolicyFp") is None and s3b.get("releaseFp") == rk.get("fingerprint")
       and s3b.get("active") == REC and s3b.get("staged") == REC, "the rotation, committed by the delegated 0.3.1: serial 4 under the successor key; release key, staged and active kept")
G = state("3b-rotated").get("gen")
# the tamper: in place, refused at launch, nothing ran, nothing changed
i3, i4 = inode("3b-rotated", FILE), inode("4-tampered", FILE)
expect(i3 and i4 and i3["inode"] == i4["inode"] and i4["size"] == tam.get("size"), f"the active file was tampered IN PLACE (inode {i3 and i3['inode']} kept, {tam.get('size')} bytes)")
t = lines("tampered"); r = res("tampered")
expect(rc("tampered") == 2 and len(t) == 1 and r.get("step") == "launch" and r.get("sent") is False and r.get("found") == tam.get("sha256")
       and r.get("expected") == {"version": V, "sha256": NEXT, "file": FILE}, "tampered: refused at launch with {expected, found = the tampered sha256}; the only output, nothing else ran")
expect(staged("4-tampered").get("active", {}).get("bytesMatch") is False and rd("staged-4-tampered.rc").strip() == "1", "`staged` diagnoses it: active.bytesMatch false, exit 1")
u = last("repair-refused", "update"); expect(rc("repair-refused") == 1 and "already exists with bytes other than its name says" in " ".join(u.get("reasons", [])), "the same artifact cannot overwrite the wrong file")
u = last("repair-old-key", "update"); expect(rc("repair-old-key") == 1 and "countersigned by a policy key this client's anchor does not name" in " ".join(u.get("reasons", [])),
       "after the rotation, the manifest countersigned by the retired key cannot repair it")
u = last("repair-1", "update"); i6 = inode("6-repaired", FILE)
expect(rc("repair-1") == 0 and u.get("ok") and u.get("already") is True and i6 and i6["size"] == nx.get("size") and i6["inode"] != i4["inode"] and staged("6-repaired").get("active", {}).get("bytesMatch") is True,
       "removed, then the successor-countersigned manifest re-published the file (idempotent: already, a new inode, bytes match)")
r = res("missing"); expect(rc("missing") == 2 and len(lines("missing")) == 1 and r.get("step") == "launch" and r.get("found") == "missing", "the active file missing: refused at launch (found: missing), nothing else ran")
u = last("repair-2", "update"); expect(rc("repair-2") == 0 and u.get("already") is True and staged("8-repaired-2").get("active", {}).get("bytesMatch") is True, "repaired again the same way")
r = res("rollback"); expect(r.get("step") == "policy" and "rollback" in (r.get("refused") or "") and r.get("sent") is False and r.get("clientVersion") == V,
       "an older policy (serial 3, successor key) through 0.3.1 at the end: refused as a rollback")
for snap in ["4-tampered", "5-tampered-after", "6-repaired", "7-missing", "8-repaired-2", "9-final"]:
    expect(state(snap).get("gen") == G and state(snap).get("state") == s3b, f"state after {snap}: unchanged (generation {G}) -- no refusal, repair or rollback attempt moved it")
after = [x.get("result", {}).get("clientVersion") for l in ACTIVE_RUNS for x in lines(l) if "result" in x and x["result"].get("step") != "launch"]
# one answered result per label in ACTIVE_RUNS (the launch refusals are not in it): streams, the whole answer, and the two
# policy refusals -- the count comes from the list, not a hand count (the first run's checker said 9 and was wrong)
expect(len(after) == len(ACTIVE_RUNS) and all(v == V for v in after), f"after activation every answered run was {V}, never 0.3.0 ({len(after)} results, want {len(ACTIVE_RUNS)})")
L = rd("l1.log"); L += "\n" + "\n".join(bytes.fromhex(m.group(1)).decode("utf-8", "replace") for m in re.finditer(r"APPOUT \d+ ([0-9a-f]+)", L))
fins = len(re.findall(r"SEALED stream nonce=\w+ fin after", L)); whole = len(re.findall(r"SEALED served nonce=", L))
expect(fins == 9 and whole == 1, f"the VM served exactly the released requests: {fins} streams (want 9) + {whole} whole (want 1)")
allfiles = [os.path.join(r_, f) for r_, _, fs in os.walk(d) for f in fs]
expect(not any("PRIVATE KEY" in open(f, errors="replace").read() for f in allfiles), "no private key anywhere in the results (lab keys stay outside the repository)")
for n in ["l1.log", "hub.jsonl", "hub.err", "carrier.log", "update-carrier.log"]:
    t = rd(n); t += "\n".join(bytes.fromhex(m.group(1)).decode("utf-8", "replace") for m in re.finditer(r"APPOUT \d+ ([0-9a-f]+)", t))
    hit = [m for m in ["GET /?graph", "steps=", '"token":', "tok_per_s"] if m in t]
    expect(not hit, f"{n}: no request or token in the clear{' (found ' + ', '.join(hit) + ')' if hit else ''}")
# raw evidence, recorded by the relay's carrier as received (runs from 2026-09-24 12:40Z on declare it in capture.json):
# one envelope per evidence exchange -- every run that got past the policy (10) -- each a v2 envelope answering the nonce
# its request carried, timed inside the run, mapped to its run label, and matching that run's own verified summary (nonce,
# app, app key) under the serial and active record committed before it; the launch and policy refusals fetched none
EXCH = ["base-stream", "staged-not-active", "active-stream", "active-whole", "planted-marker", "active-policy-2", "rotate-3", "successor-4", "repaired-stream", "repaired-2-stream"]
cap = js("capture.json")
if cap:
    ed = os.path.join(d, "evidence")
    ev = sorted(f for f in os.listdir(ed) if f.endswith(".json") and not f.endswith(".meta.json")) if os.path.isdir(ed) else []
    envs = [js(os.path.join("evidence", f)) or {} for f in ev]
    reqs = [rd(os.path.join("evidence", f[:-5] + ".request")) for f in ev]
    metas = [js(os.path.join("evidence", f[:-5] + ".meta.json")) or {} for f in ev]
    expect(len(envs) == len(EXCH) and all(e.get("format") == "enclave-pvm-app-evidence/v2" and q == f"EVIDENCE {e.get('nonce')}\n" for e, q in zip(envs, reqs)),
           f"the relay recorded one raw v2 evidence envelope per exchange, each answering the nonce its request carried ({len(envs)}, want {len(EXCH)})")
    t0, t1 = cap.get("runStart", "~"), cap.get("runEnd", "")
    expect(all(m.get("n") == i + 1 and t0 <= m.get("sentToVmAt", "") <= m.get("answeredAt", "~") <= t1 + "~" for i, m in enumerate(metas)),
           f"each exchange is timed in UTC inside the run ({t0} .. {t1})")
    mp = cap.get("exchanges", [])
    expect([x.get("label") for x in mp] == EXCH and [x.get("n") for x in mp] == list(range(1, len(EXCH) + 1)),
           "capture.json maps every exchange, in arrival order, to exactly one run label")
    # three separate claims, so a failure names its cause: (a) the envelope is the one its run verified; (b) the state the
    # run committed before its evidence request (its own stateGen, read in the generation log) has the serial and active
    # record expected; (c) the per-exchange state capture in exchanges.jsonl agrees with that generation
    ok_a = ok_b = ok_c = True
    for x, e in zip(mp, envs):
        r = res(x["label"]); v = r.get("verified") or {}
        if not (e.get("nonce", "").startswith(v.get("nonce", "~")) and e.get("app") == v.get("app") and e.get("appKey", "").startswith(v.get("appKey", "~"))):
            ok_a = False; print(f"     exchange {x.get('n')} ({x.get('label')}): the envelope is not the one its run verified")
        g = js(os.path.join("cli-state.d", f"{r.get('stateGen')}.json")) or {}; gs = g.get("state", {})
        want_act = None if x["label"] in ("base-stream", "staged-not-active") else REC
        if not (g.get("gen") == r.get("stateGen") and gs.get("serial") == r.get("policySerial") and gs.get("active") == want_act):
            ok_b = False; print(f"     exchange {x.get('n')} ({x.get('label')}): generation {r.get('stateGen')} does not hold serial {r.get('policySerial')} and the expected active record")
        st = x.get("stateAfter") or {}; a = gs.get("active") or {}
        if not (st.get("gen") == r.get("stateGen") and st.get("serial") == gs.get("serial") and st.get("policyFp") == gs.get("policyFp")
                and st.get("releaseFp") == gs.get("releaseFp") and st.get("active") == (a and {"version": a.get("version"), "sha256": a.get("sha256")} or None)):
            ok_c = False; print(f"     exchange {x.get('n')} ({x.get('label')}): exchanges.jsonl recorded {json.dumps(st)[:120]}, the generation log says gen {g.get('gen')}")
    # every call, not only those that made an exchange: a snapshot is present and IS the generation it names
    if cap.get("preflight"):
        expect(rd(cap["preflight"]).strip().splitlines()[-1:] and rd(cap["preflight"]).strip().splitlines()[-1].startswith("PASS"),
               "the capture preflight passed before the run (a capture failure stops the shell with exit 3)")
        rows = [json.loads(l) for l in rd("exchanges.jsonl").splitlines() if l.strip()]
        bad = []
        for row in rows:
            a = row.get("after") or {}; g = js(os.path.join("cli-state.d", f"{a.get('gen')}.json")) if isinstance(a.get("gen"), int) else None
            gs = (g or {}).get("state", {}); ga = gs.get("active") or None
            want = g and {"gen": g.get("gen"), "serial": gs.get("serial"), "policyFp": gs.get("policyFp"), "nextPolicyFp": gs.get("nextPolicyFp"),
                          "releaseFp": gs.get("releaseFp"), "active": ga and {"version": ga.get("version"), "sha256": ga.get("sha256")}}
            if not g or a != want: bad.append(row.get("label"))
        last_gen = max((int(f[:-5]) for f in os.listdir(os.path.join(d, "cli-state.d")) if f[:-5].isdigit()), default=None)
        expect(len(rows) >= len(EXCH) and not bad and rows[-1].get("after", {}).get("gen") == last_gen,
               f"every call's snapshot ({len(rows)} rows) is present and equals the generation it names in the log; the last is the final generation {last_gen}"
               + (f" -- mismatched: {bad}" if bad else ""))
    expect(ok_a, "each envelope is the one its run verified (nonce, app, app key)")
    expect(ok_b, "each exchange ran under the state its run committed first (its stateGen in the generation log: the serial it reports; active none before activation, 0.3.1 after)")
    expect(ok_c, "the per-exchange state capture (exchanges.jsonl 'after') agrees with the generation log")
else:
    print("info this run predates raw evidence capture: the attestation chains cannot be re-verified offline from it")
print("-- device measurements (this run, this phone; not checks):")
for label in ["base-stream", "staged-not-active", "active-stream", "planted-marker", "active-policy-2", "rotate-3", "successor-4", "repaired-stream", "repaired-2-stream"]:
    r = res(label); print(f"   {label}: {r.get('clientVersion')} tokens {r.get('tokens')} first token {r.get('firstTokenMs')} ms, all {r.get('ms')} ms")
print("PASS the installed client's activation on the device" if not fails else f"FAIL ({len(fails)})"); sys.exit(1 if fails else 0)
