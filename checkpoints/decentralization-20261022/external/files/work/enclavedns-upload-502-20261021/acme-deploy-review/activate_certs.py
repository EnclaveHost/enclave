#!/usr/bin/env python3
"""Guarded activation of ONE file: /opt/nan-relay/certs.js for enclave-api-relay.service (control VM). ROOT RUNS IT.

  sudo python3 activate_certs.py --candidate /home/controladmin/certs.js.candidate --candidate-sha <64hex>            # dry run
  sudo python3 activate_certs.py --candidate /home/controladmin/certs.js.candidate --candidate-sha <64hex> --execute  # swap + 1 restart

Dry run (default) only checks; it writes nothing. --execute:
  1. preflight (no write):
       - the candidate is a regular non-symlink file under /home/controladmin with the pinned sha;
       - live certs.js == BASE_SHA;
       - the unit is active and NeedDaemonReload=no;
       - unit + drop-in files match their pinned sha256;
       - every EnvironmentFile / LoadCredential source / /etc/nan-relay file and every /opt/nan-relay file is older than
         the PRECISE process start (from /proc, not second-precision find -newermt);
       - no [certs] order is in flight per a bounded journal window, and the journal is quiet for QUIET_S;
  2. backups: certs.js -> certs.js.before-retention-<TS> (sha == base); certs.json -> /root/relay-backups/ (0600, remote
     only, bytes copied, never printed); accounts fingerprint = counts + sha256[:16] of the accounts section;
  3. stage /opt/nan-relay/.certs-staged-<TS>.mjs (sha == pin) and `node --check` it;
  4. in-flight re-check; then CAS: live sha == base -> os.replace(staged, certs.js);
  5. ONE `systemctl restart`. Verify:
       - a new MainPID, active, NRestarts 0 after SETTLE_S;
       - certs.js == candidate with mtime < the new start (so it was loaded);
       - a "[certs] enabled" line since the restart;
       - the accounts fingerprint unchanged;
  6. any failure after the swap -> ROLLBACK SOURCE ONLY (CAS on the candidate sha -> the backup) and one restart. The
     store is never restored by this script.
Never prints env values, unit secret lines, store contents or sealed accounts. Exit 0 ok/dry-run-ok, 2 refused
before any change, 3 rolled back, 4 rollback FAILED (manual).
"""
import argparse, fcntl, hashlib, json, os, re, shutil, subprocess, sys, time

UNIT = "enclave-api-relay.service"
SRC_DIR = "/opt/nan-relay"
TARGET = SRC_DIR + "/certs.js"
BASE_SHA = "e15802cf5609c7b8cdf51c36d43f12606bd44d26622b46cfab3951df5229a415"
STORE = "/var/lib/private/enclave-relay/certs.json"
STORE_BACKUP_DIR = "/root/relay-backups"
ETC_DIR = "/etc/nan-relay"
CANDIDATE_ROOT = "/home/controladmin/"
LOCK = "/run/relay-certs-activate.lock"
# unit files as read 2026-10-21T19:09Z (live-meta.json): path -> sha256
UNIT_FILES = {
    "/etc/systemd/system/enclave-api-relay.service": "5c5a9de4006f1b41b2ccd53bf7bd911d36aefb4c2f9f2ebbaf5507e9196d11bf",
    "/etc/systemd/system/enclave-api-relay.service.d/99-control-migration.conf": "6ff4a6bd2bfe6b8bf21462d68a991c1eaa29891e587ea0ce3b05591d26f3f72a",
    "/etc/systemd/system/enclave-api-relay.service.d/host-sponsor.conf": "4463c098b13c56459cf73af16a8a77eb78c1462793bec7a7d8215611e1da3e02",
    "/etc/systemd/system/enclave-api-relay.service.d/predict.conf": "146e686d031a1f807157c990bd70e65f319c347d2fef010a0014b078f6056cf3",
    "/etc/systemd/system/enclave-api-relay.service.d/zz-predictor-replicas.conf": "26a766db845af92b3642fb2ffede5614368081bdf88b552c340c3e06598b37bc",
    "/etc/systemd/system/enclave-api-relay.service.d/zzz-eyesoff-release-recovery.conf": "ae15f8b5cfa0c1519cb2205d444407bde48686ea71ba4ddac8270df2ee2b5c87",
    "/etc/systemd/system/enclave-api-relay.service.d/zzzz-release-signing-credential.conf": "473e3e827dca4b7fd6cc22b18e67c29b7aa88540c25ff90b41595c1480ab5e35",
    "/etc/systemd/system/enclave-api-relay.service.d/zzzzz-linux-leasegas-measurement.conf": "21fadc7209de6f7ba82fd614bcddd2fe1ba2cfa9feba988d34ab36b68d5caf9a",
}
OWN = re.compile(r"^(certs\.js\.before-retention-\d{8}T\d{6}Z|\.certs-staged-\d{8}T\d{6}Z\.mjs|\.certs-rollback-\d{8}T\d{6}Z\.mjs)$")
JOURNAL_WINDOW_S = 600      # an order (settle + 2 polls of 90 s + 20 s requests) ends well inside this
QUIET_S = 15                # no [certs] line this recently (a new order logs only after the 8 s sync window)
SETTLE_S = 10
MAX_CANDIDATE = 512 * 1024
MAX_WALK = 200_000
IN_FLIGHT = ("order still running", "order in flight", "resuming order")
TERMINAL = ("issued ", "issuance failed", "failed at the CA", "backoff after", "CA still processing", "KEPT",
            "every CA is cooling", "endpoint paced", "REFUSED")


