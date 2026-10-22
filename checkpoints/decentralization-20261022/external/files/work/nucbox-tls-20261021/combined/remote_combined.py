# The on-VM half of root-activate-relay-combined.py: installs BOTH reviewed relay files (secrets.js exists fast path +
# api-relay.js ENS CORS origins) with ONE restart. Production runs it as `sudo python3 -` with main(CONFIG) appended by
# the wrapper (immutable pins there); fixture-test.py runs this same file against a scratch dir and a fake systemctl.
#
# Modes: preflight (read-only) | execute | rollback.  Exit codes:
#   0 OK | 2 REFUSED before any change | 3 FAILED validation, both files rolled back and the relay healthy again
#   4 CRITICAL: rollback did not restore a healthy relay (or a file could not be restored) - act now
# Collects NO journal text, env, store or secret: only hashes, unit state fields, HTTP status/timing and CORS headers.
import base64, hashlib, json, os, shutil, subprocess, sys, time, urllib.request, urllib.error

ENS = ["https://enclavehost.eth", "https://enclavehost.eth.link", "https://enclavehost.eth.limo"]
APEX = ["https://enclave.host", "https://www.enclave.host"]
NEG = ["https://evil.example", "https://enclavehost.eth.evil.example", "https://xenclavehost.eth", "http://enclavehost.eth",
       "https://enclavehost.eth.limo.evil.example", "https://enclavehost.eth.link.evil.example", "null", "https://ENCLAVEHOST.ETH"]


