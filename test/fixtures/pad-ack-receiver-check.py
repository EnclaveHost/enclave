#!/usr/bin/env python3
"""Fixtures for the pad-ACK streaming-hash candidate on the GENERATED harness (verbatim candidate reception block +
pads_judge_fd + write_all; bounded fake syscall/crypto boundaries; real SHA-256). Every case runs with a 10 s limit and
its REAL exit code is retained; a timeout is a FAIL. Oracle: the feeder's deterministic stream re-implemented in Python
and hashed with hashlib; the published file is also re-hashed by the old reread. Cases: success (random chunks), 1-byte
chunks, short stream, injected write ENOSPC mid-file, injected fsync failure on the REAL file, truncation after fsync,
rename failure, dirsync failure, signing failure (published, NOT acknowledged), header-check failure, prefix asset (never
hashed/acknowledged), retry of an already stored shipment (held-descriptor path, H + PADACK), 0-byte shipment."""
import hashlib, json, os, subprocess, sys, tempfile, time
from pathlib import Path
BINARY = Path(sys.argv[1]); ok = True
def check(n, c, info=""):
    global ok; print(("PASS " if c else "FAIL ") + n + ("" if c else "  " + str(info)[:600])); ok &= bool(c)
def run(*args, dir_=None, knob="1"):
    env = dict(os.environ)
    env.pop("SHIELDED_PAD_ACK_STREAM", None)
    if knob is not None: env["SHIELDED_PAD_ACK_STREAM"] = knob
    t0 = time.time()
    try: p = subprocess.run([str(BINARY)] + list(args) + (["dir=" + dir_] if dir_ else []), capture_output=True, text=True, timeout=10, env=env)
    except subprocess.TimeoutExpired: return dict(TIMEOUT=True, elapsed=round(time.time() - t0, 1))
    try: r = json.loads(p.stdout)
    except ValueError: r = dict(BADJSON=p.stdout[-300:], stderr=p.stderr[-300:])
    r["rc"] = p.returncode; r["elapsed"] = round(time.time() - t0, 2); return r
def oracle(total, maxchunk, shortstop=False, seed=0x51):
    s = seed; sent = 0; limit = total // 2 if shortstop else total; h = hashlib.sha256()
    while sent < limit:
        s = (s * 1103515245 + 12345) & 0xffffffff; n = 1 + (s >> 8) % maxchunk; n = min(n, limit - sent); b = bytearray(n)
        for i in range(n): s = (s * 1103515245 + 12345) & 0xffffffff; b[i] = (s >> 16) & 0xff
        h.update(b); sent += n
    return h.hexdigest()
