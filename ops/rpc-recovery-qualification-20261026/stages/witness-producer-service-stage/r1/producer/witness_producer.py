#!/usr/bin/env python3
"""witness-producer-service-stage/r1 (PREPARED; NOT run): the in-guest, loopback-only, UNPRIVILEGED witness producer the integrated
derived-reader driver pulls from (writer-integrated r1 `createWitnessTransport`, request `enclave-derived-witness-request/v1`).

It is an ADAPTER, not a new primitive:
  - the witness is produced ONLY by the existing, root-built upstream capture `witness_fetch` (combined-r1 build, ELF sha 36604b9c…,
    source 69812507…; OPSuccinctDataFetcher -> SuccinctHost::fetch/run), with exactly the argv mapping of the existing runner
    (start = agreedL2BlockNumber, end = trusted.claimedL2BlockNumber, l1Head = trusted.l1Head, interval = trusted.intermediateBlockInterval);
  - the HTTP framing is the qualified r14 private bridge's (`read_request`, `reply`, `Refused`, `LOOPBACK`), loaded by sha-pinned
    compile+exec (cb976541…), never re-implemented;
  - the endpoints are our own nodes on 127.0.0.1 only (the r14 bridges for the ELs, the beacon and Base node loopback ports).
Nothing here is trusted or decides anything: the bytes are the fetcher's output, served verbatim, and only the pinned native harness
accepts or refuses them against the caller's trusted input. No cache, no fallback, no public RPC, no fabricated bytes: any failure is
a non-200 answer without a witness.

  witness_producer.py serve --config FILE        (the unit)
  witness_producer.py check-config --config FILE (pins and config only; does not listen)"""
import hashlib, json, os, re, select, signal, socket, stat, subprocess, sys, tempfile, threading, time, types

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
U63 = (1 << 63) - 1
MIB = 1 << 20
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
        raise Invalid("listen must be {host: 127.0.0.1, port: 1024..65535} (in-guest loopback only)")
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
        self.stats = {"admitted": 0, "busy": 0, "served": 0, "refused": 0, "failed": 0}

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
            with self.lock:
                admit = self.active < LIMITS["max_conn"]
                self.active += admit; self.stats["admitted" if admit else "busy"] += 1
            if not admit:                                    # single flight: refused before any byte is read (the bridge's rule)
                try:
                    c.settimeout(1.0); self.br.reply(c, 503, "Service Unavailable", {"error": "busy: one witness at a time"})
                except OSError:
                    pass
                c.close(); continue
            threading.Thread(target=self.handle, args=(c,), daemon=True).start()

    def shutdown(self):
        try:
            self.ls.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.ls.close()

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
                for n in ("witness.json", "witness.json.partial", "stderr.txt"):  # only this run's own files, by name
                    try:
                        os.unlink(os.path.join(work, n))
                    except FileNotFoundError:
                        pass
                os.rmdir(work)
        except OSError:
            pass
        finally:
            if job:
                self.log({"t": time.time(), "track": job["track"], "requestSha256": job["requestSha256"], "range": [job["start"], job["end"]],
                          "interval": job["interval"], "rc": out["rc"], "witnessSha256": out.get("sha256"), "bytes": out.get("bytes"),
                          "sec": round(time.monotonic() - t0, 3), "served": out.get("served", False)})
            c.close()
            with self.lock:
                self.active -= 1

    def run_fetch(self, job, work, c, out):
        cfg, e = self.cfg, self.cfg["endpoints"]
        argv = ["/usr/bin/prlimit", f"--as={cfg['fetchMemoryMiB'] * MIB}", f"--cpu={cfg['fetchTimeoutSec'] + 1}", "--",
                cfg["fetch"]["path"], e["l1Rpc"], e["l1Beacon"], e["l2Rpc"], e["l2Node"], str(job["start"]), str(job["end"]),
                job["l1Head"], str(job["interval"]), os.path.join(work, "witness.json")]
        with open(os.path.join(work, "stderr.txt"), "wb") as err:
            p = subprocess.Popen(argv, cwd=work, env={"PATH": "/usr/bin:/bin"}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=err, start_new_session=True, close_fds=True)
            end, why = time.monotonic() + cfg["fetchTimeoutSec"], None
            while p.poll() is None:
                if time.monotonic() > end:
                    why = "deadline"
                elif self.client_gone(c):
                    why = "client gone"
                if why:
                    try:
                        os.killpg(p.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    p.wait(); break
                time.sleep(0.2)
        out["rc"] = p.returncode
        if why == "deadline":
            return 504, "Gateway Timeout", "witness fetch deadline (killed)"
        if why:
            return 499, "Client Closed Request", why
        if p.returncode != 0:
            tail = open(os.path.join(work, "stderr.txt"), "rb").read()[-300:].decode("utf-8", "replace")
            return 502, "Bad Gateway", f"witness fetch failed rc {p.returncode}: {tail}"
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
    print(f"witness-producer on {p.address[0]}:{p.address[1]} (single flight; fetcher {FETCH_ELF_SHA256[:12]}; endpoints {sorted(cfg['endpoints'].values())})",
          file=sys.stderr, flush=True)
    p.serve_forever(); return 0


if __name__ == "__main__":
    sys.exit(main())