class Refused(Exception):
    pass


def is_root():
    return os.geteuid() == 0


def log(msg):
    print(f"[activate {time.strftime('%H:%M:%SZ', time.gmtime())}] {msg}", flush=True)


def run(args, timeout=30, check=True):
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and p.returncode != 0:
        raise Refused(f"{args[0]} {args[1] if len(args) > 1 else ''} rc={p.returncode}: {p.stderr.strip()[:200]}")
    return p.stdout


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 16), b""):
            h.update(b)
    return h.hexdigest()


def show(*props):
    out = run(["systemctl", "show", UNIT] + [f"-p{p}" for p in props])
    d = {}
    for line in out.splitlines():
        k, _, v = line.partition("=")
        d.setdefault(k, []).append(v)
    return d


def one(d, k):
    return (d.get(k) or [""])[-1]


def proc_start(pid):
    """Process start as an epoch float, from /proc (tick precision); errs EARLY (truncated ticks) = conservative."""
    with open(f"/proc/{pid}/stat") as f:
        ticks = int(f.read().rsplit(")", 1)[1].split()[19])
    with open("/proc/uptime") as f:
        up = float(f.read().split()[0])
    return time.time() - up + ticks / os.sysconf("SC_CLK_TCK")


def main_pid():
    pid = int(one(show("MainPID"), "MainPID") or 0)
    if pid <= 0:
        raise Refused("no MainPID")
    return pid


def check_candidate(path, pin):
    if not re.fullmatch(r"[0-9a-f]{64}", pin or ""):
        raise Refused("--candidate-sha must be 64 lowercase hex")
    if pin == BASE_SHA:
        raise Refused("candidate sha equals the base sha")
    real = os.path.realpath(path)
    if not real.startswith(CANDIDATE_ROOT) or os.path.islink(path) or real != os.path.abspath(path):
        raise Refused(f"candidate must be a non-symlink path under {CANDIDATE_ROOT}")
    st = os.lstat(real)
    if not os.path.isfile(real) or st.st_size == 0 or st.st_size > MAX_CANDIDATE:
        raise Refused("candidate is not a regular file of sane size")
    data = open(real, "rb").read()
    if hashlib.sha256(data).hexdigest() != pin:
        raise Refused("candidate sha256 does not match --candidate-sha")
    return data


def check_unit(start):
    d = show("ActiveState", "NeedDaemonReload", "FragmentPath", "DropInPaths", "EnvironmentFiles", "LoadCredential")
    if one(d, "ActiveState") != "active":
        raise Refused(f"unit not active ({one(d, 'ActiveState')})")
    if one(d, "NeedDaemonReload") != "no":
        raise Refused("NeedDaemonReload is not 'no'")
    loaded = [one(d, "FragmentPath")] + one(d, "DropInPaths").split()
    if sorted(loaded) != sorted(UNIT_FILES):
        raise Refused("the unit's fragment/drop-in set differs from the pinned one")
    for f, want in UNIT_FILES.items():
        if sha256_file(f) != want:
            raise Refused(f"unit file changed: {f}")
    deps = [v.split(" (")[0] for v in d.get("EnvironmentFiles", []) if v]
    deps += [v.split(":", 1)[1] for v in d.get("LoadCredential", []) if ":" in v]
    if os.path.isdir(ETC_DIR):
        deps += [os.path.join(ETC_DIR, n) for n in os.listdir(ETC_DIR)]
    for f in sorted(set(deps)):
        if os.path.exists(f) and os.stat(f).st_mtime >= start:
            raise Refused(f"{f} changed after the running process started; a restart would activate it too")
    return len(set(deps))


