#!/usr/bin/env python3
"""qcow-allocation-nbd-stage/r4 alloc_check.py (prepared by Claude 1714; NOT run by Claude). r3 = r2 + root 1713: qemu-nbd binds
/proc/self/cwd/nbd.sock in its INITIAL cwd (the run dir) and THEN chdir("/"), so /proc/<child>/cwd is "/" and must never be used to
reach the socket: the client (this process) uses /proc/self/fd/<RUN DIR FD>/nbd.sock through its own open directory fd, kept open
for the whole check, after an exact inode/uid/type match; the readiness wait fails fast when the server left the run dir and no
socket exists there.
r2 (Claude 1709). Python stdlib + the installed libnbd
Python binding (nbd 1.24.4) + the pinned qemu-nbd 11.1.2. r2 = r1 + root's review (1709):

  SOCKET   the real run dir is deep (stage/runs/...), beyond AF_UNIX's 108-byte sun_path. qemu-nbd runs with cwd = the private run dir
           and binds `--socket=/proc/self/cwd/nbd.sock`; r2's client path `/proc/<CHILD PID>/cwd/nbd.sock` was WRONG (the
           server's cwd becomes "/" after binding: root 1713); r3 connects to `/proc/self/fd/<run-dir fd>/nbd.sock` after checking
           that it and `nbd.sock` stat'ed relative to the run-dir fd are the SAME socket inode, owned by us.
  SIGNALS  SIGTERM/SIGINT/SIGHUP are blocked in this process before any thread or child exists and are consumed by the watchdog
           thread (sigtimedwait), which also enforces the deadline: either ends the server's process group (TERM, then KILL) so a
           blocking libnbd call returns; the main thread then JOINS the watchdog BEFORE it reaps the child (no signal can reach a
           reaped, reusable PID). The child unblocks those signals and sets PR_SET_PDEATHSIG=SIGTERM, then verifies its parent is still
           us (else exits): a parent dying before prctl cannot leave an orphan server.
  RECEIPT  every outcome writes the COMPLETE receipt (all facts gathered so far, the refusal, signal, cleanup and image identity);
           rc 4 whenever cleanup is incomplete or the image identity changed.

READ-ONLY allocation status of EXACT byte ranges of one qcow2 image via NBD block status ("base:allocation", plus
"qemu:allocation-depth" when offered), in bounded chunks (<= 1 GiB: the protocol's 32-bit count). COMPACT totals only; no NBD read.
Flags: HOLE=1, ZERO=2; neither = ALLOCATED DATA. Image-layer allocation status only, NOT content integrity: a HOLE/ZERO byte reads
as zero from this image; the original page may legitimately have been zero, so a flagged byte is NOT necessarily lost useful content -
it only means any former NONZERO data there cannot be recovered from this image.

    alloc_check.py --image IMG --ranges RANGES.json --run-dir DIR --qemu-nbd BIN --qemu-nbd-sha256 H [--timeout S] [--image-sha256 H]
Exit 0 written; 3 refused/error/signalled (receipt written, no result claimed); 4 cleanup incomplete or image changed (STOP, inspect).
"""
import argparse, ctypes, hashlib, json, os, signal, stat, subprocess, sys, threading, time

CHUNK = 1 << 30
MAX_RANGES = 100000
MAX_CALLS = 20_000_000
SAMPLES = 32
HOLE, ZERO = 1, 2
SIGS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
SOCK = "nbd.sock"
_PRCTL = ctypes.CDLL(None, use_errno=True).prctl            # resolved before any fork


class Refused(Exception):
    pass


def sha256_file(path, limit):
    h, n = hashlib.sha256(), 0
    with open(path, "rb", buffering=0) as f:
        while True:
            b = f.read(1 << 20)
            if not b:
                return h.hexdigest()
            n += len(b)
            if n > limit:
                raise Refused(f"{path} is larger than {limit} bytes")
            h.update(b)


def ident(st):
    return [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns]


def load_ranges(path):
    with open(path, "rb") as f:
        raw = f.read((16 << 20) + 1)
    if len(raw) > 16 << 20:
        raise Refused("ranges file too large")
    v = json.loads(raw)
    r = v.get("ranges") if isinstance(v, dict) else None
    if not isinstance(r, list) or not 0 < len(r) <= MAX_RANGES or \
            any(not (isinstance(x, list) and len(x) == 2 and all(type(y) is int for y in x) and 0 <= x[0] < x[1]) for x in r):
        raise Refused(f"ranges must be 1..{MAX_RANGES} [start, end) integer pairs")
    r = sorted(r)
    if any(r[i][0] < r[i - 1][1] for i in range(1, len(r))):
        raise Refused("ranges overlap")
    return r