def padack_sha(r): return r["padack"].split()[4] if r.get("padack") else None
with tempfile.TemporaryDirectory() as d:
    N = 3000000; exp = oracle(N, 70000)
    r = run("feed=%d" % N, "chunk=70000", "shortwrites=1", dir_=d); check("(14) forced SHORT writes on the file fd (write_all must continue): K, PADACK sha == hashlib oracle == published reread, short_writes > 0", r.get("rc") == 0 and r.get("resp") == "K" and r.get("short_writes", 0) > 0 and padack_sha(r) == exp == r.get("published_sha"), r)
    r = run("feed=%d" % N, "chunk=70000", "eintr=5", dir_=d); check("(15) EINTR injected on every 5th file write (write_all must retry): K, digest equivalence holds, eintr_injected > 0", r.get("rc") == 0 and r.get("resp") == "K" and r.get("eintr_injected", 0) > 0 and padack_sha(r) == exp == r.get("published_sha"), r)
    r = run("feed=%d" % N, "chunk=70000", "prefix=1", dir_=d); check("(16) prefix asset: ZERO anchor_sha256_update calls (hashing really skipped, not just unsigned)", r.get("rc") == 0 and r.get("resp") == "K" and r.get("sha_updates") == 0 and r.get("sign_calls") == 0, r)
    r = run("feed=%d" % N, "chunk=70000", dir_=d); check("(16b) shipment: sha updates == successful write_all calls' chunks (> 0)", r.get("rc") == 0 and r.get("sha_updates", 0) > 0, r)
    r = run("feed=%d" % N, "chunk=70000", dir_=d); check("(1) success: K, published, PADACK once, ack sha == hashlib oracle == old reread of the published file, no tmp left, rc 0", r.get("rc") == 0 and r.get("resp") == "K" and r.get("published") == 1 and r.get("padack_lines") == 1 and padack_sha(r) == exp == r.get("published_sha") and r.get("published_bytes") == N and r.get("tmp_left") == 0, r)
    r = run("feed=%d" % N, "chunk=1", dir_=d); check("(2) 1-byte chunks: same equivalence", r.get("rc") == 0 and r.get("resp") == "K" and padack_sha(r) == oracle(N, 1) == r.get("published_sha"), r)
    r = run("feed=%d" % N, "chunk=70000", "short=1", dir_=d); check("(3) short stream: E, not published, tmp removed, no PADACK, 'FAILED at' logged", r.get("rc") == 0 and r.get("resp") == "E" and r.get("published") == 0 and r.get("tmp_left") == 0 and r.get("padack_lines") == 0 and "FAILED at" in r.get("out", ""), r)
    r = run("feed=%d" % N, "chunk=70000", "writefail=1000000", dir_=d); check("(4) write ENOSPC injected after 1,000,000 B: E, not published, no PADACK, 'write No space' logged", r.get("rc") == 0 and r.get("resp") == "E" and r.get("published") == 0 and r.get("padack_lines") == 0 and "No space" in r.get("out", ""), r)
    r = run("feed=%d" % N, "chunk=70000", "fsyncfail=1", dir_=d); check("(5) fsync failure injected on the REAL file: E, not published, no PADACK (all bytes had arrived)", r.get("rc") == 0 and r.get("resp") == "E" and r.get("published") == 0 and r.get("padack_lines") == 0 and "FAILED at %d of %d" % (N, N) in r.get("out", ""), r)
    r = run("feed=%d" % N, "chunk=70000", "truncate=1", dir_=d); check("(6) 1 byte truncated after fsync, before the judge: REJECTED (size differs), E, no PADACK, tmp removed", r.get("rc") == 0 and r.get("resp") == "E" and r.get("padack_lines") == 0 and "differs from the" in r.get("out", "") and r.get("tmp_left") == 0, r)
    r = run("feed=%d" % N, "chunk=70000", "renamefail=1", dir_=d); check("(7) rename (publish) failure: E, 'publish failed', not published, tmp removed, NO PADACK emitted even though the ack was prepared", r.get("rc") == 0 and r.get("resp") == "E" and r.get("published") == 0 and r.get("tmp_left") == 0 and r.get("padack_lines") == 0 and "publish failed" in r.get("out", ""), r)
    r = run("feed=%d" % N, "chunk=70000", "dirsyncfail=1", dir_=d); check("(8) directory fsync failure: E, 'withdrawn, not acknowledged', file withdrawn, NO PADACK", r.get("rc") == 0 and r.get("resp") == "E" and r.get("published") == 0 and r.get("padack_lines") == 0 and "withdrawn, not acknowledged" in r.get("out", ""), r)
    r = run("feed=%d" % N, "chunk=70000", "signfail=1", dir_=d); check("(9) ack signing failure: K (stored for a re-offer) but NO PADACK, 'acknowledgment not signed' logged", r.get("rc") == 0 and r.get("resp") == "K" and r.get("published") == 1 and r.get("padack_lines") == 0 and "not signed" in r.get("out", ""), r)
    r = run("feed=%d" % N, "chunk=70000", "headerfail=1", dir_=d); check("(10) header/identity check failure: REJECTED, E, tmp removed, no PADACK", r.get("rc") == 0 and r.get("resp") == "E" and r.get("published") == 0 and r.get("tmp_left") == 0 and r.get("padack_lines") == 0 and "REJECTED" in r.get("out", ""), r)
    r = run("feed=%d" % N, "chunk=70000", "prefix=1", dir_=d); check("(11) prefix asset: stored (K), never acknowledged, no signing call", r.get("rc") == 0 and r.get("resp") == "K" and r.get("published") == 1 and r.get("padack_lines") == 0 and r.get("sign_calls") == 0, r)
    r = run("feed=%d" % N, "retry=1", dir_=d); check("(12) retry of an already stored shipment: H + PADACK via the held-descriptor full hash, ack sha == file sha", r.get("rc") == 0 and r.get("resp") == "H" and r.get("padack_lines") == 1 and padack_sha(r) == r.get("published_sha") and r.get("published") == 1, r)
    r = run("feed=0", dir_=d); check("(13) 0-byte shipment: judge refuses on size (no stale errno text), E, no PADACK", r.get("rc") == 0 and r.get("resp") == "E" and r.get("padack_lines") == 0 and "differs from" in r.get("out", ""), r)
    # Only exact "1" may avoid the new shipment reread; every retry still rereads.
    for knob in (None, "", "0", "true", "2", "1"):
        for route in ("new", "prefix", "retry"):
            args = [] if route == "new" else [route + "=1"]
            r = run("feed=4096", "chunk=127", *args, dir_=d, knob=knob)
            streamed = knob == "1" and route == "new"
            good = (r.get("rc") == 0 and r.get("resp") == ("H" if route == "retry" else "K")
                    and (r.get("sha_updates", 0) > 0) == streamed
                    and (r.get("padack_lines") == 0 if route == "prefix" else padack_sha(r) == r.get("published_sha")))
            check("switch %r %s preserves the expected path and digest" % (knob, route), good, r)
print("RESULT", "PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
