#!/usr/bin/env python3
"""ROOT-ONLY: ONE front's provider -> the rev4 provider bundle with hostServices (A1, http only) and later the single DNS pin
(A5). PREPARED by reviewer 9d; NEVER run by 9d. The production layout is NOT install.sh's (current/ + provider.json): systemd
drop-ins choose ExecStart, the last one (zzz-native-ingress.conf, root's control-vm/activate-native-ingress.py) runs
native-recovery-464cad3/provider.mjs with provider-pinned-8b37c37.json. This helper adds ONE drop-in that sorts after it,
zzzz-host-services.conf, and touches nothing else: no existing drop-in, config, key, state, Caddy, DNS unit or other front.

  root-a1-provider.py ca-east                                   read-only preflight -> root-runs/a1-<front>-preflight-*.json
  root-a1-provider.py ca-east --stage a1|a5 --preflight P       new release dir + derived config (0600, from the pinned live
                                                                config + hostServices), --check-config, --ruleset (+ nft -c for a5)
  root-a1-provider.py ca-east --execute a1|a5 --stage-receipt S write the drop-in (CAS), restart THIS unit once, verify argv,
                                                                activity and the rule diff; automatic rollback on failure
  root-a1-provider.py ca-east --rollback a5|a1                  a5 -> back to the a1 drop-in; a1 -> drop-in removed (CAS)
Every mutating call: an attempt record is created (O_EXCL) BEFORE the ssh call; an existing record refuses (no retry).
"""
import argparse, base64, calendar, hashlib, json, os, pathlib, subprocess, sys, time

HERE = pathlib.Path(__file__).resolve().parent
WORK = HERE.parent.parent
OUT = HERE / "root-runs"
BUNDLE = (WORK / "host-service-transport-20261021/stage/network/wg-provider.mjs", "39d1513b8a884317fcc9b82f4057aeee34414b1902fe06e53af0b74d3a1b6563")
NUCBOX = "0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a"   # keccak256("https://api.enclave.host/t/nucbox-k11-4")
LIVE_BUNDLE = ("/opt/enclave-network/native-recovery-464cad3/provider.mjs", "464cad341e4a816aa17a48d6cd727988aa527842e1925acf2b79d9aab3bc6d24")
LIVE_CFG = "/etc/enclave-network/provider-pinned-8b37c37.json"
FRONTS = {  # read-only probe 18:11-18:14Z (probe/<front>*.json)
    "ca-east": {"address": "146.190.246.39", "providerId": "c4c7888e4741dcbe2c092dd81e888bf7", "uplink": "eth0",
                "liveConfigSha": "7df6eba5e4643dfc2e3f4d610d6bc11f57f05e67297cb280442fe3e7971eb986"},
}
DROPINS = {"directories.conf": "0ebefe9041fde6f9637eadc7878f5dac554c1b23d7a5b4dc581f34e677e81ac2",
           "zz-authority-pins.conf": "c679f2fb7b80704faa11148fb916429d8e22e3de1887d95b6e72a0e75f4aa75f",
           "zzz-native-ingress.conf": "1920bcf2a28bb026b65467ad23ae7af9e96520d89237ff7dd7802f57f3e297b0"}
REL = "/opt/enclave-network/hs-transport-39d1513b"
HS = {"a1": {"zone": "app.enclave.host", "platformHostPolicy": "production"},
      # a5: the single pin; per-source limits = the front's dnsdist today (MaxQPSIPRule(50,32,64,200), 16 TCP per client);
      # global stays the kernel default 2000/s burst 4000 (dnsdist has no global cap: root decision P-6)
      "a5": {"zone": "app.enclave.host", "platformHostPolicy": "production",
             "dns": {"hosts": [NUCBOX], "perSourcePps": 50, "perSourceBurst": 200, "tcpPerSource": 16}}}
CFG = {"a1": "/etc/enclave-network/provider-pinned-8b37c37.hs-a1.json", "a5": "/etc/enclave-network/provider-pinned-8b37c37.hs-a5.json"}
DROPIN = "zzzz-host-services.conf"
NODE = "/usr/local/bin/node"
FRESH_S = 1800

