#!/usr/bin/env python3
"""Switch the running enclave-guestd manager to EyesOff release 1da34434 (bounded source retirement) without
stopping any guest.

The argv changes are the -shield-template / -shield-release values (af50d526 -> 1da34434) and, only
if -adopt-runtimes does not already map af50d526, one appended entry
af50d526...=<old template>/rt/runtime.json so the running af50d526 guest stays adoptable; all prior
-adopt-runtimes entries are kept exactly.  A conflicting, repeated or malformed mapping refuses.
Every other argument and the unit environment stay as they are now (pad bank, floors, ...).

Dry run (default) only reads: systemd properties, /proc of the manager and the two QEMUs, the
drop-in directory, both release.json hashes and stat data of the instance directory and pad.  It
prints a plan.  --execute requires --reviewed-plan (that plan, unchanged) and then:
current + candidate -adopt-check, private preservation, a pidfd SIGSTOP hold of the control QEMU
guarded by a watchdog subprocess, one new drop-in, daemon-reload, restart, verification.  On any
failure it removes only its own drop-in, reloads, restarts the original if it had restarted, and
always resumes the control QEMU.  It never stops a guest.  See SWITCH-MANAGER.md.

Exit codes: 0 ok, 1 refused (production untouched), 2 usage, 3 failed and rolled back,
4 rollback incomplete (manual action needed).
"""
import argparse
import dataclasses
import hashlib
import json
import os
import re
import select
import signal
import socket
import stat
import subprocess
import sys
import time
from pathlib import Path

UNIT = "enclave-guestd.service"
DROPIN_DIR = Path("/home/steven/.config/systemd/user/enclave-guestd.service.d")
DROPIN_NAME = "zzzzzzzzz-retire-budget-20261028.conf"
OLD_TEMPLATE = "/home/steven/enclave-prod/release-af50d526/template"
OLD_RELEASE = "af50d526be6deefcdd815968ff1dd2c04327f6c3b3f981c0aa90cc585b0effae"
NEW_TEMPLATE = "/home/steven/enclave-prod/release-1da34434/template"
NEW_RELEASE = "1da344346ffe01df7695059bf4c27a5ef48ea6dc5cad11f6893683c71e5933f7"
GUEST = "gdc03538eb"
INSTANCE_DIR = Path("/home/steven/enclave-prod/guestd-root") / GUEST
CONTROL_PID = 3967858
GUEST_QEMU_PID = 112924
EXPECT_ARGV = Path(__file__).resolve().parent / "manager-argv-before.json"

HARDLINK = {"guest.cpio.gz"}  # big public file: same inode, checked stable, never copied
COPY_CAP = 256 << 20
CHUNK = 1 << 20
ADOPT_TIMEOUT = 60
SYSTEMCTL_TIMEOUT = 15
HOLD_LIMIT = 60.0      # watchdog resumes the control QEMU after this, whatever the parent does
FORWARD_BUDGET = 45.0  # SIGSTOP -> verified new manager; leaves the rest of the hold for rollback
DRAIN = 0.5

# Set by systemd per invocation; everything else in the manager environment must be identical.
VOLATILE_ENV = frozenset({
    "INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID", "MAINPID", "MANAGERPID", "NOTIFY_SOCKET",
    "WATCHDOG_PID", "WATCHDOG_USEC", "LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES",
})
# Unit properties a drop-in that only resets ExecStart must leave unchanged.
STABLE_PROPS = (
    "Environment", "EnvironmentFiles", "UnsetEnvironment", "PassEnvironment", "WorkingDirectory",
    "Type", "Restart", "KillMode", "TimeoutStopUSec", "LimitMEMLOCK", "LimitNOFILE", "MemoryMax",
    "MemoryHigh", "Slice", "Delegate", "OOMPolicy",
)


class Refuse(Exception):
    """Preflight refusal: no drop-in written, no signal sent, no restart."""


class SwitchFailed(Exception):
    """Mutation started, failed, and was rolled back."""


class RollbackIncomplete(Exception):
    """Rollback itself failed; the message says what is left."""


class _Pending(Exception):
    """Not ready yet; retry until the deadline."""


def preserve_names(guest):
    return ("instance.json", "app.bundle", "guest.cpio.gz", f"{guest}.serial", "doc.json", "verify.txt")


def live_names(guest):
    return {f"{guest}.serial"}  # appended by the running guest: snapshot, not required to be stable


@dataclasses.dataclass
class Config:
    expect_argv: Path = EXPECT_ARGV
    dropin_dir: Path = DROPIN_DIR
    dropin_name: str = DROPIN_NAME
    old_template: str = OLD_TEMPLATE
    old_release: str = OLD_RELEASE
    new_template: str = NEW_TEMPLATE
    new_release: str = NEW_RELEASE
    guest: str = GUEST
    instance_dir: Path = INSTANCE_DIR
    control_pid: int = CONTROL_PID
    guest_qemu_pid: int = GUEST_QEMU_PID
    recovery_dir: Path | None = None
    pad_recovery_dir: Path | None = None
    hold_limit: float = HOLD_LIMIT


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha256_file(path, nofollow=True):
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | (os.O_NOFOLLOW if nofollow else 0))
    try:
        h = hashlib.sha256()
        while b := os.read(fd, CHUNK):
            h.update(b)
        return h.hexdigest()
    finally:
        os.close(fd)


# ---- pure logic -------------------------------------------------------------------------------

def value_index(argv, flag):
    """Index of the value of the only '{flag} VALUE' (Go flag: -f, --f, -f=, --f= all count)."""
    forms = (flag, "-" + flag)
    hits = [i for i, a in enumerate(argv) if a in forms or a.startswith(tuple(f + "=" for f in forms))]
    if len(hits) != 1 or argv[hits[0]] != flag or hits[0] + 1 >= len(argv):
        raise Refuse(f"{flag}: need exactly one '{flag} VALUE', found {[argv[i] for i in hits]}")
    return hits[0] + 1


