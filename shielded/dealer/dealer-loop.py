#!/usr/bin/env python3
"""The dealer's loop (shielded/dealer/PLAN.md P3): keep one pVM's bank of pad
shipments ahead of its ledger mark, mint missing delivery ranges, prune only acknowledged files.

  dealer-loop.py --relay https://api.enclave.host --name pixel-1 --master <hex64> \
                 --model model.gguf --calib model.calib --out /bank [--ahead 256] [--chunk 64] [--once]
  dealer-loop.py --seed <hex64> --seed-id <hex32> --pk <hex64> --mark N ...      (offline: no relay)
  dealer-loop.py --derive-only --master <hex64> --keyfp <hex64> [--epoch 1]     (prints seed + seed_id)
  dealer-loop.py --plan-only --out DIR --seed-id ID --mark N [--ahead --chunk]   (prints the ranges it would mint)

Environment for the minting tool: DEALER (path to shielded-dealer), SHIELDED_SO,
GGML_CPU_SO, LD_LIBRARY_PATH. The seed is derived exactly as relay/pads.mjs does
(HKDF-SHA512, salt = keyFp bytes, info "enclave-pads-seed:<epoch>"); the master
seed is the platform's secret and never leaves the dealer's process.
"""
import argparse, atexit, fcntl, hashlib, hmac, json, math, os, re, select, stat, subprocess, sys, tempfile, threading, time, urllib.error, urllib.request


def hkdf_sha512(ikm: bytes, salt: bytes, info: bytes, length: int) -> bytes:
    prk = hmac.new(salt, ikm, hashlib.sha512).digest()
    out, t, ctr = b"", b"", 1
    while len(out) < length:
        t = hmac.new(prk, t + info + bytes([ctr]), hashlib.sha512).digest()
        out += t; ctr += 1
    return out[:length]


def derive_seed(master_hex: str, keyfp_hex: str, epoch: int = 1):
    master, keyfp = bytes.fromhex(master_hex), bytes.fromhex(keyfp_hex)
    seed = hkdf_sha512(master, keyfp, f"enclave-pads-seed:{epoch}".encode(), 32)
    seed_id = hkdf_sha512(master, keyfp, f"enclave-pads-seed-id:{epoch}".encode(), 16).hex()
    return seed.hex(), seed_id


PAD_INDEX_LIMIT = 1 << 24
NAME_RE = re.compile(r"^([0-9a-f]{32})-(0|[1-9][0-9]*)-([1-9][0-9]*)\.pads$")
DIGEST_RE = re.compile(r"[0-9a-f]{64}")


class AssetIdentity:
    """Identity of trusted publisher inputs, cached while their file metadata
    stays unchanged. The dealer's model/calibration storage must be immutable
    while the minting subprocess uses it; this is not an adversarial pager."""
    def __init__(self, model, calib):
        self.model, self.calib, self.cache = model, calib, {}

    def digest(self, path, algorithm):
        if not path:
            raise ValueError("missing local model or calibration")
        def stamp(st):
            return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns
        current = stamp(os.stat(path))
        key = (path, algorithm)
        if key in self.cache and self.cache[key][0] == current:
            return self.cache[key][1]
        h = hashlib.new(algorithm)
        with open(path, "rb") as f:
            before = stamp(os.fstat(f.fileno()))
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
            if stamp(os.fstat(f.fileno())) != before or stamp(os.stat(path)) != before:
                raise ValueError("local asset changed while hashing")
        if before[2] <= 0:
            raise ValueError("local asset is empty")
        value = h.digest()[:32].hex()
        self.cache[key] = (before, value)
        return value

    def mismatch(self, consumer, allow_unbound=False):
        md, cd = consumer.get("model_digest"), consumer.get("calib_digest")
        if md is None and cd is None and allow_unbound:
            return None
        if not isinstance(md, str) or not DIGEST_RE.fullmatch(md) or not isinstance(cd, str) or not DIGEST_RE.fullmatch(cd):
            return "missing or invalid grant asset identities"
        try:
            if self.digest(self.model, "sha256") != md:
                return "local model SHA256 differs from the consumer grant"
            if self.digest(self.calib, "sha512") != cd:
                return "local calibration SHA512/256 differs from the consumer grant"
        except (OSError, ValueError) as e:
            return f"cannot identify local assets: {e}"
        return None

def valid_range(index0, count):
    return type(index0) is int and type(count) is int and 0 <= index0 < PAD_INDEX_LIMIT and 0 < count <= PAD_INDEX_LIMIT - index0



def shipments(out_dir: str, seed_id: str):
    """(index0, count, path) of every shipment of this seed in the bank."""
    found = []
    for n in os.listdir(out_dir) if os.path.isdir(out_dir) else []:
        m = NAME_RE.match(n)
        if m and m.group(1) == seed_id and valid_range(int(m.group(2)), int(m.group(3))):
            found.append((int(m.group(2)), int(m.group(3)), os.path.join(out_dir, n)))
    return sorted(found)


