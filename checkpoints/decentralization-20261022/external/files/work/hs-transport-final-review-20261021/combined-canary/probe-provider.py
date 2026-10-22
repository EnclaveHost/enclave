import json, pathlib, subprocess, sys, time
H = pathlib.Path(__file__).resolve().parent; S = (H / "probe-provider.sh").read_text()
for f in sys.argv[1:]:
    r = subprocess.run(["timeout", "60", "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", f, "bash", "-s"], input=S, capture_output=True, text=True)
    (H / "probe" / f"{f}-provider.json").write_text(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "rc": r.returncode, "stdout": r.stdout, "stderr": r.stderr[-400:]}, indent=1) + "\n")
