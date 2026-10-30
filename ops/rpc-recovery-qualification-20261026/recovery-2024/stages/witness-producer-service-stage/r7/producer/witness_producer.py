#!/usr/bin/env python3
"""witness-producer-service-stage/r6 (PREPARED; NOT run) = r5 + root 1616's two shutdown races, nothing else:
  - OWNED children: `procs` holds Popen objects; the only reap (poll) and the unregistering happen in ONE critical section under
    `cv`, and every kill (deadline, client gone, shutdown) happens under the same lock and only while returncode is None - so an
    unreaped child is at worst a zombie whose pid/pgid cannot be reused; no integer snapshot is signalled outside the lock;
  - workers are registered AND started under the lock; shutdown() reports any registered worker never started or still alive.
witness-producer-service-stage/r5 (PREPARED; NOT run) = r3 + root 1610's lifecycle findings, nothing else:
  - OBSERVABLE completion: `admitted`/`completed` counts under one condition variable; `wait_quiescent()` = every admitted handler has
    finished (cleanup, log, single-flight release) - a client has its last byte BEFORE that, so callers that need the slot or the
    cleanup observe this, never a sleep;
  - SHUTDOWN (a real r1/r3 defect): `shutdown()` only closed the listener; handler threads and the fetch child (its own session, so not
    in the parent's signal path) were orphaned. r5 refuses new work, SIGKILLs every running fetch process group and joins the workers.
witness-producer-service-stage/r3 (PREPARED; NOT run): r1 (frozen, unchanged) + root 1589's output bound. It runs INSIDE the RPC VM
on 127.0.0.1 (placement r2: the host-link forward is the only ingress); the integrated derived-reader driver pulls from it
(request `enclave-derived-witness-request/v1`).

r3 vs r1 (only these):
  - DISK bound WHILE generating: the fetcher runs under `prlimit --fsize=<request cap> --core=0` (plus r1's --as/--cpu). RLIMIT_FSIZE
    is per file and applies to EVERY regular file the child writes: a write past the cap fails (EFBIG) or kills the child (SIGXFSZ),
    so neither the witness nor anything else it writes can exceed the cap on disk. The pinned upstream fetcher (base-proof-zk-witness
    fetcher.rs) writes only the output (`<out>.partial` -> rename) and two small config files `configs/L1/<chainId>.json`,
    `configs/L2/<chainId>.json` under its cwd (data_dir None: in-memory store; no temp database).
  - BOUNDED stderr: a pipe drained by a thread into the last STDERR_TAIL bytes (never a file, never unbounded memory).
  - CLEANUP of exactly the fetcher's known files (output, .partial, configs/L{1,2}/<digits>.json and those directories); an
    unexpected leftover keeps the run directory and is logged (never a recursive delete).
Everything else is r1's: the witness only from the pinned upstream capture `witness_fetch` (ELF 36604b9c…, source 69812507…) with the
runner's argv mapping; the r14 bridge's framing (cb976541…, sha-pinned compile+exec); loopback-only endpoints; no cache, no
fallback, no public RPC; any failure is a non-200 answer without witness bytes; only the pinned native accepts the bytes.

  witness_producer.py serve --config FILE        (the unit)
  witness_producer.py check-config --config FILE (pins and config only; does not listen)"""
import collections, hashlib, json, os, re, select, signal, socket, stat, subprocess, sys, tempfile, threading, time, types

REQUEST_FORMAT = "enclave-derived-witness-request/v1"
CONFIG_FORMAT = "enclave-witness-producer-config/r1"
TRACKS = ("final", "provisional")
# the provider's frozen buildTrustedInput key order (network/derived-reader/vendor/schedule-input-r2.mjs TRUSTED_KEYS)
TRUSTED_KEYS = ["chainId", "l1Head", "l1HeadNumber", "agreedL2OutputRoot", "claimedL2OutputRoot", "claimedL2BlockNumber",
                "rollupConfig", "expectedRollupConfigHash", "expectedScheduleId", "intermediateBlockInterval"]
