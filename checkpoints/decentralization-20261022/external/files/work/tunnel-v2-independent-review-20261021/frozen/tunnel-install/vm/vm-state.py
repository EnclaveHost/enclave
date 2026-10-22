#!/usr/bin/env python3
"""vm-state.py - the control VM half of the challenge-DNS feed, run as root by tunnel_install.py (`sudo python3 - ...`).
  apply   CAS: unit + script ABSENT, known_hosts == the pinned sha, no alias line. Installs the script and the unit with
          the exact pinned bytes, appends ONE known_hosts line, daemon-reload. NOT enabled. Every step is recorded in a
          root-only receipt BEFORE the next one.
  rollback  reverts ONLY what that receipt records, each by exact bytes:
          - unit/script: removed only if the receipt says this run installed them AND they still hash to those bytes;
          - known_hosts: restored whole ONLY if it still hashes to exactly what apply produced (and the backup hashes to
            what it was); otherwise ONLY the one appended line is removed and every other byte stays;
          - anything else is a conflict: left in place, reported, and the decision is NOT "rolled-back".
TEST_ROOT (tests only) prefixes every path and skips systemctl; the payloads come from --script/--unit files.
Output: one JSON line.
"""
import hashlib, json, os, pathlib, subprocess, sys

ROOT = os.environ.get("TEST_ROOT", "")
P = lambda p: pathlib.Path(ROOT + p)
SCRIPT = P("/usr/local/libexec/enclave-control-tunnel-minipc.sh")
UNIT = P("/etc/systemd/system/enclave-control-tunnel-minipc.service")
KH = P("/var/lib/enclave-control-tunnel/known_hosts")
STATE_DIR = P("/var/lib/enclave-control-tunnel-minipc.state")
RECEIPT = STATE_DIR / "receipt.json"
BACKUP = STATE_DIR / "known_hosts.orig"
sha = lambda b: hashlib.sha256(b).hexdigest()
fsha = lambda p: sha(p.read_bytes()) if p.exists() else "absent"


def systemctl(*a):
    if ROOT: return 0
    return subprocess.run(["systemctl", *a], capture_output=True).returncode


def save(r): RECEIPT.write_text(json.dumps(r, indent=1)); os.chmod(RECEIPT, 0o600)


def out(o, rc=0): print(json.dumps(o)); sys.exit(rc)


def apply(script_b, unit_b, line, kh_before):
    if RECEIPT.exists(): out({"decision": "refused: a receipt exists (apply ran before): roll back first"}, 3)
    why = []
    if SCRIPT.exists(): why.append("script present")
    if UNIT.exists(): why.append("unit present")
    if fsha(KH) != kh_before: why.append("known_hosts is not the pinned file")
    if not line.startswith("minipc-hyperv ssh-ed25519 ") or "\n" in line: why.append("bad alias line")
    if KH.exists() and any(l.startswith("minipc-hyperv ") for l in KH.read_text().splitlines()): why.append("alias already present")
    if why: out({"decision": "refused: " + "; ".join(why)}, 3)            # nothing changed, no receipt
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    r = {"knownHostsBefore": kh_before, "line": line, "scriptInstalled": None, "unitInstalled": None, "knownHostsAfter": None}
    save(r)
    st = KH.stat(); BACKUP.write_bytes(KH.read_bytes()); os.chmod(BACKUP, 0o600)
    if fsha(BACKUP) != kh_before: out({"decision": "refused: backup copy differs"}, 3)
    SCRIPT.parent.mkdir(parents=True, exist_ok=True); SCRIPT.write_bytes(script_b); os.chmod(SCRIPT, 0o755)
    r["scriptInstalled"] = fsha(SCRIPT); save(r)
    UNIT.parent.mkdir(parents=True, exist_ok=True); UNIT.write_bytes(unit_b); os.chmod(UNIT, 0o644)
    r["unitInstalled"] = fsha(UNIT); save(r)
    data = KH.read_bytes()
    add = (b"" if data.endswith(b"\n") or not data else b"\n") + line.encode() + b"\n"
    with open(KH, "ab") as f: f.write(add)
    if not ROOT: os.chown(KH, st.st_uid, st.st_gid)
    os.chmod(KH, st.st_mode & 0o777)
    r["knownHostsAfter"] = fsha(KH); r["appendedBytes"] = sha(add); save(r)
    systemctl("daemon-reload")
    out({"decision": "applied (not enabled)", "receipt": r})


def rollback():
    if not RECEIPT.exists(): out({"decision": "nothing-to-roll-back: no receipt (this run changed nothing)"})
    r = json.loads(RECEIPT.read_text()); conflicts, done = [], []
    if r.get("unitInstalled"):
        if fsha(UNIT) == r["unitInstalled"]:
            systemctl("disable", "--now", "enclave-control-tunnel-minipc.service"); UNIT.unlink(); done.append("unit removed")
        elif UNIT.exists(): conflicts.append("unit changed since apply: left in place (it may still be enabled)")
    if r.get("scriptInstalled"):
        if fsha(SCRIPT) == r["scriptInstalled"]: SCRIPT.unlink(); done.append("script removed")
        elif SCRIPT.exists(): conflicts.append("script changed since apply: left in place")
    if r.get("knownHostsAfter") or r.get("line"):
        cur = fsha(KH)
        if r.get("knownHostsAfter") and cur == r["knownHostsAfter"] and fsha(BACKUP) == r["knownHostsBefore"]:
            st = KH.stat(); KH.write_bytes(BACKUP.read_bytes()); os.chmod(KH, st.st_mode & 0o777)
            if not ROOT: os.chown(KH, st.st_uid, st.st_gid)
            done.append("known_hosts restored (unchanged since apply)")
        else:
            lines = KH.read_bytes().split(b"\n") if KH.exists() else []
            hits = [i for i, l in enumerate(lines) if l == r["line"].encode()]
            if len(hits) == 1:
                st = KH.stat(); del lines[hits[0]]; KH.write_bytes(b"\n".join(lines)); os.chmod(KH, st.st_mode & 0o777)
                if not ROOT: os.chown(KH, st.st_uid, st.st_gid)
                done.append("known_hosts: removed ONLY this run's line; later changes kept")
            elif not hits: done.append("known_hosts: this run's line is already gone")
            else: conflicts.append(f"known_hosts: the line occurs {len(hits)} times: left in place")
    systemctl("daemon-reload")
    if conflicts: out({"decision": "rollback-conflict: manual review", "conflicts": conflicts, "done": done}, 4)
    RECEIPT.rename(STATE_DIR / "receipt.rolled-back.json")
    out({"decision": "rolled-back", "done": done})


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["apply"] and len(a) == 5:
        apply(pathlib.Path(a[1]).read_bytes(), pathlib.Path(a[2]).read_bytes(), a[3], a[4])
    elif a == ["rollback"]: rollback()
    else: out({"decision": "usage: apply SCRIPT UNIT LINE KH_SHA | rollback"}, 2)
