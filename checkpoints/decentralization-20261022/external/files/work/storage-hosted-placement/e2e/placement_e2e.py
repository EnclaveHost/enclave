#!/usr/bin/env python3
"""PLACEMENT evidence (copied from work/storage-wasm-validation/e2e.py, frozen there; this copy adds the lease16
authority, replica rebuild, owner-cold and indexer-free recovery phases). Original docstring:
Release-component validation: the ACTUAL sia-s3 WASM components (wasmtime, no mock feature) served over real HTTP,
driven by SigV4-signed S3 requests, against REAL G-C2 indexd indexers and RHP4 hosts from the existing harness
(work/indexd-c2-implementation/bin/harness-c2: real indexd + PostgreSQL fixture + real coreutils RHP4/siamux hosts on
loopback; fixture chain/contracts/sector files). Fixture data and generated disposable app keys only.

  python3 e2e.py <run-id> [smoke|full]     (run it inside ONE claude-test-queue allocation; see run.sh)

Writes runs/<run-id>/: harness dir, one log per component instance, results.json (every check and every measurement).
"""
import hashlib, hmac, datetime, http.client, json, os, random, re, signal, subprocess, sys, threading, time, urllib.parse
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.dirname(os.path.dirname(HERE))
C2DIR = os.path.join(WORK, "indexd-c2-implementation")
HARNESS = os.path.join(C2DIR, "bin", "harness-c2")
PGENV = os.path.join(WORK, "storage-real-indexd", "postgres-fixture.env")
WASMTIME = "/usr/sbin/wasmtime"
VAL = os.path.join(WORK, "storage-wasm-validation", "artifacts")   # frozen, read-only copies (SHA256SUMS there)
ART = {"frozen": os.path.join(VAL, "frozen-c2-aa15a054.wasm"),
       "candidate": os.path.join(VAL, "candidate-00e9cde0.wasm")}
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
    def __init__(self, hosts, indexers=3):
        self.dir = os.path.join(RUN, "harness")
        env = dict(os.environ, GOMEMLIMIT="256MiB", GOMAXPROCS="2")
        self.log = open(os.path.join(RUN, "harness.log"), "w")
        self.p = subprocess.Popen(["taskset", "-c", "0-1", HARNESS, "-dir", self.dir, "-indexd", os.path.join(C2DIR, "src"),
                                   "-run", run_id, "-indexers", str(indexers), "-hosts", str(hosts), "-pg-host", "127.0.0.1",
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

    def __init__(self, name, art, replicas, authority, cwasm, isolation="vbs", wq=2, extra=None):
        """replicas: [(name, indexer index, seed hex, retiring)]; authority: the writerAuthority fact (dict)."""
        self.name, self.port, self.art = name, free_port(), art
        generation = json.dumps(authority, separators=(",", ":"))
        cfg = {
            "replicas": [{"name": n, "indexer": URLS[i], "appKey": s, **({"retiring": True} if r else {})} for n, i, s, r in replicas],
            "writeQuorum": wq,
            "buckets": [BUCKET],
            "credentials": [{"accessKeyId": AK, "secretAccessKey": SK}],
            "writerFence": "required",
            # as the front delivers it: the fact as a JSON string under the reserved name (front-binding interface)
            "writerAuthority": "$ENCLAVE_WRITER_AUTHORITY",
            "instanceIsolation": "$ENCLAVE_INSTANCE_ISOLATION",
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
                    "allow-ip-name-lookup", "--env", f"ENCLAVE_PORTS=http:8000={self.port}", "--env", f"ENCLAVE_EGRESS={EGRESS.url}",
                    "--env", f"ENCLAVE_WRITER_AUTHORITY={generation}", "--env", f"ENCLAVE_INSTANCE_ISOLATION={isolation}", "--env",
                    "SIAS3_CONFIG=" + json.dumps(cfg), cwasm]
        RESULTS.setdefault("commands", {})[name] = " ".join(self.cmd[:-3] + ["--env", "SIAS3_CONFIG=<fixture config: replicas, fixture keys, $ENCLAVE_WRITER_AUTHORITY, $ENCLAVE_INSTANCE_ISOLATION>", self.cmd[-1]])
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
    prefix = sorted(expected)[0].split("/")[0] + "/" if expected else "w/"
    st, keys, _ = list_keys(inst, prefix)
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


# ======================================================================================================================
# PLACEMENT PHASES (candidate artifact 00e9cde0..., the only artifact allowed in copy-tolerant mode)
# ======================================================================================================================

LEDGER16D = "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b"   # live EnclaveDeployments rev 16d (Base, chain 8453)
FIXTURE_DEPLOYMENT = "0x" + hashlib.sha256(b"storage-hosted-placement fixture deployment").hexdigest()  # NOT a real id


def lease16(claim_block, log_index):
    """The fact exactly as the front delivers it (storage-front-binding interface section 1; canonical key order)."""
    return {"source": "lease16", "chainId": 8453, "ledger": LEDGER16D, "deployment": FIXTURE_DEPLOYMENT,
            "claimBlock": claim_block, "claimLogIndex": log_index}


def recovery(name, args, key_seed_hex, workdir):
    """`sia-s3 recovery ...` as an owner runs it: the release component under wasmtime, a key file, no config,
    no indexer for `read`. Returns (status, rusage, log text)."""
    os.makedirs(workdir, exist_ok=True)
    kf = os.path.join(workdir, "app.key")
    with open(kf, "w") as f:
        f.write(key_seed_hex)
    os.chmod(kf, 0o600)
    logp = os.path.join(RUN, f"{name}.log")
    cmd = ["taskset", "-c", "2-3", WASMTIME, "run", "--allow-precompiled", "-S", "inherit-network", "-S", "allow-ip-name-lookup",
           "--dir", f"{workdir}::/work", "--env", "SIA_RECOVERY_KEY_FILE=/work/app.key", "--env", f"ENCLAVE_EGRESS={EGRESS.url}",
           CW["candidate"], "recovery", *args]
    RESULTS.setdefault("commands", {})[name] = " ".join(cmd)
    t = time.time()
    p = subprocess.Popen(cmd, stdout=open(logp, "w"), stderr=subprocess.STDOUT)
    _, status, ru = os.wait4(p.pid, 0)
    RESULTS["measure"].append({"op": name, "wallS": round(time.time() - t, 1), "cpuS": round(ru.ru_utime + ru.ru_stime, 2),
                               "maxRssMiB": ru.ru_maxrss // 1024, "status": status})
    return status, open(logp).read()


def register_full(h, idx, tag, hosts=30, attempts=6):
    """One fixture key on indexer `idx` that the indexer has attached to ALL hosts (production 10+20 layout needs 30
    distinct hosts per slab). Contracts form progressively in indexd's maintenance loop, so a key registered early can
    see fewer; mine, wait and use a fresh key until one sees every host. The shortfalls are recorded."""
    for a in range(attempts):
        seed = hashlib.sha256(f"{run_id}/{tag}/{idx}/{a}".encode()).digest()
        pk = pubkey_hex(seed)
        r = h.post(f"/register?idx={idx}&pk={pk}")
        n = r.get("attachedHosts")
        log("registered", tag, idx, "attempt", a, pk[:16], "attachedHosts", n)
        RESULTS.setdefault("registrations", []).append({"indexer": idx, "attempt": a, "attachedHosts": n})
        if n == hosts:
            return seed.hex(), pk
        h.post("/mine?n=10")
        time.sleep(45)
    raise SystemExit(f"indexer {idx}: no key attached to all {hosts} hosts after {attempts} attempts")


def objects_on(h, idx, pk):
    return h.post(f"/query?idx={idx}&q=objects&pk={pk}")["count"]


def main():
    global URLS, EGRESS, CW
    h = Harness(hosts=30, indexers=4)
    EGRESS = Egress()
    try:
        URLS = [i["url"] for i in h.post("/manifest")["indexers"]]
        RESULTS["indexers"] = URLS
        CW = {"candidate": precompile("candidate")}
        for _ in range(4):                                  # warm-up: let indexd form contracts with every host
            h.post("/mine?n=10")
            time.sleep(30)
        seeds = [register_full(h, i, "P") for i in range(4)]   # one generated fixture key per indexer r0..r3
        R = lambda i, retiring=False: (f"r{i}", i, seeds[i][0], retiring)
        SET1 = [R(0), R(1), R(2)]
        exp = {}

        # ---- 1. the production authority source: a lease16 fact (ledger 16d) under the reserved front names
        claim1 = lease16(52515800, 3)
        i1 = Instance("lease16-claim1", "candidate", SET1, claim1, CW["candidate"], isolation="vbs")
        ok1 = check("lease16 (ledger 16d) claim: fenced C2 boot on 3 replicas, isolation vbs (Shield front constant)", i1.wait_ready())
        if ok1:
            fz = i1.healthz().get("writerFence", {})
            check("healthz reports the lease16 authority, Vbs and verified C2",
                  "lease16" in str(fz.get("authority")) and fz.get("isolation") == "Vbs" and fz.get("c2", {}).get("verified") is True, json.dumps(fz)[:400])
            st, keys, _ = list_keys(i1, "p/")
            before = st
        # ---- 2. a reclaim (a later Claimed log: higher generation) preempts; the old lease refuses
        claim2 = lease16(52520000, 0)
        i2 = Instance("lease16-claim2", "candidate", SET1, claim2, CW["candidate"], isolation="vbs")
        if check("reclaim (later Claimed log) boots", i2.wait_ready()) and ok1:
            st, _, body = s3(i1, "GET", "p/x")
            st2, _, _ = s3(i1, "PUT", "p/x", body=b"x")
            check("the earlier claim served (LIST 200) and, once reclaimed, refuses GET and PUT (503)", before == 200 and st == 503 and st2 == 503,
                  f"before {before}; after GET {st} PUT {st2} {body[:200]!r}")
        RESULTS["measure"].append({"op": "lease16-claim1 instance", **i1.stop()})
        for k, n in (("p/small-a", 1024), ("p/small-b", 200_000), ("p/big", 12 * MIB)):
            b = data(f"P{k}", n)
            st, _, _ = put(i2, k, b)
            exp[k] = sha(b)
            check(f"claim2 PUT {k} ({n} B) on 3 replicas", st == 200, f"{st}")
        verify_all(i2, exp, "claim2")
        # ---- 3. the stale claim (claim1) is refused while claim2's fence is installed
        i3 = Instance("lease16-stale", "candidate", SET1, claim1, CW["candidate"], isolation="vbs")
        ready = i3.wait_ready(timeout=120)
        st, _, body = s3(i3, "GET", "p/small-a") if i3.alive() else (None, None, b"")
        check("a stale lease16 claim never becomes ready and serves nothing", not ready and st in (None, 503), f"ready {ready} GET {st} {body[:200]!r}")
        RESULTS["measure"].append({"op": "lease16-stale instance", **i3.stop()})
        # ---- 4. an indexer HOST is lost; writes continue on the remaining quorum
        pk = {i: seeds[i][1] for i in range(4)}
        h.post("/stop?idx=0")
        b = data("Pduring-loss", 2 * MIB)
        st, _, _ = put(i2, "p/during-loss", b)
        exp["p/during-loss"] = sha(b)
        check("r0's host lost: writes continue on r1+r2 (W=2)", st == 200, f"{st}")
        verify_all(i2, exp, "after host loss")
        RESULTS["measure"].append({"op": "lease16-claim2 instance", **i2.stop()})
        # ---- 5. rebuild on ANOTHER host from peers: membership change r0 (retiring, gone) -> r3 (new host, empty)
        SET2 = [R(0, True), R(1), R(2), R(3)]
        i4 = Instance("rebuild-r3", "candidate", SET2, claim2, CW["candidate"], isolation="vbs")
        if check("the same lease boots with r0 retiring and r3 (new, empty indexer) added", i4.wait_ready(timeout=1200)):
            t, last, stable = time.time(), -1, 0
            while time.time() - t < 600 and stable < 3:          # repair passes every 10 s; wait for r3 to settle
                n3 = objects_on(h, 3, pk[3])
                stable = stable + 1 if n3 == last and n3 > 0 else 0
                last = n3
                time.sleep(20)
            RESULTS.setdefault("rebuild", {})["objectCounts"] = {"r1": objects_on(h, 1, pk[1]), "r2": objects_on(h, 2, pk[2]), "r3": last}
            wd3 = os.path.join(RUN, "r3-proof")
            status, out = recovery("r3-export", ["export", URLS[3], "/work/snapshot.json"], seeds[3][0], wd3)
            okall = status == 0
            if okall:
                ssha3 = sha(open(os.path.join(wd3, "snapshot.json"), "rb").read())
                for k, dg in exp.items():
                    size = {"p/small-a": 1024, "p/small-b": 200_000, "p/big": 12 * MIB, "p/during-loss": 2 * MIB}[k]
                    st, out = recovery("r3-read-" + k.replace("/", "_"), ["read", "/work/snapshot.json", ssha3, BUCKET, k, "/work/out", dg, str(size)], seeds[3][0], wd3)
                    okall &= st == 0
                    if os.path.exists(os.path.join(wd3, "out")):
                        os.remove(os.path.join(wd3, "out"))
                os.remove(os.path.join(wd3, "app.key"))
            check("repair backfilled r3 from its peers (no backup): r3's OWN index holds every key, each recovered from r3's snapshot",
                  okall, f"object counts {RESULTS['rebuild']['objectCounts']}; {out[-200:]}")
            RESULTS.setdefault("healthz", {})["rebuild"] = i4.healthz()
        RESULTS["measure"].append({"op": "rebuild instance", **i4.stop()})
        # ---- 6. the migration completed: r0 removed from the config; r1 down too; reads come from r2+r3
        SET3 = [R(1), R(2), R(3)]
        i5 = Instance("after-rebuild", "candidate", SET3, claim2, CW["candidate"], isolation="vbs")
        if check("config without r0 boots (r1, r2, r3)", i5.wait_ready(timeout=900)):
            h.post("/stop?idx=1")
            ok = True
            for k, dg in exp.items():
                st, d = get_digest(i5, k)
                ok &= st == 200 and d == dg
            check("r1 also down: every key (incl. those written before r3 existed) reads via r2+r3", ok)
            h.post("/start?idx=1")
        RESULTS["measure"].append({"op": "after-rebuild instance", **i5.stop()})
        # ---- 6b. a fact derived from the LIVE ledger 16d by the front-binding reader (inventory/lease16-live-derivation-eyesoff.json),
        #         verbatim: the exact production format and ordering (its claim block 52818411 is later than claim2's)
        live = json.loads(json.load(open(os.path.join(HERE, "..", "inventory", "lease16-live-derivation-eyesoff.json")))["results"][0]["factJson"])
        i6 = Instance("live-ledger16d-fact", "candidate", SET3, live, CW["candidate"], isolation="vbs")
        if check("a lease16 fact derived from the LIVE ledger 16d (verbatim) boots and takes over", i6.wait_ready(timeout=900)):
            fz = i6.healthz().get("writerFence", {})
            check("its fence generation is the live claim's (16<<48 | 52818411<<16 | 571)", fz.get("ballot", {}).get("gen") == hex((16 << 48) | (52818411 << 16) | 571),
                  json.dumps(fz.get("ballot")))
            verify_all(i6, exp, "live-fact instance")
        RESULTS["measure"].append({"op": "live-fact instance", **i6.stop()})
        # ---- 7. owner cold path: the owner runs the same component, no catalog/relay/custody/lease
        own = Instance("owner-cold", "candidate", SET3, {"source": "owner-cold"}, CW["candidate"], isolation="owner-process")
        if check("owner-cold (owner-process) instance boots on r1..r3", own.wait_ready(timeout=900)):
            verify_all(own, exp, "owner-cold reads")
            b = data("Powner", 3 * MIB)
            st, _, _ = put(own, "p/owner-write", b)
            exp["p/owner-write"] = sha(b)
            check("owner-cold instance writes", st == 200, f"{st}")
        RESULTS["measure"].append({"op": "owner-cold instance", **own.stop()})
        # ---- 8. indexer-free recovery: snapshot export from one replica, then EVERY indexer down, read from hosts
        wd = os.path.join(RUN, "owner")
        status, out = recovery("recovery-export", ["export", URLS[2], "/work/snapshot.json"], seeds[2][0], wd)
        snap = os.path.join(wd, "snapshot.json")
        okx = check("recovery export from replica r2 (sealed snapshot, owner key)", status == 0 and os.path.exists(snap), out[-400:])
        for i in (1, 2, 3):
            h.post(f"/stop?idx={i}")
        if okx:
            ssha = sha(open(snap, "rb").read())
            RESULTS["snapshot"] = {"sha256": ssha, "bytes": os.path.getsize(snap)}
            for k in ("p/big", "p/small-b", "p/owner-write"):
                outname = "out-" + k.replace("/", "_")
                size = {"p/big": 12 * MIB, "p/small-b": 200_000, "p/owner-write": 3 * MIB}[k]
                status, out = recovery(f"recovery-read-{k.replace('/', '_')}", ["read", "/work/snapshot.json", ssha, BUCKET, k,
                                       f"/work/{outname}", exp[k], str(size)], seeds[2][0], wd)
                op = os.path.join(wd, outname)
                got = sha(open(op, "rb").read()) if os.path.exists(op) else None
                check(f"with EVERY indexer down, the owner recovers {k} from Sia hosts (snapshot + key only)",
                      status == 0 and got == exp[k], f"status {status} {out[-300:]}")
                if os.path.exists(op):
                    os.remove(op)   # fixture plaintext; the digest is the evidence
            os.remove(os.path.join(wd, "app.key"))
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
