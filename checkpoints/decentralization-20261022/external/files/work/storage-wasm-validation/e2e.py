#!/usr/bin/env python3
"""Release-component validation: the ACTUAL sia-s3 WASM components (wasmtime, no mock feature) served over real HTTP,
driven by SigV4-signed S3 requests, against REAL G-C2 indexd indexers and RHP4 hosts from the existing harness
(work/indexd-c2-implementation/bin/harness-c2: real indexd + PostgreSQL fixture + real coreutils RHP4/siamux hosts on
loopback; fixture chain/contracts/sector files). Fixture data and generated disposable app keys only.

  python3 e2e.py <run-id> [smoke|full]     (run it inside ONE claude-test-queue allocation; see run.sh)

Writes runs/<run-id>/: harness dir, one log per component instance, results.json (every check and every measurement).
"""
import hashlib, hmac, datetime, http.client, json, os, random, re, signal, subprocess, sys, threading, time, urllib.parse
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.dirname(HERE)
C2DIR = os.path.join(WORK, "indexd-c2-implementation")
HARNESS = os.path.join(C2DIR, "bin", "harness-c2")
PGENV = os.path.join(WORK, "storage-real-indexd", "postgres-fixture.env")
WASMTIME = "/usr/sbin/wasmtime"
ART = {"frozen": os.path.join(HERE, "artifacts", "frozen-c2-aa15a054.wasm"),
       "candidate": os.path.join(HERE, "artifacts", "candidate-00e9cde0.wasm")}
AK, SK, BUCKET, REGION = "VALIDATIONAK", "validation-fixture-secret-not-a-real-credential", "val", "auto"
MIB = 1 << 20
NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"

run_id = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else "full"
assert re.fullmatch(r"[a-z0-9]+", run_id)
RUN = os.path.join(HERE, "runs", run_id)
os.makedirs(RUN)
RESULTS = {"run": run_id, "mode": mode, "started": time.time(), "artifacts": {}, "checks": [], "measure": [], "events": []}
for k, p in ART.items():
    RESULTS["artifacts"][k] = {"path": p, "sha256": hashlib.sha256(open(p, "rb").read()).hexdigest(), "bytes": os.path.getsize(p)}
RESULTS["wasmtime"] = subprocess.run([WASMTIME, "--version"], capture_output=True, text=True).stdout.strip()


def save():
    json.dump(RESULTS, open(os.path.join(RUN, "results.json"), "w"), indent=1, default=str)


def log(*a):
    line = time.strftime("%H:%M:%S ") + " ".join(str(x) for x in a)
    print(line, flush=True)
    RESULTS["events"].append(line)


