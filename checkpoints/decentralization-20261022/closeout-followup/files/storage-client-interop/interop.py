#!/usr/bin/env python3
"""U1 interop (NOTE.md). The exact live sia-s3 0.1.8 wasm writes; the exact final 00e9cde0 wasm then makes its FIRST fenced
(C2) boot on that same account and must read every byte back; then 0.1.8 must be refused. Backend: real indexd (the
c2-enclave source, schema v28) inside harness-block c2e, with real RHP4 hosts on loopback and a NEW disposable
PostgreSQL 18 cluster in this run dir.

  run-ns.sh <run-id>   (private net + PID namespaces; never run this file directly on the host network)

Copied from work/storage-wasm-validation/e2e.py (e5d88c72), unchanged in behaviour: the SigV4 signer s3(), pubkey_hex(),
the wasmtime command line, the egress SOCKS front and the fixture writer-authority fact.
Writes runs/<id>/results.json. Exit 0 = every check passed."""
import hashlib, hmac, datetime, http.client, json, os, random, re, secrets, shutil, signal, subprocess, sys, threading, time, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.abspath(os.path.join(HERE, "..", ".."))
PGROOT = os.path.join(WORK, "storage-host-role/pg18/root")
PGBIN, PGLIB = os.path.join(PGROOT, "usr/bin"), os.path.join(PGROOT, "usr/lib")
HARNESS = os.path.join(WORK, "claude-resumed-20261022/storage-sdk-regressions/out/c2e-a/harness-block")
INDEXD_SRC = os.path.join(WORK, "claude-resumed-20261022/storage-funding-test-fix/snapshots/c2-enclave")
WASMTIME = "/usr/sbin/wasmtime"
EGRESS_PY = os.path.join(HERE, "egress_socks5.py")
ART = {"v018": os.path.join(WORK, "adapter-retained/bafybeib7at4cxxzmlp3wb7v45zrhbuggwzegspcacfylztslbcnoe6qrqu.bin"),
       "final": os.path.join(WORK, "storage-wasm-validation/artifacts/candidate-00e9cde0.wasm")}
PINS = {ART["v018"]: "d1ddecfe7c3e1d06d1921eb779e135f3a64f185a4dbcdd989f56e22f603e07d3",
        ART["final"]: "00e9cde0929dc7b8726ca4b7b9c9afb51ec4bf6d952039c907c032256ec79afc",
        HARNESS: "cac6651329468aaeb2dd4d90ac9b924a891b121edbe17d2515b34b0dae97eafa",
        EGRESS_PY: "77fad264406da15a85830ce1559fbd04feb2f9464b01576512a525112da09086",
        os.path.join(INDEXD_SRC, "GeoLite2-City.mmdb"): "18bf1695e85007dc1525e88bddd26d4f45b85550899bda8f8d1ebc1e804fc933"}
AK, SK, REGION = "INTEROPAK", "interop-fixture-secret-not-a-real-credential", "auto"
BUCKETS = ["ipfs", "git", "jot", "machines"]          # the live 0.1.8 version config's bucket set
MIB = 1 << 20

run_id = sys.argv[1]
assert re.fullmatch(r"[a-z0-9]{1,12}", run_id)
RUN = os.path.join(HERE, "runs", run_id)
os.makedirs(RUN)
R = {"run": run_id, "started": time.time(), "inputs": {}, "checks": [], "measure": [], "events": [], "db": {}}
sha_file = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
sha = lambda b: hashlib.sha256(b).hexdigest()


def save():
    json.dump(R, open(os.path.join(RUN, "results.json"), "w"), indent=1, default=str)


def log(*a):
    line = time.strftime("%H:%M:%S ") + " ".join(str(x) for x in a)
    print(line, flush=True)
    R["events"].append(line)


def check(name, ok, detail=""):
    R["checks"].append({"name": name, "ok": bool(ok), "detail": str(detail)[:1500]})
    log("CHECK", "PASS" if ok else "FAIL", name, str(detail)[:300])
    save()
    return bool(ok)


def data(tag, n):
    return random.Random(f"{run_id}/{tag}").randbytes(n)


def free_port():
    import socket
    with socket.socket() as so:
        so.bind(("127.0.0.1", 0))
        return so.getsockname()[1]


# ---------------- preconditions: pins and isolation ----------------