REQUEST_KEYS = ["format", "track", "trusted", "agreedL2BlockNumber", "maximumWitnessBytes"]
CONFIG_KEYS = ["format", "listen", "fetch", "bridge", "endpoints", "maxBlocks", "maxWitnessBytes", "fetchTimeoutSec", "fetchMemoryMiB",
               "minMemAvailableMiB", "workDir"]
# provenance pins (existing artifacts; never configurable)
FETCH_ELF_SHA256 = "36604b9c2c5bfd4e5633506ba5e97c78a3b81e53a052d913498135c0cae13f0c"      # combined-r1 root build (debug)
FETCH_SOURCE_SHA256 = "698125070eaf9c41ca88cf77924ac98e54f06d393d2b084617a080a8d5c3b008"   # witness_fetch.rs (record only)
BRIDGE_SHA256 = "cb9765418d30d238ded384c6908462516d153161f17631f28c7247905198fc9d"         # r14 witness-r2 witness_rpc_bridge.py
H32 = re.compile(r"^0x[0-9a-f]{64}$")
ENDPOINT = re.compile(r"^http://127\.0\.0\.1:([1-9][0-9]{0,4})$")
CONFIG_FILE = re.compile(r"^[0-9]{1,20}\.json$")                  # the upstream fetcher's configs/L{1,2}/<chainId>.json
U63 = (1 << 63) - 1
MIB = 1 << 20
STDERR_TAIL = 4096
LIMITS = {"max_conn": 1, "max_header": 8192, "max_request": 1 << 20, "header_deadline": 15.0, "chunk": 64 << 10}


class Invalid(Exception):
    pass


def _int(v, lo, hi):
    return type(v) is int and lo <= v <= hi


def read_nofollow(path, cap):
    """bytes of a regular, not group/world-writable file <= cap, opened without following a symlink in the last component"""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o022 or st.st_size > cap:
            raise Invalid(f"{path}: must be a regular, not group/world-writable file <= {cap} bytes")
        b = os.read(fd, cap + 1)
        if len(b) > cap:
            raise Invalid(f"{path}: grew beyond {cap} bytes")
        return st, b
    finally:
        os.close(fd)


def load_bridge(path, want=None):
    """the qualified r14 bridge module, exactly its pinned bytes (compile+exec; never the import system / a pyc)"""
    _, b = read_nofollow(path, 1 << 20)
    if hashlib.sha256(b).hexdigest() != (want or BRIDGE_SHA256):
        raise Invalid("the bridge module is not the qualified r14 bytes")
    m = types.ModuleType("witness_rpc_bridge_r14"); m.__file__ = path
    exec(compile(b, path, "exec", dont_inherit=True), m.__dict__)
    for k in ("read_request", "reply", "Refused", "LOOPBACK"):
        if not hasattr(m, k):
            raise Invalid(f"bridge module lacks {k}")
    return m


def load_config(path):
    _, raw = read_nofollow(path, 64 << 10)
    try:
        c = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise Invalid("config is not UTF-8 JSON")
    if not isinstance(c, dict) or sorted(c) != sorted(CONFIG_KEYS) or c["format"] != CONFIG_FORMAT:
        raise Invalid(f"config keys must be exactly {CONFIG_KEYS} and format {CONFIG_FORMAT}")
    if not isinstance(c["listen"], dict) or sorted(c["listen"]) != ["host", "port"] or c["listen"]["host"] != "127.0.0.1" \
            or not _int(c["listen"]["port"], 1024, 65535):
        raise Invalid("listen must be {host: 127.0.0.1, port: 1024..65535} (loopback only; the forward is the only ingress)")
    for k in ("fetch", "bridge"):
        if not isinstance(c[k], dict) or sorted(c[k]) != ["path", "sha256"] or not str(c[k]["path"]).startswith("/"):
            raise Invalid(f"{k} must be {{path (absolute), sha256}}")
    if c["fetch"]["sha256"] != FETCH_ELF_SHA256 or c["bridge"]["sha256"] != BRIDGE_SHA256:
        raise Invalid("fetch/bridge sha256 differ from this stage's provenance pins")
    e = c["endpoints"]
    if not isinstance(e, dict) or sorted(e) != ["l1Beacon", "l1Rpc", "l2Node", "l2Rpc"] or \
            not all(isinstance(v, str) and ENDPOINT.match(v) for v in e.values()) or len(set(e.values())) != 4:
        raise Invalid("endpoints must be four distinct http://127.0.0.1:<port> URLs (our own nodes/bridges; never a public RPC)")
    if not _int(c["maxBlocks"], 1, 1800) or not _int(c["maxWitnessBytes"], 1, 256 * MIB) or not _int(c["fetchTimeoutSec"], 1, 3600) \
            or not _int(c["fetchMemoryMiB"], 256, 65536) or not _int(c["minMemAvailableMiB"], 0, 1 << 20):
        raise Invalid("maxBlocks 1..1800, maxWitnessBytes 1..256 MiB, fetchTimeoutSec 1..3600, fetchMemoryMiB 256..65536, minMemAvailableMiB >= 0")
    if not isinstance(c["workDir"], str) or not c["workDir"].startswith("/"):
        raise Invalid("workDir must be absolute")
    return c