def check_sources(start):
    n = 0
    for root, _dirs, files in os.walk(SRC_DIR):
        for name in files:
            n += 1
            if n > MAX_WALK:
                raise Refused("source tree too large to verify")
            if root == SRC_DIR and OWN.match(name):
                continue
            p = os.path.join(root, name)
            if os.lstat(p).st_mtime >= start:
                raise Refused(f"{p} is newer than the running process; a restart would activate it too")
    return n


def check_no_inflight(now=None):
    """Bounded journal window. Refuse if any name's newest in-flight marker has no later terminal line, or if a [certs]
    line is newer than QUIET_S. A name that cannot be parsed from an in-flight line refuses."""
    now = now or time.time()
    out = run(["journalctl", "-u", UNIT, "--since", f"-{JOURNAL_WINDOW_S}s", "-o", "short-unix", "--no-pager"], timeout=60)
    last_line, state = 0.0, {}
    for line in out.splitlines():
        m = re.match(r"^(\d+\.\d+)\s.*?\[certs\] (.*)$", line)
        if not m:
            continue
        ts, msg = float(m.group(1)), m.group(2)
        last_line = max(last_line, ts)
        name = None
        t = msg.split()
        if len(t) >= 2 and t[0].startswith("http") and t[1].endswith(":"):
            name = t[1][:-1]
        else:
            m2 = (re.search(r"\bissued ([a-z0-9.-]+\.[a-z]{2,}) via\b", msg) or re.search(r"\bfor ([a-z0-9.-]+\.[a-z]{2,})\b", msg)
                  or re.search(r"refused ([a-z0-9.-]+\.[a-z]{2,}):", msg))
            name = m2.group(1) if m2 else None
        if any(k in msg for k in IN_FLIGHT):
            if not name:
                raise Refused("an in-flight [certs] line names no parseable host; wait and retry")
            state[name] = ("inflight", ts)
        elif name and any(k in msg for k in TERMINAL):
            state[name] = ("terminal", ts)
    busy = sorted(n for n, (s, _) in state.items() if s == "inflight")
    if busy:
        raise Refused(f"order(s) in flight per the journal: {', '.join(busy)}; wait for a terminal line")
    if last_line and now - last_line < QUIET_S:
        raise Refused(f"a [certs] line {now - last_line:.0f}s ago; wait for {QUIET_S}s of quiet")
    return len(state)


def accounts_fp():
    j = json.load(open(STORE))
    acc = j.get("accounts") or {}
    return {"accounts": len(acc), "accounts_fp": hashlib.sha256(json.dumps(acc, sort_keys=True).encode()).hexdigest()[:16],
            "certs": len(j.get("certs") or {}), "orders": len(j.get("orders") or {})}


def write_file(path, data, mode=0o644):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    if os.geteuid() == 0:
        os.chown(path, 0, 0)
    os.chmod(path, mode)