_ADOPT_ENTRY = re.compile(r"([0-9a-f]{64})=(/[^,\s]+)\Z")


def runtime_path(template):
    return f"{template}/rt/runtime.json"


def parse_adopt_runtimes(value):
    """-adopt-runtimes 'RELEASE=PATH,...' -> [(release, path)]; malformed or repeated release refuses."""
    entries, seen = [], set()
    for e in value.split(","):
        m = _ADOPT_ENTRY.match(e)
        if not m:
            raise Refuse(f"-adopt-runtimes entry {e[:100]!r} is not RELEASE=/PATH")
        if m[1] in seen:
            raise Refuse(f"-adopt-runtimes maps release {m[1]} more than once")
        seen.add(m[1])
        entries.append((m[1], m[2]))
    return entries


def mutate_argv(argv, cfg):
    """Return (candidate, changes). The -shield-template/-shield-release values change; the
    -adopt-runtimes value changes only if it lacks the old release, and then only by appending
    ',OLD_RELEASE=OLD_TEMPLATE/rt/runtime.json' (every prior entry kept byte for byte, in order),
    so the running old-release guest stays adoptable once the old template is no longer current.
    Anything else refuses."""
    out = list(argv)
    changes = []
    for flag, old, new in (("-shield-template", cfg.old_template, cfg.new_template),
                           ("-shield-release", cfg.old_release, cfg.new_release)):
        i = value_index(argv, flag)
        if argv[i] != old:
            raise Refuse(f"{flag} is {argv[i]!r}, expected {old!r}")
        out[i] = new
        changes.append({"index": i, "flag": flag, "old": old, "new": new})
    i = value_index(argv, "-adopt-runtimes")
    mapped = dict(parse_adopt_runtimes(argv[i]))
    for release, template in ((cfg.old_release, cfg.old_template), (cfg.new_release, cfg.new_template)):
        if release in mapped and mapped[release] != runtime_path(template):
            raise Refuse(f"-adopt-runtimes maps {release} to {mapped[release]!r}, expected {runtime_path(template)!r}")
    if cfg.old_release not in mapped:
        entry = f"{cfg.old_release}={runtime_path(cfg.old_template)}"
        out[i] = argv[i] + "," + entry
        changes.append({"index": i, "flag": "-adopt-runtimes", "appended": entry, "kept_entries": len(mapped)})
        if parse_adopt_runtimes(out[i])[:-1] != parse_adopt_runtimes(argv[i]) or not out[i].startswith(argv[i] + ","):
            raise Refuse("internal: -adopt-runtimes delta is not exactly one appended entry")
    diff = [i for i, (a, b) in enumerate(zip(argv, out)) if a != b]
    if len(out) != len(argv) or diff != sorted(c["index"] for c in changes):
        raise Refuse("internal: argv delta is not exactly the planned values")
    return out, changes


_SAFE_EXE = re.compile(r"/[A-Za-z0-9._/+-]+\Z")


def systemd_quote(arg):
    """One ExecStart word. systemd (not a shell) expands %specifiers on the line, C-unescapes inside
    double quotes and expands $VAR per word, so escape \\ " % $; refuse what cannot be expressed."""
    if not arg or arg == ";" or any(ord(c) < 0x20 or ord(c) == 0x7F for c in arg):
        raise Refuse(f"argument not representable in ExecStart: {arg!r}")
    return '"' + arg.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$") + '"'


def render_exec(argv):
    if not _SAFE_EXE.match(argv[0]):
        raise Refuse(f"executable path needs no quoting or prefix: {argv[0]!r}")
    return " ".join([argv[0]] + [systemd_quote(a) for a in argv[1:]])


def systemd_split(value):
    """Inverse of render_exec for the subset it emits (self-check and tests)."""
    spec = []
    it = iter(value)
    for c in it:
        if c == "%":
            if next(it, None) != "%":
                raise ValueError("specifier")
            spec.append("%")
        else:
            spec.append(c)
    s = "".join(spec)
    words, cur, i, inq, have = [], [], 0, False, False
    while i < len(s):
        c = s[i]
        if inq:
            if c == "\\":
                if i + 1 >= len(s) or s[i + 1] not in '\\"':
                    raise ValueError("escape")
                cur.append(s[i + 1])
                i += 1
            elif c == '"':
                inq = False
            else:
                cur.append(c)
        elif c == '"':
            inq = have = True
        elif c in " \t":
            if have:
                words.append("".join(cur))
            cur, have = [], False
        elif c in "\\'":
            raise ValueError("unquoted escape")
        else:
            cur.append(c)
            have = True
        i += 1
    if inq:
        raise ValueError("unterminated quote")
    if have:
        words.append("".join(cur))
    out = []
    for w in words:
        if "$" in w.replace("$$", ""):
            raise ValueError("environment expansion")
        out.append(w.replace("$$", "$"))
    return out


def render_dropin(argv, changes, cfg):
    adopt = [c for c in changes if c["flag"] == "-adopt-runtimes"]
    return ("# Written by safe_manager_switch.py. Running enclave-guestd argv with ONLY\n"
            f"# -shield-template {cfg.new_template}\n"
            f"# -shield-release {cfg.new_release}\n"
            + "".join(f"# -adopt-runtimes: all {c['kept_entries']} prior entries unchanged, appended {c['appended']}\n"
                      for c in adopt)
            + ("" if adopt else "# -adopt-runtimes unchanged (already maps the old release)\n")
            + "# Rollback: remove this file, systemctl --user daemon-reload, "
            "systemctl --user restart enclave-guestd.service\n"
            "[Service]\nExecStart=\nExecStart=" + render_exec(argv) + "\n")


_DROPIN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._@-]*\.conf\Z")