REMOTE = r'''
import json, hashlib, os, re, shutil, subprocess, sys, time
D = "/etc/systemd/system/enclave-network-provider.service.d"
def sha(p):
    try: return hashlib.sha256(open(p, "rb").read()).hexdigest()
    except FileNotFoundError: return "absent"
def run(*a, inp=None, t=60): return subprocess.run(list(a), input=inp, capture_output=True, text=True, timeout=t)
def argv():
    m = re.search(r"argv\[\]=([^;]*)", run("systemctl", "show", "enclave-network-provider", "-p", "ExecStart", "--value").stdout)
    return m.group(1).split() if m else []
def unit():
    o = run("systemctl", "show", "enclave-network-provider", "-p", "ActiveState", "-p", "MainPID", "-p", "NRestarts").stdout
    return dict(l.split("=", 1) for l in o.split())
def nftnorm():   # rules only: the contents of sets (peers, targets, own/blocked) are not rules
    t = run("nft", "-s", "list", "table", "inet", "enclave_net").stdout
    t = re.sub(r"elements = \{[^}]*\}", "elements = {}", t, flags=re.S)
    return [l.strip() for l in t.splitlines() if l.strip()]
def facts():
    n = nftnorm(); mem = [l for l in open("/proc/meminfo") if l.startswith("MemAvailable")][0].split()[1]
    return {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "argv": argv(), "unit": unit(),
            "dropins": {f: sha(os.path.join(D, f)) for f in sorted(os.listdir(D))}, "files": {p: sha(p) for p in P["files"]},
            "conntrack": shutil.which("conntrack"), "memAvailMiB": int(mem) // 1024, "nftRulesSha": hashlib.sha256("\n".join(n).encode()).hexdigest(), "nftLines": len(n)}
def dropin_text(step): return "[Service]\nExecStart=\nExecStart=%s %s/wg-provider.mjs %s\n" % (P["node"], P["rel"], P["cfg"][step])
def logs(since):   # pattern-limited lines only, never a log dump
    t = run("journalctl", "-u", "enclave-network-provider", "--since", "@%d" % since, "-o", "cat", "--no-pager", t=30).stdout
    return [l[:300] for l in t.splitlines() if re.search(r"restored \d+ peer|provider [0-9a-f]{32} up|dns role of host|DNS 53|hostServices|HOST SERVICES|platform host policy", l)][-25:]
def set_dropin(text):
    p = os.path.join(D, P["dropin"])
    if text is None: os.unlink(p)
    else:
        tmp = p + ".tmp"; open(tmp, "w").write(text); os.chmod(tmp, 0o644); os.replace(tmp, p)
    run("systemctl", "daemon-reload")
def restart_and_wait(want_argv):
    t0 = int(time.time()); run("systemctl", "restart", "enclave-network-provider", t=90)
    ok = False
    for _ in range(15):
        time.sleep(2)
        if unit().get("ActiveState") == "active" and argv() == want_argv: ok = True; break
    if ok:
        n0 = unit().get("NRestarts"); time.sleep(15); u = unit()
        ok = u.get("ActiveState") == "active" and u.get("NRestarts") == n0 and argv() == want_argv
    return ok, t0
out = {"mode": P["mode"], "before": facts()}
try:
    if P["mode"] == "preflight": pass
    elif P["mode"] == "stage":
        st = P["step"]; base = json.load(open(P["liveCfg"]))
        if sha(P["liveCfg"]) != P["liveConfigSha"]: raise SystemExit("live config is not the pinned sha")
        if "hostServices" in base: raise SystemExit("the live config already has hostServices")
        os.makedirs(P["rel"], mode=0o755, exist_ok=True); dst = P["rel"] + "/wg-provider.mjs"
        if sha(dst) == "absent":
            if sha(P["upload"]) != P["bundleSha"]: raise SystemExit("uploaded bundle is not the pinned sha")
            shutil.copyfile(P["upload"], dst + ".tmp"); os.chmod(dst + ".tmp", 0o644); os.replace(dst + ".tmp", dst)
        if sha(dst) != P["bundleSha"]: raise SystemExit("release bundle is not the pinned sha")
        text = json.dumps({**base, "hostServices": P["hs"][st]}, indent=1) + "\n"; c = P["cfg"][st]
        if sha(c) == "absent":
            fd = os.open(c, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); os.write(fd, text.encode()); os.close(fd)
        if sha(c) != hashlib.sha256(text.encode()).hexdigest(): raise SystemExit(c + " exists with other bytes")
        chk = run(P["node"], dst, "--check-config", c); rs = run(P["node"], dst, "--ruleset", c)
        out["stage"] = {"step": st, "config": c, "configSha": sha(c), "checkConfigRc": chk.returncode, "checkConfigTail": (chk.stdout + chk.stderr)[-400:],
                        "rulesetRc": rs.returncode, "rulesetSha": hashlib.sha256(rs.stdout.encode()).hexdigest()}
        if st == "a5": out["stage"]["nftCheckRc"] = run("nft", "-c", "-f", "-", inp=rs.stdout).returncode
    elif P["mode"] in ("execute", "rollback"):
        st = P["step"]; p = os.path.join(D, P["dropin"])
        cur = open(p).read() if os.path.exists(p) else None
        if P["mode"] == "execute":
            want_cur, new_text = (None, dropin_text("a1")) if st == "a1" else (dropin_text("a1"), dropin_text("a5"))
        else:
            want_cur, new_text = (dropin_text("a5"), dropin_text("a1")) if st == "a5" else (dropin_text("a1"), None)
        if cur != want_cur: raise SystemExit("CAS: %s is not the expected state" % P["dropin"])
        if argv() != P["argvBefore"]: raise SystemExit("CAS: the running argv is not the expected one")
        if any(sha(os.path.join(D, f)) != h for f, h in P["dropins"].items()): raise SystemExit("CAS: an existing drop-in changed")
        rules0 = nftnorm(); set_dropin(new_text); ok, t0 = restart_and_wait(P["argvAfter"]); rules1 = nftnorm()
        out["diff"] = {"added": [l for l in rules1 if l not in rules0], "removed": [l for l in rules0 if l not in rules1]}
        out["logs"] = logs(t0); out["active"] = ok
        good = ok and (P["mode"] == "rollback" or P["expectAdded"] is None or (out["diff"]["added"] == P["expectAdded"] and out["diff"]["removed"] == P["expectRemoved"]))
        if P["mode"] == "execute" and st == "a5": good = ok and any("dns_target4" in l for l in out["diff"]["added"]) and any("dnat ip to" in l for l in out["diff"]["added"])
        if not good:
            set_dropin(cur); okb, tb = restart_and_wait(P["argvBefore"])
            out["autoRollback"] = {"active": okb, "argv": argv(), "logs": logs(tb)}
            out["verdict"] = "FAILED, rolled back" if okb else "ROOT: failed AND the rollback did not verify"
        else: out["verdict"] = "OK"
except SystemExit as e: out["refused"] = str(e)
except Exception as e: out["error"] = repr(e)[:400]
out["after"] = facts()
print(json.dumps(out))
'''

