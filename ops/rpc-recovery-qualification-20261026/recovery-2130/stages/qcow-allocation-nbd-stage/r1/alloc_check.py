#!/usr/bin/env python3
"""qcow-allocation-nbd-stage/r1 alloc_check.py (prepared by Claude 1705; NOT run by Claude). Python stdlib + the installed libnbd
Python binding (nbd 1.24.4) + the pinned qemu-nbd 11.1.2.

READ-ONLY allocation status of EXACT byte ranges of one qcow2 image: our own foreground `qemu-nbd --read-only` child serves the image
on a unix socket in our private run dir (file locking off: the image sits on a read-only mount; no lock is taken or needed), and the
libnbd client asks NBD block status ("base:allocation", plus "qemu:allocation-depth" when offered) for each range in bounded chunks
(<= 1 GiB per request: the protocol's 32-bit count). Only COMPACT TOTALS are kept (bytes per flag class, counters, <= 32 sample
non-data ranges): never the per-cluster map, never any data byte (no NBD read is ever issued).

Flags (NBD protocol / libnbd STATE_*): base:allocation HOLE=1 ("not allocated"), ZERO=2 ("reads as zeroes"); a range with neither flag
is ALLOCATED DATA. This is ALLOCATION status of the image layer only: it says nothing about content integrity.

    alloc_check.py --image IMG --ranges RANGES.json --run-dir DIR --qemu-nbd BIN --qemu-nbd-sha256 H [--timeout S] [--image-sha256 H]
      RANGES.json = {"ranges": [[byteStart, byteEnd), ...]}   (<= 100000 ranges, non-overlapping after sort)
Exit 0 written (whatever the classification); 3 refused / error (no result claimed); 4 cleanup incomplete (inspect).
"""
import argparse, errno, hashlib, json, os, signal, stat, subprocess, sys, threading, time

CHUNK = 1 << 30
MAX_RANGES = 100000
MAX_CALLS = 20_000_000
SAMPLES = 32
HOLE, ZERO = 1, 2


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


def _pdeathsig():
    import ctypes
    ctypes.CDLL(None, use_errno=True).prctl(1, int(signal.SIGTERM), 0, 0, 0)


def classify(tot, samples, start, length, flags, depth=None):
    k = "allocatedData" if not flags & (HOLE | ZERO) else "zeroNotHole" if flags == ZERO else "hole" if flags == HOLE else "holeZero"
    tot[k] += length
    if k != "allocatedData" and len(samples) < SAMPLES:
        samples.append({"start": start, "length": length, "flags": flags, **({"depth": depth} if depth is not None else {})})


