# READ-ONLY: sha256 of the two pinned relay source files + unit PID/start. No env, store, data or journal.
import subprocess, json, pathlib, datetime
remote = r'''sudo python3 - <<'REMOTE'
import hashlib, json, subprocess, os
o = {n: hashlib.sha256(open("/opt/nan-relay/" + n, "rb").read()).hexdigest() for n in ("secrets.js", "api-relay.js")}
o["unit"] = subprocess.run(["systemctl","show","enclave-api-relay","-p","MainPID,ActiveState,ExecMainStartTimestamp,NRestarts"],capture_output=True,text=True,timeout=10).stdout
o["backupDirExists"] = os.path.isdir("/root/relay-combined-20261021")
print(json.dumps(o))
REMOTE'''
cmd = ['ssh','-p32423','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1',remote]
r = subprocess.run(cmd, capture_output=True, text=True, timeout=50)
o = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "exit": r.returncode, "err": r.stderr[:300]}
try: o["live"] = json.loads(r.stdout.strip().splitlines()[-1])
except Exception as e: o["parseError"] = str(e)
pathlib.Path(__file__).with_suffix(".json").write_text(json.dumps(o, indent=1) + "\n"); print(json.dumps(o, indent=1))
