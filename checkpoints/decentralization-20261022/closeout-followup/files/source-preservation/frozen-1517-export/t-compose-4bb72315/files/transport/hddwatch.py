#!/usr/bin/env python3
"""Runtime supervision of ONE role's network-HDD storage, for systemd (Type=notify).

  hddwatch.py check <watch.json>    one pass of every check; exit 0, or 2 naming the failed check
  hddwatch.py run   <watch.json>    check, READY=1, then re-check every intervalSec; the first failure is recorded in
                                    failureFile and the process exits 1

Why it exists: a dead export does not unmount anything. The integration test measured this:
- writes and fsync return EIO;
- the ext4 mount stays listed rw;
- systemd's view of a oneshot RemainAfterExit storage unit stays "active".

So something must actively notice and make systemd stop the consumers. The node units bind to this unit (BindsTo= +
After=), so this unit's exit stops them.

Nothing here writes to the device, remounts, retries, reformats or resyncs. Recovery is an operator step.

Checks, every pass:
- attach: this tool's recorded qemu-nbd daemon (pid + start time + exe + argv) connects the device. The kernel's NBD pid
  belongs to that daemon, and the size is the placement statement's.
- mapping (cached layout only): the dm-cache table's origin IS this device; the status is writethrough, with no
  Fail/needs_check/read-only.
- mount: the mount point is mounted rw, as ext4, from the expected device (the mapping, or the nbd device).
- ext4 errors: /sys/fs/ext4/<dev>/errors_count does not grow past its value at start.
- probe: an O_DIRECT 4 KiB read of the ORIGIN nbd device. It bypasses the page cache and the dm-cache, so a lost export
  is seen even while every read could be served from cache. It is bounded by probeTimeoutSec.
"""
import json
import mmap
import os
import socket
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Refused, refuse, abspath_plain, mount_at, emit  # noqa: E402
import hddattach  # noqa: E402

FORMAT = "enclave-rpc-hdd-watch/v1"
KEYS = {"format", "role", "attachConfig", "device", "mapping", "mountPoint", "intervalSec", "probeTimeoutSec", "failureFile"}


def load(path):
    with open(path) as f:
        w = json.load(f)
    if not isinstance(w, dict) or set(w) != KEYS or w.get("format") != FORMAT:
        refuse(f"{path}: watch config must be {FORMAT} with exactly {sorted(KEYS)}")
    if w["role"] not in ("l1", "base"):
        refuse("role must be l1 or base")
    for k in ("attachConfig", "mountPoint", "failureFile"):
        abspath_plain(w[k], k)
    if not isinstance(w["intervalSec"], (int, float)) or not 0.5 <= w["intervalSec"] <= 60:
        refuse("intervalSec must be 0.5-60")
    if not isinstance(w["probeTimeoutSec"], (int, float)) or not 1 <= w["probeTimeoutSec"] <= 120:
        refuse("probeTimeoutSec must be 1-120")
    if w["mapping"] is not None and not (isinstance(w["mapping"], str) and w["mapping"].replace("-", "").isalnum()):
        refuse("mapping must be null or a dm name")
    a = hddattach.validate(w["attachConfig"])
    if a["role"] != w["role"] or a["device"] != w["device"]:
        refuse(f"watch role/device {w['role']}/{w['device']} differ from the attach config's {a['role']}/{a['device']}")
    return w, a


def majmin(path):
    st = os.stat(path)
    return f"{os.major(st.st_rdev)}:{os.minor(st.st_rdev)}"


def mapping_ok(name, device):
    t = subprocess.run(["dmsetup", "table", name], capture_output=True, text=True, timeout=10)
    if t.returncode != 0:
        refuse(f"mapping {name} is absent")
    f = t.stdout.split()
    # "0 <sectors> cache <metadata> <cache> <origin> <block> ..." (dm-cache table, kernel docs device-mapper/cache.rst)
    if len(f) < 6 or f[2] != "cache" or f[5] != majmin(device):
        refuse(f"mapping {name} is not a cache over {device}: {t.stdout.strip()}")
    s = subprocess.run(["dmsetup", "status", name], capture_output=True, text=True, timeout=10)
    words = s.stdout.split()
    if s.returncode != 0 or "writethrough" not in words or "Fail" in words or "needs_check" in words or "ro" in words:
        refuse(f"mapping {name} status is not healthy writethrough: {s.stdout.strip()}")
    return f"/dev/mapper/{name}"


