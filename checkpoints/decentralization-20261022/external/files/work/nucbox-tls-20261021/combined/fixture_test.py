#!/usr/bin/env python3
"""LOCAL fixture test of remote_combined.py (the exact on-VM program), never production.

A scratch relay dir holds real copies of main's relay/ with the two LIVE pinned files (api-relay.js 27f71ad3, secrets.js
6f3d8c76). A fake systemctl runs the REAL relay (node api-relay.js) from it. Its custody RPCs hang, which is the production
stall, and a seeded local secrets record stands in for 59f1273d. Scenarios check exit codes, file hashes, backups and
restart counts:
  S1 preflight on LIVE                          -> 0, nothing changed, no restart
  S2 CAS: a live file is neither pin            -> 2, nothing changed, no restart
  S3 NEW with a syntax error                    -> 2, nothing changed, no restart
  S4 NEW relay crashes at start                 -> 3, both files LIVE again, healthy on LIVE
  S5 NEW reflects any Origin (CORS regression)  -> 3, both files LIVE again (security validation gates)
  S6 the reviewed pair                          -> 0, both NEW, exists fast under hanging custody, CORS exact
  S7 execute again on NEW                       -> 2 (needs LIVE), no restart
  S8 rollback                                   -> 0, both LIVE, healthy
  S9 rollback when already LIVE                 -> 2, no restart
  S10 every restart fails (relay won't start)   -> 4 CRITICAL
Also: the LIVE pair fails the exists gate under hanging custody (control: proves the gate measures the fix).
"""
import base64, hashlib, http.server, json, os, pathlib, shutil, signal, socket, socketserver, subprocess, sys, threading, time

HERE = pathlib.Path(__file__).resolve().parent
MAIN = pathlib.Path("/home/steven/Documents/Codex/2026-10-18/wo/work/enclave")
FX = HERE / "fixture-run"
PAY = HERE / "payload"
sha = lambda b: hashlib.sha256(b).hexdigest()
LIVE = {"secrets.js": (PAY / "secrets.js.live-base").read_bytes(), "api-relay.js": (PAY / "api-relay.js.live-base").read_bytes()}
NEW = {"secrets.js": (PAY / "secrets.js").read_bytes(), "api-relay.js": (PAY / "api-relay.js").read_bytes()}
assert sha(NEW["secrets.js"]).startswith("4c491271") and sha(NEW["api-relay.js"]).startswith("481f0041")
assert sha(LIVE["secrets.js"]).startswith("6f3d8c76") and sha(LIVE["api-relay.js"]).startswith("27f71ad3")
ID = "0x" + "59" * 32
results, failed = [], []


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


class Zero(http.server.BaseHTTPRequestHandler):            # a chain that answers zeros (ledger/registry reads)
    def log_message(self, *a): pass
    def do_POST(self):
        q = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        one = lambda m: {"jsonrpc": "2.0", "id": m.get("id"), "result": "0x" + "0" * 64}
        b = json.dumps([one(m) for m in q] if isinstance(q, list) else one(q)).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b)))
        self.end_headers(); self.wfile.write(b)


class Hang(http.server.BaseHTTPRequestHandler):            # the custody RPCs: accept, never answer (the production stall)
    def log_message(self, *a): pass
    def do_POST(self): time.sleep(120)


def serve(h):
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), h); srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start(); return srv.server_address[1]


FAKE_SYSTEMCTL = r'''#!/usr/bin/env python3
import json, os, signal, subprocess, sys, time
ST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state.json")
st = json.load(open(ST))
def alive(p):
    if not p: return False
    try:
        os.kill(p, 0)
        with open(f"/proc/{p}/stat") as f: return f.read().split(")")[-1].split()[0] != "Z"
    except Exception: return False
cmd = sys.argv[1]
if cmd == "show":
    a = alive(st.get("pid"))
    print(f"MainPID={st['pid'] if a else 0}\nActiveState={'active' if a else 'failed'}\nSubState={'running' if a else 'failed'}\n"
          f"ExecMainStartTimestamp={st.get('start','')}\nNRestarts={st.get('restarts',0)}")
elif cmd == "restart":
    if alive(st.get("pid")):
        os.kill(st["pid"], signal.SIGTERM)
        for _ in range(50):
            if not alive(st["pid"]): break
            time.sleep(0.2)
        else: os.kill(st["pid"], signal.SIGKILL)
    st["restarts"] = st.get("restarts", 0) + 1
    if st.get("brokenStart"): st["pid"] = 0; json.dump(st, open(ST, "w")); sys.exit(1)
    env = json.load(open(os.path.join(os.path.dirname(ST), "env.json")))
    log = open(os.path.join(os.path.dirname(ST), "relay.log"), "ab")
    p = subprocess.Popen(["node", "api-relay.js"], cwd=st["dir"], env=env, stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)
    st["pid"] = p.pid; st["start"] = time.strftime("%a %Y-%m-%d %H:%M:%S UTC", time.gmtime())
    json.dump(st, open(ST, "w"))
'''


