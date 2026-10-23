# shared state for the fake systemctl/docker/pgrep (tests only)
import json, os
D = os.environ["FAKE_DIR"]
def load(n, default):
    p = os.path.join(D, n)
    return json.load(open(p)) if os.path.exists(p) else default
def save(n, v):
    json.dump(v, open(os.path.join(D, n), "w"))
def log(*a):
    with open(os.path.join(D, "calls.log"), "a") as f:
        f.write(" ".join(a) + "\n")
def unit():
    return load("unit.json", {"ActiveState": "active", "SubState": "running", "MainPID": "4242", "UnitFileState": "enabled"})
def beh():
    return load("behavior.json", {})
def set_running(on):
    save("unit.json", {**unit(), **({"ActiveState": "active", "SubState": "running", "MainPID": "4242"} if on else
                                   {"ActiveState": "inactive", "SubState": "dead", "MainPID": "0"})})
    p = os.path.join(D, "proc")
    if on: open(p, "w").close()
    elif os.path.exists(p) and not beh().get("proc_after_stop"): os.unlink(p)