def errors_count(dev):
    name = os.path.basename(os.path.realpath(dev))
    try:
        with open(f"/sys/fs/ext4/{name}/errors_count") as f:
            return int(f.read().strip())
    except OSError:
        refuse(f"no ext4 error counter for {name}: the filesystem is not mounted")


def probe(device, offset, timeout):
    """O_DIRECT read of 4 KiB at `offset` of the raw origin; refuses on error or when it does not return in time."""
    out = {}

    def rd():
        try:
            fd = os.open(device, os.O_RDONLY | os.O_DIRECT)
            try:
                buf = mmap.mmap(-1, 4096)
                n = os.preadv(fd, [buf], offset)
                out["n"] = n
            finally:
                os.close(fd)
        except OSError as e:
            out["err"] = f"{type(e).__name__}: {e}"
    t = threading.Thread(target=rd, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        refuse(f"direct read of {device} did not return within {timeout}s")
    if "err" in out:
        refuse(f"direct read of {device} failed: {out['err']}")
    if out.get("n") != 4096:
        refuse(f"direct read of {device} returned {out.get('n')} bytes")


def one_pass(w, a, base_errors=None, n=0):
    st = hddattach.verify_attached(a, check_exe=False)   # sandboxed without CAP_SYS_PTRACE: pid+starttime+argv
    dev = w["device"]
    expect = mapping_ok(w["mapping"], dev) if w["mapping"] else dev
    m = mount_at(w["mountPoint"])
    if m is None:
        refuse(f"{w['mountPoint']} is not mounted")
    if m["fstype"] != "ext4" or os.path.realpath(m["source"]) != os.path.realpath(expect):
        refuse(f"{w['mountPoint']} is {m['fstype']} from {m['source']}, not ext4 from {expect}")
    # the SUPERBLOCK options (an ext4 error remount turns them ro). The per-mount flags in this unit's own namespace are
    # ro by design (ProtectSystem=strict makes the whole tree read-only for the supervisor; measured in the guest).
    # ext4 on 7.2.11 reports "rw,emergency_ro" after a journal abort while the mount still lists rw (measured)
    sup = m["super"].split(",")
    if "ro" in sup or "emergency_ro" in sup or "rw" not in sup:
        refuse(f"{w['mountPoint']} filesystem is no longer read-write (superblock options {m['super']})")
    errs = errors_count(expect)
    if base_errors is not None and errs > base_errors:
        refuse(f"ext4 on {expect} recorded {errs - base_errors} new error(s)")
    probe(dev, (n % 256) * 4096, w["probeTimeoutSec"])
    return errs, st


def sd_notify(msg):
    addr = os.environ.get("NOTIFY_SOCKET")
    if not addr:
        return False
    if addr.startswith("@"):
        addr = "\0" + addr[1:]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as s:
        s.connect(addr)
        s.sendall(msg.encode())
    return True


def record_failure(w, why):
    rec = {"role": w["role"], "reason": why, "at": time.time(), "pid": os.getpid()}
    tmp = w["failureFile"] + ".tmp"
    os.makedirs(os.path.dirname(w["failureFile"]), mode=0o700, exist_ok=True)
    with open(tmp, "w") as f:
        json.dump(rec, f); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, w["failureFile"])


def main(argv):
    if len(argv) != 3 or argv[1] not in ("check", "run"):
        print(__doc__, file=sys.stderr); return 64
    try:
        w, a = load(argv[2])
        errs, st = one_pass(w, a)
    except Refused as e:
        emit({"ok": False, "refused": str(e)})
        if argv[1] == "run":
            try:
                record_failure(w, str(e))
            except Exception:
                pass
            return 1
        return 2
    if argv[1] == "check":
        emit({"ok": True, "device": w["device"], "mount": w["mountPoint"], "errors": errs})
        return 0
    emit({"ok": True, "watching": w["mountPoint"], "device": w["device"], "mapping": w["mapping"], "errorsAtStart": errs})
    sd_notify(f"READY=1\nSTATUS=watching {w['mountPoint']} on {w['device']}")
    n = 1
    while True:
        time.sleep(w["intervalSec"])
        try:
            one_pass(w, a, errs, n)
        except Refused as e:
            emit({"ok": False, "transportOrStorageFailure": str(e)})
            record_failure(w, str(e))
            sd_notify(f"STATUS=failed: {e}")
            return 1
        n += 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
