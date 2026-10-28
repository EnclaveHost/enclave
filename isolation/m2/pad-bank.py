#!/usr/bin/env python3
"""Bounded, preallocated, per-VM encrypted-pad scratch storage (host side).

Run INSIDE the transient VM service, then exec QEMU. ExecStopPost calls reap
with --stopping-unit; a timer also reaps after crashes/reboots. This code never
sees pad keys or plaintext. An unavailable systemd manager fails closed.
"""
import argparse
import contextlib
import ctypes
import fcntl
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import uuid

GIB = 1024 ** 3
SLACK = 64 * 1024 ** 2  # Leave room for allocation/filesystem metadata too.
TAG = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
UNIT = re.compile(r"m2-[A-Za-z0-9_-]+-[0-9]+\.service\Z")


def reserve_blocks(fd, size):
    # Use Linux fallocate directly. Unlike posix_fallocate's libc fallback this
    # never emulates allocation by writing zeros, including during live adoption.
    libc = ctypes.CDLL(None, use_errno=True)
    alloc = libc.fallocate
    alloc.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_longlong, ctypes.c_longlong]
    alloc.restype = ctypes.c_int
    if alloc(fd, 0, 0, size) != 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))


def unit_states():
    p = subprocess.run(
        ["systemctl", "--user", "show", "m2-*", "--no-pager",
         "--property=Id,ActiveState,SubState,MainPID,ControlPID"],
        check=True, text=True, capture_output=True, timeout=15)
    result = {}
    for block in p.stdout.strip().split("\n\n"):
        if not block:
            continue
        row = dict(line.split("=", 1) for line in block.splitlines())
        if not all(k in row for k in ("Id", "ActiveState", "SubState", "MainPID", "ControlPID")):
            raise RuntimeError("incomplete systemd state; refusing pad cleanup")
        result[row["Id"]] = row
    return result


def dead(unit, states, stopping_unit=None):
    row = states.get(unit)
    if row is None:
        return True  # Successful enumeration of all loaded m2 units above.
    if row["MainPID"] != "0":
        return False
    if row["ActiveState"] in ("inactive", "failed") and row["ControlPID"] == "0":
        return True
    # ExecStopPost runs only after systemd has killed the service's processes.
    return (unit == stopping_unit and row["ActiveState"] == "deactivating"
            and row["SubState"] == "stop-post")


def process_holds(pid, identity):
    if not pid.isdigit() or int(pid) <= 0:
        return False
    for fd in Path("/proc", pid, "fd").iterdir():
        try:
            s = fd.stat()
        except FileNotFoundError:
            continue
        if (s.st_dev, s.st_ino) == identity:
            return True
    return False