def fsync_dir(d):
    fd = os.open(d, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def restart_and_verify(old_pid, want_sha, fp_before):
    t0 = time.time()
    run(["systemctl", "restart", UNIT], timeout=240)
    time.sleep(SETTLE_S)
    d = show("ActiveState", "MainPID", "NRestarts")
    pid = int(one(d, "MainPID") or 0)
    if one(d, "ActiveState") != "active" or pid <= 0 or pid == old_pid or one(d, "NRestarts") != "0":
        raise Refused(f"after restart: state={one(d, 'ActiveState')} pid={pid} (old {old_pid}) NRestarts={one(d, 'NRestarts')}")
    start = proc_start(pid)
    if sha256_file(TARGET) != want_sha or os.stat(TARGET).st_mtime >= start or start < t0 - 1:
        raise Refused("certs.js on disk is not provably the one the new process loaded")
    out = run(["journalctl", "-u", UNIT, "--since", f"@{int(t0)}", "-o", "cat", "--no-pager"], timeout=60)
    en = [l for l in out.splitlines() if "[certs] enabled" in l or "[certs] disabled" in l]
    if not en or "[certs] enabled" not in en[-1]:
        raise Refused("no '[certs] enabled' line since the restart")
    fp = accounts_fp()
    if fp["accounts"] != fp_before["accounts"] or fp["accounts_fp"] != fp_before["accounts_fp"]:
        raise Refused(f"accounts fingerprint changed: {fp_before} -> {fp}")
    return pid, fp


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidate", required=True)
    ap.add_argument("--candidate-sha", required=True)
    ap.add_argument("--execute", action="store_true")
    a = ap.parse_args(argv)
    if not is_root():
        log("REFUSED: run as root"); return 2
    lockf = open(LOCK, "w")
    try:
        fcntl.flock(lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("REFUSED: another activation holds the lock"); return 2
    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    try:
        data = check_candidate(a.candidate, a.candidate_sha)
        live = sha256_file(TARGET)
        if live != BASE_SHA:
            raise Refused(f"live certs.js is {live[:12]}…, not the base {BASE_SHA[:12]}…")
        old_pid = main_pid()
        start = proc_start(old_pid)
        log(f"pid {old_pid} started {time.strftime('%FT%T', time.gmtime(start))}.{int(start % 1 * 1000):03d}Z")
        log(f"unit pinned files ok; {check_unit(start)} env/credential/etc files older than the start")
        log(f"{check_sources(start)} files under {SRC_DIR} older than the start")
        log(f"journal: {check_no_inflight()} name(s) seen in {JOURNAL_WINDOW_S}s, none in flight")
        fp0 = accounts_fp()
        log(f"store: {fp0}")
    except Refused as e:
        log(f"REFUSED (nothing changed): {e}"); return 2
    if not a.execute:
        log("DRY RUN ok: all preflight checks pass; nothing written. Re-run with --execute to activate."); return 0

    backup = f"{TARGET}.before-retention-{ts}"
    staged = f"{SRC_DIR}/.certs-staged-{ts}.mjs"
    try:
        orig = open(TARGET, "rb").read()
        if hashlib.sha256(orig).hexdigest() != BASE_SHA:
            raise Refused("base changed during preflight")
        write_file(backup, orig)
        if sha256_file(backup) != BASE_SHA:
            raise Refused("source backup sha mismatch")
        os.makedirs(STORE_BACKUP_DIR, mode=0o700, exist_ok=True)
        os.chmod(STORE_BACKUP_DIR, 0o700)
        sb = f"{STORE_BACKUP_DIR}/certs.json.before-retention-{ts}"
        write_file(sb, open(STORE, "rb").read(), 0o600)
        log(f"backups: {backup} (sha == base), {sb} (0600, not printed)")
        write_file(staged, data)
        if sha256_file(staged) != a.candidate_sha:
            raise Refused("staged copy sha mismatch")
        run(["node", "--check", staged], timeout=60)
        log(f"staged {staged}: sha ok, node --check ok")
        check_no_inflight()
    except (Refused, OSError, subprocess.SubprocessError) as e:
        if os.path.exists(staged):
            os.unlink(staged)
        log(f"REFUSED before the swap (live certs.js untouched; backups kept): {e}"); return 2

    # compare-and-swap, then the single restart
    if sha256_file(TARGET) != BASE_SHA:
        os.unlink(staged); log("REFUSED: live certs.js changed just before the swap"); return 2
    os.replace(staged, TARGET); fsync_dir(SRC_DIR)
    log(f"swapped: {TARGET} sha {sha256_file(TARGET)[:12]}…")
    try:
        pid, fp = restart_and_verify(old_pid, a.candidate_sha, fp0)
        log(f"ACTIVATED: new pid {pid}, certs.js {a.candidate_sha[:12]}… loaded, store {fp}")
        return 0
    except (Refused, OSError, subprocess.SubprocessError) as e:
        log(f"VERIFY FAILED: {e} -> rolling back the SOURCE only (store untouched; backup {STORE_BACKUP_DIR})")
    try:
        cur = sha256_file(TARGET)
        if cur != a.candidate_sha:
            raise Refused(f"certs.js is {cur[:12]}…, neither candidate nor expected; not touching it")
        rb = f"{SRC_DIR}/.certs-rollback-{ts}.mjs"
        write_file(rb, open(backup, "rb").read())
        if sha256_file(rb) != BASE_SHA:
            raise Refused("backup does not hash to the base")
        os.replace(rb, TARGET); fsync_dir(SRC_DIR)
        cur_pid = int(one(show("MainPID"), "MainPID") or 0)
        run(["systemctl", "restart", UNIT], timeout=240)
        time.sleep(SETTLE_S)
        d = show("ActiveState", "MainPID")
        if one(d, "ActiveState") != "active" or int(one(d, "MainPID") or 0) in (0, cur_pid):
            raise Refused(f"after rollback restart: state={one(d, 'ActiveState')} pid={one(d, 'MainPID')}")
        log(f"ROLLED BACK: certs.js == base, pid {one(d, 'MainPID')} active; store {accounts_fp()}")
        return 3
    except (Refused, OSError, subprocess.SubprocessError) as e:
        log(f"ROLLBACK FAILED: {e}. MANUAL: install -m0644 {backup} {TARGET} && systemctl restart {UNIT}")
        return 4


if __name__ == "__main__":
    sys.exit(main())
