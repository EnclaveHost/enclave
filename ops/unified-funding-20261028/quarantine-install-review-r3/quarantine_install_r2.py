#!/usr/bin/env python3
"""Post-stop immutable write-quarantine installer for enclave-api-relay (r2, repair r3). SOURCE ONLY: never run before
root review.

The ONLY mutating forward transition:
  original writer ALREADY stopped (independently) + owned gate + financial-hold marker + private pre/post-stop snapshots
  -> five pinned quarantine modules (sessions.mjs 483b1c5e + four unchanged funding modules) + ONE additive drop-in
     -> `systemctl start`, verified as that candidate.
The drop-in resets ExecStart to the pinned original argv wrapped by the pinned /usr/bin/env, which sets
SESSIONS_WRITE_QUARANTINE=1 SESSIONS_FUNDING_INTAKE=0 AFTER systemd has applied Environment= and every EnvironmentFile=
and BEFORE the relay runtime is exec'd. Original EnvironmentFiles/flags are left in place, byte/mode/owner-pinned against
the private snapshots and compared before start (r2 used Environment=, which an EnvironmentFile overrides).
It never stops the original writer, never enables writes or intake, never removes the gate or the marker, never restores
financial journals and never starts original code. It is NOT the stop observer, the checkpoint qualifier or the nonce-tail
reconciler: stop/checkpoint evidence is bound by exact hash and op only, never evaluated as coverage or permission.
A running quarantine candidate may restore READS; the record always says writesResumed=false.

Historical activation-inputs-r1/install-relay-r1.py was read only as a preservation reference; nothing is reused.
Output and records carry hashes, booleans, counts and paths only: never environment values or financial contents.
"""
import argparse
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
from dataclasses import dataclass