def check_request(body, cfg):
    """-> the fetch job; raises Invalid. The fields are a job description for the pinned fetcher, never trusted: the native harness
    re-binds every one of them."""
    try:
        r = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise Invalid("request is not UTF-8 JSON")
    if not isinstance(r, dict) or sorted(r) != sorted(REQUEST_KEYS) or r["format"] != REQUEST_FORMAT or r["track"] not in TRACKS:
        raise Invalid(f"request keys must be exactly {REQUEST_KEYS}, format {REQUEST_FORMAT}, track in {TRACKS}")
    t = r["trusted"]
    if not isinstance(t, dict) or list(t) != TRUSTED_KEYS:
        raise Invalid("trusted must carry exactly the provider's trusted keys, in order")
    if t["chainId"] != 8453 or type(t["chainId"]) is not int:
        raise Invalid("chainId must be 8453")
    for k in ("l1Head", "agreedL2OutputRoot", "claimedL2OutputRoot", "expectedRollupConfigHash"):
        if not isinstance(t[k], str) or not H32.match(t[k]):
            raise Invalid(f"trusted.{k} must be 0x + 64 lowercase hex")
    if not isinstance(t["expectedScheduleId"], str) or not 1 <= len(t["expectedScheduleId"]) <= 200 or not isinstance(t["rollupConfig"], dict):
        raise Invalid("trusted.expectedScheduleId / rollupConfig shape")
    agreed, end, iv, cap = r["agreedL2BlockNumber"], t["claimedL2BlockNumber"], t["intermediateBlockInterval"], r["maximumWitnessBytes"]
    if not (_int(t["l1HeadNumber"], 0, U63) and _int(agreed, 0, U63) and _int(end, 1, U63) and _int(iv, 1, U63) and _int(cap, 1, U63)):
        raise Invalid("integers must be non-negative safe integers")
    if end <= agreed or (end - agreed) % iv or end - agreed > cfg["maxBlocks"]:
        raise Invalid(f"range must be 1..{cfg['maxBlocks']} blocks above the agreed block and a multiple of the interval")
    if cap > cfg["maxWitnessBytes"]:
        raise Invalid(f"maximumWitnessBytes above this producer's {cfg['maxWitnessBytes']}")
    return {"track": r["track"], "start": agreed, "end": end, "l1Head": t["l1Head"], "interval": iv, "cap": cap,
            "requestSha256": hashlib.sha256(body).hexdigest()}


