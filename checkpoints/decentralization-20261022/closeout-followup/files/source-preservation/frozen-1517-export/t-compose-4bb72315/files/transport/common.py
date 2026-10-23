"""Shared checks for the RPC durable-HDD transport (export side and attach side).

Python standard library only. Nothing in this module changes the system. It reads /proc, /sys and files, and it runs
`openssl` read-only to inspect certificates.
"""
import hashlib
import ipaddress
import json
import os
import re
import stat
import subprocess

ROLES = ("l1", "base")


class Refused(Exception):
    """A fail-closed refusal. The message names the check that failed."""


def refuse(msg):
    raise Refused(msg)


def load_json(path, fmt, allowed):
    with open(path, "rb") as f:
        raw = f.read(65536 + 1)
    if len(raw) > 65536:
        refuse(f"{path}: config larger than 64 KiB")
    try:
        cfg = json.loads(raw)
    except ValueError as e:
        refuse(f"{path}: not JSON ({e})")
    if not isinstance(cfg, dict):
        refuse(f"{path}: config must be an object")
    extra = sorted(set(cfg) - set(allowed))
    if extra:
        refuse(f"{path}: unknown field(s) {extra}")
    missing = sorted(k for k in allowed if k not in cfg and not allowed[k])
    if missing:
        refuse(f"{path}: missing field(s) {missing}")
    if cfg.get("format") != fmt:
        refuse(f"{path}: format must be {fmt}")
    if cfg.get("role") not in ROLES:
        refuse(f"{path}: role must be one of {ROLES}")
    return cfg


def want(obj, key, kind, where):
    v = obj.get(key) if isinstance(obj, dict) else None
    if not isinstance(v, kind) or isinstance(v, bool) and kind is not bool:
        refuse(f"{where}.{key} must be {kind.__name__}")
    return v


def abspath_plain(p, where):
    """An absolute, normalised path with no '..' and no empty or '.' component (the string itself; symlinks checked separately)."""
    if not isinstance(p, str) or not p.startswith("/") or p != os.path.normpath(p) or "\0" in p:
        refuse(f"{where}: {p!r} must be an absolute normalised path")
    return p


def no_symlink_components(path, where):
    """Every existing component of `path` must be a real directory or file, never a symlink."""
    cur = "/"
    for part in path.strip("/").split("/"):
        cur = os.path.join(cur, part)
        try:
            st = os.lstat(cur)
        except FileNotFoundError:
            return False
        if stat.S_ISLNK(st.st_mode):
            refuse(f"{where}: {cur} is a symlink; the path must not traverse links")
    return True


# ---- mounts -----------------------------------------------------------------------------------------------------------

def _unescape(s):
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), s)


def mountinfo(path="/proc/self/mountinfo"):
    out = []
    with open(path) as f:
        for line in f:
            pre, post = line.rstrip("\n").split(" - ", 1)
            a, b = pre.split(" "), post.split(" ")
            out.append({"id": int(a[0]), "parent": int(a[1]), "majmin": a[2], "root": _unescape(a[3]),
                        "target": _unescape(a[4]), "options": a[5], "fstype": b[0], "source": _unescape(b[1]),
                        "super": b[2] if len(b) > 2 else ""})
    return out


def mount_at(target):
    """The mount whose mount point is EXACTLY `target` and is the visible one (the last listed; later mounts shadow), or None."""
    hits = [m for m in mountinfo() if m["target"] == target]
    return hits[-1] if hits else None


def mount_containing(path):
    """The visible mount that contains `path` (longest mount-point prefix, last listed wins)."""
    best = None
    for m in mountinfo():
        t = m["target"]
        if path == t or path.startswith(t.rstrip("/") + "/") or t == "/":
            if best is None or len(t) >= len(best["target"]):
                best = m
    return best


def whole_disk_of(devname):
    """sysfs whole-disk name for a block device name (sda2 -> sda; dm-0 -> its slaves' disks)."""
    base = f"/sys/class/block/{devname}"
    if not os.path.exists(base):
        refuse(f"no sysfs entry for block device {devname}")
    if os.path.exists(os.path.join(base, "partition")):
        return [os.path.basename(os.path.dirname(os.path.realpath(base)))]
    slaves = os.path.join(base, "slaves")
    if os.path.isdir(slaves) and os.listdir(slaves):
        disks = []
        for s in sorted(os.listdir(slaves)):
            disks += whole_disk_of(s)
        return disks
    return [devname]