def check_dropin_name(name, existing):
    """systemd applies drop-ins in strcmp order of file name across all drop-in dirs."""
    if not _DROPIN.match(name):
        raise Refuse(f"bad drop-in name {name!r}")
    if name in existing:
        raise Refuse(f"drop-in {name} already exists")
    later = sorted(e for e in existing if e.encode() >= name.encode())
    if later:
        raise Refuse(f"drop-in {name} would not be applied last; these sort after it: {later}")


def parse_stat(text):
    rest = text[text.rindex(")") + 2:].split()
    return rest[0], int(rest[19])  # field 3 state, field 22 starttime


def parse_environ(raw):
    env = {}
    for e in raw.split(b"\0"):
        if b"=" in e:
            k, v = e.split(b"=", 1)
            env[os.fsdecode(k)] = os.fsdecode(v)
    return env


def env_diff(a, b):
    return sorted(k for k in (set(a) | set(b)) - VOLATILE_ENV if a.get(k) != b.get(k))


_ADOPT_OK = re.compile(r"\bADOPT OK (\S+)")


def adopt_verdict(lines):
    """(guests with ADOPT OK, other ADOPT lines)."""
    ok = {m.group(1) for line in lines if (m := _ADOPT_OK.search(line))}
    bad = [line for line in lines if re.search(r"\bADOPT\b", line) and not _ADOPT_OK.search(line)]
    return ok, bad


def boot_adopt_verdict(lines):
    """Normal startup uses a summary, unlike the read-only -adopt-check output."""
    guests=set();bad=[]
    for line in lines:
        m=re.search(r"adopted (\d+) guest\(s\) a previous guestd left, each verified again as the same guest: \[(.*?)\]",line)
        if m:
            names=m[2].split()
            if len(names)!=int(m[1]) or len(set(names))!=len(names):bad.append(line)
            else:guests.update(names)
        elif 'not adopted, ended:' in line or re.search(r'stopped \d+ guest unit',line):bad.append(line)
    return guests,bad


def parse_show(text):
    return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)


def show_exec_argv(value):
    m = re.findall(r"argv\[\]=(.*?) ; ignore_errors=", value)
    if len(m) != 1:
        raise Refuse(f"unit has {len(m)} ExecStart commands, expected 1")
    return m[0]


def flag_value(argv, flag):
    hits = [i for i, a in enumerate(argv) if a == flag]
    if len(hits) != 1 or hits[0] + 1 >= len(argv):
        raise Refuse(f"need exactly one {flag}")
    return argv[hits[0] + 1]


# ---- host access (replaced by a fake in tests) ------------------------------------------------

class Host:
    def run(self, argv, timeout, env=None):
        p = subprocess.run(argv, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, timeout=timeout)
        return p.returncode, p.stdout.decode("utf-8", "replace")

    def proc_read(self, pid, name):
        return Path(f"/proc/{pid}/{name}").read_bytes()

    def proc_exe(self, pid):
        return os.readlink(f"/proc/{pid}/exe")

    def sha256_path(self, path):
        return sha256_file(path, nofollow=False)

    def pidfd_open(self, pid):
        return os.pidfd_open(pid)

    def pidfd_signal(self, fd, sig):
        signal.pidfd_send_signal(fd, sig)

    def close_fd(self, fd):
        os.close(fd)

    def connect(self, host, port, timeout):
        socket.create_connection((host, port), timeout=timeout).close()

    def sleep(self, s):
        time.sleep(s)

    def monotonic(self):
        return time.monotonic()

    def euid(self):
        return os.geteuid()

    def spawn_watchdog(self, pidfd, limit):
        return Watchdog.arm(pidfd, limit)


WATCHDOG_SRC = r"""
import os, select, signal, sys, time
pidfd, rfd, limit = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3])
for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGPIPE, signal.SIGQUIT):
    signal.signal(s, signal.SIG_IGN)
end = time.monotonic() + limit
os.write(1, b"armed\n")
why = "deadline"
while (left := end - time.monotonic()) > 0:
    if select.select([rfd], [], [], left)[0]:
        why = "released" if os.read(rfd, 16) else "parent-gone"
        break
try:
    signal.pidfd_send_signal(pidfd, signal.SIGCONT)
    res = "sent"
except ProcessLookupError:
    res = "gone"
try:
    os.write(1, f"{why} sigcont={res}\n".encode())
except OSError:
    pass
"""


class Watchdog:
    """Separate process holding a dup of the control pidfd. It sends SIGCONT when released, when
    the parent dies (pipe EOF), or after `limit` seconds, whichever is first. Own session, so a
    terminal ^C does not reach it. SIGKILL of the watchdog itself cannot be prevented."""

    def __init__(self, proc, wfd):
        self.proc, self.wfd, self.result = proc, wfd, None

    @classmethod
    def arm(cls, pidfd, limit, arm_timeout=5.0):
        r, w = os.pipe()
        try:
            p = subprocess.Popen([sys.executable, "-I", "-S", "-c", WATCHDOG_SRC, str(pidfd), str(r), str(limit)],
                                 pass_fds=(pidfd, r), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, start_new_session=True)
        except BaseException:
            os.close(w)
            raise
        finally:
            os.close(r)
        if select.select([p.stdout], [], [], arm_timeout)[0] and p.stdout.readline() == b"armed\n":
            return cls(p, w)
        p.kill()
        p.wait()
        os.close(w)
        raise Refuse("watchdog did not arm")

    def release(self):
        try:
            os.write(self.wfd, b"done")
        except OSError:
            pass
        os.close(self.wfd)
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            pass  # it still resumes the control QEMU at its deadline
        self.result = self.proc.stdout.read().decode(errors="replace").strip() if self.proc.returncode is not None else "running"
        self.proc.stdout.close()
        return self.result


# ---- identities -------------------------------------------------------------------------------

@dataclasses.dataclass(frozen=True)
class Ident:
    pid: int
    start: int
    uid: int
    state: str
    argv0: str
    name: str
    cmdline_sha256: str

    def pin(self):
        return {"pid": self.pid, "start": self.start, "uid": self.uid, "argv0": self.argv0,
                "name": self.name, "cmdline_sha256": self.cmdline_sha256}