def preconditions():
    for p, want in PINS.items():
        got = sha_file(p)
        R["inputs"][os.path.relpath(p, WORK)] = got
        if got != want:
            raise SystemExit(f"pin mismatch {p}: {got} != {want}")
    nets = sorted(l.split(":")[0].strip() for l in open("/proc/net/dev").read().splitlines()[2:])   # per network namespace (sysfs is not)
    R["isolation"] = {"netInterfaces": nets, "uid": os.getuid(), "pid": os.getpid()}
    if nets != ["lo"] or os.getuid() == 0 or os.getpid() > 50:
        raise SystemExit(f"refused: not in the private namespaces (interfaces {nets}, uid {os.getuid()}, pid {os.getpid()})")
    R["wasmtime"] = subprocess.run([WASMTIME, "--version"], capture_output=True, text=True).stdout.strip()


# ---------------- disposable PostgreSQL 18 ----------------

class PG:
    def __init__(self):
        self.dir = os.path.join(RUN, "pg")
        self.data = os.path.join(self.dir, "data")
        os.makedirs(self.dir)
        # the Unix socket path must stay under 107 bytes: a short, owned, private dir (removed in close())
        import tempfile
        self.sock = tempfile.mkdtemp(prefix=f"u1pg-{run_id}-", dir="/tmp")
        R["pgSocketDir"] = self.sock
        try:
            self._start()
        except BaseException:
            self.close()
            raise

    def _start(self):
        self.pwfile = os.path.join(self.dir, "pw")
        fd = os.open(self.pwfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, secrets.token_hex(24).encode()); os.close(fd)
        self.env = {"PATH": f"{PGBIN}:/usr/bin:/bin", "LD_LIBRARY_PATH": PGLIB, "LC_ALL": "C", "TZ": "UTC"}
        subprocess.run([os.path.join(PGBIN, "initdb"), "-D", self.data, "-U", "interop", f"--pwfile={self.pwfile}", "--auth-local=trust",
                        "--auth-host=scram-sha-256", "-E", "UTF8", "--locale=C"], env=self.env, check=True, capture_output=True)
        self.log = open(os.path.join(RUN, "postgres.log"), "w")
        self.p = subprocess.Popen([os.path.join(PGBIN, "postgres"), "-D", self.data, "-c", "listen_addresses=127.0.0.1", "-p", "5432",
                                   "-c", f"unix_socket_directories={self.sock}", "-c", "shared_buffers=16MB", "-c", "max_connections=200",
                                   "-c", "fsync=off"], env=self.env, stdout=self.log, stderr=subprocess.STDOUT)
        for _ in range(60):
            if subprocess.run([os.path.join(PGBIN, "pg_isready"), "-h", self.sock, "-p", "5432"], env=self.env, capture_output=True).returncode == 0:
                break
            time.sleep(1)
        else:
            raise SystemExit("PostgreSQL not ready")
        R["postgres"] = subprocess.run([os.path.join(PGBIN, "postgres"), "--version"], env=self.env, capture_output=True, text=True).stdout.strip()
        log("postgres ready", R["postgres"])

    def q(self, sql):
        """read-only query on THIS run's indexer database (own disposable cluster)"""
        r = subprocess.run([os.path.join(PGBIN, "psql"), "-h", self.sock, "-p", "5432", "-U", "interop", "-d", f"sias3_real_{run_id}_r0",
                            "-v", "ON_ERROR_STOP=1", "-Atc", sql], env=self.env, capture_output=True, text=True)
        if r.returncode:
            raise RuntimeError(r.stderr[-500:])
        return r.stdout.strip()

    def close(self):
        if getattr(self, "p", None) is not None:
            subprocess.run([os.path.join(PGBIN, "pg_ctl"), "-D", self.data, "-m", "fast", "-w", "-t", "60", "stop"], env=self.env, capture_output=True)
            try:
                self.p.wait(timeout=60)
            except subprocess.TimeoutExpired:
                self.p.kill()
                self.p.wait(timeout=30)
        shutil.rmtree(self.data, ignore_errors=True)
        shutil.rmtree(self.sock, ignore_errors=True)


# ---------------- harness (real indexd + RHP4 hosts) ----------------