def setup():
    if FX.exists():
        stop_relay(); shutil.rmtree(FX)
    (FX / "relay").mkdir(parents=True)
    subprocess.run(["rsync", "-a", "--copy-links", "--exclude", "node_modules", f"{MAIN}/relay/", f"{FX}/relay/"], check=True)
    os.symlink(MAIN / "relay" / "node_modules", FX / "relay" / "node_modules")
    for n, b in LIVE.items(): (FX / "relay" / n).write_bytes(b)
    (FX / "data").mkdir(); (FX / "tmp").mkdir()
    port, zero, h1, h2 = free_port(), serve(Zero), serve(Hang), serve(Hang)
    env = {"PATH": os.environ["PATH"], "HOME": str(FX / "tmp"), "TMPDIR": str(FX / "tmp"), "ENCLAVES": "http://127.0.0.1:1",
           "API_RELAY_PORT": str(port), "API_RELAY_BIND": "127.0.0.1", "BASE_RPC": f"http://127.0.0.1:{zero}", "RPC_FALLBACKS": "0",
           "DEPLOYMENTS_ADDRESS": "0x" + "12" * 20, "FEATURED_VIEWS_FILE": str(FX / "tmp" / "feat.json"), "CORS_ORIGINS": "",
           "SECRETS_KEY": "ef" * 32, "AUTH_DATA_DIR": str(FX / "data"),
           "CUSTODY_VAULT": "0x" + "34" * 20, "CUSTODY_RPCS": f"http://127.0.0.1:{h1},http://127.0.0.1:{h2}"}
    (FX / "env.json").write_text(json.dumps(env))
    # the stand-in for 59f1273d's relay-held record, written by the relay's own secrets.js (durable store)
    seed = ('const s = await import(process.argv[1]); await s.initSecrets(); '
            f's.applyPut("{ID}", JSON.stringify({{ set: {{ FIXTURE_ONLY: "x" }} }})); process.exit(0);')
    subprocess.run(["node", "--input-type=module", "-e", seed, str(FX / "relay" / "secrets.js")], env=env, check=True, timeout=60,
                   capture_output=True)
    (FX / "systemctl").write_text(FAKE_SYSTEMCTL); (FX / "systemctl").chmod(0o755)
    (FX / "state.json").write_text(json.dumps({"dir": str(FX / "relay"), "pid": 0, "restarts": 0}))
    subprocess.run([str(FX / "systemctl"), "restart", "x"], check=True)
    st = json.loads((FX / "state.json").read_text()); st["restarts"] = 0; (FX / "state.json").write_text(json.dumps(st))
    for _ in range(60):
        try:
            import urllib.request
            if urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2).status == 200: break
        except Exception: time.sleep(1)
    else: raise SystemExit("fixture relay never became healthy: " + (FX / "relay.log").read_text()[-1500:])
    return port


def stop_relay():
    try:
        st = json.loads((FX / "state.json").read_text())
        if st.get("pid"): os.kill(st["pid"], signal.SIGKILL)
    except Exception: pass


def state(): return json.loads((FX / "state.json").read_text())
def hashes(): return {n: sha((FX / "relay" / n).read_bytes())[:8] for n in LIVE}


def run(port, mode, new=None, **over):
    files = {}
    for n in LIVE:
        nb = (new or NEW)[n]
        files[n] = {"live": sha(LIVE[n]), "new": sha(nb), **({"b64": base64.b64encode(nb).decode()} if mode == "execute" else {})}
    cfg = {"mode": mode, "dir": str(FX / "relay"), "bakdir": str(FX / "bak"), "unit": "enclave-api-relay", "port": port,
           "systemctl": [str(FX / "systemctl")], "files": files, "existsId": ID, "existsMaxS": 3, "healthBudgetS": 25, **over}
    (FX / "cfg.json").write_text(json.dumps(cfg))
    r = subprocess.run([sys.executable, str(HERE / "remote_combined.py"), str(FX / "cfg.json")], capture_output=True, text=True, timeout=900)
    try: o = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception: o = {"result": "UNPARSED", "stdout": r.stdout[-600:], "stderr": r.stderr[-600:]}
    return r.returncode, o


def check(name, cond, detail=""):
    results.append({"case": name, "ok": bool(cond), "detail": detail})
    if not cond: failed.append(name)
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""), flush=True)


def scenario(label, port, mode, new=None, want_rc=0, want_files=None, want_restarts=None, extra=None, **over):
    r0 = state()["restarts"]
    rc, o = run(port, mode, new, **over)
    d = f"rc={rc} result={o.get('result')!r}"
    check(f"{label}: exit {want_rc}", rc == want_rc, d)
    if want_files: check(f"{label}: files {want_files}", hashes() == want_files, f"{hashes()} {d}")
    if want_restarts is not None: check(f"{label}: {want_restarts} restart(s)", state()["restarts"] - r0 == want_restarts, f"{state()['restarts'] - r0} {d}")
    if extra: extra(o, d)
    print("   ", d, flush=True)
    return o