def read_ident(host, pid):
    cmd = host.proc_read(pid, "cmdline")
    if not cmd:
        raise Refuse(f"pid {pid} has no cmdline")
    argv = cmd.rstrip(b"\0").split(b"\0")
    name = argv[argv.index(b"-name") + 1].decode(errors="replace")[:120] if b"-name" in argv[:-1] else ""
    state, start = parse_stat(host.proc_read(pid, "stat").decode(errors="replace"))
    uid = next(int(l.split()[1]) for l in host.proc_read(pid, "status").decode().splitlines() if l.startswith("Uid:"))
    return Ident(pid, start, uid, state, os.fsdecode(argv[0]), name, sha256_bytes(cmd))


def read_argv(host, pid):
    return [os.fsdecode(a) for a in host.proc_read(pid, "cmdline").rstrip(b"\0").split(b"\0")]


def open_pidfd(host, ident):
    """pidfd for exactly `ident`: identity re-read after opening, so a reused PID is refused."""
    fd = host.pidfd_open(ident.pid)
    try:
        if read_ident(host, ident.pid).pin() != ident.pin():
            raise Refuse(f"pid {ident.pid} changed identity while opening pidfd")
        host.pidfd_signal(fd, 0)
    except BaseException:
        host.close_fd(fd)
        raise
    return fd


def check_alive(host, fd, ident, what):
    try:
        host.pidfd_signal(fd, 0)
        now = read_ident(host, ident.pid)
    except (ProcessLookupError, FileNotFoundError):
        raise SwitchFailed(f"{what} QEMU {ident.pid} is gone")
    if now.pin() != ident.pin():
        raise SwitchFailed(f"{what} QEMU {ident.pid} identity changed")
    return now


def check_qemu(host, ident, what):
    if not os.path.basename(ident.argv0).startswith("qemu-system"):
        raise Refuse(f"{what} pid {ident.pid} is {ident.argv0!r}, not QEMU")
    if ident.state in "Tt":
        raise Refuse(f"{what} pid {ident.pid} is already stopped (state {ident.state}); someone else holds it")
    if ident.uid != host.euid():
        raise Refuse(f"{what} pid {ident.pid} uid {ident.uid} != euid {host.euid()}")


# ---- systemd ----------------------------------------------------------------------------------