class Harness:
    def __init__(self, pg, hosts=30):
        self.dir = os.path.join(RUN, "harness")
        self.log = open(os.path.join(RUN, "harness.log"), "w")
        env = dict(os.environ, GOMEMLIMIT="256MiB", GOMAXPROCS="2")
        self.p = subprocess.Popen(["taskset", "-c", "0-1", HARNESS, "-dir", self.dir, "-indexd", INDEXD_SRC, "-run", run_id, "-indexers", "1",
                                   "-hosts", str(hosts), "-pg-host", "127.0.0.1", "-pg-port", "5432", "-pg-user", "interop",
                                   "-pg-password-file", pg.pwfile, "-log-level", "warn"], stdout=self.log, stderr=subprocess.STDOUT, env=env)
        for _ in range(900):
            if os.path.exists(os.path.join(self.dir, "ctl.url")):
                break
            if self.p.poll() is not None:
                raise SystemExit("harness exited before it was ready")
            time.sleep(1)
        else:
            raise SystemExit("harness not ready")
        self.ctl = open(os.path.join(self.dir, "ctl.url")).read().strip()
        log("harness ready", self.ctl)

    def post(self, path, timeout=900):
        u = urllib.parse.urlparse(self.ctl)
        c = http.client.HTTPConnection(u.hostname, u.port, timeout=timeout)
        c.request("POST", path, body=b"")
        r = c.getresponse()
        body = r.read().decode()
        if r.status != 200:
            raise RuntimeError(f"ctl {path}: {r.status} {body[:300]}")
        return json.loads(body) if body.strip() else {}

    def close(self):
        try:
            self.post("/exit?drop=1", timeout=120)
        except Exception as e:
            log("harness exit:", e)
        try:
            self.p.wait(timeout=120)
        except subprocess.TimeoutExpired:
            self.p.kill()
            self.p.wait(timeout=30)