def main(cfg):
    D, BAK, UNIT, PORT = cfg["dir"], cfg["bakdir"], cfg["unit"], cfg["port"]
    SYSTEMCTL = cfg.get("systemctl", ["systemctl"])
    MODE, FILES = cfg["mode"], cfg["files"]           # FILES: name -> {live, new, b64?}
    NAMES = list(FILES)                               # install order; rollback restores in reverse
    out = {"mode": MODE, "steps": [], "checks": {}}

    def step(k, **v): out["steps"].append({"step": k, "t": time.strftime("%H:%M:%SZ", time.gmtime()), **v})
    def sha(p):
        with open(p, "rb") as f: return hashlib.sha256(f.read()).hexdigest()
    def path(n): return os.path.join(D, n)
    def bak(n): return os.path.join(BAK, f"{n}.pre-{FILES[n]['live'][:8]}")
    def show():
        r = subprocess.run(SYSTEMCTL + ["show", UNIT, "-p", "MainPID,ActiveState,SubState,ExecMainStartTimestamp,NRestarts"],
                           capture_output=True, text=True, timeout=15)
        return dict(l.split("=", 1) for l in r.stdout.splitlines() if "=" in l)
    def http(method, p, origin=None, body=None, timeout=10, extra=None):
        h = {"accept": "application/json", **({"origin": origin} if origin else {}), **(extra or {})}
        if body is not None: h["content-type"] = "application/json"
        t0 = time.time()
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{PORT}{p}", data=None if body is None else json.dumps(body).encode(), headers=h, method=method)
            with urllib.request.urlopen(req, timeout=timeout) as r: code, hd, txt = r.status, r.headers, r.read(400)
        except urllib.error.HTTPError as e: code, hd, txt = e.code, e.headers, e.read(400)
        except Exception as e: code, hd, txt = 0, None, f"{type(e).__name__}".encode()
        res = {"code": code, "s": round(time.time() - t0, 3)}
        if hd is not None:
            res["acao"] = hd.get("access-control-allow-origin"); res["acac"] = hd.get("access-control-allow-credentials")
        try:
            j = json.loads(txt); res["body"] = {k: j[k] for k in ("ok", "exists", "custody", "error") if k in j}
        except Exception: res["body"] = None if code else txt.decode("latin-1")[:60]
        return res
    def done(rc, result):
        out["result"] = result; out["exit"] = rc; print(json.dumps(out)); sys.exit(rc)

    def exists_checks(n=3):
        return [http("POST", "/v1/secrets/exists", body={"id": cfg["existsId"]}, timeout=20) for _ in range(n)]
    def cors_matrix():
        m = {}
        for o in ENS + APEX + NEG + [None]:
            g = http("GET", "/health", origin=o, timeout=10)
            p = http("OPTIONS", "/v1/secrets/exists", origin=o, timeout=10,
                     extra={"access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type"})
            m[str(o)] = {"get": [g["code"], g.get("acao"), g.get("acac")], "preflight": [p["code"], p.get("acao"), p.get("acac")]}
        return m
    def cors_failures(m):
        bad = []
        for o, r in m.items():
            for kind in ("get", "preflight"):
                code, acao, acac = r[kind]
                ok_code = 200 if kind == "get" else 204
                if code != ok_code: bad.append(f"{kind} {o}: HTTP {code}")
                elif o in ENS and (acao != o or acac is not None): bad.append(f"{kind} {o}: want exact ACAO, no ACAC; got {acao!r}/{acac!r}")
                elif o in APEX and (acao != o or acac != "true"): bad.append(f"{kind} {o}: apex lost its credentialed grant; got {acao!r}/{acac!r}")
                elif o not in ENS + APEX and (acao is not None or acac is not None): bad.append(f"{kind} {o}: untrusted origin got {acao!r}/{acac!r}")
        return bad
    def exists_failures(cs):
        return [f"exists #{i}: {c['code']} {c.get('body')} {c['s']}s" for i, c in enumerate(cs)
                if not (c["code"] == 200 and isinstance(c.get("body"), dict) and c["body"].get("exists") is True and c["s"] < cfg.get("existsMaxS", 3))]
    def healthy_after(old_pid, budget):
        t_end = time.time() + budget
        while time.time() < t_end:
            s = show()
            if s.get("ActiveState") == "active" and s.get("MainPID") not in ("0", "", old_pid):
                h = http("GET", "/health", timeout=5)
                if h["code"] == 200: return True, s, h
            time.sleep(2)
        s = show(); return False, s, http("GET", "/health", timeout=5)
    def restart(expect):
        for n in NAMES:
            if sha(path(n)) != expect[n]: return False, f"CAS before restart: {n} is {sha(path(n))[:12]}, want {expect[n][:12]}"
        s0 = show(); old = s0.get("MainPID")
        r = subprocess.run(SYSTEMCTL + ["restart", UNIT], capture_output=True, text=True, timeout=120)
        ok, s, h = healthy_after(old, cfg.get("healthBudgetS", 60))
        step("restart", oldPid=old, rc=r.returncode, newPid=s.get("MainPID"), active=s.get("ActiveState"), health=h["code"], healthy=ok)
        return ok, None if ok else f"relay not healthy after restart (rc {r.returncode}, {s.get('ActiveState')}, health {h['code']})"
    def put(n, src_bytes=None, src_path=None):
        # atomic per file: same-dir temp (.js so node treats it like the target), owner/mode of the target, fsync, rename
        st = os.stat(path(n)); tmp = os.path.join(D, f".{n}.combined.tmp.js")
        if src_path: shutil.copyfile(src_path, tmp)
        else:
            with open(tmp, "wb") as f: f.write(src_bytes)
        with open(tmp, "rb+") as f: os.fsync(f.fileno())
        os.chown(tmp, st.st_uid, st.st_gid); os.chmod(tmp, st.st_mode & 0o7777)
        os.replace(tmp, path(n))
    def restore_all():
        errs = []
        for n in reversed(NAMES):
            try:
                cur = sha(path(n))
                if cur == FILES[n]["live"]: continue
                if cur != FILES[n]["new"]: errs.append(f"{n} is {cur[:12]}: neither pin, left alone"); continue
                if sha(bak(n)) != FILES[n]["live"]: errs.append(f"{n}: backup is not LIVE"); continue
                put(n, src_path=bak(n))
                if sha(path(n)) != FILES[n]["live"]: errs.append(f"{n}: restore did not land")
            except Exception as e: errs.append(f"{n}: {type(e).__name__}: {e}"[:160])
        step("restored", files={n: sha(path(n))[:12] for n in NAMES}, errors=errs)
        return errs

    # ---- preflight: every mode, read-only ----
    s = show(); cur = {n: sha(path(n)) for n in NAMES}
    step("preflight", unit=s, files={n: {"sha": cur[n], "is": "LIVE" if cur[n] == FILES[n]["live"] else "NEW" if cur[n] == FILES[n]["new"] else "OTHER"} for n in NAMES},
         backups={n: (sha(bak(n)) == FILES[n]["live"]) if os.path.exists(bak(n)) else None for n in NAMES}, health=http("GET", "/health", timeout=5))
    out["checks"]["before"] = {"exists": exists_checks(1), "cors": cors_matrix()}
    if s.get("ActiveState") != "active": done(2, "REFUSED: the relay is not active; not touching it")
    if MODE in ("preflight", "execute"):
        other = [n for n in NAMES if cur[n] not in (FILES[n]["live"], FILES[n]["new"])]
        if other: done(2, f"REFUSED: live {other} match neither pin")
    if MODE == "preflight":
        state = "LIVE" if all(cur[n] == FILES[n]["live"] for n in NAMES) else "NEW" if all(cur[n] == FILES[n]["new"] for n in NAMES) else "MIXED"
        done(0, f"PREFLIGHT OK: both files {state}" if state != "MIXED" else "PREFLIGHT OK but MIXED (one file NEW): execute refuses; use rollback")

    if MODE == "execute":
        if any(cur[n] != FILES[n]["live"] for n in NAMES): done(2, "REFUSED: execute needs BOTH files at their LIVE pins")
        blobs = {n: base64.b64decode(FILES[n]["b64"]) for n in NAMES}
        if any(hashlib.sha256(blobs[n]).hexdigest() != FILES[n]["new"] for n in NAMES): done(2, "REFUSED: a NEW payload did not arrive intact")
        # syntax-check both NEW files where they will live (package.json "type" applies), before anything moves
        for n in NAMES:
            chk = os.path.join(D, f".{n}.combined.check.js")
            with open(chk, "wb") as f: f.write(blobs[n])
            r = subprocess.run([cfg.get("node", "node"), "--check", chk], capture_output=True, text=True, timeout=60)
            os.unlink(chk)
            if r.returncode != 0: done(2, f"REFUSED: node --check failed for NEW {n} ({r.stderr.strip().splitlines()[-1][:160] if r.stderr.strip() else r.returncode})")
        step("syntax", ok=NAMES)
        os.makedirs(BAK, mode=0o700, exist_ok=True)
        for n in NAMES:
            if not os.path.exists(bak(n)): shutil.copy2(path(n), bak(n))
            if sha(bak(n)) != FILES[n]["live"]: done(2, f"REFUSED: backup {bak(n)} is not LIVE")
        step("backups", files={n: bak(n) for n in NAMES})
        restarted = False
        try:
            for n in NAMES:
                if sha(path(n)) != FILES[n]["live"]:                      # CAS, re-read right before each rename
                    errs = restore_all(); done(2 if not errs else 4, f"REFUSED: {n} changed during install (restored others: {errs or 'ok'})")
                put(n, src_bytes=blobs[n])
                if sha(path(n)) != FILES[n]["new"]:
                    errs = restore_all(); done(2 if not errs else 4, f"REFUSED: {n} did not land (restored: {errs or 'ok'})")
            step("installed", files={n: sha(path(n))[:12] for n in NAMES})
            restarted = True
            ok, why = restart({n: FILES[n]["new"] for n in NAMES})
            fails = [why] if not ok else []
            if ok:
                ex = exists_checks(3); cm = cors_matrix()
                out["checks"]["after"] = {"exists": ex, "cors": cm}
                fails = exists_failures(ex) + cors_failures(cm)
        except SystemExit: raise
        except Exception as e:
            fails = [f"unexpected {type(e).__name__}: {e}"[:200]]
            if not restarted:                                             # files moved, the running process never saw them
                errs = restore_all(); done(2 if not errs else 4, f"REFUSED after {fails[0]} (restored: {errs or 'ok'}; no restart)")
        if not fails: done(0, "ACTIVATED: both files NEW, relay healthy, exists fast, CORS exact")
        step("VALIDATION FAILED", failures=fails[:20])
        errs = restore_all()
        ok2, why2 = restart({n: FILES[n]["live"] for n in NAMES}) if not errs else (False, "files not restored")
        if ok2: out["checks"]["afterRollback"] = {"exists": exists_checks(1), "cors": cors_matrix()}
        done(3 if ok2 else 4, ("FAILED, ROLLED BACK (relay healthy on LIVE): " if ok2 else "CRITICAL: ROLLBACK DID NOT RESTORE A HEALTHY RELAY: ")
             + "; ".join(fails[:3]) + ("" if ok2 else f" | {why2} {errs}"))

    if MODE == "rollback":
        if all(cur[n] == FILES[n]["live"] for n in NAMES): done(2, "REFUSED: both files already LIVE; nothing to roll back (no restart)")
        if any(cur[n] not in (FILES[n]["live"], FILES[n]["new"]) for n in NAMES): done(2, "REFUSED: a live file matches neither pin")
        if any(cur[n] == FILES[n]["new"] and not (os.path.exists(bak(n)) and sha(bak(n)) == FILES[n]["live"]) for n in NAMES):
            done(2, "REFUSED: no intact LIVE backup for a NEW file")
        errs = restore_all()
        if errs: done(4, f"CRITICAL: restore errors {errs}")
        ok, why = restart({n: FILES[n]["live"] for n in NAMES})
        if ok: out["checks"]["after"] = {"exists": exists_checks(1), "cors": cors_matrix()}
        done(0 if ok else 4, "ROLLED BACK: both files LIVE, relay healthy" if ok else f"CRITICAL: rolled back but {why}")
    done(2, f"REFUSED: unknown mode {MODE}")


if __name__ == "__main__":
    main(json.load(open(sys.argv[1])))