def systemctl(host, *args):
    try:
        rc, out = host.run(["systemctl", "--user", *args], timeout=SYSTEMCTL_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise SwitchFailed(f"systemctl {' '.join(args[:2])} timed out")
    if rc != 0:
        raise SwitchFailed(f"systemctl {' '.join(args[:2])} rc={rc}")
    return out


def show_unit(host, props):
    try:
        out = systemctl(host, "show", UNIT, *[x for p in props for x in ("-p", p)])
    except SwitchFailed as e:
        raise Refuse(str(e))
    s = parse_show(out)
    if "EnvironmentFiles" in props:
        s.setdefault("EnvironmentFiles", "")
    missing = [p for p in props if p not in s]
    if missing:
        raise Refuse(f"systemctl show lacks {missing}")
    return s


def journal_lines(host, *match, n=5000):
    try:
        rc, out = host.run(["journalctl", "--user", *match, "-o", "cat", "--no-pager", "-n", str(n)], timeout=20)
    except subprocess.TimeoutExpired:
        raise _Pending("journalctl timed out")
    if rc != 0:
        raise _Pending(f"journalctl rc={rc}")
    return out.splitlines()


# ---- preflight --------------------------------------------------------------------------------

@dataclasses.dataclass
class Ctx:
    mpid: int
    mident: Ident
    argv: list
    candidate: list
    env: dict
    adopt_env: dict
    exe_sha256: str
    props: dict
    dropin_paths: list
    dropin_path: Path
    dropin_text: str
    control: Ident
    guest_qemu: Ident
    listen: list
    items: list
    pad: dict
    control_fd: int | None = None
    guest_fd: int | None = None
    host: object = None

    def close(self):
        for a in ("control_fd", "guest_fd"):
            if getattr(self, a) is not None:
                self.host.close_fd(getattr(self, a))
                setattr(self, a, None)


def check_release(template, release_id, runtime=False):
    """runtime: also require template/rt/runtime.json (the -adopt-runtimes target) as a regular file."""
    t = Path(template)
    if os.path.realpath(t) != str(t) or not t.is_dir():
        raise Refuse(f"{t} is not a real directory")
    rj = t.parent / "release.json"
    if not stat.S_ISREG(os.lstat(rj).st_mode) or sha256_file(rj) != release_id:
        raise Refuse(f"{rj} does not hash to {release_id}")
    if runtime:
        rt = runtime_path(t)
        if not os.path.lexists(rt) or os.path.realpath(rt) != rt or not stat.S_ISREG(os.lstat(rt).st_mode):
            raise Refuse(f"{rt} is not a regular file inside the template")


def private_parent(p, euid):
    parent = p.parent
    st = os.lstat(parent)
    if os.path.lexists(p):
        raise Refuse(f"{p} already exists")
    if not stat.S_ISDIR(st.st_mode) or os.path.realpath(parent) != str(parent) or st.st_uid != euid:
        raise Refuse(f"{parent} must be a real directory owned by uid {euid}")
    return st.st_dev


def inspect_items(cfg):
    items = []
    for name in preserve_names(cfg.guest):
        st = os.lstat(cfg.instance_dir / name)
        if not stat.S_ISREG(st.st_mode):
            raise Refuse(f"{name} is not a regular file")
        mode = "hardlink" if name in HARDLINK else "snapshot" if name in live_names(cfg.guest) else "copy"
        if mode != "hardlink" and st.st_size > COPY_CAP:
            raise Refuse(f"{name} is {st.st_size} bytes, over the {COPY_CAP} copy cap")
        items.append({"name": name, "mode": mode, "dev": st.st_dev, "ino": st.st_ino})
    return items


def inspect_pad(cfg, env):
    bank = env.get("SHIELDED_PAD_BANK_DIR")
    if not bank:
        raise Refuse("running manager has no SHIELDED_PAD_BANK_DIR")
    p = Path(bank) / f"{cfg.guest}.padbank"
    lst = os.lstat(p)
    if stat.S_ISLNK(lst.st_mode):
        target, real = os.readlink(p), os.path.realpath(p)
    elif stat.S_ISREG(lst.st_mode):
        target, real = None, str(p)
    else:
        raise Refuse(f"{p} is neither a symlink nor a regular file")
    st = os.lstat(real)
    if not stat.S_ISREG(st.st_mode):
        raise Refuse(f"pad target {real} is not a regular file")
    return {"path": str(p), "symlink_target": target, "real": real, "dev": st.st_dev, "ino": st.st_ino}


def preflight(cfg, host):
    expected = json.loads(cfg.expect_argv.read_text())
    if not (isinstance(expected, list) and expected and all(isinstance(a, str) for a in expected)):
        raise Refuse(f"{cfg.expect_argv} is not a JSON list of strings")
    s = show_unit(host, ("MainPID", "ActiveState", "SubState", "NeedDaemonReload", "DropInPaths", "ExecStart") + STABLE_PROPS)
    if (s["ActiveState"], s["SubState"]) != ("active", "running"):
        raise Refuse(f"{UNIT} is {s['ActiveState']}/{s['SubState']}")
    if s["NeedDaemonReload"] != "no":
        raise Refuse("unit has pending unit-file changes (NeedDaemonReload); reload would apply more than this drop-in")
    mpid = int(s["MainPID"])
    if mpid <= 1:
        raise Refuse(f"MainPID {mpid}")
    mident = read_ident(host, mpid)
    if mident.uid != host.euid():
        raise Refuse(f"run as the manager's user (uid {mident.uid}); euid is {host.euid()}")
    argv = read_argv(host, mpid)
    if argv != expected:
        bad = [i for i in range(max(len(argv), len(expected))) if argv[i:i + 1] != expected[i:i + 1]]
        raise Refuse(f"running manager argv differs from {cfg.expect_argv.name} at indices {bad[:10]}")
    if show_exec_argv(s["ExecStart"]) != " ".join(argv):
        raise Refuse("unit ExecStart differs from the running argv")
    if host.proc_exe(mpid) != argv[0]:
        raise Refuse("manager /proc/exe is not argv[0] (replaced or deleted binary)")
    exe_sha = host.sha256_path(f"/proc/{mpid}/exe")
    if host.sha256_path(argv[0]) != exe_sha:
        raise Refuse("argv[0] on disk differs from the running binary")
    env = parse_environ(host.proc_read(mpid, "environ"))
    candidate, changes = mutate_argv(argv, cfg)
    check_release(cfg.old_template, cfg.old_release, runtime=True)  # the candidate maps it in -adopt-runtimes
    check_release(cfg.new_template, cfg.new_release)
    text = render_dropin(candidate, changes, cfg)
    if systemd_split(text.splitlines()[-1][len("ExecStart="):]) != candidate:
        raise Refuse("internal: ExecStart quoting does not round-trip")
    dropin_paths = s["DropInPaths"].split()
    dd = cfg.dropin_dir
    if os.path.realpath(dd) != str(dd) or not dd.is_dir():
        raise Refuse(f"{dd} is not a real directory")
    check_dropin_name(cfg.dropin_name, set(os.listdir(dd)) | {Path(p).name for p in dropin_paths})
    control = read_ident(host, cfg.control_pid)
    gq = read_ident(host, cfg.guest_qemu_pid)
    check_qemu(host, control, "control")
    check_qemu(host, gq, "guest")
    if cfg.guest.encode() not in host.proc_read(gq.pid, "cmdline"):
        raise Refuse(f"pid {gq.pid} cmdline does not name guest {cfg.guest}")
    if len({mpid, control.pid, gq.pid}) != 3:
        raise Refuse("manager, control and guest PIDs must differ")
    listen = []
    for f in ("-listen", "-data-listen"):
        h, _, port = flag_value(argv, f).rpartition(":")
        listen.append((h, int(port)))
    try:
        ok, _ = adopt_verdict(journal_lines(host, "-u", UNIT, "-g", "ADOPT OK", n=50))
    except _Pending:
        ok = set()  # No historical match is normal; execute requires two fresh adoption checks.
    items = inspect_items(cfg)
    pad = inspect_pad(cfg, env)
    rec = None
    if cfg.recovery_dir:
        rdev = private_parent(cfg.recovery_dir, host.euid())
        if any(i["mode"] == "hardlink" and i["dev"] != rdev for i in items):
            raise Refuse("recovery dir must be on the instance directory's filesystem (hardlinks)")
        pdev = private_parent(cfg.pad_recovery_dir, host.euid()) if cfg.pad_recovery_dir else rdev
        if pdev != pad["dev"]:
            raise Refuse("pad hardlink needs --pad-recovery-dir on the pad's filesystem")
        rec = {"dir": str(cfg.recovery_dir), "pad_dir": str(cfg.pad_recovery_dir or cfg.recovery_dir)}
    adopt_env = {k: v for k, v in env.items() if k not in VOLATILE_ENV}
    adopt_env.setdefault("GUESTD_ENABLE", "1")  # as the historical switch script invoked -adopt-check
    plan = {
        "schema": "safe-manager-switch-plan/1",
        "unit": UNIT,
        "manager": {**mident.pin(), "exe_sha256": exe_sha, "argv_sha256": sha256_bytes(json.dumps(argv).encode())},
        "candidate_argv_sha256": sha256_bytes(json.dumps(candidate).encode()),
        "changes": changes,
        "dropin": {"path": str(dd / cfg.dropin_name), "sha256": sha256_bytes(text.encode()),
                   "existing": [Path(p).name for p in dropin_paths]},
        "control_qemu": control.pin(),
        "guest_qemu": gq.pin(),
        "guest": cfg.guest,
        "releases": {"old": cfg.old_release, "new": cfg.new_release},
        "journal_has_adopt_ok_history": bool(ok),
        "preserve": {"instance_dir": str(cfg.instance_dir), "items": items,
                     "pad": {k: pad[k] for k in ("path", "symlink_target", "real", "dev", "ino")}},
        "recovery": rec,
        "adopt_env_added": sorted(set(adopt_env) - set(env)),
    }
    ctx = Ctx(mpid, mident, argv, candidate, env, adopt_env, exe_sha, {p: s[p] for p in STABLE_PROPS},
              dropin_paths, dd / cfg.dropin_name, text, control, gq, listen, items, pad, host=host)
    return plan, ctx


def run_adopt(host, argv, env, guest):
    try:
        rc, out = host.run(argv + ["-adopt-check"], timeout=ADOPT_TIMEOUT, env=env)
    except subprocess.TimeoutExpired:
        return {"rc": None, "ok": False, "adopt_lines": ["timeout"], "output": ""}
    lines = out.splitlines()
    guests, bad = adopt_verdict(lines)
    return {"rc": rc, "ok": rc == 0 and not bad and guests == {guest},
            "adopt_lines": [l for l in lines if re.search(r"\bADOPT\b", l)][:20], "output": out}


# ---- preservation -----------------------------------------------------------------------------

def fsync_dir(p):
    fd = os.open(p, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def make_private_dir(p, euid):
    os.mkdir(p, 0o700)
    os.chmod(p, 0o700)
    st = os.lstat(p)
    if not stat.S_ISDIR(st.st_mode) or stat.S_IMODE(st.st_mode) != 0o700 or st.st_uid != euid:
        raise Refuse(f"{p} is not a private directory")


def write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        os.fsync(fd)
    finally:
        os.close(fd)


def hardlink_stable(src, dst, dev, ino, live=False):
    a = os.lstat(src)
    if not stat.S_ISREG(a.st_mode) or (a.st_dev, a.st_ino) != (dev, ino):
        raise Refuse(f"{src} is not the planned inode")
    os.link(src, dst, follow_symlinks=False)
    b, c = os.lstat(src), os.lstat(dst)
    if not (a.st_ino == b.st_ino == c.st_ino and a.st_dev == c.st_dev
            and a.st_size == b.st_size and (live or a.st_mtime_ns == b.st_mtime_ns)):
        os.unlink(dst)
        raise Refuse(f"{src} changed while linking")
    return {"mode": "hardlink", "dev": c.st_dev, "ino": c.st_ino, "size": c.st_size,
            "blocks": c.st_blocks, "nlink": c.st_nlink, "mtime_ns": c.st_mtime_ns,
            "live_inode_retained": live, "content_snapshot": False}


def copy_hashed(src, dst, live):
    fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > COPY_CAP:
            raise Refuse(f"{src}: not a regular file under the copy cap")
        h, left = hashlib.sha256(), st.st_size
        out = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            while left:
                b = os.read(fd, min(CHUNK, left))
                if not b:
                    raise Refuse(f"{src} shrank while copying")
                h.update(b)
                view = memoryview(b)
                while view:
                    view = view[os.write(out, view):]
                left -= len(b)
            os.fsync(out)
        finally:
            os.close(out)
        st2 = os.fstat(fd)
        if not live:
            if (st2.st_size, st2.st_mtime_ns) != (st.st_size, st.st_mtime_ns) or sha256_file(src) != h.hexdigest():
                raise Refuse(f"{src} changed while copying")
        return {"mode": "snapshot" if live else "copy", "size": st.st_size, "sha256": h.hexdigest()}
    finally:
        os.close(fd)


def preserve(cfg, ctx, adopt, euid):
    rec = cfg.recovery_dir
    make_private_dir(rec, euid)
    pad_dir = cfg.pad_recovery_dir or rec
    if cfg.pad_recovery_dir:
        make_private_dir(pad_dir, euid)
    manifest = {"schema": "safe-manager-switch-recovery/1", "items": {}}
    for it in ctx.items:
        src, dst = cfg.instance_dir / it["name"], rec / it["name"]
        manifest["items"][it["name"]] = (hardlink_stable(src, dst, it["dev"], it["ino"]) if it["mode"] == "hardlink"
                                         else copy_hashed(src, dst, it["mode"] == "snapshot"))
    pad = ctx.pad
    manifest["pad"] = {"path": pad["path"], "symlink_target": pad["symlink_target"], "real": pad["real"],
                       **hardlink_stable(pad["real"], pad_dir / "pad.target", pad["dev"], pad["ino"], live=True)}
    if pad["symlink_target"] is not None:
        os.symlink(pad["symlink_target"], pad_dir / "pad.symlink")
    for k, r in adopt.items():
        write_private(rec / f"adopt-{k}.out", r["output"].encode())
        manifest[f"adopt_{k}"] = {k2: r[k2] for k2 in ("rc", "ok", "adopt_lines")}
    write_private(rec / "manager-argv.json", json.dumps(ctx.argv, indent=1).encode())
    write_private(rec / "candidate-argv.json", json.dumps(ctx.candidate, indent=1).encode())
    write_private(rec / "dropin.conf", ctx.dropin_text.encode())
    write_private(rec / "recovery.json", json.dumps(manifest, indent=2, sort_keys=True).encode())
    for d in {rec, pad_dir}:
        fsync_dir(d)
    return manifest


# ---- the switch -------------------------------------------------------------------------------

@dataclasses.dataclass(frozen=True)
class Owned:
    dev: int
    ino: int
    sha256: str


def write_dropin(path, text):
    data = text.encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    st = os.fstat(fd)
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        os.fchmod(fd, 0o644)
        os.fsync(fd)
    except BaseException:
        if (os.lstat(path).st_dev, os.lstat(path).st_ino) == (st.st_dev, st.st_ino):
            os.unlink(path)
        raise
    finally:
        os.close(fd)
    fsync_dir(path.parent)
    return Owned(st.st_dev, st.st_ino, sha256_bytes(data))


def remove_owned(path, owned):
    st = os.lstat(path)
    if (st.st_dev, st.st_ino) != (owned.dev, owned.ino) or sha256_file(path) != owned.sha256:
        raise RollbackIncomplete(f"{path} is no longer the file this run wrote; not removed")
    os.unlink(path)
    fsync_dir(path.parent)


def reverify(host, ctx):
    s = show_unit(host, ("MainPID", "NeedDaemonReload"))
    if int(s["MainPID"]) != ctx.mpid or s["NeedDaemonReload"] != "no":
        raise Refuse("manager or unit changed since preflight")
    if read_ident(host, ctx.mpid).pin() != ctx.mident.pin():
        raise Refuse("manager identity changed since preflight")
    for fd, ident, what in ((ctx.control_fd, ctx.control, "control"), (ctx.guest_fd, ctx.guest_qemu, "guest")):
        try:
            if check_alive(host, fd, ident, what).state in "Tt":
                raise Refuse(f"{what} QEMU is stopped by someone else")
        except SwitchFailed as e:
            raise Refuse(str(e))


def verify_reloaded(host, ctx):
    s = show_unit(host, ("MainPID", "NeedDaemonReload", "DropInPaths", "ExecStart") + STABLE_PROPS)
    if s["NeedDaemonReload"] != "no":
        raise SwitchFailed("NeedDaemonReload after reload")
    if s["DropInPaths"].split() != ctx.dropin_paths + [str(ctx.dropin_path)]:
        raise SwitchFailed("systemd does not apply the new drop-in last")
    if show_exec_argv(s["ExecStart"]) != " ".join(ctx.candidate):
        raise SwitchFailed("systemd's ExecStart is not the candidate argv")
    changed = [p for p in STABLE_PROPS if s[p] != ctx.props[p]]
    if changed:
        raise SwitchFailed(f"unit properties changed: {changed}")
    if int(s["MainPID"]) != ctx.mpid:
        raise SwitchFailed("manager restarted underneath")


def wait_manager(cfg, host, ctx, argv, deadline, check_adopt):
    while True:
        try:
            s = show_unit(host, ("MainPID", "ActiveState"))
            pid = int(s["MainPID"])
            if s["ActiveState"] == "failed":
                raise SwitchFailed(f"{UNIT} failed")
            if s["ActiveState"] != "active" or pid <= 1 or pid == ctx.mpid:
                raise _Pending("not started")
            try:
                got = read_argv(host, pid)
            except FileNotFoundError:
                raise _Pending("pid gone")
            if got != argv:
                raise _Pending(f"manager {pid} has not yet execed the expected argv")
            for h, port in ctx.listen:
                try:
                    host.connect(h, port, 1)
                except OSError:
                    raise _Pending(f"{h}:{port} not accepting")
            if check_adopt:
                guests, bad = boot_adopt_verdict(journal_lines(host, f"_PID={pid}"))
                if bad or guests - {cfg.guest}:
                    raise SwitchFailed(f"adoption log: unexpected {bad[:3] or sorted(guests)}")
                if guests != {cfg.guest}:
                    raise _Pending("no ADOPT OK yet")
            return pid
        except _Pending as e:
            if host.monotonic() > deadline:
                raise SwitchFailed(f"timeout waiting for manager: {e}")
            host.sleep(0.2)


def verify_switched(cfg, host, ctx, deadline):
    pid = wait_manager(cfg, host, ctx, ctx.candidate, deadline, True)
    if host.sha256_path(f"/proc/{pid}/exe") != ctx.exe_sha256:
        raise SwitchFailed("new manager binary hash differs")
    diff = env_diff(ctx.env, parse_environ(host.proc_read(pid, "environ")))
    if diff:
        raise SwitchFailed(f"manager environment differs in {diff}")
    check_alive(host, ctx.guest_fd, ctx.guest_qemu, "guest")
    check_alive(host, ctx.control_fd, ctx.control, "control")
    return pid


def rollback(cfg, host, ctx, owned, restarted, out):
    if owned is not None:
        remove_owned(ctx.dropin_path, owned)
        try:
            systemctl(host, "daemon-reload")
            s = show_unit(host, ("DropInPaths", "ExecStart"))
        except (SwitchFailed, Refuse) as e:
            raise RollbackIncomplete(f"drop-in removed but reload failed: {e}")
        if s["DropInPaths"].split() != ctx.dropin_paths or show_exec_argv(s["ExecStart"]) != " ".join(ctx.argv):
            raise RollbackIncomplete("drop-in removed but systemd does not show the original ExecStart")
    if restarted:
        try:
            systemctl(host, "restart", UNIT)
            pid = wait_manager(cfg, host, ctx, ctx.argv, host.monotonic() + 30, False)
        except (SwitchFailed, Refuse) as e:
            raise RollbackIncomplete(f"original configuration restored but restart not verified: {e}")
        out(f"rollback: original manager running as pid {pid}")
    elif int(show_unit(host, ("MainPID",))["MainPID"]) != ctx.mpid:
        raise RollbackIncomplete("manager PID changed although this run did not restart it")
    else:
        out(f"rollback: original manager pid {ctx.mpid} untouched")


def hold_and_switch(cfg, host, ctx, out):
    reverify(host, ctx)
    wd = host.spawn_watchdog(ctx.control_fd, cfg.hold_limit)
    owned, restarted = None, False
    try:
        host.pidfd_signal(ctx.control_fd, signal.SIGSTOP)
        t0 = host.monotonic()
        out(f"control QEMU {ctx.control.pid} held (watchdog {cfg.hold_limit:.0f}s)")
        host.sleep(DRAIN)
        owned = write_dropin(ctx.dropin_path, ctx.dropin_text)
        systemctl(host, "daemon-reload")
        verify_reloaded(host, ctx)
        restarted = True  # set before the call: a timed-out restart may still have happened
        systemctl(host, "restart", UNIT)
        pid = verify_switched(cfg, host, ctx, t0 + FORWARD_BUDGET)
        out(f"manager {pid} runs {cfg.new_release[:8]}, ADOPT OK {cfg.guest}, guest QEMU {ctx.guest_qemu.pid} unchanged")
        return pid
    except BaseException as e:
        out(f"FAILED: {e!r}; rolling back (owned drop-in: {owned is not None}, restarted: {restarted})")
        try:
            rollback(cfg, host, ctx, owned, restarted, out)
        except RollbackIncomplete:
            raise
        except BaseException as r:
            raise RollbackIncomplete(f"rollback raised {r!r}") from e
        raise SwitchFailed(repr(e)) from e
    finally:
        try:
            host.pidfd_signal(ctx.control_fd, signal.SIGCONT)
            out(f"control QEMU {ctx.control.pid} resumed")
        except ProcessLookupError:
            out(f"control QEMU {ctx.control.pid} is gone at resume")
        finally:
            out(f"watchdog: {wd.release()}")


def load_reviewed(path, euid):
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != euid or st.st_mode & 0o022 or st.st_size > 1 << 20:
        raise Refuse(f"{path}: reviewed plan must be a regular file of yours, not group/world-writable")
    return json.loads(Path(path).read_text())


def plan_diff(a, b):
    return sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))