def main():
    port = setup()
    L = {n: sha(LIVE[n])[:8] for n in LIVE}; N = {n: sha(NEW[n])[:8] for n in LIVE}
    try:
        def s1(o, d):
            b = o["checks"]["before"]
            check("S1: before = LIVE: ENS origins get no ACAO (the bug e49 fixes)", all(b["cors"][x]["get"][1] is None for x in
                  ["https://enclavehost.eth", "https://enclavehost.eth.link", "https://enclavehost.eth.limo"]), json.dumps(b["cors"])[:300])
            check("S1: before = LIVE: exists stalls past 3 s under hanging custody (the bug relay-exists fixes)",
                  b["exists"][0]["code"] != 200 or b["exists"][0]["s"] >= 3, json.dumps(b["exists"]))
        scenario("S1 preflight", port, "preflight", want_rc=0, want_files=L, want_restarts=0, extra=s1)

        # S2: CAS - a live file that is neither pin
        p = FX / "relay" / "api-relay.js"; p.write_bytes(LIVE["api-relay.js"] + b"\n// drift\n")
        scenario("S2 CAS drift", port, "execute", want_rc=2, want_restarts=0,
                 extra=lambda o, d: check("S2: drifted file untouched, no backup taken", sha(p.read_bytes()) == sha(LIVE["api-relay.js"] + b"\n// drift\n")
                                          and not (FX / "bak").exists(), d))
        p.write_bytes(LIVE["api-relay.js"])

        bad_syntax = dict(NEW, **{"api-relay.js": NEW["api-relay.js"] + b"\nconst = ;\n"})
        scenario("S3 syntax", port, "execute", new=bad_syntax, want_rc=2, want_files=L, want_restarts=0,
                 extra=lambda o, d: check("S3: no temp/check files left", not list((FX / "relay").glob(".*combined*")), d))

        crash = dict(NEW, **{"api-relay.js": NEW["api-relay.js"] + b"\nthrow new Error('fixture: crash at start');\n"})
        scenario("S4 crash", port, "execute", new=crash, want_rc=3, want_files=L, want_restarts=2,
                 extra=lambda o, d: check("S4: healthy on LIVE after auto-rollback", "ROLLED BACK" in o.get("result", ""), d))

        reflect = dict(NEW, **{"api-relay.js": NEW["api-relay.js"].replace(
            b'} else if (origin && CORS_PUBLIC_ORIGINS.includes(origin)) {', b'} else if (origin) {', 1)})
        assert reflect["api-relay.js"] != NEW["api-relay.js"]
        def s5(o, d):
            fl = next((s for s in o["steps"] if s["step"] == "VALIDATION FAILED"), {}).get("failures", [])
            check("S5: the untrusted-origin gate is what failed", any("untrusted origin" in f for f in fl), json.dumps(fl)[:300])
        scenario("S5 CORS reflect", port, "execute", new=reflect, want_rc=3, want_files=L, want_restarts=2, extra=s5)

        def s6(o, d):
            a = o["checks"]["after"]
            check("S6: exists 3x 200 exists:true each < 3 s with custody hanging", all(c["code"] == 200 and c["body"].get("exists") is True and c["s"] < 3
                                                                                      for c in a["exists"]), json.dumps(a["exists"]))
            check("S6: backups hold LIVE", all(sha((FX / "bak" / f"{n}.pre-{sha(LIVE[n])[:8]}").read_bytes()) == sha(LIVE[n]) for n in LIVE), d)
        scenario("S6 execute reviewed pair", port, "execute", want_rc=0, want_files=N, want_restarts=1, extra=s6)
        scenario("S7 execute again", port, "execute", want_rc=2, want_files=N, want_restarts=0)
        scenario("S8 rollback", port, "rollback", want_rc=0, want_files=L, want_restarts=1)
        scenario("S9 rollback again", port, "rollback", want_rc=2, want_files=L, want_restarts=0)

        st = state(); st["brokenStart"] = True; (FX / "state.json").write_text(json.dumps(st))
        scenario("S10 nothing starts", port, "execute", want_rc=4, want_restarts=2,
                 extra=lambda o, d: check("S10: CRITICAL reported, files restored to LIVE", "CRITICAL" in o.get("result", "") and hashes() == L, d))
    finally:
        stop_relay()
    (HERE / "fixture-test.json").write_text(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "remoteProgramSha256": sha((HERE / "remote_combined.py").read_bytes()), "results": results, "failed": failed}, indent=1) + "\n")
    print(f"FIXTURE: {len(results) - len(failed)}/{len(results)} pass" + (f"; FAILED: {failed}" if failed else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