def classify(tot, samples, start, length, flags):
    k = "allocatedData" if not flags & (HOLE | ZERO) else "zeroNotHole" if flags == ZERO else "hole" if flags == HOLE else "holeZero"
    tot[k] += length
    if k != "allocatedData" and len(samples) < SAMPLES:
        samples.append({"start": start, "length": length, "flags": flags})


class Server:
    """our own qemu-nbd child: started, signalled and reaped ONLY through this object"""

    def __init__(self, a, run_fd, res):
        self.a, self.run_fd, self.res, self.child, self.reaped = a, run_fd, res, None, False
        self.done, self.lock, self.reason = threading.Event(), threading.Lock(), None
        self.watch = None

    def start(self):
        parent = os.getpid()

        def pre():                                          # in the child, before exec
            signal.pthread_sigmask(signal.SIG_UNBLOCK, SIGS)
            if _PRCTL(1, int(signal.SIGTERM), 0, 0, 0) != 0 or os.getppid() != parent:   # PR_SET_PDEATHSIG + parent race
                os._exit(126)
        opts = f"driver=qcow2,file.driver=file,file.filename={self.a.image},file.locking=off,read-only=on"
        log = os.open("qemu-nbd.out", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.run_fd)
        try:
            self.child = subprocess.Popen([self.a.qemu_nbd, "--read-only", "--shared=1", "--allocation-depth", f"--socket=/proc/self/cwd/{SOCK}",
                                           "--image-opts", opts], cwd=self.a.run_dir, stdin=subprocess.DEVNULL,
                                          stdout=log, stderr=subprocess.STDOUT, start_new_session=True, preexec_fn=pre, pass_fds=())
        finally:
            os.close(log)
        self.res["server"] = {"pid": self.child.pid, "bind": f"/proc/self/cwd/{SOCK} (initial cwd = run dir)",
                              "client": None}
        self.watch = threading.Thread(target=self._watchdog, daemon=True); self.watch.start()

    def exited(self):
        """has the child exited? WITHOUT reaping it (WNOWAIT): until stop() reaps, its PID/PGID cannot be reused"""
        with self.lock:
            if self.reaped:
                return True
            return os.waitid(os.P_PID, self.child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None

    def _kill(self, sig):
        with self.lock:                                     # only while unreaped (a zombie is fine): never a reused PID
            if self.child is not None and not self.reaped:
                try:
                    os.killpg(self.child.pid, sig)
                except ProcessLookupError:
                    pass

    def _watchdog(self):
        end = time.monotonic() + self.a.timeout
        while not self.done.is_set():
            left = end - time.monotonic()
            if left <= 0:
                self.reason = "deadline"; break
            got = signal.sigtimedwait(SIGS, min(0.5, left))
            if got is not None:
                self.reason = f"signal {got.si_signo}"; break
        if self.reason:
            self.res["stopReason"] = self.reason
            self._kill(signal.SIGTERM)
            for _ in range(20):
                if self.exited():
                    break
                time.sleep(0.25)
            self._kill(signal.SIGKILL)

    def socket_path(self):
        """r3: the run dir's nbd.sock through THIS process's own open run-dir fd (short path; the fd stays open until cleanup):
        a socket, ours, and the same inode as the entry seen relative to that fd. FileNotFoundError while not yet bound."""
        b = os.stat(SOCK, dir_fd=self.run_fd, follow_symlinks=False)
        via = f"/proc/self/fd/{self.run_fd}/{SOCK}"
        a = os.stat(via, follow_symlinks=False)
        if not stat.S_ISSOCK(b.st_mode) or not stat.S_ISSOCK(a.st_mode) or b.st_uid != os.geteuid() or (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino):
            raise Refused("the server socket is not our run dir's own socket")
        self.res["server"]["client"] = via
        return via

    def stop(self):
        """join the watchdog FIRST, then end and reap the child; returns True if the child is reaped"""
        self.done.set()
        if self.watch is not None:
            self.watch.join(timeout=30)
            if self.watch.is_alive():
                self.res.setdefault("cleanupProblems", []).append("watchdog did not stop")
        if self.child is None:
            return True
        for sig, w in ((None, 10), (signal.SIGTERM, 10), (signal.SIGKILL, 10)):
            if sig is not None:
                self._kill(sig)
            end = time.monotonic() + w
            while not self.exited() and time.monotonic() < end:
                time.sleep(0.05)
            if self.exited():
                break
        self._kill(signal.SIGKILL)                          # anything left of its group, while the leader is still unreaped
        with self.lock:
            if not self.reaped and os.waitid(os.P_PID, self.child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
                self.child.wait(); self.reaped = True       # the ONLY reap, after the watchdog was joined
        self.res["serverReturncode"] = self.child.returncode
        return self.reaped


def check(a, res):
    import nbd
    t0 = time.monotonic()
    if not os.path.isabs(a.run_dir) or os.path.islink(a.run_dir) or not os.path.isdir(a.run_dir):
        raise Refused("run dir must be an existing absolute directory")
    run_fd = os.open(a.run_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    srv = None
    try:
        st = os.fstat(run_fd)
        if st.st_uid != os.geteuid() or st.st_mode & 0o077:
            raise Refused("run dir must be private (0700, this user)")
        try:
            os.stat(SOCK, dir_fd=run_fd, follow_symlinks=False)
            raise Refused("socket path exists: one check per run dir")
        except FileNotFoundError:
            pass
        if sha256_file(a.qemu_nbd, 64 << 20) != a.qemu_nbd_sha256:
            raise Refused("qemu-nbd is not the pinned binary")
        if "," in a.image or not os.path.isabs(a.image):
            raise Refused("image path must be absolute without a comma (qemu option syntax)")
        fd = os.open(a.image, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            pst = os.fstat(fd)
        finally:
            os.close(fd)
        if not stat.S_ISREG(pst.st_mode) or os.access(a.image, os.W_OK):
            raise Refused("image must be a regular file that this user cannot write")
        res["imageBefore"] = ident(pst)
        if a.image_sha256 and sha256_file(a.image, 1 << 30) != a.image_sha256:
            raise Refused("image sha256 is not the expected one (fixture)")
        ranges = load_ranges(a.ranges)
        res.update(ranges=len(ranges), rangeBytes=sum(e - s for s, e in ranges), chunkBytes=CHUNK)
        srv = Server(a, run_fd, res); srv.start()
        end = time.monotonic() + 60
        run_real = os.path.realpath(a.run_dir)
        while True:
            try:
                path = srv.socket_path(); break
            except FileNotFoundError:
                pass
            try:                                            # fail fast: the server binds in its initial cwd, then leaves it
                left = os.readlink(f"/proc/{srv.child.pid}/cwd") != run_real
            except OSError:
                left = False
            if left:
                try:
                    srv.socket_path(); continue
                except FileNotFoundError:
                    raise Refused("qemu-nbd left its initial cwd without a socket in the run dir (bind failed: see qemu-nbd.out)")
            if srv.exited():
                raise Refused("qemu-nbd exited before listening (see qemu-nbd.out)")
            if srv.reason or time.monotonic() > end:
                raise Refused(f"qemu-nbd did not listen ({srv.reason or '60 s'})")
            time.sleep(0.1)
        h = nbd.NBD()
        h.add_meta_context(nbd.CONTEXT_BASE_ALLOCATION)
        h.add_meta_context("qemu:allocation-depth")
        h.connect_unix(path)
        if not h.can_meta_context(nbd.CONTEXT_BASE_ALLOCATION) or not h.is_read_only():
            raise Refused("server does not offer base:allocation on a read-only export")
        has_depth = h.can_meta_context("qemu:allocation-depth")
        size = h.get_size()
        if ranges[-1][1] > size:
            raise Refused(f"a range ends beyond the export size {size}")
        tot = {"allocatedData": 0, "zeroNotHole": 0, "hole": 0, "holeZero": 0}
        depth_tot, samples, calls, all_data_ranges = {}, [], 0, 0
        for s, e in ranges:
            pos, all_data = s, True
            while pos < e:
                if srv.reason:
                    raise Refused(f"stopped: {srv.reason}")
                calls += 1
                if calls > MAX_CALLS:
                    raise Refused("too many block-status calls")
                got = {}

                def cb(meta, off, entries, err, got=got):
                    if meta in (nbd.CONTEXT_BASE_ALLOCATION, "qemu:allocation-depth") and meta not in got:
                        got[meta] = list(entries)
                    return 0
                h.block_status(min(CHUNK, e - pos), pos, cb)
                ents = got.get(nbd.CONTEXT_BASE_ALLOCATION)
                if not ents or len(ents) % 2:
                    raise Refused(f"no base:allocation extents at {pos}")
                adv = 0
                for i in range(0, len(ents), 2):
                    ln, fl = ents[i], ents[i + 1]
                    if ln <= 0:
                        raise Refused("zero-length extent from the server")
                    ln = min(ln, e - (pos + adv))
                    if ln <= 0:
                        break
                    if fl & ~(HOLE | ZERO):
                        raise Refused(f"unknown base:allocation flags {fl:#x}")
                    all_data &= not fl & (HOLE | ZERO)
                    classify(tot, samples, pos + adv, ln, fl); adv += ln
                if has_depth and "qemu:allocation-depth" in got:
                    d, dadv = got["qemu:allocation-depth"], 0
                    for i in range(0, len(d) - 1, 2):
                        n = min(d[i], adv - dadv)
                        if n <= 0:
                            break
                        depth_tot[str(d[i + 1])] = depth_tot.get(str(d[i + 1]), 0) + n; dadv += n
                if adv <= 0:
                    raise Refused(f"no progress at {pos}")
                pos += adv
            all_data_ranges += bool(all_data)
        ext = bool(h.get_extended_headers_negotiated())
        h.shutdown(); h.close()
        if sum(tot.values()) != res["rangeBytes"]:
            raise Refused("classified bytes != range bytes")
        res.update(exportSize=size, extendedHeaders=ext, calls=calls, totals=tot, rangesFullyAllocatedData=all_data_ranges,
                   rangesWithHoleOrZero=len(ranges) - all_data_ranges, nonDataSamples=samples,
                   allocationDepthBytes=depth_tot if has_depth else "not offered", seconds=round(time.monotonic() - t0, 1), complete=True)
    finally:
        reaped = srv.stop() if srv is not None else True
        try:
            os.unlink(SOCK, dir_fd=run_fd)
        except FileNotFoundError:
            pass
        except OSError as e:
            res.setdefault("cleanupProblems", []).append(f"socket unlink: {e.strerror}")
        os.close(run_fd)
        if "imageBefore" in res:
            try:
                after = ident(os.stat(a.image))
            except OSError as e:
                after = {"error": e.strerror}
            res["imageAfter"], res["imageUnchanged"] = after, after == res["imageBefore"]
        res["cleanupComplete"] = reaped and not res.get("cleanupProblems")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True); ap.add_argument("--ranges", required=True); ap.add_argument("--run-dir", required=True)
    ap.add_argument("--qemu-nbd", required=True); ap.add_argument("--qemu-nbd-sha256", required=True)
    ap.add_argument("--timeout", type=int, default=7200); ap.add_argument("--image-sha256")
    a = ap.parse_args(argv)
    if not 10 <= a.timeout <= 86400:
        print("timeout must be 10..86400", file=sys.stderr); return 2
    old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, SIGS)   # before any thread/child: only the watchdog consumes them
    res = {"format": "qcow-allocation-nbd/v2", "image": a.image, "complete": False,
           "meaning": ("image-layer ALLOCATION status only (NBD base:allocation); NOT content integrity; no data byte was read. A HOLE/ZERO "
                       "byte reads as zero here: the original page may have been zero, so it is not necessarily lost useful content; it "
                       "only means former NONZERO data there cannot be recovered from this image. Full MDBX + state checks remain required.")}
    rc = 0
    try:
        check(a, res)
    except Exception as e:                                       # noqa: BLE001 - every failure: refusal + the complete receipt
        res["refused"] = f"{type(e).__name__}: {e}"[:500]; rc = 3
    late = signal.sigtimedwait(SIGS, 0)                         # a signal that arrived after the watchdog stopped
    if late is not None:
        res.setdefault("stopReason", f"signal {late.si_signo}"); rc = rc or 3
    if res.get("stopReason") and not res.get("refused"):
        rc = rc or 3
    if res.get("imageUnchanged") is False or res.get("cleanupComplete") is False:
        rc = 4
    res["rc"] = rc
    try:
        fd = os.open(os.path.join(a.run_dir, f"result-{time.time_ns()}.json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.write(fd, (json.dumps(res, indent=1, sort_keys=True) + "\n").encode()); os.close(fd)
    except OSError as e:
        print(f"result not written: {e}", file=sys.stderr); rc = rc or 3
    print(json.dumps({k: res.get(k) for k in ("rc", "refused", "stopReason", "totals", "rangesWithHoleOrZero", "imageUnchanged", "cleanupComplete")}))
    signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
    return rc


if __name__ == "__main__":
    sys.exit(main())