def read_sys(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


# ---- addresses ---------------------------------------------------------------------------------------------------------

def literal_ip(addr, where):
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        refuse(f"{where}: {addr!r} must be a literal IP address (no hostname, no wildcard)")
    if ip.is_unspecified or ip.is_multicast:
        refuse(f"{where}: {addr} is a wildcard/multicast address; bind one specific address")
    return ip


def port(v, where):
    if not isinstance(v, int) or isinstance(v, bool) or not 1024 <= v <= 65535:
        refuse(f"{where}: port must be an integer 1024-65535")
    return v


# ---- TLS material ------------------------------------------------------------------------------------------------------

def private_file(path, where):
    """A key file: regular, not a symlink, owned by us, no group/other permission bits."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        refuse(f"{where}: {path} is missing")
    if not stat.S_ISREG(st.st_mode):
        refuse(f"{where}: {path} must be a regular file (not a link)")
    if st.st_uid != os.geteuid():
        refuse(f"{where}: {path} must be owned by the user running this service")
    if st.st_mode & 0o077:
        refuse(f"{where}: {path} has group/other permissions ({oct(st.st_mode & 0o777)}); chmod 600")


def public_file(path, where):
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        refuse(f"{where}: {path} is missing")
    if not stat.S_ISREG(st.st_mode):
        refuse(f"{where}: {path} must be a regular file (not a link)")
    if st.st_mode & 0o022:
        refuse(f"{where}: {path} is group/other writable")


def openssl(*args, data=None):
    r = subprocess.run(["openssl", *args], input=data, capture_output=True, timeout=30)
    if r.returncode != 0:
        refuse(f"openssl {' '.join(args[:2])} failed: {r.stderr.decode(errors='replace').strip()[:300]}")
    return r.stdout.decode()


def cert_facts(path):
    """Read-only facts about a PEM certificate: sha256 fingerprint, subject, issuer, SANs, EKU, expiry check."""
    txt = openssl("x509", "-in", path, "-noout", "-fingerprint", "-sha256", "-subject", "-issuer", "-checkend", "0",
                  "-ext", "subjectAltName,extendedKeyUsage,basicConstraints", "-nameopt", "RFC2253")
    fp = re.search(r"Fingerprint=([0-9A-F:]+)", txt)
    return {"sha256": fp.group(1).replace(":", "").lower() if fp else None,
            "subject": (re.search(r"^subject=(.*)$", txt, re.M) or [None, None])[1],
            "issuer": (re.search(r"^issuer=(.*)$", txt, re.M) or [None, None])[1],
            "text": txt}


def verify_chain(ca, cert, purpose):
    r = subprocess.run(["openssl", "verify", "-x509_strict", "-purpose", purpose, "-CAfile", ca, cert],
                       capture_output=True, timeout=30)
    if r.returncode != 0:
        refuse(f"{cert} does not verify under {ca} for {purpose}: {r.stdout.decode().strip()} {r.stderr.decode().strip()}"[:400])


def authz_identity(dn):
    """qemu's --object option syntax doubles commas inside values; refuse anything else that could break the option list."""
    if not isinstance(dn, str) or not re.fullmatch(r"[A-Za-z0-9=,. _-]{3,200}", dn) or "CN=" not in dn:
        refuse(f"client identity {dn!r} must be a plain DN such as 'O=Enclave RPC HDD,CN=enclave-rpc-l1-client'")
    return dn.replace(",", ",,")


def opt_value(v, where):
    """A value placed inside a qemu --object/--image-opts list: no commas, no '=' surprises, no whitespace."""
    if not isinstance(v, str) or not re.fullmatch(r"[A-Za-z0-9/._:-]{1,255}", v):
        refuse(f"{where}: {v!r} cannot be passed safely inside a qemu option list")
    return v


# ---- owned processes ---------------------------------------------------------------------------------------------------

def proc_identity(pid):
    """(starttime, exe, argv) for a live pid, or None. starttime is /proc/<pid>/stat field 22 (boot-relative ticks)."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            st = f.read()
        start = int(st[st.rindex(")") + 2:].split()[19])
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            argv = [a.decode(errors="replace") for a in f.read().split(b"\0") if a]
        try:
            exe = os.readlink(f"/proc/{pid}/exe")
        except OSError:
            exe = None
        return start, exe, argv
    except (FileNotFoundError, ProcessLookupError, ValueError, IndexError):
        return None


def argv_digest(argv):
    return hashlib.sha256("\0".join(argv).encode()).hexdigest()


def owned_record(pid, role, purpose, launched_argv, wait=5.0):
    """Record a process we just launched. Its live argv must equal the argv WE launched. A process seen mid-exec has an
    empty or different /proc/<pid>/cmdline, so retry briefly instead of recording an empty identity."""
    import time
    want = argv_digest(launched_argv)
    end = time.monotonic() + wait
    while True:
        ident = proc_identity(pid)
        if ident is None:
            refuse(f"process {pid} vanished before it could be recorded")
        start, exe, argv = ident
        if argv_digest(argv) == want:
            return {"pid": pid, "starttime": start, "exe": exe, "argvSha256": want, "role": role,
                    "purpose": purpose, "uid": os.geteuid()}
        if time.monotonic() > end:
            refuse(f"process {pid} does not run the launched command line; not recorded as owned")
        time.sleep(0.05)


def is_owned(rec, check_exe=True):
    """True only if the pid is alive AND is the very process recorded (same start time, executable and argv).
    check_exe=False is for a capability-less observer (the hddwatch supervisor). The kernel refuses it readlink of
    /proc/<pid>/exe of a root process with more capabilities (ptrace access check), so it compares pid + boot-relative
    start time + full argv. Those still identify one process; it is never used to signal anything."""
    ident = proc_identity(rec.get("pid", -1)) if isinstance(rec.get("pid"), int) and rec["pid"] > 1 else None
    if ident is None:
        return False
    start, exe, argv = ident
    return start == rec.get("starttime") and (not check_exe or exe == rec.get("exe")) and argv_digest(argv) == rec.get("argvSha256")


def write_state_exclusive(path, obj):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f, indent=1, sort_keys=True)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())


def read_state(path):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def emit(obj):
    print(json.dumps(obj, sort_keys=True), flush=True)