def plan(existing, mark: int, ahead: int, chunk: int, ack_floor: int = 0, acked=(), max_pending: int = 1024):
    """Cover missing delivery from ack_floor through mark+ahead, not from mark.
    Emit exact gaps split at chunk boundaries, never re-mint acknowledged indices.
    The pending cap bounds retention when old consumers cannot acknowledge."""
    if any(type(x) is not int for x in (mark, ahead, chunk, ack_floor, max_pending)) or not (0 <= mark <= PAD_INDEX_LIMIT and 0 <= ack_floor <= PAD_INDEX_LIMIT and 0 < ahead <= PAD_INDEX_LIMIT and 0 < chunk <= PAD_INDEX_LIMIT and 0 < max_pending <= PAD_INDEX_LIMIT):
        raise ValueError("invalid pad planning bounds")
    previous = ack_floor
    if not isinstance(acked, (tuple, list)) or len(acked) > 64:
        raise ValueError("invalid acknowledgment ranges")
    for pair in acked:
        if not isinstance(pair, (tuple, list)) or len(pair) != 2 or not valid_range(pair[0], pair[1] - pair[0]) or pair[0] <= previous:
            raise ValueError("invalid acknowledgment range")
        previous = pair[1]
    covered = sorted([(i0, i0 + c) for i0, c, _ in existing if valid_range(i0, c)] + list(map(tuple, acked)))
    horizon = min(PAD_INDEX_LIMIT, ((mark + ahead + chunk - 1) // chunk) * chunk, ack_floor + max_pending)
    want, cursor = [], ack_floor
    def gap(end):
        nonlocal cursor
        while cursor < end:
            stop = min(end, ((cursor // chunk) + 1) * chunk)
            want.append((cursor, stop - cursor)); cursor = stop
    for lo, hi in covered:
        if hi <= cursor: continue
        if lo >= horizon: break
        if cursor < lo: gap(min(lo, horizon))
        cursor = max(cursor, hi)
    if cursor < horizon: gap(horizon)
    delivered = [p for i0, c, p in existing if valid_range(i0, c) and i0 + c <= ack_floor]
    return want, delivered


def relay_get(base: str, path: str):
    with urllib.request.urlopen(base.rstrip("/") + path, timeout=30) as r:
        return json.loads(r.read().decode())


def relay_put_file(base: str, seed_id: str, path: str, token: str):
    """Stream one shipment into the platform's store; the relay renames it only if the sha256 matches."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""): h.update(chunk)
    url = f"{base.rstrip('/')}/v1/pads/shipments/{seed_id}/{os.path.basename(path)}?sha256={h.hexdigest()}"
    with open(path, "rb") as f:
        req = urllib.request.Request(url, data=f, method="PUT", headers={"Authorization": "Bearer " + token, "Content-Length": str(os.path.getsize(path)), "Content-Type": "application/octet-stream"})
        with urllib.request.urlopen(req, timeout=3600) as r:
            return json.loads(r.read().decode())


def relay_delete(base: str, seed_id: str, name: str, token: str):
    req = urllib.request.Request(f"{base.rstrip('/')}/v1/pads/shipments/{seed_id}/{name}", method="DELETE", headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return r.status
    except urllib.error.HTTPError as e: return e.code


_HEX_RE = re.compile(r"^[0-9a-f]+$")
_JOURNAL_NAME = ".dealer-loop.journal"
_UINT64_MAX = (1 << 64) - 1
_PROTO_INDEX_LIMIT = 1 << 24
_PROTO_MAX_COUNT = 4096

def _is_int(x): return type(x) is int          # exact: neither bool nor float (1.0 must not pass as 1)
def _is_hex(x, n): return isinstance(x, str) and len(x) == n and _HEX_RE.match(x) is not None
def _finite_secs(name, v, hi=3600.0):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 < v <= hi:
        raise ValueError(f"{name} must be a finite number in (0, {hi}]")
    return float(v)

def _write_all(fd, data, deadline):
    """Write every byte to a NONBLOCKING fd before the absolute monotonic deadline; TimeoutError past it."""
    view = memoryview(data); off = 0
    while off < len(view):
        left = deadline - time.monotonic()
        if left <= 0: raise TimeoutError("write deadline")
        if not select.select([], [fd], [], min(left, 1.0))[1]: continue
        try: off += os.write(fd, view[off:])
        except BlockingIOError: continue

def _read_line(fd, buf, deadline, line_max):
    """One LF-terminated printable-ASCII line from a NONBLOCKING fd through `buf` (a bytearray). None on a
    clean EOF at a line boundary. TimeoutError past the deadline. ValueError on an oversized/unterminated
    line, an empty or non-printable line, EOF inside a line, or UNSOLICITED bytes after the line: the child
    emits exactly one line per turn, so anything more is a protocol violation, never buffered for later."""
    while True:
        k = buf.find(b"\n")
        if k >= 0:
            line = bytes(buf[:k]); del buf[:k + 1]
            if buf: raise ValueError("unsolicited output after a protocol line")
            if not line or any(c < 32 or c > 126 for c in line): raise ValueError("empty or non-printable protocol line")
            return line.decode("ascii")
        if len(buf) >= line_max: raise ValueError("oversized or unterminated protocol output")
        left = deadline - time.monotonic()
        if left <= 0: raise TimeoutError("read deadline")
        if not select.select([fd], [], [], min(left, 1.0))[0]: continue
        try: chunk = os.read(fd, line_max - len(buf))
        except BlockingIOError: continue
        if not chunk:
            if buf: raise ValueError("EOF inside a protocol line")
            return None
        buf.extend(chunk)

def _quiet(fd):
    """True when a nonblocking fd has no pending bytes or EOF: the child must be silent between turns."""
    return not select.select([fd], [], [], 0)[0]

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_PID_MAX = 4194304

def _boot_id():
    """This boot's UUID, or None when it cannot be read or is not a UUID (callers treat None as UNKNOWN)."""
    try:
        with open("/proc/sys/kernel/random/boot_id") as f: v = f.read().strip()
    except OSError: return None
    return v if _UUID_RE.match(v) else None

def _proc_start(pid):
    """('ok', starttime_ticks) for a live pid, ('zombie', ticks) for an exited-unreaped one, ('gone', None)
    ONLY when the kernel says the pid does not exist, and ('unknown', None) for every read, permission or
    parse failure - which is never mistaken for death."""
    try:
        with open(f"/proc/{pid}/stat") as f: raw = f.read()
    except (FileNotFoundError, ProcessLookupError): return ("gone", None)
    except OSError: return ("unknown", None)
    try:
        rest = raw.rsplit(")", 1)[1].split()     # fields after comm: state is rest[0], starttime is rest[19]
        state, start = rest[0], int(rest[19])
        if start < 0 or start > (1 << 63): return ("unknown", None)
    except (ValueError, IndexError): return ("unknown", None)
    return ("zombie" if state in ("Z", "X") else "ok", start)

def _child_state(boot_id, pid, start):
    """ALIVE / DEAD / UNKNOWN for one recorded child incarnation. Death is proven only by a verified boot
    change, the pid being gone, a different incarnation on the same pid, or an exited (zombie) process;
    any read/parse failure is UNKNOWN, and UNKNOWN always refuses."""
    now = _boot_id()
    if now is None: return "UNKNOWN"
    if now != boot_id: return "DEAD"                      # a reboot: no process survives it
    st, v = _proc_start(pid)
    if st == "gone": return "DEAD"
    if st == "unknown": return "UNKNOWN"
    if v != start: return "DEAD"                          # same pid, another incarnation
    return "DEAD" if st == "zombie" else "ALIVE"

def _file_state(path):
    """'present' / 'absent' (ONLY on ENOENT) / 'unknown' (any other stat failure, which refuses)."""
    try: os.lstat(path); return "present"
    except FileNotFoundError: return "absent"
    except OSError: return "unknown"

def _write_fd_all(fd, data):
    """Write every byte to a blocking fd, looping through short writes; a zero-length write is a failure."""
    view = memoryview(data); off = 0
    while off < len(view):
        k = os.write(fd, view[off:])
        if k <= 0: raise OSError("short write (zero bytes)")
        off += k

def _no_duplicate_keys(pairs):
    d = {}
    for k, v in pairs:
        if k in d: raise ValueError(f"duplicate key {k!r}")
        d[k] = v
    return d

class PersistentDealer:
    """One long-lived `shielded-dealer MODEL --jobs-stdin OUT [--mtp 1]` child, reused across refills
    (measured ~5.4x shorter refill latency than a fresh process per pass). CPU-only: the frontend refuses
    --worker in stream mode. Guarantees: exactly one job in flight (non-blocking lock); an exact READY
    (version 1, mtp mode, calib SHA512/256 vs the admitted calibration) and DONE handshake; bounded binary
    reads (LINE_MAX, printable ASCII, zero tolerance for unsolicited output) and a byte-capped stderr ring;
    the nonblocking send and the read share ONE absolute deadline; any anomaly kills AND reaps the child
    before any fd is closed; intent is journaled DURABLY (exclusive 0600 temp, fsync, no-overwrite link,
    directory fsync) BEFORE the send and cleared (unlink + directory fsync, failing closed) only after the
    exact DONE. READY/DONE carry no authority to reserve or consume, and READY mtp=1 is the SELECTED MODE,
    not a completeness attestation - full-manifest admission stays upstream."""

    READY_RE = re.compile(r"^PADS-READY 1 mtp=([01]) calib=([0-9a-f]{64})$")
    LINE_MAX = 512
    STDERR_CAP = 64 * 1024

    def __init__(self, dealer, model, calib, out, mtp, expect_calib_sha, model_sha,
                 startup_timeout=180.0, mint_timeout=120.0):
        # lifecycle fields first, so _die() is safe from every later failure path
        self.proc = None; self.dir_fd = -1; self._err_t = None; self._stop = threading.Event()
        self.seq = 0; self.dead = False; self.reaped = None; self._buf = bytearray(); self._err = bytearray()
        self._inflight = threading.Lock()
        if not (_is_hex(expect_calib_sha, 64) and _is_hex(model_sha, 64)):
            raise ValueError("persistent dealer: admitted identities must be 64 lowercase hex")
        if not (_is_int(mtp) and mtp in (0, 1)): raise ValueError("persistent dealer: mtp must be the int 0 or 1")
        self.startup_timeout = _finite_secs("startup_timeout", startup_timeout)
        self.mint_timeout = _finite_secs("mint_timeout", mint_timeout)
        if not stat.S_ISDIR(os.lstat(out).st_mode): raise ValueError("persistent dealer: OUT must be a real directory")
        self.out, self.mtp, self.model_sha, self.calib_sha = out, mtp, model_sha, expect_calib_sha
        self.journal = os.path.join(out, _JOURNAL_NAME)
        cmd = [dealer, model, "--jobs-stdin", out] + (["--mtp", "1"] if mtp else [])
        try:
            self.dir_fd = os.open(out, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            self.proc = subprocess.Popen(cmd, env={**os.environ, "SHIELDED_CALIB": calib}, stdin=subprocess.PIPE,
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
            self._in = self.proc.stdin.fileno(); self._outfd = self.proc.stdout.fileno()
            os.set_blocking(self._in, False); os.set_blocking(self._outfd, False)
            t = threading.Thread(target=self._drain_err, daemon=True); t.start(); self._err_t = t
            boot, (pst, pstart) = _boot_id(), _proc_start(self.proc.pid)
            if boot is None or pst != "ok":
                raise RuntimeError("cannot establish the child's incarnation (boot id / start time)")
            self.child = {"boot_id": boot, "child_pid": self.proc.pid, "child_start": pstart}
            line = _read_line(self._outfd, self._buf, time.monotonic() + self.startup_timeout, self.LINE_MAX)
        except (OSError, RuntimeError, TimeoutError, ValueError) as e:
            self._die(); raise RuntimeError(f"persistent dealer: startup failed, no valid READY ({e}); stderr: {self._tail()}") from None
        m = self.READY_RE.match(line or "")
        if not m:
            self._die(); raise RuntimeError(f"persistent dealer: bad READY {line!r}; stderr: {self._tail()}")
        if int(m.group(1)) != self.mtp:
            self._die(); raise RuntimeError(f"persistent dealer: READY mtp={m.group(1)} != requested {self.mtp}")
        if m.group(2) != expect_calib_sha:
            self._die(); raise RuntimeError("persistent dealer: READY calib digest differs from the admitted calibration")

    def _drain_err(self):
        fd = self.proc.stderr.fileno()
        try:
            while not self._stop.is_set():
                if not select.select([fd], [], [], 0.25)[0]: continue     # cooperative: re-check the stop flag
                chunk = os.read(fd, 4096)
                if not chunk: return
                self._err.extend(chunk)
                if len(self._err) > self.STDERR_CAP: del self._err[:len(self._err) - self.STDERR_CAP]
        except (OSError, ValueError): return

    def _tail(self): return self._err[-600:].decode("ascii", "replace").replace("\n", " | ")

    def _die(self):
        """Kill and REAP first; then stop and join the stderr drain before its fd is closed (so the thread can
        never read a reused descriptor); only then close the pipes. If the child cannot be reaped, that is
        reported as UNREAPED rather than claimed as a kill."""
        if self.dead: return
        self.dead = True; p = self.proc
        if p is not None:
            if p.poll() is None:
                for sig, wait in ((p.terminate, 3), (p.kill, 3)):
                    try: sig()
                    except OSError: pass
                    try: p.wait(timeout=wait); break
                    except subprocess.TimeoutExpired: continue
            self.reaped = p.poll() is not None
            if not self.reaped: print(f"persistent dealer: child pid {p.pid} UNREAPED after terminate+kill; its state is unknown", flush=True)
        self._stop.set()
        if self._err_t is not None: self._err_t.join(timeout=3)
        drain_alive = self._err_t is not None and self._err_t.is_alive()
        if p is not None:
            for f in (p.stdin, p.stdout) + (() if drain_alive else (p.stderr,)):
                try: f.close()
                except OSError: pass
        if drain_alive: print("persistent dealer: stderr drain did not stop; leaving its descriptor open rather than racing it", flush=True)
        if self.dir_fd >= 0:
            try: os.close(self.dir_fd)
            except OSError: pass
            self.dir_fd = -1

    def _journal_write(self, rec):
        data = (json.dumps(rec, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")
        fd, tmp = tempfile.mkstemp(dir=self.out, prefix=_JOURNAL_NAME + ".", suffix=".tmp")   # O_EXCL, 0600
        try:
            _write_fd_all(fd, data); os.fsync(fd); os.close(fd); fd = -1
            os.link(tmp, self.journal)          # atomic publish that never overwrites an existing intent
            os.fsync(self.dir_fd)
        finally:
            if fd >= 0: os.close(fd)
            try: os.unlink(tmp)
            except OSError: pass

    def _journal_clear(self):
        os.unlink(self.journal); os.fsync(self.dir_fd)   # any failure propagates: an intent never lingers silently

    def mint_range(self, seed, seed_id, pk, index0, count):
        """Mint ONE shipment: journal the intent durably, send the record, require the exact DONE, clear the
        journal, return the path. Any anomaly kills+reaps the child and leaves the adapter dead; the journal
        then blocks every mutating run on this bank until it is reconciled (see reconcile_persistent_journal)."""
        if not self._inflight.acquire(blocking=False): raise RuntimeError("persistent dealer: another job is in flight")
        try: return self._mint(seed, seed_id, pk, index0, count)
        finally: self._inflight.release()

    def _mint(self, seed, seed_id, pk, index0, count):
        if self.dead: raise RuntimeError("persistent dealer is dead; reconcile before reuse")
        if not (_is_hex(seed, 64) and _is_hex(seed_id, 32) and _is_hex(pk, 64)):
            raise RuntimeError("persistent dealer: non-canonical seed/seed_id/pk")
        if not (_is_int(index0) and _is_int(count) and 1 <= count <= _PROTO_MAX_COUNT and
                0 <= index0 < _PROTO_INDEX_LIMIT and index0 + count <= _PROTO_INDEX_LIMIT):
            raise RuntimeError(f"persistent dealer: range out of protocol bounds ({index0!r},{count!r})")
        if self.seq >= _UINT64_MAX - 1: self._die(); raise RuntimeError("persistent dealer: sequence exhausted")
        seq = self.seq + 1; deadline = time.monotonic() + self.mint_timeout
        if self.proc.poll() is not None or not _quiet(self._outfd):
            self._die(); raise RuntimeError(f"persistent dealer: child exited or spoke unsolicited before seq {seq}; stderr: {self._tail()}")
        try:
            self._journal_write({"v": 1, "seq": seq, "seed_id": seed_id, "index0": index0, "count": count, "pk": pk,
                                 "mtp": self.mtp, "model_sha256": self.model_sha, "calib_sha512": self.calib_sha,
                                 "ts": time.time(), "state": "in-flight", **self.child})
        except OSError as e:
            self._die(); raise RuntimeError(f"persistent dealer: cannot journal intent durably ({e}); refusing to send")
        record = bytearray(f"{seq}\t{seed}\t{seed_id}\t{pk}\t{index0}\t{count}\n", "ascii")
        try:
            try: _write_all(self._in, record, deadline)
            finally:
                for k in range(len(record)): record[k] = 0
            line = _read_line(self._outfd, self._buf, deadline, self.LINE_MAX)
        except (TimeoutError, ValueError, OSError) as e:
            self._die(); raise RuntimeError(f"persistent dealer: seq {seq} failed ({e}); stderr: {self._tail()}")
        expect = f"PADS-DONE {seq} {seed_id} {index0} {count}"
        if line != expect:
            self._die(); raise RuntimeError(f"persistent dealer: expected {expect!r}, got {line!r}; stderr: {self._tail()}")
        try: self._journal_clear()
        except OSError as e:
            self._die(); raise RuntimeError(f"persistent dealer: seq {seq} published but its journal cannot be cleared ({e}); the intent stays and blocks until reconciled")
        self.seq = seq
        return os.path.join(self.out, f"{seed_id}-{index0}-{count}.pads")

    def close(self):
        """Clean EOF -> the child exits 0; a child that will not exit is killed and reaped."""
        if self.dead: return
        try: self.proc.stdin.close()
        except OSError: pass
        try: rc = self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired: rc = None
        if rc != 0: print(f"persistent dealer exited {rc}; stderr: {self._tail()}", flush=True)
        self._die()


def reconcile_persistent_journal(out, model_sha=None, calib_sha=None):
    """Runs for EVERY mutating mode under the bank lock, flag or not, with NO bypass flag. The journal is
    read bounded, without following symlinks, against an exact schema with type/range/state/sequence checks,
    and its admitted model/calibration identities are compared with the local assets. It names the child
    incarnation (boot id, pid, start time) that was minting, so recovery can independently verify that the
    child is stopped:
      child still alive                -> REFUSE (an orphan is minting into this bank; stop it first)
      child stopped, file ABSENT       -> the shipment was never published and no writer can publish it now:
                                          discard the intent (unlink + directory fsync) and continue
      child stopped, file PRESENT      -> REFUSE: a name is not proof of seed/key/model/geometry; validate or
                                          remove the file by hand, then remove the journal by hand
    Never accepts a filename as proof, and never clears an intent it cannot prove is harmless."""
    path = os.path.join(out, _JOURNAL_NAME)
    try: st = os.lstat(path)
    except FileNotFoundError: return
    except OSError as e: sys.exit(f"persistent journal: cannot stat {path} ({e}); refusing every mutating operation")
    if not stat.S_ISREG(st.st_mode): sys.exit(f"persistent journal: {path} is not a regular file; refusing")
    if st.st_size > 4096: sys.exit("persistent journal: oversized; refusing")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try: raw = os.read(fd, 4097)
        finally: os.close(fd)
        rec = json.loads(raw.decode("ascii"), object_pairs_hook=_no_duplicate_keys)
    except (OSError, ValueError) as e: sys.exit(f"persistent journal: unreadable or malformed ({e}); refusing")
    keys = {"v", "seq", "seed_id", "index0", "count", "pk", "mtp", "model_sha256", "calib_sha512", "ts", "state",
            "boot_id", "child_pid", "child_start"}
    if not isinstance(rec, dict) or set(rec) != keys: sys.exit("persistent journal: unexpected schema; refusing")
    bad = []
    if not (_is_int(rec["v"]) and rec["v"] == 1): bad.append("version")
    if rec["state"] != "in-flight": bad.append("state")
    if not (_is_int(rec["seq"]) and 1 <= rec["seq"] <= _UINT64_MAX): bad.append("seq")
    i0, c = rec["index0"], rec["count"]
    if not (_is_int(i0) and _is_int(c) and 1 <= c <= _PROTO_MAX_COUNT and 0 <= i0 < _PROTO_INDEX_LIMIT and i0 + c <= _PROTO_INDEX_LIMIT): bad.append("range")
    if not (_is_hex(rec["seed_id"], 32) and _is_hex(rec["pk"], 64) and _is_hex(rec["model_sha256"], 64) and _is_hex(rec["calib_sha512"], 64)): bad.append("identities")
    if not (_is_int(rec["mtp"]) and rec["mtp"] in (0, 1)): bad.append("mtp")
    if type(rec["ts"]) not in (int, float) or not math.isfinite(rec["ts"]): bad.append("ts")
    if not (isinstance(rec["boot_id"], str) and _UUID_RE.match(rec["boot_id"]) and _is_int(rec["child_pid"]) and
            1 <= rec["child_pid"] <= _PID_MAX and _is_int(rec["child_start"]) and 0 <= rec["child_start"] <= (1 << 63)): bad.append("child")
    if bad: sys.exit(f"persistent journal: invalid fields ({', '.join(bad)}); refusing")
    ident = "matches" if (model_sha == rec["model_sha256"] and calib_sha == rec["calib_sha512"]) else "does NOT match (or cannot be checked)"
    name = f"{rec['seed_id']}-{i0}-{c}.pads"; tag = f"{rec['seq']}:{name[:-5]}"
    child = _child_state(rec["boot_id"], rec["child_pid"], rec["child_start"])
    if child == "ALIVE":
        sys.exit(f"persistent journal: UNRESOLVED intent {tag} and its dealer child pid {rec['child_pid']} is STILL RUNNING (an orphan is "
                 f"minting into this bank). Refusing every mutating operation; stop that child, then rerun.")
    if child == "UNKNOWN":
        sys.exit(f"persistent journal: UNRESOLVED intent {tag}; the state of its dealer child pid {rec['child_pid']} is UNKNOWN (boot id or "
                 f"/proc unreadable). Unknown is never treated as stopped. Refusing every mutating operation until it can be verified.")
    fstate = _file_state(os.path.join(out, name)); present = fstate == "present"
    if fstate == "unknown":
        sys.exit(f"persistent journal: UNRESOLVED intent {tag}; cannot stat {name} (only a missing file counts as absent). Refusing.")
    if not present:
        try:
            os.unlink(path); dfd = os.open(out, os.O_RDONLY | os.O_DIRECTORY)
            try: os.fsync(dfd)
            finally: os.close(dfd)
        except OSError as e: sys.exit(f"persistent journal: child stopped and {name} absent, but the intent cannot be discarded ({e}); refusing")
        print(f"persistent journal: intent {tag} discarded - its child (pid {rec['child_pid']}) is verified stopped and {name} was never "
              f"published, so nothing can publish it now; planning will re-mint the gap (local identity {ident})", flush=True)
        return
    sys.exit(f"persistent journal: UNRESOLVED intent {tag}: its child is stopped but {name} is PRESENT with unconfirmed completion and "
             f"contents (a name is not proof of seed/key/model/geometry; local model/calib identity {ident}). Refusing every mutating "
             f"operation on this bank. Manual recovery only: validate that file against the admitted identity or remove it, then remove "
             f"{path} by hand. There is deliberately no flag for this.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--relay"); ap.add_argument("--name")
    ap.add_argument("--all", action="store_true", help="serve every consumer the relay lists (GET /v1/pads/consumers) instead of one --name")
    ap.add_argument("--master"); ap.add_argument("--keyfp"); ap.add_argument("--epoch", type=int, default=1)
    ap.add_argument("--seed"); ap.add_argument("--seed-id"); ap.add_argument("--pk"); ap.add_argument("--mark", type=int)
    ap.add_argument("--ack-floor", type=int, default=None, help="offline delivered floor; NEVER inferred from --mark")
    ap.add_argument("--max-pending", type=int, default=1024, help="maximum unacknowledged index span retained before waiting for delivery progress")
    ap.add_argument("--model"); ap.add_argument("--calib"); ap.add_argument("--out")
    ap.add_argument("--mtp", type=int, choices=(0, 1), default=0, help="include the model's MTP head in the dealer registration; required for MTP consumers")
    ap.add_argument("--allow-unbound-consumer", action="store_true", help="explicit legacy development mode: allow relay consumers with neither asset identity; malformed or mismatched identities still refuse")
    ap.add_argument("--ahead", type=int, default=256); ap.add_argument("--chunk", type=int, default=64)
    ap.add_argument("--mint-batch", type=int, default=0, help="shipments per dealer run (0 = all missing at once); small values push the first shipments sooner at the cost of extra model loads")
    ap.add_argument("--once", action="store_true"); ap.add_argument("--interval", type=float, default=30.0)
    ap.add_argument("--worker", default=os.environ.get("DEALER_WORKER", ""), help="host:port of the dealer's OWN worker (GPU minting; never an operator's)")
    ap.add_argument("--derive-only", action="store_true"); ap.add_argument("--plan-only", action="store_true")
    ap.add_argument("--push", action="store_true", help="upload each new shipment to the relay's store and delete acknowledged ones there (needs PADS_DEALER_TOKEN)")
    ap.add_argument("--persistent-dealer", action="store_true", help="opt-in, CPU-only: keep one shielded-dealer registered across refills via --jobs-stdin instead of a fresh process each pass (~5.4x shorter refill latency; refuses --worker; fail-closed journal recovery)")
    a = ap.parse_args()
    identity = AssetIdentity(a.model, a.calib)

    if a.derive_only:
        seed, seed_id = derive_seed(a.master, a.keyfp, a.epoch)
        print(json.dumps({"seed": seed, "seed_id": seed_id})); return 0

    if not a.out: sys.exit("need --out")
    # One writer owns a bank, including across concurrent daemon invocations.
    # A read-only plan does not take the writer lock.
    if not a.plan_only:
        os.makedirs(a.out, exist_ok=True)
        bank_lock = open(os.path.join(a.out, ".dealer-loop.lock"), "a")
        try: fcntl.flock(bank_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: sys.exit("another dealer already owns this bank")

    token = os.environ.get("PADS_DEALER_TOKEN", "")
    if a.push and not (a.relay and token): sys.exit("--push needs --relay and PADS_DEALER_TOKEN")
    if not a.plan_only:   # EVERY mutating mode holds the bank lock here: an unresolved intent blocks it, flag or not
        msha = csha = None
        try:
            if a.model: msha = identity.digest(a.model, "sha256")
            if a.calib: csha = identity.digest(a.calib, "sha512")
        except (OSError, ValueError): msha = csha = None
        reconcile_persistent_journal(a.out, msha, csha)
        if a.persistent_dealer:
            if a.worker: sys.exit("--persistent-dealer is CPU-only and cannot be combined with --worker")
            if not (a.model and a.calib): sys.exit("--persistent-dealer needs --model and --calib")

    warned_old, warned_cap = set(), set()
    def prune_and_plan(seed_id, mark, ack_floor=None, acked=(), finalized=False):
        """A failed store listing permits neither destructive cleanup nor speculative re-mint."""
        if finalized:
            print(f"seed {seed_id} finalized; no further mint", flush=True); return []
        if ack_floor is None:
            ack_floor = 0
            if seed_id not in warned_old and not a.plan_only:
                print(f"seed {seed_id}: no delivery floor; planning from 0, pruning nothing (retention capped at {a.max_pending} indices)", flush=True)
                warned_old.add(seed_id)
        existing = shipments(a.out, seed_id)
        stored = []
        if a.push:
            try:
                listing = relay_get(a.relay, f"/v1/pads/shipments?seed_id={seed_id}").get("shipments")
                if not isinstance(listing, list): raise ValueError("invalid shipment listing")
                for item in listing:
                    if not isinstance(item, dict): raise ValueError("invalid shipment entry")
                    name = item.get("name", ""); m = NAME_RE.fullmatch(name)
                    if not m or m.group(1) != seed_id or not valid_range(int(m.group(2)), int(m.group(3))): raise ValueError("invalid shipment name")
                    i0, count = int(m.group(2)), int(m.group(3))
                    if item.get("index0") != i0 or item.get("count") != count or type(item.get("bytes")) is not int or item["bytes"] <= 0: raise ValueError("invalid shipment metadata")
                    stored.append((i0, count, name))
            except (urllib.error.HTTPError, urllib.error.URLError, OSError, ValueError) as e:
                print(f"store listing failed ({getattr(e, 'code', None) or getattr(e, 'reason', e)}); no mint, prune or upload until it recovers", flush=True)
                return []
        want, _ = plan(existing + stored, mark, a.ahead, a.chunk, ack_floor, acked, a.max_pending)
        local_spent = [p for i0,c,p in existing if i0+c <= ack_floor]
        if a.plan_only:
            print(json.dumps({"seed_id": seed_id, "mark": mark, "ack_floor": ack_floor, "mint": want, "prune": local_spent})); return []
        if mark + a.ahead > ack_floor + a.max_pending and seed_id not in warned_cap:
            print(f"seed {seed_id}: pending delivery cap reached; will not extend beyond {ack_floor + a.max_pending} until acknowledgments advance", flush=True)
            warned_cap.add(seed_id)
        elif mark + a.ahead <= ack_floor + a.max_pending:
            warned_cap.discard(seed_id)
        for p in local_spent:
            os.unlink(p); print(f"pruned {os.path.basename(p)} (delivered floor {ack_floor})", flush=True)
        if a.push:
            have = {name for _,_,name in stored}
            for i0,c,name in stored:
                if i0+c <= ack_floor:
                    print(f"relay prune {name} -> {relay_delete(a.relay, seed_id, name, token)}", flush=True)
            for _,_,p in shipments(a.out, seed_id):
                name = os.path.basename(p)
                if name in have: continue
                try:
                    res = relay_put_file(a.relay, seed_id, p, token)
                    print(f"re-pushed {name}: {res.get('bytes')} bytes (store lacked it)", flush=True)
                except (urllib.error.HTTPError, urllib.error.URLError, OSError) as e:
                    print(f"push of {name} failed: {getattr(e, 'code', None) or getattr(e, 'reason', e)}; retained for retry", flush=True)
        if not want: print(f"no missing delivery ranges for {seed_id} (mark {mark}, delivered floor {ack_floor})", flush=True)
        return want

    persistent = {"pd": None}
    def get_persistent():
        if persistent["pd"] is None:
            dealer = os.environ.get("DEALER", "shielded-dealer")
            persistent["pd"] = PersistentDealer(dealer, a.model, a.calib, a.out, a.mtp,
                                                identity.digest(a.calib, "sha512"), identity.digest(a.model, "sha256"))
        return persistent["pd"]
    atexit.register(lambda: persistent["pd"].close() if persistent["pd"] else None)

    def mint(jobs):
        """jobs: [(seed, seed_id, pk, want)] -> ONE dealer run (one model load), then push. Seeds
        go through a 0600 file that lives only for the run. With --mint-batch N the wanted ranges
        are minted and pushed N shipments at a time, so a consumer that is already decoding sees
        its first shipment after one small run instead of after the whole window."""
        jobs = [j for j in jobs if j[3]]
        if not jobs: return
        if a.mint_batch > 0 and any(len(j[3]) > a.mint_batch for j in jobs):
            pending = [list(j[3]) for j in jobs]
            while any(pending):
                part = [(j[0], j[1], j[2], pend[:a.mint_batch]) for j, pend in zip(jobs, pending)]
                for pend in pending: del pend[:a.mint_batch]
                mint_once(part)
            return
        mint_once(jobs)

    def mint_once(jobs):
        jobs = [j for j in jobs if j[3]]
        if not jobs: return
        if not (a.model and a.calib): sys.exit("minting needs --model and --calib")
        for seed, seed_id, pk, _ in jobs:
            if not (seed and pk): sys.exit(f"minting {seed_id} needs its seed (--seed or --master) and pad key (--pk or the consumer's)")
        if a.persistent_dealer:
            pd = get_persistent()
            t0 = time.time()
            for seed, seed_id, pk, want in jobs:
                for i0, c in want:
                    path = pd.mint_range(seed, seed_id, pk, i0, c)   # journaled, exact-ack, fail-closed
                    if a.push:
                        try:
                            res = relay_put_file(a.relay, seed_id, path, token)
                            print(f"  pushed {os.path.basename(path)} (persistent, {time.time() - t0:.1f} s): {res.get('bytes')} bytes, sha256 {str(res.get('sha256'))[:16]}", flush=True)
                        except (urllib.error.HTTPError, urllib.error.URLError, OSError) as e:
                            print(f"  push of {os.path.basename(path)} failed: {getattr(e, 'code', None) or getattr(e, 'reason', e)}; next pass retries", flush=True)
                extra = f" in {time.time() - t0:.1f} s (persistent child, one load)" if seed_id == jobs[-1][1] else ""
                print(f"minted {len(want)} shipment(s) for {seed_id} covering up to {want[-1][0] + want[-1][1]}{extra}", flush=True)
            return
        dealer = os.environ.get("DEALER", "shielded-dealer")
        fd, jobfile = tempfile.mkstemp(prefix="dealer-jobs-", suffix=".txt", dir=a.out)
        try:
            with os.fdopen(fd, "w") as f:
                for seed, seed_id, pk, want in jobs:
                    ranges = ",".join(f"{i0}:{c}" for i0, c in want)
                    tmpl = os.path.join(a.out, f"{seed_id}-{{index0}}-{{count}}.pads")
                    f.write(f"{seed} {seed_id} {pk} {tmpl} {ranges}\n")
            cmd = [dealer, a.model, "--jobs", jobfile]
            if a.mtp: cmd += ["--mtp", "1"]
            if a.worker: cmd += ["--worker", a.worker]
            env = {**os.environ, "SHIELDED_CALIB": a.calib}
            t0 = time.time()
            # Streaming publish: shielded-dealer prints "minted <path>: indices [a, b), ..." and flushes
            # right after each shipment file is closed, so a consumer that is already decoding gets its
            # first shipment while the same process (one model load) keeps minting the rest. Only paths
            # from this run's plan are pushed, and only once the line for them has been seen.
            planned = {os.path.join(a.out, f"{seed_id}-{i0}-{c}.pads"): (seed_id, i0, c) for seed, seed_id, pk, want in jobs for i0, c in want}
            pushed_now = set()
            proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            for line in proc.stdout:
                if not (a.push and line.startswith("minted ")): continue
                path = line[len("minted "):].split(": indices", 1)[0].strip()
                if path not in planned or path in pushed_now: continue
                seed_id_p, i0, c = planned[path]
                try:
                    res = relay_put_file(a.relay, seed_id_p, path, token)
                    pushed_now.add(path)
                    print(f"  pushed {os.path.basename(path)} (streamed, {time.time() - t0:.1f} s): {res.get('bytes')} bytes, sha256 {str(res.get('sha256'))[:16]}", flush=True)
                except (urllib.error.HTTPError, urllib.error.URLError, OSError) as e:
                    print(f"  streamed push of {os.path.basename(path)} failed: {getattr(e, 'code', None) or getattr(e, 'reason', e)}; retried below", flush=True)
            rc = proc.wait()
            if rc != 0: sys.exit(f"shielded-dealer failed ({rc}) for {len(jobs)} job(s)")
        finally:
            try: os.unlink(jobfile)
            except OSError: pass
        for seed, seed_id, pk, want in jobs:
            print(f"minted {len(want)} shipment(s) for {seed_id} covering up to {want[-1][0] + want[-1][1]}" + (f" in {time.time() - t0:.1f} s (one load for {len(jobs)} consumer(s))" if seed_id == jobs[-1][1] else ""), flush=True)
            if a.push:
                for i0, c in want:
                    fpath = os.path.join(a.out, f"{seed_id}-{i0}-{c}.pads")
                    if fpath in pushed_now: continue   # already published while minting
                    try:
                        res = relay_put_file(a.relay, seed_id, fpath, token)
                        print(f"  pushed {os.path.basename(fpath)}: {res.get('bytes')} bytes, sha256 {str(res.get('sha256'))[:16]}", flush=True)
                    except (urllib.error.HTTPError, urllib.error.URLError, OSError) as e:
                        # a refused upload (wrong bearer, relay restarting) is retried by the
                        # store sync on the next pass; the bank keeps the file
                        print(f"  push of {os.path.basename(fpath)} failed: {getattr(e, 'code', None) or getattr(e, 'reason', e)} (is PADS_DEALER_TOKEN the relay's?); next pass retries", flush=True)

    def serve(seed, seed_id, pk, mark, ack_floor, acked=(), finalized=False):
        mint([(seed, seed_id, pk, prune_and_plan(seed_id, mark, ack_floor, acked, finalized))])

    while True:
        if a.all:
            # the dealer daemon: every attached consumer with a pad key, each
            # pass (one model load per consumer for now; a multi-seed mint in
            # one load is the obvious next step for the 27B)
            if not (a.relay and a.master): sys.exit("--all needs --relay and --master")
            try:
                cons = relay_get(a.relay, "/v1/pads/consumers").get("consumers", [])
            except (urllib.error.HTTPError, urllib.error.URLError, OSError) as e:
                print(f"relay {a.relay} unreachable ({getattr(e, 'code', None) or getattr(e, 'reason', e)}); waiting", flush=True)
                if a.once: return 1
                time.sleep(a.interval); continue
            served, rejected, jobs = 0, 0, []
            for c in cons:
                if not c.get("issued"):
                    continue                     # attached, but never asked for its seed: nothing to mint for yet
                mismatch = identity.mismatch(c, a.allow_unbound_consumer) if not a.plan_only else None
                if mismatch:
                    print(f"consumer {c.get('name', '?')}: REFUSED ({mismatch}); no mint, upload or prune", flush=True)
                    rejected += 1
                    continue
                seed, sid = derive_seed(a.master, c["keyFp"], c.get("epoch", a.epoch))
                if sid != c["seed_id"]:
                    print(f"consumer {c['name']}: seed id mismatch (relay {c['seed_id']}, derived {sid}); skipped", flush=True); continue
                print(f"consumer {c['name']} ({sid}, mark {c.get('mark', 0)})", flush=True)
                jobs.append((seed, sid, c.get("padKey") or "", prune_and_plan(sid, c.get("mark", 0), c.get("ack_floor"), c.get("acked", []), c.get("finalized", False)))); served += 1
            mint(jobs)                           # every consumer's missing ranges, one model load
            if not served: print(f"no consumer with a seed among {len(cons)} attached; waiting", flush=True)
            if a.once or a.plan_only: return 1 if rejected else 0
            time.sleep(a.interval); continue

        seed, seed_id, pk, mark = a.seed, a.seed_id, a.pk, a.mark
        ack_floor, acked, finalized = a.ack_floor, (), False
        if a.relay and a.name:
            try:
                info = relay_get(a.relay, f"/v1/pads/pvm?name={a.name}")
            except (urllib.error.HTTPError, urllib.error.URLError, OSError) as e:
                # the pVM detaches whenever the owner app restarts; a 404 here is
                # routine, the bank keeps and the next pass picks up where it was
                code = getattr(e, "code", None) or getattr(e, "reason", e)
                print(f"pVM {a.name} not attached ({code}); waiting", flush=True)
                if a.once: return 1
                time.sleep(a.interval); continue
            seed_id, pk, mark = info["seed_id"], info.get("padKey") or pk, info.get("mark", 0)
            ack_floor, acked, finalized = info.get("ack_floor"), info.get("acked", []), info.get("finalized", False)
            if info.get("issued") is False:
                if a.once: return 0
                time.sleep(a.interval); continue
            mismatch = identity.mismatch(info, a.allow_unbound_consumer) if not a.plan_only else None
            if mismatch:
                print(f"consumer {a.name}: REFUSED ({mismatch}); no mint, upload or prune", flush=True)
                if a.once: return 1
                time.sleep(a.interval); continue
            if a.master:
                seed, sid = derive_seed(a.master, info["keyFp"], info.get("epoch", a.epoch))
                if sid != seed_id: sys.exit(f"seed id mismatch: relay {seed_id}, derived {sid} (wrong master or epoch?)")
        if not seed_id or mark is None:
            sys.exit("need --relay/--name or --seed-id/--mark")
        serve(seed, seed_id, pk, mark, ack_floor, acked, finalized)
        if a.once or a.plan_only: return 0
        time.sleep(a.interval)

if __name__ == "__main__":
    sys.exit(main())
