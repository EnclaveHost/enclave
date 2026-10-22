#!/usr/bin/env python3
"""ROOT activation of TWO reviewed enclave-api-relay source files with ONE restart. PREPARED by claude (combined); NOT run.

  ./root-activate-relay-combined.py              preflight only (read-only: hashes, unit state, health, exists timing,
                                                 loopback CORS matrix, public CORS)                                [default]
  ./root-activate-relay-combined.py --execute    preflight -> node --check both NEW in place -> backups -> per-file CAS +
                                                 atomic rename -> ONE `systemctl restart enclave-api-relay` -> validate
  ./root-activate-relay-combined.py --rollback   both files back to LIVE from the backups (CAS) -> ONE restart -> health

Files in /opt/nan-relay (pins are immutable here; the payload copies in combined/payload are read-only and re-hashed):
  secrets.js    6f3d8c76… -> 4c491271…   /v1/secrets/exists answers from a local record without waiting on custody
                                          (relay-exists/RESULT.txt; 64+35 tests; live-identical baseline fails the 2 cases)
  api-relay.js  27f71ad3… -> 481f0041…   exact, credential-free CORS for https://enclavehost.eth/.eth.link/.eth.limo;
                                          apex + www keep the credentialed grant (e49: ens-public-site-20261021/native-origin/fix)
Validation after the restart (all must pass, else BOTH files are restored from backup and the relay restarted once more):
  new MainPID, active, /health 200 within 60 s; 3x POST /v1/secrets/exists for 59f1273d -> 200 exists:true, each < 3 s;
  loopback CORS on GET /health and OPTIONS /v1/secrets/exists: each ENS origin -> ACAO == origin and NO credentials; apex/www
  -> ACAO == origin + credentials; 8 untrusted/look-alike/suffix/http/null/case origins and no Origin -> no ACAO, no ACAC.
Exit: 0 OK | 2 REFUSED, nothing changed | 3 validation FAILED, rolled back, relay healthy | 4 CRITICAL, act now.
No journal text, env file, data dir, secrets store or key is read. Public CORS (via the fronts) is reported, not gated.
"""
import base64, hashlib, json, pathlib, subprocess, sys, datetime, tempfile

HERE = pathlib.Path(__file__).resolve().parent
PINS = {  # install order: secrets.js first (api-relay.js imports it; its exports are unchanged)
    "secrets.js":   {"live": "6f3d8c7633510b5a0c6e4a230aa8b0dad78eff585ad59f8b1fc381f3ef138ea5",
                     "new":  "4c49127164e716a7431b1e2d62cd703f82b7a849641205e5bdf28d3bd17a198b"},
    "api-relay.js": {"live": "27f71ad333a268c4370ff96cf703a07e936c1f20287c38ce0cb9effe1724a001",
                     "new":  "481f00410b87f30ee467183db7121175d37c010be5b2c23891a0a19e63b4579d"},
}
REMOTE_SHA = None  # filled below and printed, so the receipt names the exact on-VM program
ID59 = "0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c"
SSH = ['ssh', '-p32423', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
       '-o', 'UserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts',
       '-i', '/home/steven/.ssh/minipc', 'controladmin@127.0.0.1', 'sudo python3 -']


def public_cors():
    rows = []
    for o in ["https://enclavehost.eth", "https://enclavehost.eth.link", "https://enclavehost.eth.limo", "https://enclave.host",
              "https://www.enclave.host", "https://evil.example", "https://enclavehost.eth.evil.example"]:
        with tempfile.NamedTemporaryFile() as h:
            r = subprocess.run(['curl', '-sS', '--max-time', '15', '-o', '/dev/null', '-D', h.name, '-w', '%{http_code}', '-H', f'Origin: {o}',
                                'https://api.enclave.host/health'], capture_output=True, text=True, timeout=25)
            hd = {l.split(':', 1)[0].strip().lower(): l.split(':', 1)[1].strip() for l in open(h.name, encoding='latin-1') if ':' in l}
        rows.append({"origin": o, "code": r.stdout.strip(), "acao": hd.get("access-control-allow-origin"), "acac": hd.get("access-control-allow-credentials")})
    return rows


def main():
    global REMOTE_SHA
    mode = {"": "preflight", "--execute": "execute", "--rollback": "rollback"}.get(sys.argv[1] if len(sys.argv) > 1 else "")
    if mode is None: sys.exit(f"unknown argument {sys.argv[1]!r}")
    files = {}
    for n, p in PINS.items():
        new = (HERE / "payload" / n).read_bytes(); base = (HERE / "payload" / f"{n}.live-base").read_bytes()
        assert hashlib.sha256(new).hexdigest() == p["new"], f"payload/{n} is not the reviewed NEW"
        assert hashlib.sha256(base).hexdigest() == p["live"], f"payload/{n}.live-base is not the reviewed LIVE"
        files[n] = {**p, **({"b64": base64.b64encode(new).decode()} if mode == "execute" else {})}
    src = (HERE / "remote_combined.py").read_text()
    REMOTE_SHA = hashlib.sha256(src.encode()).hexdigest()
    cfg = {"mode": mode, "dir": "/opt/nan-relay", "bakdir": "/root/relay-combined-20261021", "unit": "enclave-api-relay", "port": 8100,
           "files": files, "existsId": ID59, "existsMaxS": 3, "healthBudgetS": 60}
    program = src.replace('if __name__ == "__main__":\n    main(json.load(open(sys.argv[1])))',
                          f'main(json.loads(base64.b64decode({base64.b64encode(json.dumps(cfg).encode()).decode()!r})))')
    assert program != src, "could not bind the config"
    o = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "mode": mode, "remoteProgramSha256": REMOTE_SHA,
         "wrapperSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(), "publicCorsBefore": public_cors()}
    r = subprocess.run(SSH, input=program, capture_output=True, text=True, timeout=600)
    o.update({"sshExit": r.returncode, "stderr": r.stderr[-400:]})
    try: o["remote"] = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception as e: o["parseError"] = str(e)[:200]; o["stdoutTail"] = r.stdout[-400:]
    if mode != "preflight": o["publicCorsAfter"] = public_cors()
    rc = o.get("remote", {}).get("exit", 4 if mode != "preflight" else 2)
    if r.returncode != rc: rc = r.returncode if r.returncode else rc      # an ssh/python failure is never success
    o["exit"] = rc
    name = f"combined-{mode}-{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    (HERE / name).write_text(json.dumps(o, indent=1) + "\n")
    print(json.dumps({k: o[k] for k in ("mode", "exit", "remoteProgramSha256")} | {"result": o.get("remote", {}).get("result"), "receipt": name}, indent=1))
    sys.exit(rc)


if __name__ == "__main__":
    main()