PLAN_SCHEMA = "quarantine-install-r2-plan-v3"
SNAP_SCHEMA = "quarantine-install-r2-snapshot-v3"
STATE_SCHEMA = "quarantine-install-r2-state-v3"
CLOSED_OPS = frozenset({"funding-activation-r1-20261028"})
OP_RE = re.compile(r"^[a-z0-9][a-z0-9-]{7,63}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
INV_RE = re.compile(r"^[0-9a-f]{32}$")
BOOT_RE = re.compile(r"^[0-9a-f-]{36}$")
DROPIN_NAME_RE = re.compile(r"^zz-quarantine-r2-[a-z0-9-]{8,64}\.conf$")
CONF_RE = re.compile(r"^[A-Za-z0-9_.@-]+\.conf$")
# Exec tokens written into the drop-in: no whitespace, quotes, '%' specifiers, '$' expansion, ';' or backslashes.
ARGV_TOKEN_RE = re.compile(r"^[A-Za-z0-9_./:=+-]+$")
DROPIN_ENV = (("SESSIONS_WRITE_QUARANTINE", "1"), ("SESSIONS_FUNDING_INTAKE", "0"))
WRAPPER = "/usr/bin/env"  # pinned path; bytes pinned by plan launch.wrapperSha256 == pre == post == current
GATE_ID_PREFIX = "session-write-gate-"  # pinned session_gate.py gate_route()['@id']
# systemd-set per-invocation fields whose VALUES may differ; presence must match. Nothing else may differ.
VOLATILE_ENV = frozenset({b"INVOCATION_ID", b"JOURNAL_STREAM", b"SYSTEMD_EXEC_PID", b"LISTEN_PID", b"WATCHDOG_PID"})
JOURNAL, INDEX = "sessions-relayer.json", "sessions-index.json"
MAX_FILE = 64 << 20
MAX_BINARY = 1 << 30
MAX_STATE_FILES = 10000
TIMEOUT = {"show": 15, "reload": 60, "start": 210, "stop": 220, "helper": 30, "probe": 5}


@dataclass(frozen=True)
class Pins:
    candidate: dict
    protected: dict
    original_sessions: str
    gate_helper: str
    exec_argv: tuple = ()  # exact original ExecStart argv (no prefix flags)
    environment_files: tuple = ()  # ((path, ignoreErrors), ...) in systemd order


# Production pins (relay-quarantine-review-r1 PREPARE-MANIFEST + prestage readback; runbook baseline; launch facts from
# root's read-only `systemctl show` of PID 228946: paths/order/ignoreErrors only, no contents). Tests inject their own
# Pins; the CLI never accepts overrides.
PRODUCTION_PINS = Pins(
    candidate={
        "sessions.mjs": "483b1c5ef29d83c937a5fd5b15ea3b2e940025d76706a1c5a63867f33c55c4e3",
        "funding-route.mjs": "1989f3ebf88833ac492e4f121ff33d564b1798eae1e5239b1aae444b63b572cd",
        "funding-activation.mjs": "7554454dbe091f4bcc7ef8e15ac5dd8082c8be6d94256f52b1c8fadcfc198645",
        "fee-policy.mjs": "32bcf03ea52db9be70d86e957dd440c1697daf0eaeab79f732378002d4f2bcfd",
        "funding-abi.mjs": "6bb37e658aca45fd416d5ea17dda3109e1b41791e674976a60425d579f485cd7",
    },
    protected={
        "api-relay.js": "481f00410b87f30ee467183db7121175d37c010be5b2c23891a0a19e63b4579d",
        "sessions-abi.mjs": "e9c2464c529d0665e4b2e38bdaa0bf8c703346f046b85521aba755bfc1b2a0a6",
        "snp-verify.mjs": "10520dd25d6a7a40225a7076521c383fc3eb296b1f290ac6b9e9fbbd1697de91",
        "store.js": "12157d8ccf8b1ec4ffd4d0af9b5b846650ec20aac748bcc51ad087e119922dcd",
    },
    original_sessions="457e86472adce2f1fdd2dfa82759578a56f7d72f0c5e5ee18e53999a26d0682d",
    gate_helper="1fa1385b6b8b295be40ceb398ac285c0aa2e88076f7067e90fe7ca9d39f73187",
    exec_argv=("/usr/bin/node", "/opt/nan-relay/api-relay.js"),
    environment_files=(
        ("/etc/nan-relay/api-relay.env", False),
        ("/etc/nan-relay/host-sponsor.env", True),
        ("/etc/enclave-rpc/clients.env", False),
        ("/etc/nan-relay/predictor-replicas.env", False),
        ("/etc/nan-relay/eyesoff-release-recovery.env", False),
        ("/etc/nan-relay/release-signing-credential.env", False),
        ("/etc/nan-relay/linux-leasegas-measurements.env", False),
        ("/etc/nan-relay/queued-release-recovery-20261022.env", False),
        ("/etc/nan-relay/loader-cache-release-20261028.env", False),
    ),
)


@dataclass(frozen=True)
class Layout:
    unit: str = "enclave-api-relay.service"
    relay_dir: str = "/opt/nan-relay"
    stage_dir: str = "/opt/enclave-funding-staged/quarantine-r1-20261028"
    state_dir: str = "/var/lib/enclave-relay"
    unit_file: str = "/etc/systemd/system/enclave-api-relay.service"
    ops_root: str = "/var/lib/enclave-maintenance/funding-cutover"
    gate_helper: str = "/opt/enclave-funding-staged/maintenance-r1/session_gate.py"
    expected_dropins: int = 10

    @property
    def dropin_dir(self):
        return self.unit_file + ".d"


class Refusal(Exception):
    def __init__(self, code, **facts):
        super().__init__(code)
        self.code, self.facts = code, facts


def need(cond, code, **facts):
    if not cond:
        raise Refusal(code, **facts)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def canon(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode() + b"\n"


def is_int(x):
    return type(x) is int


# ----------------------------------------------------------------------------------------------- pure validation
def exact_keys(obj, keys, where):
    need(isinstance(obj, dict) and set(obj) == set(keys), "plan-schema", where=where)


def validate_plan(plan, op, pins, layout, now):
    """Strict schema: unknown keys (e.g. a 'coverageVerified' flag) are refused, never trusted. now=None skips freshness."""
    exact_keys(plan, {"schema", "op", "issuedAtUnix", "expiresAtUnix", "oldIdentity", "baselineTargets", "unitFiles",
                      "dropInName", "lockPath", "gate", "holdMarker", "stopRecord", "checkpointEvidence",
                      "preStopSnapshotSha256", "postStopSnapshotSha256", "probePort", "launch"}, "plan")
    need(plan["schema"] == PLAN_SCHEMA, "plan-schema", where="schema")
    need(plan["op"] == op and bool(OP_RE.match(op)) and op not in CLOSED_OPS, "op-invalid")
    iss, exp = plan["issuedAtUnix"], plan["expiresAtUnix"]
    need(is_int(iss) and is_int(exp) and 0 < exp - iss <= 6 * 3600, "plan-schema", where="validity")
    if now is not None:
        need(iss <= now < exp, "plan-not-fresh")
    ident = plan["oldIdentity"]
    exact_keys(ident, {"pid", "startTicks", "bootId", "controlGroup", "invocationId"}, "oldIdentity")
    need(is_int(ident["pid"]) and ident["pid"] > 1 and is_int(ident["startTicks"]) and ident["startTicks"] > 0
         and isinstance(ident["bootId"], str) and bool(BOOT_RE.match(ident["bootId"]))
         and isinstance(ident["invocationId"], str) and bool(INV_RE.match(ident["invocationId"]))
         and isinstance(ident["controlGroup"], str) and ident["controlGroup"].startswith("/")
         and os.path.normpath(ident["controlGroup"]) == ident["controlGroup"], "plan-schema", where="oldIdentity")
    bt = plan["baselineTargets"]
    exact_keys(bt, set(pins.candidate), "baselineTargets")
    need(bt["sessions.mjs"] == pins.original_sessions, "baseline-not-original-sessions")
    for n, v in bt.items():
        need(n == "sessions.mjs" or v in ("absent", pins.candidate[n]), "baseline-module-unexpected", name=n)
    uf = plan["unitFiles"]
    need(isinstance(uf, dict) and len(uf) == 1 + layout.expected_dropins and layout.unit_file in uf,
         "plan-schema", where="unitFiles")
    for p, h in uf.items():
        d, n = os.path.split(p)
        need(isinstance(h, str) and bool(HEX64.match(h)), "plan-schema", where="unitFiles")
        need(p == layout.unit_file or (d == layout.dropin_dir and bool(CONF_RE.match(n))), "plan-schema", where="unitFiles")
    dn = plan["dropInName"]
    need(isinstance(dn, str) and bool(DROPIN_NAME_RE.match(dn)) and layout.dropin_dir + "/" + dn not in uf,
         "plan-schema", where="dropInName")
    for k in ("holdMarker", "stopRecord", "checkpointEvidence"):
        r = plan[k]
        exact_keys(r, {"path", "sha256"}, k)
        need(isinstance(r["path"], str) and r["path"].startswith("/") and os.path.normpath(r["path"]) == r["path"]
             and isinstance(r["sha256"], str) and bool(HEX64.match(r["sha256"])), "plan-schema", where=k)
    # gate.hash is session_gate.py's routesSha256 (sha256 of canonical routes JSON); gate.etag its Caddy ETag.
    exact_keys(plan["gate"], {"hash", "etag"}, "gate")
    need(isinstance(plan["gate"]["hash"], str) and bool(HEX64.match(plan["gate"]["hash"]))
         and isinstance(plan["gate"]["etag"], str) and bool(plan["gate"]["etag"]), "plan-schema", where="gate")
    lp = plan["lockPath"]
    need(isinstance(lp, str) and lp.startswith("/") and os.path.normpath(lp) == lp, "plan-schema", where="lockPath")
    for k in ("preStopSnapshotSha256", "postStopSnapshotSha256"):
        need(isinstance(plan[k], str) and bool(HEX64.match(plan[k])), "plan-schema", where=k)
    need(plan["preStopSnapshotSha256"] != plan["postStopSnapshotSha256"], "plan-schema", where="snapshots")
    need(is_int(plan["probePort"]) and 0 < plan["probePort"] < 65536, "plan-schema", where="probePort")
    exact_keys(plan["launch"], {"wrapperSha256", "runtimeSha256"}, "launch")
    need(all(isinstance(v, str) and bool(HEX64.match(v)) for v in plan["launch"].values()), "plan-schema", where="launch")
    wrapped_argv(pins.exec_argv)
    return plan


def wrapped_argv(exec_argv):
    """The pinned original argv, unchanged, behind `/usr/bin/env SESSIONS_WRITE_QUARANTINE=1 SESSIONS_FUNDING_INTAKE=0`."""
    need(isinstance(exec_argv, tuple) and len(exec_argv) >= 1 and exec_argv[0].startswith("/")
         and all(isinstance(t, str) and bool(ARGV_TOKEN_RE.match(t)) for t in exec_argv), "exec-argv-invalid")
    return (WRAPPER,) + tuple("%s=%s" % kv for kv in DROPIN_ENV) + exec_argv


def dropin_bytes(op, exec_argv):
    need(bool(OP_RE.match(op)), "op-invalid")
    return ("# quarantine-install-r2 op=%s: immutable write quarantine, intake OFF. Additive; do not edit.\n"
            "# ExecStart is reset to the pinned original argv behind the pinned %s, which sets the two flags after\n"
            "# every Environment=/EnvironmentFile= is applied and before the relay runtime is exec'd. EnvironmentFiles\n"
            "# and all other unit settings are left as they are.\n"
            "[Service]\nExecStart=\nExecStart=%s\n" % (op, WRAPPER, " ".join(wrapped_argv(exec_argv)))).encode()


def parse_env(raw):
    out = {}
    for item in raw.split(b"\0"):
        if not item:
            continue
        need(b"=" in item, "env-malformed")
        k, v = item.split(b"=", 1)
        need(k not in out, "env-duplicate-key")
        out[k] = v
    return out


def env_problems(original, candidate, added, invocation_id):
    """Counts/labels only, never names or values from the original environment."""
    a, b = parse_env(original), parse_env(candidate)
    add = {k.encode(): v.encode() for k, v in added.items()}
    p = []
    if any(k in a for k in add):
        p.append("original-has-added-key")
    if any(b.get(k) != v for k, v in add.items()):
        p.append("added-key-value")
    if b.get(b"INVOCATION_ID") != invocation_id.encode():
        p.append("invocation-id")
    ka, kb = set(a) - VOLATILE_ENV, set(b) - VOLATILE_ENV - set(add)
    if ka != kb:
        p.append("keyset-differs:%d" % len(ka ^ kb))
    diff = sum(1 for k in ka & kb if a[k] != b[k])
    if diff:
        p.append("values-differ:%d" % diff)
    pres = sum(1 for k in VOLATILE_ENV if (k in a) != (k in b))
    if pres:
        p.append("volatile-presence:%d" % pres)
    return p


def quarantine_probe_ok(doc):
    """GET /v1/sessions/quarantine must prove the IMMUTABLE startup flag. GET /funding/config is never activation evidence."""
    return (isinstance(doc, dict) and doc.get("writeQuarantine") is True and doc.get("value") == "1"
            and isinstance(doc.get("journal"), dict) and doc["journal"].get("persisted") is False)


SHOW_SINGLE = ("MainPID", "ActiveState", "SubState", "ControlGroup", "InvocationID", "DropInPaths", "Result")
EXEC_ENTRY_RE = re.compile(r"\{ path=(\S+) ; argv\[\]=(.*?) ; ignore_errors=(yes|no) ; [^{}]*\}")
ENVFILE_RE = re.compile(r"^(/\S+) \(ignore_errors=(yes|no)\)$")


def parse_show(out):
    """`systemctl show -p ...` text -> dict. The ExecStart/EnvironmentFiles value shapes are ASSUMED from systemd's show
    format (UNQUALIFIED: compare with live read-only output). Anything not parsed exactly is refused, never guessed."""
    props = {}
    for line in out.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            props.setdefault(k, []).append(v)
    need(all(len(props.get(k, [])) <= 1 for k in SHOW_SINGLE), "show-unparsed")
    one = lambda k: props.get(k, [""])[0]  # noqa: E731
    execs = []
    for v in props.get("ExecStart", []):
        found = EXEC_ENTRY_RE.findall(v)
        need(v == "" or (len(found) > 0 and len(found) == v.count("{ path=")), "show-unparsed", prop="ExecStart")
        execs += [{"path": p, "argv": a.split(" "), "ignoreErrors": i == "yes"} for p, a, i in found]
    files = []
    for v in props.get("EnvironmentFiles", []):
        if v:
            m = ENVFILE_RE.match(v)
            need(m is not None, "show-unparsed", prop="EnvironmentFiles")
            files.append([m.group(1), m.group(2) == "yes"])
    return {"MainPID": int(one("MainPID") or 0), "ActiveState": one("ActiveState"), "SubState": one("SubState"),
            "ControlGroup": one("ControlGroup"), "InvocationID": one("InvocationID"),
            "DropInPaths": sorted(one("DropInPaths").split()), "Result": one("Result"),
            "ExecStart": execs, "EnvironmentFiles": files}


# ----------------------------------------------------------------------------------------------- filesystem
class FS:
    """All production paths are absolute; `root` maps them (explicit "/" in production, an owned temp dir in tests)."""

    def __init__(self, root, uid):
        need(os.path.isabs(root), "root-not-absolute")
        self.root, self.uid = os.path.realpath(root), uid

    def p(self, a):
        need(isinstance(a, str) and a.startswith("/") and os.path.normpath(a) == a and "\0" not in a,
             "path-not-normalized", path=str(a))
        return a if self.root == "/" else self.root + a

    def no_symlink(self, a):
        """True if `a` exists with no symlink component below root; False if a component is missing."""
        self.p(a)
        cur = self.root.rstrip("/")
        for part in a.strip("/").split("/"):
            cur += "/" + part
            try:
                st = os.lstat(cur)
            except FileNotFoundError:
                return False
            need(not stat.S_ISLNK(st.st_mode), "symlink-in-path", path=a)
        return True

    def lstat(self, a):
        return os.lstat(self.p(a)) if self.no_symlink(a) else None

    def read(self, a, missing="missing"):
        need(self.no_symlink(a), missing, path=a)
        fd = os.open(self.p(a), os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            st = os.fstat(fd)
            need(stat.S_ISREG(st.st_mode) and st.st_size <= MAX_FILE, "not-regular-or-too-large", path=a)
            chunks, n = [], 0
            while True:
                c = os.read(fd, 1 << 20)
                if not c:
                    break
                n += len(c)
                need(n <= MAX_FILE, "not-regular-or-too-large", path=a)
                chunks.append(c)
            return b"".join(chunks), st
        finally:
            os.close(fd)

    def digest(self, a, limit=MAX_BINARY):
        """Streamed sha256 + metadata of a regular, non-symlinked file. Binaries are hashed, never copied."""
        need(self.no_symlink(a), "missing", path=a)
        fd = os.open(self.p(a), os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            st = os.fstat(fd)
            need(stat.S_ISREG(st.st_mode) and st.st_size <= limit, "not-regular-or-too-large", path=a)
            h, n = hashlib.sha256(), 0
            while True:
                c = os.read(fd, 1 << 20)
                if not c:
                    break
                n += len(c)
                need(n <= limit, "not-regular-or-too-large", path=a)
                h.update(c)
            st2 = os.fstat(fd)
            need(n == st.st_size and (st2.st_size, st2.st_mtime_ns, st2.st_ctime_ns)
                 == (st.st_size, st.st_mtime_ns, st.st_ctime_ns), "changed-during-read", path=a)
        finally:
            os.close(fd)
        return {"sha256": h.hexdigest(), "size": n, "mode": st.st_mode & 0o7777, "uid": st.st_uid, "gid": st.st_gid}

    def hash_or_absent(self, a):
        return sha(self.read(a)[0]) if self.lstat(a) is not None else "absent"

    def owned(self, st, a, private=False):
        need(st.st_uid == self.uid, "wrong-owner", path=a)
        need(not st.st_mode & 0o022, "group-or-world-writable", path=a)
        if private:
            need(not st.st_mode & 0o077, "not-private", path=a)

    def listdir(self, a):
        need(self.no_symlink(a) and stat.S_ISDIR(os.lstat(self.p(a)).st_mode), "missing-directory", path=a)
        return sorted(os.listdir(self.p(a)))

    def fsync_path(self, a, directory=True):
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | (os.O_DIRECTORY if directory else 0)
        fd = os.open(self.p(a), flags)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def mkdir_private(self, a):
        need(self.no_symlink(os.path.dirname(a)), "missing-directory", path=os.path.dirname(a))
        try:
            os.mkdir(self.p(a), 0o700)
        except FileExistsError:
            raise Refusal("already-exists", path=a)
        os.chmod(self.p(a), 0o700)
        self.fsync_path(os.path.dirname(a))

    def makedirs_private(self, a, below):
        cur = below
        for part in a[len(below):].strip("/").split("/"):
            cur += "/" + part
            if self.lstat(cur) is None:
                self.mkdir_private(cur)

    def _write_tmp(self, a, data, mode, owner):
        d, n = os.path.split(a)
        tmp = "%s/.%s.qr2.tmp" % (d, n)
        try:
            fd = os.open(self.p(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
        except FileExistsError:
            raise Refusal("interrupted-temp-retained", path=tmp)
        try:
            os.fchmod(fd, mode)
            if owner is not None:
                os.fchown(fd, *owner)
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)
        need(sha(self.read(tmp)[0]) == sha(data), "stage-readback-mismatch", path=tmp)
        return tmp

    def write_new(self, a, data, mode, owner=None):
        """Exclusive temp -> fsync -> readback -> link (never replaces) -> fsync dir."""
        need(self.lstat(a) is None, "destination-exists", path=a)
        tmp = self._write_tmp(a, data, mode, owner)
        try:
            os.link(self.p(tmp), self.p(a))
        except FileExistsError:
            raise Refusal("destination-exists-temp-retained", path=a)
        os.unlink(self.p(tmp))
        self.fsync_path(os.path.dirname(a))

    def replace(self, a, data, mode, owner, expect_sha):
        """Exclusive temp -> fsync -> readback -> CAS current bytes -> rename -> fsync dir."""
        tmp = self._write_tmp(a, data, mode, owner)
        need(self.hash_or_absent(a) == expect_sha, "cas-mismatch-temp-retained", path=a)
        os.rename(self.p(tmp), self.p(a))
        self.fsync_path(os.path.dirname(a))

    def unlink_cas(self, a, expect_sha):
        need(self.hash_or_absent(a) == expect_sha, "cas-mismatch", path=a)
        os.unlink(self.p(a))
        self.fsync_path(os.path.dirname(a))


class Record:
    """The install record state.json (never a financial journal): every phase is fsync+rename with CAS on the last bytes."""

    def __init__(self, fs, d, op, hook=None, doc=None, last=None):
        self.fs, self.path, self.hook, self.last = fs, d + "/state.json", hook, last
        self.doc = doc or {"schema": STATE_SCHEMA, "op": op, "phase": None, "facts": {}, "history": []}

    def save(self, phase, **facts):
        self.doc["phase"] = phase
        self.doc["facts"].update(facts)
        self.doc["history"].append({"phase": phase, "at": round(time.time(), 3)})
        data = canon(self.doc)
        if self.last is None:
            self.fs.write_new(self.path, data, 0o600)
        else:
            self.fs.replace(self.path, data, 0o600, None, self.last)
        self.last = sha(data)
        if self.hook:
            self.hook(phase)


# ----------------------------------------------------------------------------------------------- production host adapter
class SystemdHost:
    """PRODUCTION adapter: UNQUALIFIED until root reviews it against the live host. argv lists only (no shell), every call
    bounded. gate_status follows the pinned session_gate.py output; parse_show shapes still need live qualification."""

    def __init__(self, layout, pins):
        self.L, self.pins = layout, pins

    def _run(self, argv, timeout):
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=True, shell=False,
                              env={"PATH": "/usr/bin:/bin", "LC_ALL": "C", "SYSTEMD_PAGER": ""}).stdout

    def show(self, unit):
        return parse_show(self._run(["systemctl", "show", unit, "-p", "MainPID", "-p", "ActiveState", "-p", "SubState",
                                     "-p", "ControlGroup", "-p", "InvocationID", "-p", "DropInPaths", "-p", "Result",
                                     "-p", "ExecStart", "-p", "EnvironmentFiles"], TIMEOUT["show"]))

    def cgroup_pids(self, cg):
        """Recursive cgroup.procs, bounded; None when the cgroup no longer exists (recorded as absent)."""
        base = "/sys/fs/cgroup" + cg
        if not os.path.isdir(base):
            return None
        pids, dirs = [], 0
        for d, _, files in os.walk(base, followlinks=False):
            dirs += 1
            need(dirs <= 4096, "cgroup-walk-bound")
            if "cgroup.procs" in files:
                with open(os.path.join(d, "cgroup.procs")) as f:
                    pids += [int(x) for x in f.read().split()]
        return pids

    def start_ticks(self, pid):
        try:
            with open("/proc/%d/stat" % pid) as f:
                return int(f.read().rsplit(")", 1)[1].split()[19])
        except (FileNotFoundError, ProcessLookupError):
            return None

    def environ(self, pid):
        with open("/proc/%d/environ" % pid, "rb") as f:
            return f.read(1 << 20)

    def exe(self, pid):
        return os.readlink("/proc/%d/exe" % pid)

    def proc_cgroup(self, pid):
        with open("/proc/%d/cgroup" % pid) as f:
            return [x.split("::", 1)[1] for x in f.read().splitlines() if x.startswith("0::")][0]

    def boot_id(self):
        with open("/proc/sys/kernel/random/boot_id") as f:
            return f.read().strip()

    def daemon_reload(self):
        self._run(["systemctl", "daemon-reload"], TIMEOUT["reload"])

    def start(self, unit):
        self._run(["systemctl", "start", unit], TIMEOUT["start"])

    def stop(self, unit):
        """Used ONLY on an invocation positively bound and re-verified as this installer's candidate."""
        self._run(["systemctl", "stop", unit], TIMEOUT["stop"])

    def gate_status(self, op):
        """Pinned session_gate.py shapes. `inspect` -> {routesSha256, etag, gateIds, upstreams}; `status --op` ->
        {phase, ownedGateExact, gateAbsent, routesSha256, matchesBefore, etag}. The two are separate route reads; both
        are returned and Installer._require_gate demands they agree with each other and with the plan."""
        with open(self.L.gate_helper, "rb") as f:
            need(sha(f.read()) == self.pins.gate_helper, "gate-helper-pin")
        try:
            insp = json.loads(self._run(["/usr/bin/python3", self.L.gate_helper, "inspect"], TIMEOUT["helper"]))
            st = json.loads(self._run(["/usr/bin/python3", self.L.gate_helper, "status", "--op", op], TIMEOUT["helper"]))
        except (subprocess.SubprocessError, OSError, ValueError) as e:
            raise Refusal("gate-helper-failed", error=type(e).__name__)
        need(isinstance(insp, dict) and isinstance(st, dict) and isinstance(insp.get("routesSha256"), str)
             and bool(HEX64.match(insp["routesSha256"])), "gate-helper-shape")
        return {"hash": insp["routesSha256"], "etag": insp.get("etag"), "gateIds": insp.get("gateIds"),
                "phase": st.get("phase"), "ownedGateExact": st.get("ownedGateExact"), "gateAbsent": st.get("gateAbsent"),
                "statusHash": st.get("routesSha256"), "statusEtag": st.get("etag")}

    def quarantine_probe(self, port):
        """Bounded readiness poll (6 x 5 s) of loopback GET /v1/sessions/quarantine only."""
        import urllib.request
        last = None
        for _ in range(6):
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/v1/sessions/quarantine" % port,
                                            timeout=TIMEOUT["probe"]) as r:
                    return json.loads(r.read(65536))
            except OSError as e:
                last = e
                time.sleep(5)
        raise Refusal("quarantine-probe-unavailable", error=type(last).__name__)


# ----------------------------------------------------------------------------------------------- installer
STOPPED = ("inactive", "failed")
META_KEYS = ("absent", "sha256", "size", "mode", "uid", "gid")


def file_meta(entry):
    return {k: (entry or {}).get(k) for k in META_KEYS}


class Installer:
    def __init__(self, fs, host, layout=Layout(), pins=PRODUCTION_PINS, clock=time.time, hook=None):
        self.fs, self.host, self.L, self.pins, self.clock, self.hook = fs, host, layout, pins, clock, hook
        self._seen = None  # set ONLY by _bind_candidate after a start that returned normally

    def opdir(self, op):
        need(bool(OP_RE.match(op)) and op not in CLOSED_OPS, "op-invalid")
        return "%s/%s" % (self.L.ops_root, op)

    def _secure_dir(self, a, missing="missing-directory"):
        st = self.fs.lstat(a)
        need(st is not None, missing, path=a)
        need(stat.S_ISDIR(st.st_mode), "not-directory", path=a)
        self.fs.owned(st, a, private=True)

    def _lock(self, path):
        need(self.fs.no_symlink(path), "lock-missing", path=path)
        fd = os.open(self.fs.p(path), os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            self.fs.owned(os.fstat(fd), path)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise Refusal("lock-not-acquired", path=path)
        except BaseException:
            os.close(fd)
            raise
        return fd

    # -- identity / service -----------------------------------------------------------------------------------------
    def _live_identity(self, pid, ticks):
        s = self.host.show(self.L.unit)
        need(s["ActiveState"] == "active" and s["MainPID"] == pid, "live-identity-mismatch")
        need(self.host.start_ticks(pid) == ticks, "live-identity-mismatch")
        need(self.host.proc_cgroup(pid) == s["ControlGroup"], "live-identity-mismatch")
        need(bool(INV_RE.match(s["InvocationID"])), "live-identity-mismatch")
        return {"pid": pid, "startTicks": ticks, "bootId": self.host.boot_id(), "controlGroup": s["ControlGroup"],
                "invocationId": s["InvocationID"]}

    def _require_stopped(self, ident):
        """Independently re-observed; never satisfied by a stop record. Does not stop anything itself."""
        s = self.host.show(self.L.unit)
        need(s["ActiveState"] in STOPPED and s["MainPID"] == 0, "service-not-inactive")
        for cg in {ident["controlGroup"], s["ControlGroup"] or ident["controlGroup"]}:
            need(not self.host.cgroup_pids(cg), "cgroup-not-empty")
        need(self.host.boot_id() == ident["bootId"], "boot-changed")
        # pid+startTicks (+boot): a reused PID number with other start ticks is a different process.
        need(self.host.start_ticks(ident["pid"]) != ident["startTicks"], "old-writer-identity-present")
        return s

    # -- launch configuration -------------------------------------------------------------------------------------------
    def _runtime(self):
        wrapped_argv(self.pins.exec_argv)
        return self.pins.exec_argv[0]

    def _expected_launch(self, wrapped):
        argv = list(wrapped_argv(self.pins.exec_argv) if wrapped else self.pins.exec_argv)
        wrapped_argv(self.pins.exec_argv)
        return {"execStart": {"path": argv[0], "argv": argv, "ignoreErrors": False},
                "environmentFiles": [[p, bool(i)] for p, i in self.pins.environment_files]}

    def _launch_config(self, s):
        ex = s.get("ExecStart")
        need(isinstance(ex, list) and len(ex) == 1, "execstart-not-single")
        return {"execStart": dict(ex[0]), "environmentFiles": [list(x) for x in s.get("EnvironmentFiles") or []]}

    def _launch_record(self):
        return {"loaded": self._launch_config(self.host.show(self.L.unit)), "wrapper": self.fs.digest(WRAPPER),
                "runtime": self.fs.digest(self._runtime())}

    def _current_meta(self, a):
        if self.fs.lstat(a) is None:
            return file_meta({"absent": True})
        data, st = self.fs.read(a)
        return file_meta({"sha256": sha(data), "size": len(data), "mode": st.st_mode & 0o7777, "uid": st.st_uid,
                          "gid": st.st_gid})

    def _require_launch(self, plan, pre, post, wrapped):
        """Exact launch inputs: loaded ExecStart (original, or exactly the wrapped original) and ordered EnvironmentFiles;
        pinned wrapper/runtime bytes+owner; every EnvironmentFile's bytes/size/mode/owner == pre-stop == post-stop."""
        fs, pins = self.fs, self.pins
        orig = self._expected_launch(False)
        need(pre["launch"]["loaded"] == orig and post["launch"]["loaded"] == orig, "original-launch-config-mismatch")
        need(self._launch_config(self.host.show(self.L.unit)) == self._expected_launch(wrapped),
             "loaded-launch-config-mismatch")
        for key, path in (("wrapper", WRAPPER), ("runtime", self._runtime())):
            cur = fs.digest(path)
            need(cur["uid"] == fs.uid and not cur["mode"] & 0o022, "launch-binary-not-owned", name=key)
            need(cur == pre["launch"][key] == post["launch"][key] and cur["sha256"] == plan["launch"][key + "Sha256"],
                 "launch-binary-drift", name=key)
        for p, ignore in pins.environment_files:
            need(p in pre["files"] and p in post["files"], "environment-file-not-snapshotted", path=p)
            need(not pre["files"][p].get("changedDuringCopy"), "environment-file-drift", path=p)
            cur = self._current_meta(p)
            need(file_meta(pre["files"][p]) == file_meta(post["files"][p]) == cur, "environment-file-drift", path=p)
            need(ignore or not cur["absent"], "environment-file-missing", path=p)

    # -- snapshots ----------------------------------------------------------------------------------------------------
    def _state_files(self):
        L, fs, out = self.L, self.fs, []
        need(fs.no_symlink(L.state_dir), "missing-directory", path=L.state_dir)
        for d, dirs, files in os.walk(fs.p(L.state_dir), followlinks=False):
            for n in dirs + files:
                st = os.lstat(os.path.join(d, n))
                need(not stat.S_ISLNK(st.st_mode), "symlink-in-state")
                need(stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode), "special-file-in-state")
            for n in files:
                full = os.path.join(d, n)
                out.append(full if fs.root == "/" else full[len(fs.root):])
            need(len(out) <= MAX_STATE_FILES, "state-walk-bound")
        return sorted(out)

    def _baseline_paths(self):
        L = self.L
        names = self.fs.listdir(L.dropin_dir)
        for n in names:
            st = self.fs.lstat(L.dropin_dir + "/" + n)
            need(stat.S_ISREG(st.st_mode) and bool(CONF_RE.match(n)), "dropin-dir-unexpected-entry")
        return ([L.relay_dir + "/" + n for n in sorted(self.pins.candidate)]
                + [L.relay_dir + "/" + n for n in sorted(self.pins.protected)]
                + [L.unit_file] + [L.dropin_dir + "/" + n for n in names]
                + [p for p, _ in self.pins.environment_files] + self._state_files())

    def snapshot(self, op, label, pid=None, start_ticks=None, stop_record_sha256=None):
        """pre-stop: live original identity + private environ (taken BEFORE the independent stop).
        post-stop: re-observes writer death, fsyncs actual journal/index, immutable private copy with readback.
        Both record the loaded launch config and wrapper/runtime digests; EnvironmentFiles are copied privately."""
        fs, L = self.fs, self.L
        od = self.opdir(op)
        if label == "pre-stop":
            need(is_int(pid) and is_int(start_ticks), "snapshot-args")
            self._secure_dir(L.ops_root)
            ident = self._live_identity(pid, start_ticks)
            launch = self._launch_record()
            fs.mkdir_private(od)  # exclusive: a fresh, never-reused operation
            fs.mkdir_private(od + "/snapshots")
        elif label == "post-stop":
            need(isinstance(stop_record_sha256, str) and bool(HEX64.match(stop_record_sha256)), "snapshot-args")
            self._secure_dir(od)
            pre = self._load_snapshot(op, "pre-stop", None)
            ident = pre["identity"]
            self._require_stopped(ident)
            launch = self._launch_record()
            for n in (JOURNAL, INDEX):
                if fs.lstat(L.state_dir + "/" + n) is not None:
                    fs.fsync_path(L.state_dir + "/" + n, directory=False)
            fs.fsync_path(L.state_dir)
        else:
            raise Refusal("snapshot-args")
        sd = "%s/snapshots/%s" % (od, label)
        fs.mkdir_private(sd)
        entries, changed = {}, 0
        for a in self._baseline_paths():
            st = fs.lstat(a)
            if st is None:
                entries[a] = {"absent": True}
                continue
            data, st = fs.read(a)
            fs.makedirs_private(sd + "/files" + os.path.dirname(a), sd)
            fs.write_new(sd + "/files" + a, data, 0o600)
            after = fs.hash_or_absent(a)
            e = {"sha256": sha(data), "size": len(data), "mode": st.st_mode & 0o7777, "uid": st.st_uid, "gid": st.st_gid}
            if after != e["sha256"]:
                need(label == "pre-stop", "changed-after-stop", path=a)  # a live copy is not atomic; keep both hashes
                e["changedDuringCopy"], e["sha256After"] = True, after
                changed += 1
            entries[a] = e
        doc = {"schema": SNAP_SCHEMA, "op": op, "label": label, "takenAtUnix": int(self.clock()), "identity": ident,
               "stopRecordSha256": stop_record_sha256, "environSha256": None, "files": entries, "launch": launch}
        if label == "pre-stop":
            env = self.host.environ(pid)
            need(self.host.start_ticks(pid) == start_ticks, "identity-changed-during-snapshot")
            fs.write_new(sd + "/environ.bin", env, 0o600)
            doc["environSha256"] = sha(env)
        else:
            self._require_stopped(ident)
        data = canon(doc)
        fs.write_new(sd + "/MANIFEST.json", data, 0o600)
        fs.fsync_path(sd)
        fs.fsync_path(od + "/snapshots")
        return {"label": label, "manifestSha256": sha(data), "files": len(entries), "changedDuringCopy": changed}

    def _load_snapshot(self, op, label, pin):
        fs = self.fs
        sd = "%s/snapshots/%s" % (self.opdir(op), label)
        data, st = fs.read(sd + "/MANIFEST.json", missing="snapshot-missing")
        fs.owned(st, sd, private=True)
        need(pin is None or sha(data) == pin, "snapshot-hash-mismatch", label=label)
        doc = json.loads(data)
        need(doc.get("schema") == SNAP_SCHEMA and doc.get("op") == op and doc.get("label") == label
             and isinstance(doc.get("launch"), dict), "snapshot-binding", label=label)
        for a, e in doc["files"].items():
            if e.get("absent"):
                continue
            need(fs.lstat(sd + "/files" + a) is not None, "snapshot-copy-missing", label=label)
            copy, cst = fs.read(sd + "/files" + a)
            fs.owned(cst, a, private=True)
            need(sha(copy) == e["sha256"], "snapshot-copy-mismatch", label=label)
        if label == "pre-stop":
            env, est = fs.read(sd + "/environ.bin", missing="snapshot-environ-missing")
            fs.owned(est, sd, private=True)
            need(sha(env) == doc["environSha256"], "snapshot-environ-mismatch")
        return doc

    # -- bound evidence -----------------------------------------------------------------------------------------------
    def _bound(self, ref, op, ident, missing, **extra):
        data, st = self.fs.read(ref["path"], missing=missing)
        self.fs.owned(st, ref["path"])
        need(sha(data) == ref["sha256"], missing.replace("missing", "hash-mismatch"))
        doc = json.loads(data)
        base = {k: ident[k] for k in ("pid", "startTicks", "bootId")}
        need(isinstance(doc, dict) and doc.get("op") == op and doc.get("baseline") == base
             and all(doc.get(k) == v for k, v in extra.items()), missing.replace("missing", "binding"))
        return ref["sha256"]

    def _require_marker(self, op, plan):
        return self._bound(plan["holdMarker"], op, plan["oldIdentity"], "hold-marker-missing",
                           phase="financial-hold", preStopSnapshotSha256=plan["preStopSnapshotSha256"])

    def _require_gate(self, op, plan):
        """Owned gate exactly present (status + inspect gateIds) and routes CAS: inspect and status reads agree with each
        other AND with the plan's routesSha256/etag."""
        g = self.host.gate_status(op) or {}
        need(g.get("phase") == "gate-verified" and g.get("ownedGateExact") is True and g.get("gateAbsent") is False
             and g.get("gateIds") == [GATE_ID_PREFIX + op], "gate-not-owned")
        need(g.get("hash") == plan["gate"]["hash"] and g.get("etag") == plan["gate"]["etag"]
             and g.get("statusHash") == g.get("hash") and g.get("statusEtag") == g.get("etag"), "gate-cas-mismatch")

    # -- current-state checks -----------------------------------------------------------------------------------------
    def _require_targets(self, expect, code):
        for n, h in expect.items():
            need(self.fs.hash_or_absent(self.L.relay_dir + "/" + n) == h, code, name=n)

    def _require_unit_files(self, plan, op, with_dropin):
        L = self.L
        orig = sorted(os.path.basename(p) for p in plan["unitFiles"] if p != L.unit_file)
        want = sorted(orig + [plan["dropInName"]]) if with_dropin else orig
        need(self.fs.listdir(L.dropin_dir) == want, "dropin-drift")
        for p, h in plan["unitFiles"].items():
            need(self.fs.hash_or_absent(p) == h, "unit-or-dropin-drift")
        if with_dropin:
            need(self.fs.hash_or_absent(L.dropin_dir + "/" + plan["dropInName"])
                 == sha(dropin_bytes(op, self.pins.exec_argv)), "owned-dropin-drift")

    def _require_state_unchanged(self, post):
        prefix = self.L.state_dir + "/"
        want = {a: e["sha256"] for a, e in post["files"].items() if a.startswith(prefix)}
        have = {a: self.fs.hash_or_absent(a) for a in self._state_files()}
        need(have == want, "financial-state-changed-after-stop")

    def _require_journal_unchanged(self, post):
        a = self.L.state_dir + "/" + JOURNAL
        e = post["files"].get(a, {"absent": True})
        need(self.fs.hash_or_absent(a) == ("absent" if e.get("absent") else e["sha256"]), "relayer-journal-changed")

    # -- apply ----------------------------------------------------------------------------------------------------------
    def _load_plan(self, op, plan_sha256, fresh):
        data, st = self.fs.read(self.opdir(op) + "/plan.json", missing="plan-missing")
        self.fs.owned(st, "plan.json", private=True)
        need(sha(data) == plan_sha256, "plan-hash-mismatch")
        return validate_plan(json.loads(data), op, self.pins, self.L, self.clock() if fresh else None)

    def _preflight(self, op, plan):
        fs, L, pins = self.fs, self.L, self.pins
        ident = plan["oldIdentity"]
        self._require_stopped(ident)
        self._require_gate(op, plan)
        ev = {"holdMarkerSha256": self._require_marker(op, plan),
              "stopRecordSha256": self._bound(plan["stopRecord"], op, ident, "stop-record-missing"),
              "checkpointEvidenceSha256": self._bound(plan["checkpointEvidence"], op, ident, "checkpoint-evidence-missing")}
        pre = self._load_snapshot(op, "pre-stop", plan["preStopSnapshotSha256"])
        post = self._load_snapshot(op, "post-stop", plan["postStopSnapshotSha256"])
        need(pre["identity"] == ident and post["identity"] == ident, "snapshot-identity-mismatch")
        need(post["stopRecordSha256"] == plan["stopRecord"]["sha256"], "post-stop-not-bound-to-stop-record")
        env, _ = fs.read(self.opdir(op) + "/snapshots/pre-stop/environ.bin")
        need(not any(k.encode() in parse_env(env) for k, _ in DROPIN_ENV), "original-env-has-quarantine-keys")
        # source / unit / drop-in drift: current == plan == pre-stop == post-stop
        h = lambda doc, a: "absent" if doc["files"].get(a, {"absent": True}).get("absent") else doc["files"][a]["sha256"]
        self._require_unit_files(plan, op, with_dropin=False)
        for a, want in plan["unitFiles"].items():
            need(h(pre, a) == want and h(post, a) == want, "unit-or-dropin-drift")
        need(sorted(a for a in pre["files"] if a.startswith(L.dropin_dir + "/"))
             == sorted(a for a in plan["unitFiles"] if a != L.unit_file), "dropin-drift")
        self._require_launch(plan, pre, post, wrapped=False)
        expect = dict(plan["baselineTargets"])
        self._require_targets(expect, "source-drift")
        self._require_targets(pins.protected, "protected-drift")
        for n, want in list(expect.items()) + list(pins.protected.items()):
            a = L.relay_dir + "/" + n
            need(h(pre, a) == want and h(post, a) == want, "source-drift", name=n)
        self._require_state_unchanged(post)
        # stage: owned, not writable by others, exact pins, bytes kept for the install
        self._stage = {}
        for n, want in pins.candidate.items():
            data, st = fs.read(L.stage_dir + "/" + n, missing="stage-missing")
            fs.owned(st, L.stage_dir + "/" + n)
            need(sha(data) == want, "stage-pin-mismatch", name=n)
            self._stage[n] = data
        sst = fs.lstat(L.relay_dir + "/sessions.mjs")
        self._meta = (sst.st_mode & 0o7777, (sst.st_uid, sst.st_gid))
        ust = fs.lstat(L.unit_file)
        self._unit_owner = (ust.st_uid, ust.st_gid)
        self._env, self._pre, self._post, self._seen = env, pre, post, None
        changed = sum(1 for a in set(pre["files"]) | set(post["files"])
                      if a.startswith(L.state_dir + "/") and h(pre, a) != h(post, a))
        ev.update(preStopSnapshotSha256=plan["preStopSnapshotSha256"], postStopSnapshotSha256=plan["postStopSnapshotSha256"],
                  originalEnvironSha256=sha(env), relayerJournalPostStop=h(post, L.state_dir + "/" + JOURNAL),
                  stateFilesChangedPreToPost=changed, coverageEvaluated=False, gateCas=dict(plan["gate"]),
                  launchPins=dict(plan["launch"]), environmentFiles=len(pins.environment_files))
        return ev

    def apply(self, op, plan_sha256):
        fs = self.fs
        od = self.opdir(op)
        self._secure_dir(od)
        plan = self._load_plan(op, plan_sha256, fresh=True)
        idir = od + "/install-r2"
        need(fs.lstat(idir) is None, "op-already-attempted")  # no blind rerun: use inspect / rollback
        lock = self._lock(plan["lockPath"])
        try:
            ev = self._preflight(op, plan)
            fs.mkdir_private(idir)
            rec = Record(fs, idir, op, self.hook)
            rec.save("preflight-verified", planSha256=plan_sha256, writesResumed=False, intakeEnabled=False, **ev)
            return self._install_and_start(op, plan, rec)
        finally:
            os.close(lock)

    def _install_and_start(self, op, plan, rec):
        fs, L, pins = self.fs, self.L, self.pins
        try:
            rec.save("sources-installing", installed=[])
            installed = []
            for n in sorted(pins.candidate):
                a, base = L.relay_dir + "/" + n, plan["baselineTargets"][n]
                if base == pins.candidate[n]:
                    continue
                mode, owner = self._meta
                if base == "absent":
                    fs.write_new(a, self._stage[n], mode, owner)
                else:
                    fs.replace(a, self._stage[n], mode, owner, base)
                installed.append(n)
                rec.save("sources-installing", installed=list(installed))
            self._require_targets(pins.candidate, "installed-source-mismatch")
            self._require_targets(pins.protected, "protected-drift")
            rec.save("sources-installed")
            self._require_unit_files(plan, op, with_dropin=False)
            db = dropin_bytes(op, pins.exec_argv)
            fs.write_new(L.dropin_dir + "/" + plan["dropInName"], db, 0o644, self._unit_owner)
            self._require_unit_files(plan, op, with_dropin=True)
            rec.save("dropin-written", dropInSha256=sha(db))
            rec.save("reload-unknown")
            self.host.daemon_reload()
            s = self.host.show(L.unit)
            need(s["DropInPaths"] == sorted([p for p in plan["unitFiles"] if p != L.unit_file]
                                            + [L.dropin_dir + "/" + plan["dropInName"]]), "dropin-set-after-reload")
            # the loaded ExecStart must be exactly the wrapped original (a later-sorting drop-in could override ours)
            self._require_launch(plan, self._pre, self._post, wrapped=True)
            # fresh re-checks immediately before the single start
            before = self._require_stopped(plan["oldIdentity"])
            self._require_gate(op, plan)
            self._require_marker(op, plan)
            self._require_state_unchanged(self._post)
            self._require_targets(pins.candidate, "installed-source-mismatch")
            self._require_unit_files(plan, op, with_dropin=True)
            self._require_launch(plan, self._pre, self._post, wrapped=True)
        except Exception as e:
            rec.save("failed-before-start-retained", refusal=getattr(e, "code", type(e).__name__), originalStarted=False,
                     candidateStarted=False)
            raise
        prior = before["InvocationID"]
        rec.save("start-unknown", priorInvocationId=prior)
        try:
            self.host.start(L.unit)
            # reached only when `systemctl start` returned normally; an exception above leaves _seen None (unknown)
            self._seen = self._bind_candidate(op, plan, prior)
            rec.save("candidate-bound", candidateBinding=dict(self._seen))
            cand = self._verify_candidate(op, plan, self._seen)
        except Exception as e:
            return self._fail_after_start(op, plan, rec, prior, e)
        rec.save("quarantine-running-gate-retained", candidate=cand, writesResumed=False, intakeEnabled=False,
                 gateRetained=True, holdMarkerRetained=True, originalStarted=False, launchOfOriginalPermitted=False,
                 fundingConfigTreatedAsActivation=False, coverageEvaluated=False)
        return rec.doc

    def _bind_candidate(self, op, plan, prior):
        """Positive binding of the invocation this start produced: new invocation (not prior/old), not the old pid+ticks,
        loaded ExecStart exactly wrapped, /proc cgroup == unit cgroup, exe == pinned runtime, environ INVOCATION_ID ==
        unit InvocationID, both quarantine flags in force, candidate sources and owned drop-in in place, stable ticks."""
        L, old = self.L, plan["oldIdentity"]
        s = self.host.show(L.unit)
        need(s["ActiveState"] == "active" and s["SubState"] == "running", "candidate-not-running")
        pid, inv, cg = s["MainPID"], s["InvocationID"], s["ControlGroup"]
        need(pid > 0 and bool(INV_RE.match(inv or "")) and inv not in (prior, old["invocationId"]),
             "candidate-invocation-not-new")
        ticks = self.host.start_ticks(pid)
        need(ticks is not None and (pid, ticks) != (old["pid"], old["startTicks"]), "candidate-is-old-identity")
        need(self._launch_config(s) == self._expected_launch(True), "loaded-launch-config-mismatch")
        need(bool(cg) and self.host.proc_cgroup(pid) == cg and pid in (self.host.cgroup_pids(cg) or []),
             "candidate-cgroup-mismatch")
        need(self.host.exe(pid) == self._runtime(), "candidate-exe-not-runtime")
        env = self.host.environ(pid)
        penv = parse_env(env)
        need(penv.get(b"INVOCATION_ID") == inv.encode(), "candidate-invocation-not-bound")
        need(all(penv.get(k.encode()) == v.encode() for k, v in DROPIN_ENV), "candidate-flags-not-in-force")
        self._require_targets(self.pins.candidate, "installed-source-mismatch")
        self._require_unit_files(plan, op, with_dropin=True)
        need(self.host.start_ticks(pid) == ticks and self.host.show(L.unit)["InvocationID"] == inv,
             "candidate-identity-changed")
        return {"pid": pid, "startTicks": ticks, "invocationId": inv, "controlGroup": cg, "environSha256": sha(env)}

    def _verify_candidate(self, op, plan, seen):
        L, pid, inv = self.L, seen["pid"], seen["invocationId"]
        env = self.host.environ(pid)
        need(sha(env) == seen["environSha256"], "candidate-identity-changed")
        problems = env_problems(self._env, env, dict(DROPIN_ENV), inv)
        need(not problems, "candidate-environment", problems=problems)
        self._require_targets(self.pins.candidate, "installed-source-mismatch")
        self._require_targets(self.pins.protected, "protected-drift")
        self._require_unit_files(plan, op, with_dropin=True)
        self._require_launch(plan, self._pre, self._post, wrapped=True)
        need(quarantine_probe_ok(self.host.quarantine_probe(plan["probePort"])), "quarantine-not-immutable-on")
        self._require_journal_unchanged(self._post)
        self._require_gate(op, plan)
        self._require_marker(op, plan)
        s2 = self.host.show(L.unit)
        need(s2["MainPID"] == pid and s2["InvocationID"] == inv and self.host.start_ticks(pid) == seen["startTicks"],
             "candidate-identity-changed")
        return {"pid": pid, "startTicks": seen["startTicks"], "invocationId": inv, "controlGroup": seen["controlGroup"],
                "environmentPreserved": True, "execStartWrapped": True, "environmentFilesUnchanged": True,
                "addedEnvKeys": sorted(k for k, _ in DROPIN_ENV), "writeQuarantine": "1", "fundingIntake": "0"}

    def _fail_after_start(self, op, plan, rec, prior, err):
        """Stop ONLY the invocation positively bound by _bind_candidate, re-verified identical now. An unknown start
        (exception from start, or binding never completed) grants NO stop authority, whatever is running: the gate and
        marker stay, nothing is stopped, manual reconciliation is recorded. Never starts the original; journals untouched."""
        L, old = self.L, plan["oldIdentity"]
        code = getattr(err, "code", type(err).__name__)
        rec.save("candidate-failed-verifying", refusal=code, writesResumed=False)
        seen = self._seen
        s = self.host.show(L.unit)
        pid, inv = s["MainPID"], s["InvocationID"]
        cg = s["ControlGroup"] or (seen or {}).get("controlGroup") or old["controlGroup"]
        if s["ActiveState"] in STOPPED and pid == 0 and not self.host.cgroup_pids(cg):
            rec.save("failed-candidate-not-running-original-stopped", candidateStopped=False, originalStarted=False,
                     gateRetained=True, holdMarkerRetained=True)
            raise Refusal(code, phase=rec.doc["phase"])
        if seen is None:
            rec.save("failed-unknown-retained-manual-reconciliation", candidateStopped=False, originalStarted=False,
                     gateRetained=True, holdMarkerRetained=True, manualReconciliationRequired=True,
                     observedMainPid=pid, observedInvocationId=inv)
            raise Refusal("candidate-unbound-not-stopped", cause=code, phase=rec.doc["phase"])
        ours, ticks = False, None
        try:
            ticks = self.host.start_ticks(pid) if pid > 0 else None
            env = self.host.environ(pid) if ticks is not None else None
            now = {"pid": pid, "startTicks": ticks, "invocationId": inv, "controlGroup": s["ControlGroup"],
                   "environSha256": sha(env) if env is not None else None}
            ours = (ticks is not None and now == seen and self.host.proc_cgroup(pid) == seen["controlGroup"]
                    and pid in (self.host.cgroup_pids(seen["controlGroup"]) or [])
                    and self._launch_config(s) == self._expected_launch(True) and self.host.start_ticks(pid) == ticks)
        except Exception:
            ours = False
        if not ours:
            rec.save("failed-ambiguous-retained-manual-reconciliation", candidateStopped=False, originalStarted=False,
                     gateRetained=True, holdMarkerRetained=True, manualReconciliationRequired=True,
                     observedMainPid=pid, observedInvocationId=inv)
            raise Refusal("candidate-unverified-not-stopped", cause=code, phase=rec.doc["phase"])
        rec.save("candidate-stop-unknown", stoppingInvocationId=inv)
        try:
            self.host.stop(L.unit)
        except Exception as e:
            raise Refusal("candidate-stop-unknown", cause=type(e).__name__, phase=rec.doc["phase"])
        s2 = self.host.show(L.unit)
        stopped = (s2["ActiveState"] in STOPPED and s2["MainPID"] == 0 and not self.host.cgroup_pids(cg)
                   and self.host.start_ticks(pid) != ticks)
        rec.save("failed-candidate-stopped-original-stopped" if stopped else "candidate-stop-unverified-retained",
                 candidateStopped=stopped, originalStarted=False, gateRetained=True, holdMarkerRetained=True)
        raise Refusal(code, phase=rec.doc["phase"])

    # -- rollback (separate command; STOPPED only; exact CAS) -----------------------------------------------------------
    def rollback(self, op, expected_state_sha256):
        """Restores selected source/config bytes while stopped. Never starts anything; never touches financial state,
        gate, marker or EnvironmentFiles. launchPermitted is always false: any later start is a separate decision."""
        fs, L, pins = self.fs, self.L, self.pins
        idir = self.opdir(op) + "/install-r2"
        data, _ = fs.read(idir + "/state.json", missing="no-install-record")
        need(sha(data) == expected_state_sha256, "state-cas-mismatch")
        doc = json.loads(data)
        need(doc.get("phase") != "rolled-back-stopped", "already-rolled-back")
        plan = self._load_plan(op, doc["facts"]["planSha256"], fresh=False)
        lock = self._lock(plan["lockPath"])
        try:
            self._require_stopped(plan["oldIdentity"])
            for k in ("candidate", "candidateBinding"):
                cand = doc["facts"].get(k)
                if cand:
                    need(self.host.start_ticks(cand["pid"]) != cand["startTicks"], "candidate-identity-present")
            pre = self._load_snapshot(op, "pre-stop", plan["preStopSnapshotSha256"])
            rec = Record(fs, idir, op, self.hook, doc=doc, last=expected_state_sha256)
            rec.save("rollback-started")
            restored = []
            for n in sorted(pins.candidate):
                a, base = L.relay_dir + "/" + n, plan["baselineTargets"][n]
                cur = fs.hash_or_absent(a)
                if cur == base:
                    continue
                need(cur == pins.candidate[n], "rollback-cas", name=n)
                if base == "absent":
                    fs.unlink_cas(a, cur)
                else:
                    e = pre["files"][a]
                    orig, _ = fs.read("%s/snapshots/pre-stop/files%s" % (self.opdir(op), a))
                    need(sha(orig) == base == e["sha256"], "rollback-source-snapshot")
                    fs.replace(a, orig, e["mode"], (e["uid"], e["gid"]), cur)
                restored.append(n)
            dp = L.dropin_dir + "/" + plan["dropInName"]
            if fs.lstat(dp) is not None:
                fs.unlink_cas(dp, sha(dropin_bytes(op, pins.exec_argv)))
            self._require_unit_files(plan, op, with_dropin=False)
            self._require_targets(plan["baselineTargets"], "rollback-incomplete")
            self.host.daemon_reload()
            s = self.host.show(L.unit)
            need(s["DropInPaths"] == sorted(p for p in plan["unitFiles"] if p != L.unit_file), "dropin-set-after-reload")
            need(self._launch_config(s) == self._expected_launch(False), "loaded-launch-config-mismatch")
            self._require_stopped(plan["oldIdentity"])
            rec.save("rolled-back-stopped", restored=restored, launchPermitted=False, originalStarted=False,
                     gateRetained=True, holdMarkerRetained=True, financialStateTouched=False, writesResumed=False)
            return rec.doc
        finally:
            os.close(lock)

    # -- inspect (read-only) --------------------------------------------------------------------------------------------
    def inspect(self, op):
        fs, L = self.fs, self.L
        od = self.opdir(op)
        out = {"op": op, "opDir": fs.lstat(od) is not None, "phase": None, "snapshots": {}, "leftoverTemps": []}
        for label in ("pre-stop", "post-stop"):
            m = "%s/snapshots/%s/MANIFEST.json" % (od, label)
            out["snapshots"][label] = sha(fs.read(m)[0]) if fs.lstat(m) is not None else None
        sp = od + "/install-r2/state.json"
        if fs.lstat(sp) is not None:
            data, _ = fs.read(sp)
            doc = json.loads(data)
            out.update(phase=doc["phase"], stateSha256=sha(data), facts=doc["facts"], history=doc["history"])
        for d in (L.relay_dir, L.dropin_dir, od + "/install-r2"):
            if fs.lstat(d) is not None:
                out["leftoverTemps"] += [d + "/" + n for n in fs.listdir(d) if n.endswith(".qr2.tmp")]
        return out


# ----------------------------------------------------------------------------------------------- CLI
def main(argv=None, out=None):
    out = out or sys.stdout
    ap = argparse.ArgumentParser(description="r2 post-stop quarantine installer (root-reviewed use only)")
    ap.add_argument("--root", required=True, help='explicit filesystem root; production is exactly "/"')
    ap.add_argument("--apply", action="store_true", help="required for any mutating command on /")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("snapshot")
    s.add_argument("--op", required=True)
    s.add_argument("--label", required=True, choices=["pre-stop", "post-stop"])
    s.add_argument("--pid", type=int)
    s.add_argument("--start-ticks", type=int)
    s.add_argument("--stop-record-sha256")
    a = sub.add_parser("apply")
    a.add_argument("--op", required=True)
    a.add_argument("--plan-sha256", required=True)
    r = sub.add_parser("rollback")
    r.add_argument("--op", required=True)
    r.add_argument("--expected-state-sha256", required=True)
    i = sub.add_parser("inspect")
    i.add_argument("--op", required=True)
    args = ap.parse_args(argv)
    try:
        # Owned temp roots are library-only (tests inject a unit-test host); never point real systemctl at a fake tree.
        need(os.path.realpath(args.root) == "/", "non-default-root-is-library-only")
        need(os.geteuid() == 0, "default-root-needs-root-uid")
        need(args.apply or args.cmd == "inspect", "default-root-needs-apply")
        os.umask(0o077)
        L = Layout()
        inst = Installer(FS("/", 0), SystemdHost(L, PRODUCTION_PINS), L, PRODUCTION_PINS)
        if args.cmd == "snapshot":
            res = inst.snapshot(args.op, args.label, args.pid, args.start_ticks, args.stop_record_sha256)
        elif args.cmd == "apply":
            res = inst.apply(args.op, args.plan_sha256)
        elif args.cmd == "rollback":
            res = inst.rollback(args.op, args.expected_state_sha256)
        else:
            res = inst.inspect(args.op)
        out.write(canon({"ok": True, "result": res}).decode())
        return 0
    except Refusal as e:
        out.write(canon({"ok": False, "refusal": e.code, "facts": e.facts}).decode())
        return 2


if __name__ == "__main__":
    sys.exit(main())