def pubkey_hex(seed):
    """ed25519 public key of a 32-byte seed (copied from e2e.py)"""
    q = 2 ** 255 - 19
    d = -121665 * pow(121666, q - 2, q) % q
    I = pow(2, (q - 1) // 4, q)

    def xrecover(y):
        xx = (y * y - 1) * pow(d * y * y + 1, q - 2, q)
        x = pow(xx, (q + 3) // 8, q)
        if (x * x - xx) % q:
            x = x * I % q
        return q - x if x % 2 else x

    By = 4 * pow(5, q - 2, q) % q
    B = (xrecover(By), By, 1, xrecover(By) * By % q)

    def add(P, Q):
        x1, y1, z1, t1 = P
        x2, y2, z2, t2 = Q
        a = (y1 - x1) * (y2 - x2) % q
        b = (y1 + x1) * (y2 + x2) % q
        c = t1 * 2 * d * t2 % q
        dd = z1 * 2 * z2 % q
        e, f, g, h = b - a, dd - c, dd + c, b + a
        return (e * f % q, g * h % q, f * g % q, e * h % q)

    def mul(s, P):
        Rr = (0, 1, 1, 0)
        while s:
            if s & 1:
                Rr = add(Rr, P)
            P = add(P, P)
            s >>= 1
        return Rr

    h = hashlib.sha512(seed).digest()
    a = 2 ** 254 + sum(2 ** i * ((h[i // 8] >> (i % 8)) & 1) for i in range(3, 254))
    x, y, z, _ = mul(a, B)
    zi = pow(z, q - 2, q)
    x, y = x * zi % q, y * zi % q
    return (y | ((x & 1) << 255)).to_bytes(32, "little").hex()


class Egress:
    def __init__(self):
        self.port = free_port()
        self.log_path = os.path.join(RUN, "egress.log")
        self.p = subprocess.Popen(["taskset", "-c", "0-1", sys.executable, "-u", EGRESS_PY, str(self.port)],
                                  stdout=open(self.log_path, "w"), stderr=subprocess.STDOUT)
        time.sleep(1)
        self.url = f"socks5://dep1:tok1@127.0.0.1:{self.port}"

    def connects(self):
        return sum(1 for l in open(self.log_path) if l.startswith("CONNECT"))

    def close(self):
        self.p.terminate()
        self.p.wait(timeout=30)


# ---------------- the components under wasmtime ----------------

ALL = []


class Instance:
    def __init__(self, name, art, cfg, cwasm):
        self.name, self.port, self.art = name, free_port(), art
        self.log_path = os.path.join(RUN, f"{name}.log")
        env = {"PATH": os.environ["PATH"], "HOME": RUN}
        self.cmd = ["taskset", "-c", "2-3", WASMTIME, "run", "--allow-precompiled", "-S", "inherit-network", "-S", "allow-ip-name-lookup",
                    "--env", f"ENCLAVE_PORTS=http:8000={self.port}", "--env", f"ENCLAVE_EGRESS={EGRESS.url}", "--env", "SIAS3_CONFIG=" + json.dumps(cfg), cwasm]
        shown = {k: ("<fixture app key>" if k == "appKey" else v) for k, v in cfg.items()}
        if "replicas" in shown:
            shown["replicas"] = [{**r, "appKey": "<fixture app key>"} for r in cfg["replicas"]]
        R.setdefault("instances", {})[name] = {"artifact": art, "config": shown}
        self.t0 = time.time()
        self.p = subprocess.Popen(self.cmd, stdout=open(self.log_path, "w"), stderr=subprocess.STDOUT, env=env)
        ALL.append(self)
        self.peak, self.stop_sampling = 0, False
        self.sampler = threading.Thread(target=self.sample, daemon=True)
        self.sampler.start()
        self.ep = ("127.0.0.1", self.port)

    def alive(self):
        try:
            return open(f"/proc/{self.p.pid}/stat").read().rsplit(")", 1)[1].split()[0] != "Z"
        except OSError:
            return False

    def sample(self):
        while not self.stop_sampling and self.alive():
            try:
                rss = int(re.search(r"VmRSS:\s+(\d+)", open(f"/proc/{self.p.pid}/status").read()).group(1)) // 1024
                self.peak = max(self.peak, rss)
            except (OSError, AttributeError):
                pass
            time.sleep(0.2)

    def healthz(self):
        try:
            st, _, body = s3(self, "GET", raw_path="/healthz", sign=False, timeout=30)
            return json.loads(body) if st == 200 else {"status": st}
        except Exception as e:
            return {"error": str(e)[:200]}

    def wait_ready(self, timeout=900):
        t = time.time()
        while time.time() - t < timeout:
            if not self.alive():
                return False
            h = self.healthz()
            if h.get("ready") is True:
                log(self.name, "ready after", round(time.time() - t, 1), "s")
                return True
            time.sleep(2)
        return False

    def stop(self):
        self.stop_sampling = True
        self.sampler.join()
        if self.alive():
            os.kill(self.p.pid, signal.SIGTERM)
        for _ in range(300):
            pid, status, ru = os.wait4(self.p.pid, os.WNOHANG)
            if pid:
                break
            time.sleep(0.1)
        else:
            os.kill(self.p.pid, signal.SIGKILL)
            pid, status, ru = os.wait4(self.p.pid, 0)
        self.p.returncode = status
        m = {"op": f"{self.name} instance", "maxRssMiB": ru.ru_maxrss // 1024, "cpuS": round(ru.ru_utime + ru.ru_stime, 2),
             "wallS": round(time.time() - self.t0, 1), "sampledPeakRssMiB": self.peak, "status": status}
        R["measure"].append(m)
        return m


def enc(s, keep_slash=False):
    return urllib.parse.quote(s, safe="-_.~" + ("/" if keep_slash else ""))


def s3(inst, method, bucket=None, key="", query=None, body=b"", headers=None, raw_path=None, sign=True, timeout=1800, sink=None):
    """SigV4-signed S3 request (copied from e2e.py; bucket is a parameter here)"""
    query = query or {}
    headers = dict(headers or {})
    path = raw_path or ("/" + enc(bucket) + ("/" + enc(key, True) if key else ""))
    qs = "&".join(f"{enc(k)}={enc(v)}" for k, v in sorted(query.items()))
    host = f"{inst.ep[0]}:{inst.ep[1]}"
    if sign:
        now = datetime.datetime.now(datetime.timezone.utc)
        amz, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
        ph = hashlib.sha256(body).hexdigest()
        headers.update({"host": host, "x-amz-date": amz, "x-amz-content-sha256": ph})
        signed = sorted(k.lower() for k in headers)
        hmap = {k.lower(): str(v).strip() for k, v in headers.items()}
        canon = "\n".join([method, path, qs, "".join(f"{h}:{hmap[h]}\n" for h in signed), ";".join(signed), ph])
        scope = f"{day}/{REGION}/s3/aws4_request"
        sts = f"AWS4-HMAC-SHA256\n{amz}\n{scope}\n{hashlib.sha256(canon.encode()).hexdigest()}"
        k = hmac.new(("AWS4" + SK).encode(), day.encode(), hashlib.sha256).digest()
        for part in (REGION, "s3", "aws4_request"):
            k = hmac.new(k, part.encode(), hashlib.sha256).digest()
        sig = hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()
        headers["Authorization"] = f"AWS4-HMAC-SHA256 Credential={AK}/{scope}, SignedHeaders={';'.join(signed)}, Signature={sig}"
    c = http.client.HTTPConnection(*inst.ep, timeout=timeout)
    c.request(method, path + ("?" + qs if qs else ""), body=body, headers=headers)
    r = c.getresponse()
    if sink is not None:            # stream the body into a hash (as e2e.py), never held in driver memory
        out, n = b"", 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            sink.update(chunk); n += len(chunk)
        sink.n = n
    else:
        out = r.read()
    c.close()
    return r.status, {k.lower(): v for k, v in r.getheaders()}, out


# ---------------- expected state: (bucket, key) -> (tag, size) ; bytes are regenerated, only digests are kept ----------------

EXP = {}


def put(inst, b, k, tag, n, **kw):
    body = data(tag, n)
    t = time.time()
    st, h, out = s3(inst, "PUT", b, k, body=body, **kw)
    R["measure"].append({"op": f"{inst.name} PUT {b}/{k} {n}", "wallS": round(time.time() - t, 2), "status": st})
    if st == 200:
        EXP[(b, k)] = (tag, n)
    return st, h, out


def multipart(inst, b, k, parts, complete=True):
    """parts: [(tag, n)] -> (status of the last step, upload id, [(partNumber, etag)])"""
    st, _, out = s3(inst, "POST", b, k, query={"uploads": ""})
    m = re.search(rb"<UploadId>([^<]+)</UploadId>", out)
    if st != 200 or not m:
        return st, None, []
    uid, done = m.group(1).decode(), []
    for i, (tag, n) in enumerate(parts, 1):
        st, h, _ = s3(inst, "PUT", b, k, query={"partNumber": str(i), "uploadId": uid}, body=data(tag, n))
        if st != 200:
            return st, uid, done
        done.append((i, h.get("etag", "")))
    if not complete:
        return 200, uid, done
    return complete_mp(inst, b, k, uid, done, parts)


def complete_mp(inst, b, k, uid, done, parts):
    xml = "<CompleteMultipartUpload>" + "".join(f"<Part><PartNumber>{n}</PartNumber><ETag>{e}</ETag></Part>" for n, e in done) + "</CompleteMultipartUpload>"
    st, _, out = s3(inst, "POST", b, k, query={"uploadId": uid}, body=xml.encode())
    if st == 200 and b"<Error>" not in out:
        EXP[(b, k)] = ("mp:" + "+".join(f"{t}:{n}" for t, n in parts), sum(n for _, n in parts))
    return st, uid, done


class Sink:
    def __init__(self):
        self.h, self.n = hashlib.sha256(), 0

    def update(self, b):
        self.h.update(b)

    def hexdigest(self):
        return self.h.hexdigest()


DIGESTS = {}


def expected_digest(tag, n):
    if (tag, n) not in DIGESTS:
        DIGESTS[(tag, n)] = sha(expected_bytes(tag, n))
    return DIGESTS[(tag, n)]


def expected_bytes(tag, n):
    if tag.startswith("mp:"):
        return b"".join(data(t, int(x)) for t, x in (p.rsplit(":", 1) for p in tag[3:].split("+")))
    return data(tag, n)


def verify_all(inst, label, ranges=True):
    """every expected key: whole GET byte-exact; ranged GETs on the big ones; listing per bucket == expected exactly"""
    bad = []
    for (b, k), (tag, n) in sorted(EXP.items()):
        hs = Sink()
        st, _, _ = s3(inst, "GET", b, k, sink=hs)
        if st != 200 or hs.hexdigest() != expected_digest(tag, n):
            bad.append(f"{b}/{k}: {st} {hs.n}/{n}")
    check(f"{label}: every key reads back byte-exact ({len(EXP)} keys)", not bad, bad)
    if ranges:
        rb = []
        for (b, k), (tag, n) in sorted(EXP.items()):
            if n < 8 * MIB:
                continue
            full = expected_bytes(tag, n)
            for rng, want in ((f"bytes=0-99", full[:100]), (f"bytes={n - 5000}-{n - 4001}", full[n - 5000:n - 4000]),
                              ("bytes=-1000", full[-1000:]), (f"bytes={40 * MIB - 10}-{40 * MIB + 9}", full[40 * MIB - 10:40 * MIB + 10] if n > 40 * MIB + 10 else None)):
                if want is None:
                    continue
                st, _, out = s3(inst, "GET", b, k, headers={"range": rng})
                if st != 206 or out != want:
                    rb.append(f"{b}/{k} {rng}: {st} {len(out)}")
        check(f"{label}: ranged reads (incl. across the slab boundary) are byte-exact", not rb, rb)
    lb = []
    for b in BUCKETS:
        st, _, out = s3(inst, "GET", b, query={"list-type": "2", "prefix": ""})
        got = sorted(re.findall(r"<Contents>.*?<Key>(.*?)</Key>", out.decode(), re.S))
        want = sorted(k for (bb, k) in EXP if bb == b)
        if st != 200 or got != want:
            lb.append(f"{b}: {st} got {got} want {want}")
    check(f"{label}: listings are exact per bucket (deleted keys absent)", not lb, lb)


def account_row(pg, pk):
    row = pg.q(f"SELECT fence IS NOT NULL, cas_mode, seq_enabled, event_seq, fence_pending FROM accounts WHERE public_key = decode('{pk}', 'hex')")
    f, c, s, e, p = row.split("|")
    return {"fence": f == "t", "casMode": c == "t", "seqEnabled": s == "t", "eventSeq": int(e), "fencePending": p == "t",
            "objects": int(pg.q(f"SELECT COUNT(*) FROM objects o JOIN accounts a ON a.id = o.account_id WHERE a.public_key = decode('{pk}', 'hex')"))}


def precompile(name):
    out = os.path.join(RUN, f"{name}.cwasm")
    t = time.time()
    subprocess.run(["taskset", "-c", "2-3", WASMTIME, "compile", "-o", out, ART[name]], check=True)
    R["measure"].append({"op": f"wasmtime compile {name}", "wallS": round(time.time() - t, 1)})
    return out


def lease(gen):
    return {"source": "lease17", "chainId": 31337, "ledger": "0x" + "11" * 20, "deployment": "0x" + "22" * 32, "generation": gen}


def main():
    global EGRESS
    preconditions()
    pg = PG()
    h = harness = None
    EGRESS = None
    try:
        h = Harness(pg, hosts=30)
        EGRESS = Egress()
        url = h.post("/manifest")["indexers"][0]["url"]
        R["indexer"] = url
        R["db"]["dbVersion"] = pg.q("SELECT db_version FROM global_settings")
        check("backend: the harness indexer's PostgreSQL schema is exactly v28 (c2-enclave)", R["db"]["dbVersion"] == "28", R["db"]["dbVersion"])
        seed = hashlib.sha256(f"{run_id}/interop-app-key".encode()).digest()
        pk = pubkey_hex(seed)
        r = h.post(f"/register?idx=0&pk={pk}")
        log("registered fixture app key", pk[:16], "attachedHosts", r.get("attachedHosts"))
        R["appKeyPublic"] = pk
        cw = {k: precompile(k) for k in ART}
        cfg018 = {"indexer": url, "appKey": seed.hex(), "region": REGION, "buckets": BUCKETS,
                  "credentials": [{"accessKeyId": AK, "secretAccessKey": SK}], "compactEverySecs": 30}

        def cfg_final(gen):
            return {"replicas": [{"name": "r0", "indexer": url, "appKey": seed.hex()}], "writeQuorum": 1, "region": REGION, "buckets": BUCKETS,
                    "credentials": [{"accessKeyId": AK, "secretAccessKey": SK}], "writerFence": "required", "writerAuthority": lease(gen),
                    "instanceIsolation": "snp", "compactEverySecs": 60, "repairEverySecs": 10, "metadataTimeoutSecs": 60, "uploadTimeoutSecs": 900}

        # ---------------- L: the exact live 0.1.8 writes (unfenced, legacy account) ----------------
        old = Instance("v018-writer", "v018", cfg018, cw["v018"])
        if not check("L: the exact 0.1.8 wasm becomes ready on the v28 backend (unenrolled account)", old.wait_ready()):
            return
        ok = True
        for b, k, tag, n in [("ipfs", "a.txt", "a1", 1024), ("ipfs", "dir/b", "b", 100_000), ("git", "objects/c", "c", 700_000),
                             ("jot", "d", "d", 3_000_000), ("jot", "gone", "gone", 2048), ("machines", "alpine/e", "e", 12 * MIB),
                             ("machines", "two-slab", "two", 48 * MIB), ("ipfs", "a.txt", "a2", 5000)]:
            st, _, out = put(old, b, k, tag, n)
            ok &= check(f"L: 0.1.8 PUT {b}/{k} ({n} B)", st == 200, f"{st} {out[:200]!r}")
        st, _, _ = s3(old, "DELETE", "jot", "gone")
        if st == 204:
            EXP.pop(("jot", "gone"), None)
        check("L: 0.1.8 DELETE jot/gone", st == 204, st)
        st, _, _ = s3(old, "PUT", "ipfs", "dir/b", body=b"must-not-replace", headers={"if-none-match": "*"})
        check("L: 0.1.8 conditional PUT If-None-Match:* on an existing key is 412 (and changes nothing)", st == 412, st)
        st, _, _ = multipart(old, "git", "packs/mp", [("mp1", 5 * MIB), ("mp2", 1 * MIB)])
        check("L: 0.1.8 completed multipart upload git/packs/mp", st == 200, st)
        st, open_uid, open_parts = multipart(old, "jot", "open", [("op1", 5 * MIB)], complete=False)
        check("L: 0.1.8 leaves an OPEN multipart upload jot/open (1 part)", st == 200 and open_uid and len(open_parts) == 1, st)
        t = time.time()
        hz = old.healthz()
        while time.time() - t < 300 and not ((hz.get("compactor") or {}).get("compacted_objects", 0) > 0):
            time.sleep(5)
            hz = old.healthz()
        R["healthz018"] = hz
        check("L: 0.1.8's compactor packed small objects (packed-slab legacy format)", (hz.get("compactor") or {}).get("compacted_objects", 0) > 0, hz.get("compactor"))
        verify_all(old, "L: 0.1.8 reads its own writes")
        old.stop()
        R["db"]["beforeEnrollment"] = account_row(pg, pk)
        check("L: indexd DB before the first fenced boot: no fence, not in CAS mode (legacy account)",
              not R["db"]["beforeEnrollment"]["fence"] and not R["db"]["beforeEnrollment"]["casMode"], R["db"]["beforeEnrollment"])

        # ---------------- C: the exact final wasm's FIRST fenced (C2) boot on that account ----------------
        cand = Instance("final-first-boot", "final", cfg_final(1), cw["final"])
        if not check("C: final 00e9cde0 makes its first fenced (C2) boot on the 0.1.8-written account and becomes ready", cand.wait_ready()):
            return
        hz = cand.healthz()
        t = time.time()
        while time.time() - t < 300:
            rep = (hz.get("replicas") or [{}])[0]
            if (rep.get("record") or {}).get("admitted") and (rep.get("membership") or {}).get("phase") == "stable":
                break
            time.sleep(5)
            hz = cand.healthz()
        R["healthzFirstBoot"] = hz
        wf = hz.get("writerFence") or {}
        check("C: /healthz reports C2 verified and fence mode required", (wf.get("c2") or {}).get("verified") is True and wf.get("mode") == "required", wf)
        rep = (hz.get("replicas") or [{}])[0]
        check("C: first maintenance wrote the single-indexer membership record (admitted, epoch 1, stable)",
              (rep.get("record") or {}).get("admitted") is True and (rep.get("record") or {}).get("epoch") == 1 and (rep.get("membership") or {}).get("phase") == "stable",
              {"record": rep.get("record"), "membership": rep.get("membership")})
        R["db"]["afterEnrollment"] = account_row(pg, pk)
        check("C: indexd DB after the first fenced boot: fence installed and the account is in CAS mode (enrolled)",
              R["db"]["afterEnrollment"]["fence"] and R["db"]["afterEnrollment"]["casMode"], R["db"]["afterEnrollment"])
        R["evidenceAfterEnrollment"] = h.post("/evidence").get("evidence")
        verify_all(cand, "C: final reads the 0.1.8 writes")
        st, _, out = s3(cand, "GET", "jot", query={"uploads": ""})
        ids = re.findall(rb"<UploadId>([^<]+)</UploadId>", out)
        check("C: the open 0.1.8 multipart upload is listed by the final wasm", st == 200 and open_uid.encode() in ids, f"{st} {out[:300]!r}")
        st, h2, _ = s3(cand, "PUT", "jot", "open", query={"partNumber": "2", "uploadId": open_uid}, body=data("op2", MIB))
        st2, _, out2 = complete_mp(cand, "jot", "open", open_uid, open_parts + [(2, h2.get("etag", ""))], [("op1", 5 * MIB), ("op2", MIB)])
        check("C: the final wasm completes the 0.1.8 upload (0.1.8 part 1 + its own part 2) and it reads back", st == 200 and st2 == 200 and ("jot", "open") in EXP,
              f"part {st} complete {st2} {out2[:200]!r}")
        st, _, _ = put(cand, "ipfs", "new-by-final", "nf", 2 * MIB)
        st2, _, _ = put(cand, "jot", "d", "d2", MIB)
        st3, _, _ = s3(cand, "DELETE", "git", "objects/c")
        if st3 == 204:
            EXP.pop(("git", "objects/c"), None)
        check("C: the final wasm writes new, overwrites a 0.1.8 key and deletes a 0.1.8 key", (st, st2, st3) == (200, 200, 204), (st, st2, st3))
        verify_all(cand, "C: after the final wasm's writes")
        cand.stop()
        again = Instance("final-restart", "final", cfg_final(2), cw["final"])
        if check("C: a new final instance (generation 2) boots on the enrolled account", again.wait_ready()):
            verify_all(again, "C: after restart")
        again.stop()

        # ---------------- O: the old 0.1.8 client on the ENROLLED account ----------------
        R["db"]["beforeOld"] = account_row(pg, pk)
        old2 = Instance("v018-after-enrollment", "v018", cfg018, cw["v018"])
        ready = old2.wait_ready(timeout=300)
        R["healthz018AfterEnrollment"] = old2.healthz()
        st = st2 = None
        if old2.alive():
            try:
                st, _, out = s3(old2, "PUT", "ipfs", "by-0.1.8-after-enrollment", body=b"must be refused", timeout=300)
                st2, _, out2 = s3(old2, "DELETE", "ipfs", "dir/b", timeout=300)
            except Exception as e:
                log("old client request error:", e)
        check("O: 0.1.8 on the enrolled account cannot write: its PUT and DELETE are refused", st != 200 and st2 != 204,
              f"ready {ready} PUT {st} DELETE {st2}")
        old2.stop()
        R["db"]["afterOld"] = account_row(pg, pk)
        check("O: the refused 0.1.8 attempts changed nothing in indexd (same event head and object count)",
              (R["db"]["afterOld"]["eventSeq"], R["db"]["afterOld"]["objects"]) == (R["db"]["beforeOld"]["eventSeq"], R["db"]["beforeOld"]["objects"]),
              {"before": R["db"]["beforeOld"], "after": R["db"]["afterOld"]})
        last = Instance("final-after-old", "final", cfg_final(3), cw["final"])
        if check("O: the final wasm (generation 3) boots after the 0.1.8 attempt", last.wait_ready()):
            st, _, _ = s3(last, "GET", "ipfs", "by-0.1.8-after-enrollment")
            check("O: the 0.1.8 PUT is absent", st == 404, st)
            verify_all(last, "O: final state unchanged by the old client", ranges=False)
        last.stop()
    finally:
        for i in ALL:
            if i.alive():
                i.stop()
        R["egressConnects"] = EGRESS.connects() if EGRESS else None
        if EGRESS:
            EGRESS.close()
        if h:
            h.close()
        pg.close()
        du = subprocess.run(["du", "-sm", RUN], capture_output=True, text=True).stdout.split()
        R["diskBeforeCleanupMiB"] = int(du[0]) if du else None
        for d in (os.path.join(RUN, "harness", "hosts"), pg.data):
            shutil.rmtree(d, ignore_errors=True)
        for f in os.listdir(RUN):
            if f.endswith(".cwasm"):
                os.remove(os.path.join(RUN, f))
        R["cleanup"] = {"hostSectorsRemoved": not os.path.exists(os.path.join(RUN, "harness", "hosts")), "pgDataRemoved": not os.path.exists(pg.data), "pgSocketDirRemoved": not os.path.exists(pg.sock),
                        "pidsLeftInNamespace": sorted(int(p) for p in os.listdir("/proc") if p.isdigit() and int(p) != os.getpid())}
        R["finished"] = time.time()
        R["passed"] = sum(c["ok"] for c in R["checks"])
        R["failed"] = sum(not c["ok"] for c in R["checks"])
        save()
        log("checks passed", R["passed"], "failed", R["failed"], "cleanup", R["cleanup"])


signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError("driver wall bound 3000 s")))
signal.alarm(3000)
main()
sys.exit(0 if R.get("failed", 1) == 0 and R["checks"] else 1)