def clean_run(work):
    """remove exactly the fetcher's known files, then the run directory; -> the names left behind (never a recursive delete)"""
    for n in ("witness.json", "witness.json.partial"):
        try:
            os.unlink(os.path.join(work, n))
        except FileNotFoundError:
            pass
    for sub in ("configs/L1", "configs/L2"):
        d = os.path.join(work, sub)
        try:
            names = os.listdir(d)
        except FileNotFoundError:
            continue
        for n in names:
            p = os.path.join(d, n)
            if CONFIG_FILE.match(n) and stat.S_ISREG(os.lstat(p).st_mode):
                os.unlink(p)
        try:
            os.rmdir(d)
        except OSError:
            pass
    try:
        os.rmdir(os.path.join(work, "configs"))
    except OSError:
        pass
    try:
        os.rmdir(work)
        return []
    except OSError:
        left = []
        for root, ds, fs in os.walk(work):
            left += [os.path.relpath(os.path.join(root, x), work) for x in ds + fs]
        return sorted(left)[:20]


class Producer:
    meminfo = "/proc/meminfo"

    def __init__(self, cfg, bridge=None, log=None):
        self.cfg, self.log = cfg, log or (lambda d: print(json.dumps(d, sort_keys=True), file=sys.stderr, flush=True))
        self.br = bridge or load_bridge(cfg["bridge"]["path"])
        self.fetch_id = self.verify_fetch()
        st = os.lstat(cfg["workDir"])
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077:
            raise Invalid("workDir must be this user's 0700 directory (not a symlink)")
        host, port = cfg["listen"]["host"], cfg["listen"]["port"]
        if host not in self.br.LOOPBACK:
            raise Invalid("loopback only")
        self.ls = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); self.ls.bind((host, port)); self.ls.listen(8)
        self.address = self.ls.getsockname(); self.active, self.lock = 0, threading.Lock()
        self.cv, self.completed, self.workers, self.procs, self.closing = threading.Condition(self.lock), 0, set(), set(), False
        self.stats = {"admitted": 0, "busy": 0, "served": 0, "refused": 0, "failed": 0}

    def wait_quiescent(self, timeout=30.0):
        """True once every admitted connection's handler has COMPLETED (cleanup, log, slot release)"""
        with self.cv:
            return self.cv.wait_for(lambda: self.completed == self.stats["admitted"] and self.active == 0, timeout)

    def wait_admitted(self, n, timeout=30.0):
        """True once at least n connections have been admitted (accepted into the single slot)"""
        with self.cv:
            return self.cv.wait_for(lambda: self.stats["admitted"] >= n, timeout)

    def verify_fetch(self, want=None):
        """sha of the fetcher ELF read through a no-follow fd; -> (dev, ino, size, mtime_ns) re-checked before every run"""
        fd = os.open(self.cfg["fetch"]["path"], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o022 or not st.st_mode & 0o100:
                raise Invalid("the fetcher must be a regular, executable, not group/world-writable file")
            h = hashlib.sha256()
            for b in iter(lambda: os.read(fd, 1 << 20), b""):
                h.update(b)
        finally:
            os.close(fd)
        if h.hexdigest() != (want or FETCH_ELF_SHA256):
            raise Invalid("the fetcher is not the pinned witness_fetch build")
        return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)

    def mem_available_mib(self):
        for line in open(self.meminfo, encoding="ascii"):
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
        raise Invalid("MemAvailable unreadable")

    def serve_forever(self):
        while True:
            try:
                c, _ = self.ls.accept()
            except OSError:
                return
            with self.cv:
                admit = self.active < LIMITS["max_conn"] and not self.closing
                self.active += admit; self.stats["admitted" if admit else "busy"] += 1
                if admit:                                    # r6: registered AND started under the lock: shutdown never sees an
                    th = threading.Thread(target=self.handle, args=(c,), daemon=True)   # unstarted worker
                    self.workers.add(th); th.start()
                self.cv.notify_all()
            if not admit:                                    # single flight: refused before any byte is read (the bridge's rule)
                try:
                    c.settimeout(1.0); self.br.reply(c, 503, "Service Unavailable", {"error": "busy: one witness at a time"})
                except OSError:
                    pass
                c.close(); continue

    def shutdown(self, timeout=15.0):
        """stop accepting, SIGKILL every OWNED, UNREAPED fetch process group, join every handler (bounded); -> the registered handlers
        that are still alive or were never started (empty = complete)"""
        with self.cv:
            self.closing = True
            # r6: the kill happens UNDER the ownership lock, only for children whose returncode is still None. Every reap (poll) is
            # done under this same lock and unregisters the child in the same critical section, so an unreaped child is at worst a
            # zombie: its pid/pgid cannot have been reused. No integer snapshot is ever signalled outside the lock.
            self.kill_owned()
            workers = list(self.workers)
        try:
            self.ls.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.ls.close()
        end = time.monotonic() + timeout
        for th in workers:
            if th is not threading.current_thread() and th.ident is not None:
                th.join(max(0.0, end - time.monotonic()))
        with self.cv:
            return [th.name for th in self.workers if th.ident is None or th.is_alive()]

    def kill_owned(self, p=None):
        """caller holds self.cv. SIGKILL the process group of each owned child that is NOT yet reaped (returncode None)."""
        for q in ([p] if p is not None else list(self.procs)):
            if q in self.procs and q.returncode is None:
                try:
                    os.killpg(q.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def handle(self, c):
        t0, job, out = time.monotonic(), None, {"rc": None}
        try:
            try:
                body = self.br.read_request(c, LIMITS)
            except self.br.Refused as e:
                code, reason = e.args[0]; self.stats["refused"] += 1
                return self.br.reply(c, code, reason, {"error": reason})
            try:
                job = check_request(body, self.cfg)
            except Invalid as e:
                self.stats["refused"] += 1; return self.br.reply(c, 400, "Bad Request", {"error": str(e)[:300]})
            try:
                mem = self.mem_available_mib()
            except (Invalid, OSError, ValueError):
                mem = -1                                     # unreadable counts as below the floor
            if mem < self.cfg["minMemAvailableMiB"]:
                self.stats["refused"] += 1; return self.br.reply(c, 503, "Service Unavailable", {"error": "host memory floor: not starting a fetch"})
            st = os.stat(self.cfg["fetch"]["path"], follow_symlinks=False)
            if (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns) != self.fetch_id:
                self.stats["failed"] += 1; return self.br.reply(c, 500, "Internal Server Error", {"error": "the pinned fetcher changed since start"})
            work = tempfile.mkdtemp(prefix="w-", dir=self.cfg["workDir"])
            try:
                code, reason, why = self.run_fetch(job, work, c, out)
                if code != 200:
                    self.stats["failed"] += 1
                    if why != "client gone":
                        self.br.reply(c, code, reason, {"error": why})
                    return
                self.send_witness(c, os.path.join(work, "witness.json"), job, out)
            finally:
                out["leftover"] = clean_run(work)
        except OSError:
            pass
        finally:
            if job:
                self.log({"t": time.time(), "track": job["track"], "requestSha256": job["requestSha256"], "range": [job["start"], job["end"]],
                          "interval": job["interval"], "rc": out["rc"], "witnessSha256": out.get("sha256"), "bytes": out.get("bytes"),
                          "sec": round(time.monotonic() - t0, 3), "served": out.get("served", False), "stderrTail": out.get("stderrTail", ""),
                          "leftover": out.get("leftover", [])})
            c.close()
            with self.cv:                                    # the LAST step: completion is observable only after all of the above
                self.active -= 1; self.completed += 1; self.workers.discard(threading.current_thread()); self.cv.notify_all()

    def run_fetch(self, job, work, c, out):
        cfg, e = self.cfg, self.cfg["endpoints"]
        argv = ["/usr/bin/prlimit", f"--as={cfg['fetchMemoryMiB'] * MIB}", f"--cpu={cfg['fetchTimeoutSec'] + 1}", f"--fsize={job['cap']}", "--core=0", "--",
                cfg["fetch"]["path"], e["l1Rpc"], e["l1Beacon"], e["l2Rpc"], e["l2Node"], str(job["start"]), str(job["end"]),
                job["l1Head"], str(job["interval"]), os.path.join(work, "witness.json")]
        with self.cv:
            if self.closing:
                return 503, "Service Unavailable", "shutting down: no new fetch"
            p = subprocess.Popen(argv, cwd=work, env={"PATH": "/usr/bin:/bin"}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.PIPE, start_new_session=True, close_fds=True)
            self.procs.add(p)                                # the Popen object (never a bare pid); its own session: pgid == pid
        tail = collections.deque(maxlen=STDERR_TAIL)                     # bounded: only the last STDERR_TAIL bytes are kept

        def drain():
            for chunk in iter(lambda: p.stderr.read1(65536), b""):
                tail.extend(chunk)
        reader = threading.Thread(target=drain, daemon=True); reader.start()
        end, why = time.monotonic() + cfg["fetchTimeoutSec"], None
        while True:
            with self.cv:                                    # r6: the ONLY reap (poll) and the unregistering are one critical section
                if p.poll() is not None:
                    self.procs.discard(p); break
                if why:
                    self.kill_owned(p)                       # still unreaped: its pgid cannot have been reused
            if not why:
                if time.monotonic() > end:
                    why = "deadline"; continue
                if self.client_gone(c):
                    why = "client gone"; continue
            time.sleep(0.05 if why else 0.2)
        reader.join(5); p.stderr.close()                     # stderr may stay open after the reap (a grandchild): never a kill now
        out["rc"], out["stderrTail"] = p.returncode, bytes(tail)[-300:].decode("utf-8", "replace")
        if why == "deadline":
            return 504, "Gateway Timeout", "witness fetch deadline (killed)"
        if why:
            return 499, "Client Closed Request", why
        if p.returncode == -signal.SIGXFSZ:
            return 502, "Bad Gateway", f"the fetcher exceeded the {job['cap']}-byte file bound while writing (killed): not served"
        if p.returncode != 0:
            return 502, "Bad Gateway", f"witness fetch failed rc {p.returncode}: {out['stderrTail']}"
        return 200, "OK", None

    @staticmethod
    def client_gone(c):
        try:
            r, _, _ = select.select([c], [], [], 0)
            return bool(r) and c.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) == b""
        except (BlockingIOError, InterruptedError):
            return False
        except OSError:
            return True

    def send_witness(self, c, path, job, out):
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        except FileNotFoundError:
            self.stats["failed"] += 1
            return self.br.reply(c, 502, "Bad Gateway", {"error": "the fetcher exited 0 but left no witness output: not served"})
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_size == 0 or st.st_size > job["cap"]:
                self.stats["failed"] += 1
                return self.br.reply(c, 502, "Bad Gateway", {"error": f"witness of {st.st_size} bytes is outside 1..{job['cap']}: not served"})
            h, n = hashlib.sha256(), 0
            c.settimeout(60.0)
            c.sendall(f"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {st.st_size}\r\nConnection: close\r\n\r\n".encode())
            while n < st.st_size:
                b = os.read(fd, min(LIMITS["chunk"], st.st_size - n))
                if not b:
                    break                                       # shorter than its fstat size: the client sees a short body, never padding
                c.sendall(b); h.update(b); n += len(b)
            out.update(sha256=h.hexdigest(), bytes=n, served=n == st.st_size); self.stats["served"] += n == st.st_size
        finally:
            os.close(fd)


def main(argv=None):
    a = argv if argv is not None else sys.argv[1:]
    if len(a) != 3 or a[0] not in ("serve", "check-config") or a[1] != "--config":
        print(__doc__); return 2
    try:
        cfg = load_config(a[2])
        if a[0] == "check-config":
            load_bridge(cfg["bridge"]["path"])
            print(json.dumps({"ok": True, "fetchSha256": FETCH_ELF_SHA256, "fetchSourceSha256": FETCH_SOURCE_SHA256, "bridgeSha256": BRIDGE_SHA256,
                              "endpoints": cfg["endpoints"]}, sort_keys=True))
            return 0
        p = Producer(cfg)
    except (Invalid, OSError) as e:
        print(f"REFUSED: {e}", file=sys.stderr); return 1
    print(f"witness-producer r3 on {p.address[0]}:{p.address[1]} (single flight; fetcher {FETCH_ELF_SHA256[:12]}; per-file bound = request cap)",
          file=sys.stderr, flush=True)
    p.serve_forever(); return 0


if __name__ == "__main__":
    sys.exit(main())