def execute(cfg, host, reviewed, out):
    plan, ctx = preflight(cfg, host)
    try:
        if plan != reviewed:
            raise Refuse(f"live state differs from the reviewed plan in {plan_diff(plan, reviewed)}")
        if cfg.recovery_dir is None:
            raise Refuse("--recovery-dir is required")
        ctx.control_fd = open_pidfd(host, ctx.control)
        ctx.guest_fd = open_pidfd(host, ctx.guest_qemu)
        adopt = {k: run_adopt(host, a, ctx.adopt_env, cfg.guest) for k, a in (("current", ctx.argv), ("candidate", ctx.candidate))}
        for k, r in adopt.items():
            out(f"adopt-check {k}: rc={r['rc']} {r['adopt_lines']}")
            if not r["ok"]:
                raise Refuse(f"{k} -adopt-check did not report exactly ADOPT OK {cfg.guest}")
        preserve(cfg, ctx, adopt, host.euid())
        out(f"preserved into {cfg.recovery_dir}")
        return hold_and_switch(cfg, host, ctx, out)
    finally:
        ctx.close()


def main(argv=None, host=None, out=print):
    ap = argparse.ArgumentParser(allow_abbrev=False, description=__doc__.split("\n\n")[0])
    ap.add_argument("--execute", action="store_true", help="perform the switch (default: dry run)")
    ap.add_argument("--reviewed-plan", type=Path, help="plan JSON from a dry run; required with --execute")
    ap.add_argument("--write-plan", type=Path, help="dry run: also write the plan here (new file, 0600)")
    ap.add_argument("--adopt-check", action="store_true", help="dry run: also run both -adopt-check subprocesses")
    ap.add_argument("--expect-argv", type=Path, default=EXPECT_ARGV)
    ap.add_argument("--dropin-name", default=DROPIN_NAME)
    ap.add_argument("--control-pid", type=int, default=CONTROL_PID)
    ap.add_argument("--guest-qemu-pid", type=int, default=GUEST_QEMU_PID)
    ap.add_argument("--recovery-dir", type=Path)
    ap.add_argument("--pad-recovery-dir", type=Path)
    try:
        a = ap.parse_args(argv)
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else 2
    if a.execute != (a.reviewed_plan is not None) or (a.execute and (a.write_plan or a.adopt_check or not a.recovery_dir)):
        ap.print_usage(sys.stderr)
        print("--execute needs --reviewed-plan and --recovery-dir; --reviewed-plan only with --execute", file=sys.stderr)
        return 2
    if a.pad_recovery_dir and not a.recovery_dir:
        return 2
    cfg = Config(expect_argv=a.expect_argv, dropin_name=a.dropin_name, control_pid=a.control_pid,
                 guest_qemu_pid=a.guest_qemu_pid, recovery_dir=a.recovery_dir, pad_recovery_dir=a.pad_recovery_dir)
    host = host or Host()
    try:
        try:
            if a.execute:
                execute(cfg, host, load_reviewed(a.reviewed_plan, host.euid()), out)
                return 0
            plan, ctx = preflight(cfg, host)
            try:
                text = json.dumps(plan, indent=2, sort_keys=True) + "\n"
                out(text)
                out(ctx.dropin_text)
                if a.adopt_check:
                    for k, v in (("current", ctx.argv), ("candidate", ctx.candidate)):
                        r = run_adopt(host, v, ctx.adopt_env, cfg.guest)
                        out(f"adopt-check {k}: ok={r['ok']} rc={r['rc']} {r['adopt_lines']}")
                if a.write_plan:
                    write_private(a.write_plan, text.encode())
            finally:
                ctx.close()
            out("DRY RUN: nothing changed")
            return 0
        except (OSError, ValueError, KeyError, StopIteration, IndexError) as e:
            raise Refuse(repr(e))
    except Refuse as e:
        print(f"REFUSED (no drop-in, no signal, no restart): {e}", file=sys.stderr)
        return 1
    except SwitchFailed as e:
        print(f"FAILED and rolled back: {e}", file=sys.stderr)
        return 3
    except RollbackIncomplete as e:
        print(f"ROLLBACK INCOMPLETE, manual action needed: {e}", file=sys.stderr)
        return 4


if __name__ == "__main__":
    sys.exit(main())