def check(name, ok, detail=""):
    RESULTS["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
    log("CHECK", "PASS" if ok else "FAIL", name, detail)
    save()
    return ok


# ---------------- deterministic fixture data (digests only are kept) ----------------

def data(tag, n):
    return random.Random(tag).randbytes(n)


def sha(b):
    return hashlib.sha256(b).hexdigest()


# ---------------- harness ----------------

class Harness:
    def __init__(self, hosts):
        self.dir = os.path.join(RUN, "harness")
        env = dict(os.environ, GOMEMLIMIT="256MiB", GOMAXPROCS="2")
        self.log = open(os.path.join(RUN, "harness.log"), "w")
        self.p = subprocess.Popen(["taskset", "-c", "0-1", HARNESS, "-dir", self.dir, "-indexd", os.path.join(C2DIR, "src"),
                                   "-run", run_id, "-indexers", "3", "-hosts", str(hosts), "-pg-host", "127.0.0.1",
                                   "-pg-port", "55432", "-pg-env", PGENV, "-log-level", "warn"],
                                  stdout=self.log, stderr=subprocess.STDOUT, env=env)
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
        try:
            return json.loads(body)
        except ValueError:
            return {}

    def close(self):
        try:
            self.post("/exit?drop=1", timeout=120)
        except Exception as e:
            log("harness exit:", e)
        try:
            self.p.wait(timeout=120)
        except subprocess.TimeoutExpired:
            self.p.terminate()
            self.p.wait(timeout=60)
        subprocess.run(["rm", "-rf", os.path.join(self.dir, "hosts")])


def pubkey_hex(seed):
    """ed25519 public key of a 32-byte seed (the sia app key), via the Python stdlib-free route: ask the harness? No:
    computed with a tiny pure-Python ed25519 (RFC 8032 reference arithmetic), only for fixture seeds."""
    q = 2 ** 255 - 19
    l = 2 ** 252 + 27742317777372353535851937790883648493
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
        R = (0, 1, 1, 0)
        while s:
            if s & 1:
                R = add(R, P)
            P = add(P, P)
            s >>= 1
        return R

    h = hashlib.sha512(seed).digest()
    a = 2 ** 254 + sum(2 ** i * ((h[i // 8] >> (i % 8)) & 1) for i in range(3, 254))
    x, y, z, _ = mul(a, B)
    zi = pow(z, q - 2, q)
    x, y = x * zi % q, y * zi % q
    enc = (y | ((x & 1) << 255)).to_bytes(32, "little")
    return enc.hex()


def register(h, tag, n=3):
    """`n` generated fixture app keys (one per indexer, from indexer 0), registered through the harness."""
    seeds = []
    for i in range(n):
        seed = hashlib.sha256(f"{run_id}/{tag}/{i}".encode()).digest()
        pk = pubkey_hex(seed)
        r = h.post(f"/register?idx={i}&pk={pk}")
        log("registered", tag, i, pk[:16], "attachedHosts", r.get("attachedHosts"))
        seeds.append((seed.hex(), pk))
    return seeds


# ---------------- the egress front ----------------

class Egress:
    """The deployment's egress SOCKS5 front (user/pass, CONNECT only): sia-s3's own spike/socks5.py, byte-identical
    copy. As in production (ENCLAVE_EGRESS), every component dial (indexer HTTP and host SiaMux) goes through it."""
    def __init__(self):
        self.port = free_port()
        self.log_path = os.path.join(RUN, "egress.log")
        self.p = subprocess.Popen(["taskset", "-c", "0-1", sys.executable, "-u", os.path.join(HERE, "egress_socks5.py"), str(self.port)],
                                  stdout=open(self.log_path, "w"), stderr=subprocess.STDOUT)
        time.sleep(1)
        self.url = f"socks5://dep1:tok1@127.0.0.1:{self.port}"

    def connects(self):
        return sum(1 for l in open(self.log_path) if l.startswith("CONNECT"))

    def close(self):
        self.p.terminate()
        self.p.wait(timeout=30)


# ---------------- the component under wasmtime ----------------

ALL = []


def free_port():
    """A loopback port the OS reports free now (other workers' services share this host)."""
    import socket
    with socket.socket() as so:
        so.bind(("127.0.0.1", 0))
        return so.getsockname()[1]


class Instance:
    port_next = 18600

    def __init__(self, name, art, seeds, generation, cwasm, extra=None):
        self.name, self.port, self.art = name, free_port(), art
        cfg = {
            "replicas": [{"name": f"r{i}", "indexer": URLS[i], "appKey": s} for i, (s, _) in enumerate(seeds)],
            "writeQuorum": 2 if len(seeds) == 3 else 1,
            "buckets": [BUCKET],
            "credentials": [{"accessKeyId": AK, "secretAccessKey": SK}],
            "writerFence": "required",
            "writerAuthority": {"source": "lease17", "chainId": 31337, "ledger": "0x" + "11" * 20,
                                "deployment": "0x" + "22" * 32, "generation": generation},
            "instanceIsolation": "snp",
            "compactEverySecs": 60,
            "repairEverySecs": 10,
            "metadataTimeoutSecs": 60,
            "uploadTimeoutSecs": 900,
        }
        cfg.update(extra or {})
        self.log_path = os.path.join(RUN, f"{name}.log")
        self.logf = open(self.log_path, "w")
        env = {"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/tmp")}
        self.cmd = ["taskset", "-c", "2-3", WASMTIME, "run", "--allow-precompiled", "-S", "inherit-network", "-S",
                    "allow-ip-name-lookup", "--env", f"ENCLAVE_PORTS=http:8000={self.port}", "--env", f"ENCLAVE_EGRESS={EGRESS.url}", "--env",
                    "SIAS3_CONFIG=" + json.dumps(cfg), cwasm]
        RESULTS.setdefault("commands", {})[name] = " ".join(self.cmd[:-3] + ["--env", "SIAS3_CONFIG=<fixture config: replicas, fixture keys, lease17 gen %d, snp>" % generation, self.cmd[-1]])
        self.t0 = time.time()
        self.p = subprocess.Popen(self.cmd, stdout=self.logf, stderr=subprocess.STDOUT, env=env)
        ALL.append(self)
        self.peak = 0
        self.stop_sampling = False
        self.sampler = threading.Thread(target=self.sample, daemon=True)
        self.sampler.start()
        self.ep = ("127.0.0.1", self.port)

    def proc_status(self):
        try:
            st = open(f"/proc/{self.p.pid}/status").read()
            rss = int(re.search(r"VmRSS:\s+(\d+)", st).group(1)) // 1024
            hwm = int(re.search(r"VmHWM:\s+(\d+)", st).group(1)) // 1024
            f = open(f"/proc/{self.p.pid}/stat").read().rsplit(")", 1)[1].split()
            tck = os.sysconf("SC_CLK_TCK")
            return {"rssMiB": rss, "hwmMiB": hwm, "cpuS": (int(f[11]) + int(f[12])) / tck}
        except (OSError, AttributeError):
            return None

    def alive(self):
        """Running and not yet a zombie, WITHOUT reaping it (stop() collects its rusage with wait4)."""
        try:
            return open(f"/proc/{self.p.pid}/stat").read().rsplit(")", 1)[1].split()[0] != "Z"
        except OSError:
            return False

    def sample(self):
        while not self.stop_sampling and self.alive():
            s = self.proc_status()
            if s:
                self.peak = max(self.peak, s["rssMiB"])
            time.sleep(0.2)

    def wait_ready(self, timeout=900):
        t = time.time()
        while time.time() - t < timeout:
            if not self.alive():
                return False
            try:
                st, _, body = s3(self, "GET", key=None, raw_path="/healthz", sign=False, timeout=10)
                if st == 200:
                    j = json.loads(body)
                    if j.get("ready") or j.get("status") == "ready":
                        log(self.name, "ready after", round(time.time() - t, 1), "s")
                        return True
            except Exception:
                pass
            time.sleep(2)
        return False

    def healthz(self):
        st, _, body = s3(self, "GET", key=None, raw_path="/healthz", sign=False, timeout=30)
        return json.loads(body) if st == 200 else {"status": st}

    def stop(self):
        self.stop_sampling = True
        self.sampler.join()
        if self.alive():
            os.kill(self.p.pid, signal.SIGTERM)
        try:
            _, status, ru = os.wait4(self.p.pid, 0)
        except ChildProcessError:
            return {}
        self.p.returncode = status
        return {"maxRssMiB": ru.ru_maxrss // 1024, "cpuUserS": round(ru.ru_utime, 2), "cpuSysS": round(ru.ru_stime, 2),
                "wallS": round(time.time() - self.t0, 1), "sampledPeakRssMiB": self.peak, "status": status}


# ---------------- S3 over HTTP (SigV4, as scripts/s3check.py) ----------------

def enc(s, keep_slash=False):
    return urllib.parse.quote(s, safe="-_.~" + ("/" if keep_slash else ""))


def s3(inst, method, key="", query=None, body=b"", headers=None, raw_path=None, sign=True, timeout=1800, sink=None):
    query = query or {}
    headers = dict(headers or {})
    path = raw_path or ("/" + enc(BUCKET) + ("/" + enc(key, True) if key else ""))
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
    if sink is not None:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            sink.update(chunk)
        data_ = b""
    else:
        data_ = r.read()
    c.close()
    return r.status, {k.lower(): v for k, v in r.getheaders()}, data_


def timed(label, fn, *a, **kw):
    t = time.time()
    out = fn(*a, **kw)
    RESULTS["measure"].append({"op": label, "wallS": round(time.time() - t, 2)})
    return out


def put(inst, key, body, **kw):
    st, h, b = timed(f"{inst.name} PUT {key} {len(body)}", s3, inst, "PUT", key, body=body, **kw)
    return st, h, b


def get_digest(inst, key, rng=None):
    hsh = hashlib.sha256()
    hd = {"range": rng} if rng else {}
    st, h, _ = timed(f"{inst.name} GET {key} {rng or ''}", s3, inst, "GET", key, headers=hd, sink=hsh)
    return st, hsh.hexdigest()


def list_keys(inst, prefix="", delimiter=None):
    q = {"list-type": "2", "prefix": prefix}
    if delimiter:
        q["delimiter"] = delimiter
    st, _, body = s3(inst, "GET", "", query=q)
    if st != 200:
        return st, [], []
    root = ET.fromstring(body)
    keys = [e.find(NS + "Key").text for e in root.findall(NS + "Contents")]
    pfx = [e.find(NS + "Prefix").text for e in root.findall(NS + "CommonPrefixes")]
    return st, keys, pfx


# ---------------- the bounded workload (identical for both artifacts) ----------------

SMALL = [("w/small-0", 1024), ("w/small-1", 100_000), ("w/small-2", 700_000), ("w/dir/small-3", 3_000_000)]
TWO_SLAB = ("w/two-slab", 48 * MIB)        # buffered PUT (below maxBodyBytes 64 MiB): 40 MiB + 8 MiB slabs
STREAM = ("w/stream", 70 * MIB)            # above maxBodyBytes: streamed to Sia while it arrives; 2 slabs
LEVELS = (1, 2, 3)                         # concurrent 8 MiB PUTs (the adapter's part size), single replica


def concurrency(inst, tag):
    """Levels of concurrent 8 MiB PUTs (plus one whole GET of the first object) on a single-replica instance. Records
    wall, component CPU and the component's VmHWM after each level (linear memory never shrinks, so the HWM steps
    are the extra memory each level needed)."""
    ok = True
    first = data(f"{tag}conc-seed", 8 * MIB)
    st, _, _ = put(inst, "c/seed", first)
    ok &= check(f"{inst.name} seed PUT", st == 200)
    for lvl in LEVELS:
        res = {}

        def one(i):
            b = data(f"{tag}conc{lvl}-{i}", 8 * MIB)
            res[i] = (s3(inst, "PUT", f"c/l{lvl}-{i}", body=b)[0], sha(b))

        def reader():
            res["get"] = get_digest(inst, "c/seed")

        th = [threading.Thread(target=one, args=(i,)) for i in range(lvl)] + [threading.Thread(target=reader)]
        before = inst.proc_status()
        t0 = time.time()
        [t.start() for t in th]
        [t.join() for t in th]
        after = inst.proc_status()
        RESULTS["measure"].append({"op": f"{inst.name} {lvl} concurrent 8 MiB PUT(s) + 1 GET (1 replica)", "wallS": round(time.time() - t0, 2),
                                   "cpuS": round(after["cpuS"] - before["cpuS"], 2), "hwmBeforeMiB": before["hwmMiB"], "hwmAfterMiB": after["hwmMiB"]})
        for i in range(lvl):
            st, d = get_digest(inst, f"c/l{lvl}-{i}")
            ok &= check(f"{inst.name} level {lvl}: concurrent PUT {i} reads back", res[i][0] == 200 and d == res[i][1], f"{res[i][0]}")
        ok &= check(f"{inst.name} level {lvl}: GET during the PUTs", res["get"] == (200, sha(first)))
    return ok


def workload(inst, tag, expected):
    """Write/read/list/range/overwrite/delete/copy/multipart/concurrency. `expected` collects key -> sha256."""
    ok = True
    for k, n in SMALL:
        b = data(f"{tag}{k}", n)
        st, h, _ = put(inst, k, b)
        ok &= check(f"{inst.name} PUT {k}", st == 200 and h.get("etag", "").strip('"') == hashlib.md5(b).hexdigest(), f"status {st}")
        expected[k] = sha(b)
    for k, n in (TWO_SLAB, STREAM):
        b = data(f"{tag}{k}", n)
        st, _, body = put(inst, k, b)
        ok &= check(f"{inst.name} PUT {k} ({n // MIB} MiB)", st == 200, f"status {st} {body[:200]!r}")
        expected[k] = sha(b)
        mid = 40 * MIB  # the first slab boundary (10 data shards x 4 MiB)
        whole = b
        st, d = get_digest(inst, k)
        ok &= check(f"{inst.name} GET {k} whole", st == 200 and d == expected[k], f"status {st}")
        for rng, lo, hi in ((f"bytes={mid - 100}-{mid + 99}", mid - 100, mid + 100), ("bytes=-1000", n - 1000, n), ("bytes=0-99", 0, 100)):
            st, d = get_digest(inst, k, rng)
            ok &= check(f"{inst.name} GET {k} {rng}", st == 206 and d == sha(whole[lo:hi]), f"status {st}")
        del b, whole
    for k, n in SMALL:
        st, d = get_digest(inst, k)
        ok &= check(f"{inst.name} GET {k}", st == 200 and d == expected[k], f"status {st}")
    st, keys, _ = list_keys(inst, "w/")
    ok &= check(f"{inst.name} LIST w/", st == 200 and sorted(keys) == sorted(expected), f"{keys}")
    st, keys, pfx = list_keys(inst, "w/", "/")
    ok &= check(f"{inst.name} LIST w/ delimiter", st == 200 and pfx == ["w/dir/"], f"{keys} {pfx}")
    # overwrite, conditional create on an existing key
    b = data(f"{tag}overwrite", 200_000)
    st, _, _ = put(inst, "w/small-1", b)
    expected["w/small-1"] = sha(b)
    st2, d = get_digest(inst, "w/small-1")
    ok &= check(f"{inst.name} overwrite w/small-1", st == 200 and st2 == 200 and d == expected["w/small-1"])
    st, _, _ = put(inst, "w/small-1", b"x", headers={"if-none-match": "*"})
    ok &= check(f"{inst.name} If-None-Match on an existing key is 412", st == 412, f"status {st}")
    # delete
    st, _, _ = timed(f"{inst.name} DELETE w/small-2", s3, inst, "DELETE", "w/small-2")
    expected.pop("w/small-2")
    st2, _, _ = s3(inst, "GET", "w/small-2")
    ok &= check(f"{inst.name} DELETE then GET 404", st == 204 and st2 == 404, f"{st} {st2}")
    # copy
    st, _, _ = s3(inst, "PUT", "w/copy", headers={"x-amz-copy-source": f"/{BUCKET}/w/small-0"})
    expected["w/copy"] = expected["w/small-0"]
    st2, d = get_digest(inst, "w/copy")
    ok &= check(f"{inst.name} CopyObject", st == 200 and d == expected["w/copy"], f"{st} {st2}")
    # multipart (5 MiB + 1 MiB)
    st, _, body = s3(inst, "POST", "w/multi", query={"uploads": ""})
    m = re.search(rb"<UploadId>([^<]+)</UploadId>", body) if st == 200 else None  # no xmlns on this result
    uid = m.group(1).decode() if m else None
    ok &= check(f"{inst.name} multipart create", uid is not None, f"status {st} {body[:200]!r}")
    parts, whole = [], b""
    for i, n in ((1, 5 * MIB), (2, MIB)):
        pb = data(f"{tag}part{i}", n)
        whole += pb
        st, h, _ = put(inst, "w/multi", pb, query={"partNumber": str(i), "uploadId": uid})
        parts.append((i, h.get("etag")))
    xml = "<CompleteMultipartUpload>" + "".join(f"<Part><PartNumber>{i}</PartNumber><ETag>{e}</ETag></Part>" for i, e in parts) + "</CompleteMultipartUpload>"
    st, _, _ = s3(inst, "POST", "w/multi", query={"uploadId": uid}, body=xml.encode())
    expected["w/multi"] = sha(whole)
    st2, d = get_digest(inst, "w/multi")
    ok &= check(f"{inst.name} multipart", st == 200 and d == expected["w/multi"], f"{st} {st2}")
    return ok


def verify_all(inst, expected, label):
    ok = True
    for k, dg in sorted(expected.items()):
        st, d = get_digest(inst, k)
        ok &= check(f"{label}: {inst.name} reads {k}", st == 200 and d == dg, f"status {st}")
    st, keys, _ = list_keys(inst, "w/")
    ok &= check(f"{label}: {inst.name} lists exactly the expected keys", sorted(keys) == sorted(expected), f"{sorted(set(keys) ^ set(expected))}")
    return ok


def wait_compaction(inst, expected_small, deadline_s):
    t = time.time()
    while time.time() - t < deadline_s:
        txt = open(inst.log_path).read()
        n = sum(int(m) for m in re.findall(r"compactor \(r\d\): repacked (\d+) objects", txt))
        if n >= 3 * expected_small:
            return n
        time.sleep(10)
    return sum(int(m) for m in re.findall(r"compactor \(r\d\): repacked (\d+) objects", open(inst.log_path).read()))


def precompile(name):
    out = os.path.join(RUN, f"{name}.cwasm")
    t = time.time()
    p = subprocess.Popen(["taskset", "-c", "2-3", WASMTIME, "compile", "-o", out, ART[name]])
    _, status, ru = os.wait4(p.pid, 0)
    m = {"op": f"wasmtime compile {name}", "wallS": round(time.time() - t, 1), "cpuS": round(ru.ru_utime + ru.ru_stime, 1),
         "maxRssMiB": ru.ru_maxrss // 1024, "status": status}
    RESULTS["measure"].append(m)
    log("precompiled", m)
    return out


def phase(label, fn):
    import traceback
    try:
        fn()
    except Exception:
        check(f"phase {label} completed without a driver exception", False, traceback.format_exc()[-1500:])


def main():
    global URLS, EGRESS
    h = Harness(hosts=30)
    EGRESS = Egress()
    try:
        URLS = [i["url"] for i in h.post("/manifest")["indexers"]]
        RESULTS["indexers"] = URLS
        cw = {k: precompile(k) for k in ART}
        if mode == "smoke":
            keys = register(h, "smoke")
            inst = Instance("smoke-frozen", "frozen", keys, 1, cw["frozen"])
            check("smoke: ready", inst.wait_ready())
            b = data("smoke", 1000)
            st, _, body = put(inst, "s/one", b)
            check("smoke: PUT", st == 200, f"{st} {body[:300]!r}")
            st, d = get_digest(inst, "s/one")
            check("smoke: GET", st == 200 and d == sha(b))
            RESULTS["healthz"] = inst.healthz()
            m = inst.stop()
            RESULTS["measure"].append({"op": "smoke instance", **m})
            return
        # S. the same bounded heavy workload on each artifact, ONE replica (the live single-indexer shape): multi-slab
        #    buffered and streamed PUTs, ranges, list, overwrite, delete, copy, multipart, concurrency, packing
        keysS = {"frozen": register(h, "Sfrozen", n=1), "candidate": register(h, "Scandidate", n=1)}
        expS = {"frozen": {}, "candidate": {}}
        for name in ("frozen", "candidate"):
            inst = Instance(f"{name}-S", name, keysS[name], 1, cw[name])
            if not check(f"{name}: boots fenced (C2) on one replica and becomes ready", inst.wait_ready()):
                RESULTS["measure"].append({"op": f"{name} S instance total", **inst.stop()})
                continue
            s0, t0 = inst.proc_status(), time.time()
            phase(f"{name} concurrency", lambda: concurrency(inst, name))
            s1 = inst.proc_status()
            RESULTS["measure"].append({"op": f"{name} S concurrency (identical ops, 1 replica, fresh instance)", "wallS": round(time.time() - t0, 1),
                                       "cpuS": round(s1["cpuS"] - s0["cpuS"], 2), "hwmMiB": s1["hwmMiB"]})
            s0, t0 = s1, time.time()
            phase(f"{name} workload", lambda: workload(inst, name, expS[name]))
            s1 = inst.proc_status()
            RESULTS["measure"].append({"op": f"{name} S workload (identical ops, 1 replica)", "wallS": round(time.time() - t0, 1),
                                       "cpuS": round(s1["cpuS"] - s0["cpuS"], 2), "hwmMiB": s1["hwmMiB"]})
            n = wait_compaction(inst, 1, 600)
            hz = inst.healthz()
            check(f"{name}: compactor repacked small objects (upload_packed path)", n > 0,
                  f"repacked {n}; healthz smallUnpacked={hz.get('smallUnpacked')} compactor={hz.get('compactor')}")
            for k in [k for k in list(expS[name]) if k.startswith("c/")]:
                pass
            verify_all(inst, {k: v for k, v in expS[name].items()}, f"{name} after packing")
            RESULTS.setdefault("healthz", {})[name] = hz
            RESULTS["measure"].append({"op": f"{name} S instance total", **inst.stop()})
        # O. old-format readback (candidate reads what the frozen artifact wrote, incl. multi-slab and packed objects),
        #    preemption, rollback readback and a stale lease, on the frozen artifact's single-replica account
        expA, keysA = expS["frozen"], keysS["frozen"]
        cand = Instance("candidate-reads-frozen", "candidate", keysA, 2, cw["candidate"])
        if check("candidate boots on the frozen artifact's account (lease gen 2)", cand.wait_ready()):
            verify_all(cand, expA, "old-format readback")
            b = data("cand-on-A", 5 * MIB)
            st, _, _ = put(cand, "w/written-by-candidate", b)
            expA["w/written-by-candidate"] = sha(b)
            check("candidate writes on the frozen artifact's account", st == 200)
        RESULTS["measure"].append({"op": "old-format instance", **cand.stop()})
        x = Instance("gen3", "candidate", keysA, 3, cw["candidate"])
        if check("gen-3 instance boots", x.wait_ready()):
            st0, _ = get_digest(x, "w/small-0")
            back = Instance("frozen-gen4", "frozen", keysA, 4, cw["frozen"])
            if check("frozen artifact boots with lease gen 4", back.wait_ready()):
                st, _, _ = s3(x, "GET", "w/small-0")
                st2, _, _ = s3(x, "PUT", "w/after-preempt", body=b"x")
                check("gen 3 served before; after gen 4 took over it refuses reads and writes", st0 == 200 and st == 503 and st2 == 503,
                      f"before {st0}; after GET {st} PUT {st2}")
                RESULTS["measure"].append({"op": "gen3 instance", **x.stop()})
                verify_all(back, expA, "rollback readback (frozen reads candidate writes)")
                stale = Instance("stale-gen3", "candidate", keysA, 3, cw["candidate"])
                ready = stale.wait_ready(timeout=120)
                st, _, body = s3(stale, "GET", "w/small-0") if stale.alive() else (None, None, b"")
                check("a stale-lease instance (gen 3 < 4) is refused: never ready, serves nothing", not ready and st in (None, 503),
                      f"ready {ready} GET {st} {body[:200]!r}")
                st, d = get_digest(back, "w/small-0")
                check("the gen-4 writer still serves after the stale attempt", st == 200 and d == expA["w/small-0"])
                RESULTS["measure"].append({"op": "stale instance", **stale.stop()})
            RESULTS["measure"].append({"op": "frozen gen4 instance", **back.stop()})
        if x.alive():
            RESULTS["measure"].append({"op": "gen3 instance", **x.stop()})
        # R. three replicas (W=2): each artifact, identical small ops (each still a full 30-shard slab per replica)
        keysR = {"frozen": register(h, "Rfrozen"), "candidate": register(h, "Rcandidate")}
        expR = {}
        for name in ("frozen", "candidate"):
            inst = Instance(f"{name}-R", name, keysR[name], 1, cw[name])
            if check(f"{name}: boots fenced (C2) on 3 replicas", inst.wait_ready()):
                s0, t0 = inst.proc_status(), time.time()
                ok = True
                for i in range(3):
                    b = data(f"R{name}{i}", MIB)
                    st, _, _ = put(inst, f"r/obj-{i}", b)
                    st2, d = get_digest(inst, f"r/obj-{i}")
                    ok &= st == 200 and st2 == 200 and d == sha(b)
                    if name == "candidate":
                        expR[f"r/obj-{i}"] = sha(b)
                st, keys, _ = list_keys(inst, "r/")
                std, _, _ = s3(inst, "DELETE", "r/obj-2")
                st404, _, _ = s3(inst, "GET", "r/obj-2")
                if name == "candidate":
                    expR.pop("r/obj-2")
                check(f"{name}: 3-replica PUT/GET/LIST/DELETE", ok and st == 200 and len(keys) == 3 and std == 204 and st404 == 404, f"{st} {keys} {std} {st404}")
                s1 = inst.proc_status()
                RESULTS["measure"].append({"op": f"{name} R ops (identical, 3 replicas)", "wallS": round(time.time() - t0, 1),
                                           "cpuS": round(s1["cpuS"] - s0["cpuS"], 2), "hwmMiB": s1["hwmMiB"]})
            RESULTS["measure"].append({"op": f"{name} R instance total", **inst.stop()})
        # F. endpoint loss, failover and rejoin (candidate, 3 replicas, lease gen 2)
        keysB = keysR["candidate"]
        fo = Instance("candidate-failover", "candidate", keysB, 2, cw["candidate"])
        if check("candidate (gen 2) boots on its 3-replica accounts", fo.wait_ready()):
            pk0 = keysB[0][1]
            b0 = h.post(f"/query?idx=0&q=objects&pk={pk0}")["count"]
            h.post("/stop?idx=0")
            b = data("during-outage", 2 * MIB)
            st, _, _ = put(fo, "r/during-outage", b)
            expR["r/during-outage"] = sha(b)
            st2, d = get_digest(fo, "r/during-outage")
            st3, d3 = get_digest(fo, "r/obj-0")
            check("indexer r0 down: PUT and GETs (new and old keys) succeed with W=2 of 3",
                  st == 200 and st2 == 200 and d == expR["r/during-outage"] and st3 == 200 and d3 == expR["r/obj-0"], f"{st} {st2} {st3}")
            h.post("/start?idx=0")
            t = time.time()
            n0 = n1 = 0
            while time.time() - t < 600:
                n0 = h.post(f"/query?idx=0&q=objects&pk={pk0}")["count"]
                n1 = h.post(f"/query?idx=1&q=objects&pk={keysB[1][1]}")["count"]
                if n0 == n1 and n0 > b0:
                    break
                time.sleep(10)
            check("r0 rejoins and repair backfills it (its object count grows to r1's)", n0 == n1 and n0 > b0, f"r0 {b0} -> {n0}, r1 {n1}")
            h.post("/stop?idx=1")
            ok = True
            for k, dg in expR.items():
                st, d = get_digest(fo, k)
                ok &= st == 200 and d == dg
            check("r1 down after the rejoin: every key (incl. the one written during r0's outage) reads via r0+r2", ok)
            h.post("/start?idx=1")
            RESULTS.setdefault("healthz", {})["failover"] = fo.healthz()
        RESULTS["measure"].append({"op": "failover instance", **fo.stop()})
    finally:
        for i in ALL:
            if i.alive():
                RESULTS["measure"].append({"op": f"{i.name} (stopped at exit)", **i.stop()})
        RESULTS["finished"] = time.time()
        RESULTS["egressConnects"] = EGRESS.connects()
        save()
        EGRESS.close()
        h.close()
        RESULTS["passed"] = sum(c["ok"] for c in RESULTS["checks"])
        RESULTS["failed"] = sum(not c["ok"] for c in RESULTS["checks"])
        save()
        log("checks passed", RESULTS["passed"], "failed", RESULTS["failed"])


main()
sys.exit(0 if RESULTS.get("failed", 1) == 0 and RESULTS["checks"] else 1)