def check(a):
    import nbd
    t0 = time.monotonic()
    if not os.path.isabs(a.run_dir) or os.path.islink(a.run_dir) or not os.path.isdir(a.run_dir):
        raise Refused("run dir must be an existing absolute directory")
    st = os.stat(a.run_dir)
    if st.st_uid != os.geteuid() or st.st_mode & 0o077:
        raise Refused("run dir must be private (0700, this user)")
    sock = os.path.join(a.run_dir, "nbd.sock")
    if os.path.lexists(sock):
        raise Refused("socket path exists: one check per run dir")
    if sha256_file(a.qemu_nbd, 64 << 20) != a.qemu_nbd_sha256:
        raise Refused("qemu-nbd is not the pinned binary")
    fd = os.open(a.image, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        pst = os.fstat(fd)
    finally:
        os.close(fd)
    if not stat.S_ISREG(pst.st_mode) or os.access(a.image, os.W_OK):
        raise Refused("image must be a regular file that this user cannot write")
    if "," in a.image:
        raise Refused("image path must not contain a comma (qemu option syntax)")
    before = ident(pst)
    if a.image_sha256 and sha256_file(a.image, 1 << 30) != a.image_sha256:
        raise Refused("image sha256 is not the expected one (fixture)")
    ranges = load_ranges(a.ranges)
    res = {"format": "qcow-allocation-nbd/v1", "image": a.image, "imageBefore": before, "ranges": len(ranges),
           "rangeBytes": sum(e - s for s, e in ranges), "chunkBytes": CHUNK,
           "meaning": "image-layer ALLOCATION status only (NBD base:allocation); NOT content integrity; no data byte was read"}
    child, log = None, open(os.path.join(a.run_dir, "qemu-nbd.out"), "wb")
    killed = threading.Event()
    try:
        opts = f"driver=qcow2,file.driver=file,file.filename={a.image},file.locking=off,read-only=on"
        child = subprocess.Popen([a.qemu_nbd, "--read-only", "--shared=1", "--allocation-depth",
                                  f"--socket={sock}", "--image-opts", opts], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                 start_new_session=True, preexec_fn=_pdeathsig)
        res["server"] = {"pid": child.pid}
        end = time.monotonic() + 60
        while not os.path.exists(sock):
            if child.poll() is not None:
                raise Refused(f"qemu-nbd exited ({child.returncode}) before listening")
            if time.monotonic() > end:
                raise Refused("qemu-nbd did not listen within 60 s")
            time.sleep(0.1)

        def watchdog():                                   # a hung server/client cannot outlive the deadline
            if not killed.wait(max(1, a.timeout - (time.monotonic() - t0))):
                killed.set(); os.killpg(child.pid, signal.SIGKILL)
        threading.Thread(target=watchdog, daemon=True).start()
        h = nbd.NBD()
        h.add_meta_context(nbd.CONTEXT_BASE_ALLOCATION)
        h.add_meta_context("qemu:allocation-depth")
        h.connect_unix(sock)
        if not h.can_meta_context(nbd.CONTEXT_BASE_ALLOCATION):
            raise Refused("server does not offer base:allocation")
        has_depth = h.can_meta_context("qemu:allocation-depth")
        if not h.is_read_only():
            raise Refused("the NBD export is not read-only")
        size = h.get_size()
        if ranges[-1][1] > size:
            raise Refused(f"a range ends beyond the export size {size}")
        tot = {"allocatedData": 0, "zeroNotHole": 0, "hole": 0, "holeZero": 0}
        depth_tot, samples, calls, ranges_all_data = {}, [], 0, 0
        for s, e in ranges:
            pos, all_data = s, True
            while pos < e:
                calls += 1
                if calls > MAX_CALLS:
                    raise Refused("too many block-status calls")
                count = min(CHUNK, e - pos)
                got = {}

                def cb(meta, off, entries, err, got=got):
                    if meta in (nbd.CONTEXT_BASE_ALLOCATION, "qemu:allocation-depth") and meta not in got:
                        got[meta] = list(entries)
                    return 0
                h.block_status(count, pos, cb)
                ents = got.get(nbd.CONTEXT_BASE_ALLOCATION)
                if not ents or len(ents) % 2:
                    raise Refused(f"no base:allocation extents at {pos}")
                advanced = 0
                for i in range(0, len(ents), 2):
                    ln, fl = ents[i], ents[i + 1]
                    if ln <= 0:
                        raise Refused("zero-length extent from the server")
                    ln = min(ln, e - (pos + advanced))      # the final extent may extend past the asked range: clip
                    if ln <= 0:
                        break
                    if fl & ~(HOLE | ZERO):
                        raise Refused(f"unknown base:allocation flags {fl:#x}")
                    if fl & (HOLE | ZERO):
                        all_data = False
                    classify(tot, samples, pos + advanced, ln, fl)
                    advanced += ln
                if has_depth and "qemu:allocation-depth" in got:     # informational: 0 unallocated, 1 this image
                    d, dadv = got["qemu:allocation-depth"], 0
                    for i in range(0, len(d) - 1, 2):
                        n = min(d[i], advanced - dadv)
                        if n <= 0:
                            break
                        depth_tot[str(d[i + 1])] = depth_tot.get(str(d[i + 1]), 0) + n; dadv += n
                if advanced <= 0:
                    raise Refused(f"no progress at {pos}")
                pos += advanced
            ranges_all_data += all_data
        ext = bool(h.get_extended_headers_negotiated())
        h.shutdown()
        h.close()
        res.update(exportSize=size, extendedHeaders=ext, calls=calls, totals=tot, rangesFullyAllocatedData=ranges_all_data,
                   rangesWithHoleOrZero=len(ranges) - ranges_all_data, nonDataSamples=samples,
                   allocationDepthBytes=depth_tot if has_depth else "not offered", seconds=round(time.monotonic() - t0, 1))
        if sum(tot.values()) != res["rangeBytes"]:
            raise Refused("classified bytes != range bytes")
        return res
    finally:
        killed.set()
        if child is not None:
            for sig, w in ((None, 10), (signal.SIGTERM, 10), (signal.SIGKILL, 10)):
                if sig is not None and child.poll() is None:
                    try:
                        os.killpg(child.pid, sig)
                    except ProcessLookupError:
                        pass
                try:
                    child.wait(timeout=w); break
                except subprocess.TimeoutExpired:
                    continue
            res["serverReturncode"] = child.returncode
        log.close()
        if os.path.lexists(sock):
            os.unlink(sock)
        after = ident(os.stat(a.image))
        res["imageAfter"], res["imageUnchanged"] = after, after == before
        res["cleanupComplete"] = child is None or child.returncode is not None


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True); ap.add_argument("--ranges", required=True); ap.add_argument("--run-dir", required=True)
    ap.add_argument("--qemu-nbd", required=True); ap.add_argument("--qemu-nbd-sha256", required=True)
    ap.add_argument("--timeout", type=int, default=7200); ap.add_argument("--image-sha256")
    a = ap.parse_args(argv)
    if not 10 <= a.timeout <= 86400:
        print("timeout must be 10..86400", file=sys.stderr); return 2
    rc, out = 0, {}
    try:
        out = check(a)
        if not out.get("imageUnchanged") or not out.get("cleanupComplete"):
            rc = 4
    except Exception as e:                                       # noqa: BLE001 - every failure is a refusal; cleanup ran in check()
        out = {"refused": f"{type(e).__name__}: {e}"[:500]}; rc = 3
    try:
        fd = os.open(os.path.join(a.run_dir, f"result-{time.time_ns()}.json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.write(fd, (json.dumps({**out, "rc": rc}, indent=1, sort_keys=True) + "\n").encode()); os.close(fd)
    except OSError as e:
        print(f"result not written: {e}", file=sys.stderr); rc = rc or 3
    print(json.dumps({k: out.get(k) for k in ("refused", "totals", "rangesWithHoleOrZero", "imageUnchanged", "cleanupComplete")}))
    return rc


if __name__ == "__main__":
    sys.exit(main())