class Bank:
    def __init__(self, directory):
        self.path = Path(directory)
        if not self.path.is_absolute():
            raise ValueError("pad directory must be absolute")
        self.path.mkdir(mode=0o700, parents=True, exist_ok=True)
        s = self.path.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o022:
            raise ValueError("pad directory must be owned by this user and not writable by others")

    @contextlib.contextmanager
    def locked(self):
        fd = os.open(self.path / ".pad-bank.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            s = os.fstat(fd)
            if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != os.getuid():
                raise ValueError("unsafe pad lock")
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def file(self, tag):
        if not TAG.fullmatch(tag):
            raise ValueError("invalid pad tag")
        return self.path / (tag + ".padbank")

    def metadata(self, tag):
        return Path(str(self.file(tag)) + ".json")

    def regular(self, path):
        s = path.lstat()
        if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != os.getuid():
            raise ValueError(f"unsafe pad file (symlink, hardlink, type or owner): {path.name}")
        return s

    def sync_dir(self):
        fd = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def write_record(self, tag, record):
        target = self.metadata(tag)
        tmp = self.path / (".record-" + uuid.uuid4().hex)
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(record, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, target)
            self.sync_dir()
        finally:
            tmp.unlink(missing_ok=True)

    def read_record(self, tag):
        p = self.metadata(tag)
        self.regular(p)
        r = json.loads(p.read_text())
        if (r.get("version") != 1 or r.get("tag") != tag
                or not UNIT.fullmatch(r.get("unit", ""))
                or not r["unit"].startswith("m2-" + tag + "-")
                or not isinstance(r.get("size"), int) or r["size"] <= 0):
            raise ValueError(f"invalid pad ownership record: {p.name}")
        return r

    def remove(self, tag, record):
        p = self.file(tag)
        try:
            s = self.regular(p)
        except FileNotFoundError:
            pass
        else:
            # A pre-create intent may have no inode if the process died between
            # O_EXCL creation and recording the inode. Its dead unit, exclusive
            # directory lock and non-replacing creation still establish ownership.
            if record.get("inode") is not None and (s.st_dev, s.st_ino) != tuple(record["inode"]):
                raise ValueError(f"pad inode changed: {p.name}; refusing deletion")
            p.unlink()
        self.metadata(tag).unlink(missing_ok=True)
        self.sync_dir()
        print(f"pad-bank: reclaimed {tag}", file=sys.stderr)

    def reap_locked(self, states, stopping_unit=None):
        for p in sorted(self.path.glob("*.padbank.json")):
            tag = p.name.removesuffix(".padbank.json")
            r = self.read_record(tag)
            if dead(r["unit"], states, stopping_unit):
                self.remove(tag, r)

    def usage(self):
        logical = allocated = future = 0
        for p in self.path.glob("*.padbank"):
            s = self.regular(p)
            logical += s.st_size
            allocated += s.st_blocks * 512
            future += max(0, s.st_size - s.st_blocks * 512)
        fs = os.statvfs(self.path)
        return {"logical_bytes": logical, "allocated_bytes": allocated,
                "future_growth_bytes": future, "available_bytes": fs.f_bavail * fs.f_frsize}

    def allocate(self, tag, unit, size, cap, floor):
        if not UNIT.fullmatch(unit) or not unit.startswith("m2-" + tag + "-"):
            raise ValueError("unit does not match pad tag")
        if size <= 0 or cap <= 0 or floor <= 0 or size > cap:
            raise ValueError("invalid pad size, cap or disk headroom")
        with self.locked():
            states = unit_states()
            if unit not in states or states[unit]["MainPID"] != str(os.getpid()):
                raise RuntimeError("allocation must run as the VM service's main process")
            self.reap_locked(states)
            p = self.file(tag)
            if os.path.lexists(p) or os.path.lexists(self.metadata(tag)):
                raise FileExistsError(f"pad already exists: {p.name}; refusing replacement")
            usage = self.usage()
            if usage["logical_bytes"] + size > cap:
                raise RuntimeError("pad storage cap exceeded (counts full logical sizes)")
            needed = size + usage["future_growth_bytes"] + floor + SLACK
            if usage["available_bytes"] < needed:
                raise RuntimeError(f"pad admission denied: need {needed} available bytes including disk headroom")
            r = {"version": 1, "tag": tag, "unit": unit, "size": size, "inode": None}
            self.write_record(tag, r)  # Durable intent BEFORE creating the pad.
            created = False
            try:
                fd = os.open(p, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                created = True
                try:
                    s = os.fstat(fd)
                    r["inode"] = [s.st_dev, s.st_ino]
                    self.write_record(tag, r)
                    # No sparse fallback: reserve all blocks before QEMU starts.
                    reserve_blocks(fd, size)
                    os.fsync(fd)
                    if os.fstat(fd).st_blocks * 512 < size:
                        raise RuntimeError("filesystem did not reserve the complete pad")
                finally:
                    os.close(fd)
                after = self.usage()
                if after["available_bytes"] < floor + after["future_growth_bytes"] + SLACK:
                    raise RuntimeError("disk headroom changed during pad allocation")
            except BaseException:
                if created:
                    self.remove(tag, r)
                else:
                    self.metadata(tag).unlink(missing_ok=True)
                    self.sync_dir()
                raise
            print(f"pad-bank: reserved {size} bytes for {unit}; cap={cap} headroom={floor}", file=sys.stderr)
            return p

    def adopt(self, tag, unit, cap, floor):
        """One-time upgrade of a live legacy pad; never removes or rewrites it."""
        if not UNIT.fullmatch(unit) or not unit.startswith("m2-" + tag + "-"):
            raise ValueError("unit does not match pad tag")
        if cap <= 0 or floor <= 0:
            raise ValueError("invalid cap or disk headroom")
        with self.locked():
            states = unit_states()
            row = states.get(unit)
            if not row or row["ActiveState"] != "active":
                raise RuntimeError("adoption requires an active VM service")
            self.reap_locked(states)
            p = self.file(tag)
            s = self.regular(p)
            identity = (s.st_dev, s.st_ino)
            if s.st_size <= 0 or not process_holds(row["MainPID"], identity):
                raise RuntimeError("VM main process does not hold this pad inode open")
            if os.path.lexists(self.metadata(tag)):
                r = self.read_record(tag)
                if r["unit"] != unit or r.get("inode") != list(identity):
                    raise RuntimeError("existing pad ownership does not match")
            usage = self.usage()
            if usage["logical_bytes"] > cap:
                raise RuntimeError("existing pads exceed storage cap")
            if usage["available_bytes"] < usage["future_growth_bytes"] + floor + SLACK:
                raise RuntimeError("insufficient headroom to reserve existing pads")
            fd = os.open(p, os.O_RDWR | os.O_NOFOLLOW)
            try:
                opened = os.fstat(fd)
                if (opened.st_dev, opened.st_ino, opened.st_size) != (*identity, s.st_size):
                    raise RuntimeError("pad changed during adoption")
                r = {"version": 1, "tag": tag, "unit": unit, "size": s.st_size,
                     "inode": list(identity)}
                self.write_record(tag, r)
                # Linux fallocate reserves holes without modifying written data.
                # On failure keep the live pad intact; the ownership record still
                # permits cleanup when the VM eventually exits.
                reserve_blocks(fd, s.st_size)
                os.fsync(fd)
                if os.fstat(fd).st_blocks * 512 < s.st_size:
                    raise RuntimeError("filesystem did not reserve the complete existing pad")
            finally:
                os.close(fd)
            after = self.usage()
            if after["available_bytes"] < after["future_growth_bytes"] + floor + SLACK:
                raise RuntimeError("disk headroom changed during adoption; live pad preserved")
            print(f"pad-bank: adopted and reserved {s.st_size} bytes for {unit}", file=sys.stderr)


def systemd_quote(value):
    # ':' command prefix disables environment expansion; '%' still needs escaping.
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'


def notify_ready():
    address = os.environ.get("NOTIFY_SOCKET")
    if not address:
        raise RuntimeError("pad service must use Type=notify")
    if address.startswith("@"):
        address = "\0" + address[1:]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as s:
        s.connect(address)
        s.sendall(b"READY=1\nSTATUS=Pad blocks reserved; starting VM")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("action", choices=("run", "adopt", "reap", "status", "stop-command", "reaper-command"))
    p.add_argument("--directory", required=True)
    p.add_argument("--tag")
    p.add_argument("--unit")
    p.add_argument("--stopping-unit")
    p.add_argument("--gib", type=int)
    p.add_argument("--max-gib", type=int, default=704)
    p.add_argument("--reserve-gib", type=int, default=100)
    argv = sys.argv[1:]
    command = []
    if "--" in argv:
        split = argv.index("--")
        command, argv = argv[split + 1:], argv[:split]
    a = p.parse_args(argv)
    if a.action in ("stop-command", "reaper-command"):
        if a.action == "stop-command" and (not a.unit or not UNIT.fullmatch(a.unit)):
            p.error("--unit is required")
        command = [sys.executable, str(Path(__file__).resolve()), "reap", "--directory", a.directory]
        if a.action == "stop-command":
            command += ["--stopping-unit", a.unit]
        print(":" + " ".join(systemd_quote(s) for s in command))
        return
    bank = Bank(a.directory)
    if a.action == "run":
        if not a.tag or not a.unit or a.gib is None or not command:
            p.error("run requires --tag, --unit, --gib and -- command")
        bank.allocate(a.tag, a.unit, a.gib * GIB, a.max_gib * GIB, a.reserve_gib * GIB)
        # Let run-domain begin its QMP deadline only AFTER disk reservation.
        notify_ready()
        os.execvp(command[0], command)
    elif a.action == "adopt":
        if not a.tag or not a.unit:
            p.error("adopt requires --tag and --unit")
        bank.adopt(a.tag, a.unit, a.max_gib * GIB, a.reserve_gib * GIB)
    elif a.action == "reap":
        with bank.locked():
            bank.reap_locked(unit_states(), a.stopping_unit)
    else:
        with bank.locked():
            print(json.dumps(dict(bank.usage(), cap_bytes=a.max_gib * GIB,
                                  reserve_bytes=a.reserve_gib * GIB), sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"pad-bank: {e}", file=sys.stderr)
        sys.exit(1)