def sha(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def now(): return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

def params(front, mode, step=None):
    f = FRONTS[front]
    live_argv = [NODE, LIVE_BUNDLE[0], LIVE_CFG]
    a1_argv, a5_argv = [NODE, REL + "/wg-provider.mjs", CFG["a1"]], [NODE, REL + "/wg-provider.mjs", CFG["a5"]]
    before = {("execute", "a1"): live_argv, ("execute", "a5"): a1_argv, ("rollback", "a5"): a5_argv, ("rollback", "a1"): a1_argv}.get((mode, step))
    after = {("execute", "a1"): a1_argv, ("execute", "a5"): a5_argv, ("rollback", "a5"): a1_argv, ("rollback", "a1"): live_argv}.get((mode, step))
    gate = f'iifname "{f["uplink"]}" oifname "wg-exit" ct status dnat udp dport 53 drop'
    return {"mode": mode, "step": step, "node": NODE, "rel": REL, "cfg": CFG, "hs": HS, "dropin": DROPIN, "dropins": DROPINS,
            "liveCfg": LIVE_CFG, "liveConfigSha": f["liveConfigSha"], "bundleSha": BUNDLE[1], "upload": "/root/hs-canary-upload/wg-provider.mjs",
            "files": [LIVE_BUNDLE[0], LIVE_CFG, REL + "/wg-provider.mjs", CFG["a1"], CFG["a5"]],
            "argvBefore": before, "argvAfter": after,
            # A1 = the old table plus EXACTLY the plain DNS gate (kernel.mjs b912c85c; inert without dns)
            "expectAdded": [gate] if (mode, step) == ("execute", "a1") else None, "expectRemoved": []}

def remote(front, p, secs=240):
    # the program on stdin, its parameters embedded as base64 JSON (no remote shell quoting)
    prog = "import base64, json\nP = json.loads(base64.b64decode(%r))\n" % base64.b64encode(json.dumps(p).encode()).decode() + REMOTE
    r = subprocess.run(["timeout", str(secs), "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", front, "python3", "-"],
                       input=prog, capture_output=True, text=True)
    try: return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception: return {"error": f"no result (ssh rc {r.returncode})", "stdout": r.stdout[-600:], "stderr": r.stderr[-400:]}

def save(name, obj):
    OUT.mkdir(exist_ok=True)
    with open(OUT / name, "x") as fh: json.dump(obj, fh, indent=1); fh.flush(); os.fsync(fh.fileno())
    print("receipt:", OUT / name)

def fresh(path, what):
    o = json.loads(pathlib.Path(path).read_text())
    if o.get("what") != what: raise SystemExit(f"{path} is not a {what} receipt")
    if time.time() - calendar.timegm(time.strptime(o["at"], "%Y-%m-%dT%H:%M:%SZ")) > FRESH_S: raise SystemExit(f"{path} is older than {FRESH_S} s")
    return o

def dropin_sha(step): return hashlib.sha256(("[Service]\nExecStart=\nExecStart=%s %s/wg-provider.mjs %s\n" % (NODE, REL, CFG[step])).encode()).hexdigest()

def preflight_ok(r, front, step):
    """step a1: the live state (no drop-in of ours); step a5: the verified A1 state"""
    b = r.get("before", {}); f = FRONTS[front]
    bad = [] if "error" not in r and "refused" not in r else [r.get("error") or r.get("refused")]
    want_argv = [NODE, LIVE_BUNDLE[0], LIVE_CFG] if step == "a1" else [NODE, REL + "/wg-provider.mjs", CFG["a1"]]
    want_dropins = DROPINS if step == "a1" else {**DROPINS, DROPIN: dropin_sha("a1")}
    if b.get("argv") != want_argv: bad.append(f"argv {b.get('argv')}")
    if b.get("files", {}).get(LIVE_BUNDLE[0]) != LIVE_BUNDLE[1]: bad.append("live bundle sha")
    if b.get("files", {}).get(LIVE_CFG) != f["liveConfigSha"]: bad.append("live config sha")
    if b.get("dropins") != want_dropins: bad.append(f"drop-ins {b.get('dropins')}")
    if step == "a5" and not b.get("conntrack"): bad.append("conntrack absent (DNS 53 would fail closed)")
    if b.get("unit", {}).get("ActiveState") != "active": bad.append("unit not active")
    if (b.get("memAvailMiB") or 0) < 256: bad.append("memAvailMiB < 256")
    return bad

def main(argv):
    a = argparse.ArgumentParser(); a.add_argument("front", choices=sorted(FRONTS)); x = a.add_mutually_exclusive_group()
    x.add_argument("--stage", choices=["a1", "a5"]); x.add_argument("--execute", choices=["a1", "a5"]); x.add_argument("--rollback", choices=["a1", "a5"])
    a.add_argument("--preflight"); a.add_argument("--stage-receipt")
    o = a.parse_args(argv); ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    if sha(BUNDLE[0]) != BUNDLE[1]: raise SystemExit("local bundle is not the pinned sha")
    if not (o.stage or o.execute or o.rollback):
        r = remote(o.front, params(o.front, "preflight")); bad = {s: preflight_ok(r, o.front, s) for s in ("a1", "a5")}
        save(f"a1-{o.front}-preflight-{ts}.json", {"what": "preflight", "at": now(), "front": o.front, "result": r, "refused": bad})
        print(json.dumps({"refused": bad, "before": r.get("before")}, indent=1)); return 0 if not (bad["a1"] and bad["a5"]) else 1
    if o.stage:
        pre = fresh(o.preflight, "preflight")
        if pre["front"] != o.front or pre["refused"][o.stage]: raise SystemExit(f"--preflight must pass for step {o.stage} on this front: {pre['refused'][o.stage]}")
        up = subprocess.run(["timeout", "120", "ssh", "-o", "BatchMode=yes", o.front, "install", "-d", "-m", "0700", "/root/hs-canary-upload"], capture_output=True)
        cp = subprocess.run(["timeout", "180", "scp", "-q", "-o", "BatchMode=yes", str(BUNDLE[0]), f"{o.front}:/root/hs-canary-upload/wg-provider.mjs"], capture_output=True)
        if up.returncode or cp.returncode: raise SystemExit("upload failed")
        r = remote(o.front, params(o.front, "stage", o.stage)); s = r.get("stage", {})
        ok = (not r.get("refused") and not r.get("error") and s.get("checkConfigRc") == 0 and s.get("rulesetRc") == 0 and s.get("nftCheckRc", 0) == 0)
        save(f"a1-{o.front}-stage-{o.stage}-{ts}.json", {"what": "stage", "at": now(), "front": o.front, "step": o.stage, "ok": ok, "result": r})
        print(json.dumps(r, indent=1)); return 0 if ok else 4
    mode, step = ("execute", o.execute) if o.execute else ("rollback", o.rollback)
    if mode == "execute":
        st = fresh(o.stage_receipt, "stage") if o.stage_receipt else None
        if not st or not st["ok"] or st["front"] != o.front or st["step"] != step: raise SystemExit("--stage-receipt: a passing stage of this front and step")
    name = f"attempt-a1-{o.front}-{mode}-{step}.json"
    try: save(name, {"what": "attempt", "at": now(), "front": o.front, "mode": mode, "step": step, "helper": sha(__file__)})
    except FileExistsError: print(f"REFUSED: {OUT / name} exists; an attempt is never retried automatically (root inspects, then moves it aside)"); return 4
    r = remote(o.front, params(o.front, mode, step), 300)
    save(f"a1-{o.front}-{mode}-{step}-result-{ts}.json", {"what": "result", "at": now(), "attempt": name, "result": r})
    print(json.dumps(r, indent=1)); v = r.get("verdict")
    print(v or "UNKNOWN: no verdict. ROOT: read the result; do not retry")
    return 0 if v == "OK" else 2 if v == "FAILED, rolled back" else 3

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
