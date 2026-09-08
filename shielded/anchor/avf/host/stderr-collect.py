#!/usr/bin/env python3
"""Collect the engine's exported stderr (ENGINE_EXPORT_STDERR=1) from a phone log and REFUSE anything
that is not provably complete and IN ORDER. Wire format (each line may carry a "VSOCK " prefix):
  STDERR-EXPORT v1 scope=snapshot-after-engine-main-cleanup file_bytes=N from=F total=T chunk_bytes=C chunks=K sha256=<hex64> truncated=0|1
  STDERR-CHUNK <i> <offset> <len> <sha256 of the chunk, first 16 hex> <base64>
  STDERR-END v1 chunks=K total=T sha256=<hex64>
A streaming state machine accepts exactly: ONE header, then chunks 0..K-1 in that order, then ONE END,
then nothing. A chunk before the header, out of order, duplicated (even identical), after END, a second
header, an END before all chunks, any STDERR-EXPORT-FAILED record, or any other STDERR-* record is a
REJECT. Every numeric field is a canonical non-negative integer: file_bytes/from up to signed 64-bit
(an honestly truncated larger file is fine), total <= 64 MiB, chunk_bytes <= 4096, and the encoded
length is checked BEFORE decoding. Input is bounded: log <= 128 MiB, a line > 8192 bytes is skipped
unless it is an export record (then REJECT). truncated=1 (the engine exported only the LAST T of
file_bytes) yields PARTIAL, never COMPLETE, naming the skipped bytes.
SCOPE: the export is a FILE SNAPSHOT of engine.err taken after engine_main's cleanup; the process-static
shielded pool can still write stderr later, so COMPLETE means every byte of that snapshot, never all the
stderr the process ever wrote. The scope token is required verbatim and echoed in the status.
Input is read through a no-follow, nonblocking descriptor that must be a regular file (fstat on the same
fd), and the cumulative bytes read are bounded by MAX_LOG through BOTH loops, so a growing file, FIFO or
/proc file cannot be read forever. Assembly streams into one buffer with an incremental hasher, so many
tiny chunks cost no per-chunk objects.
Outputs are EXCLUSIVE: the data file and the status file must not exist (so a rerun can never leave a
stale COMPLETE); the data file is written only for COMPLETE/PARTIAL, the status file always.
Exit 0 COMPLETE, 1 PARTIAL, 2 REJECT.
Usage: stderr-collect.py <phone log> <out file> [--json <status file>]"""
import base64, hashlib, json, os, re, stat, sys

MAX_LOG = 128 << 20; MAX_LINE = 8192; MAX_TOTAL = 64 << 20; MAX_CHUNK = 4096; MAX_FILE = (1 << 63) - 1
SCOPE = "snapshot-after-engine-main-cleanup"
DEC = re.compile(r"^(0|[1-9][0-9]*)$"); HEX64 = re.compile(r"^[0-9a-f]{64}$"); HEX16 = re.compile(r"^[0-9a-f]{16}$")

class Reject(Exception): pass

def dec(s, hi):
    if not DEC.match(s) or len(s) > 20: raise Reject("non-canonical integer %r" % s[:24])
    v = int(s)
    if v > hi: raise Reject("integer out of bounds %r" % s[:24])
    return v

def kv(fields, keys):
    d = {}
    for f in fields:
        if "=" not in f: raise Reject("bad field %r" % f[:40])
        k, v = f.split("=", 1)
        if k in d: raise Reject("duplicate field %r" % k)
        d[k] = v
    if set(d) != set(keys): raise Reject("fields %s != %s" % (sorted(d), sorted(keys)))
    return d

class Collector:
    """Feed lines in log order; call finish(). state: 0 = before header, 1 = chunks, 2 = before END, 3 = done."""
    def __init__(self):
        self.state = 0; self.expect = 0; self.buf = bytearray(); self.hasher = hashlib.sha256(); self.h = None; self.K = self.cb = self.total = 0
    def feed(self, line):
        if line.startswith("VSOCK "): line = line[6:]
        if not line.startswith("STDERR-"): return
        if self.state == 3: raise Reject("record after STDERR-END")
        w = line.split(" ")
        if w[0] == "STDERR-EXPORT-FAILED": raise Reject("engine reported export failure: %s" % line[21:120])
        if w[0] == "STDERR-EXPORT":
            if self.state != 0: raise Reject("second STDERR-EXPORT header")
            if len(w) < 2 or w[1] != "v1": raise Reject("unknown export version")
            f = kv(w[2:], ("scope", "file_bytes", "from", "total", "chunk_bytes", "chunks", "sha256", "truncated"))
            if f["scope"] != SCOPE: raise Reject("unknown export scope %r" % f["scope"][:48])
            fb = dec(f["file_bytes"], MAX_FILE); frm = dec(f["from"], MAX_FILE); total = dec(f["total"], MAX_TOTAL)
            cb = dec(f["chunk_bytes"], MAX_CHUNK); K = dec(f["chunks"], MAX_TOTAL); trunc = dec(f["truncated"], 1)
            if not HEX64.match(f["sha256"]): raise Reject("header sha256 not 64 hex")
            if cb == 0 or frm + total != fb: raise Reject("from+total != file_bytes")
            if (trunc == 0) != (frm == 0): raise Reject("truncated flag disagrees with from")
            if K != (total + cb - 1) // cb: raise Reject("chunks inconsistent with total/chunk_bytes")
            self.h = {"scope": SCOPE, "file_bytes": fb, "from": frm, "total": total, "chunks": K, "sha256": f["sha256"], "truncated": trunc}
            self.K, self.cb, self.total = K, cb, total; self.state = 2 if K == 0 else 1; return
        if w[0] == "STDERR-CHUNK":
            if self.state == 0: raise Reject("chunk before the header")
            if self.state != 1: raise Reject("chunk after all %d chunks" % self.K)
            if len(w) != 6: raise Reject("chunk field count %d" % len(w))
            i = dec(w[1], self.K); off = dec(w[2], MAX_TOTAL); ln = dec(w[3], MAX_CHUNK)
            if i != self.expect: raise Reject("chunk %d out of order (expected %d)" % (i, self.expect))
            want = self.cb if i < self.K - 1 else self.total - self.cb * (self.K - 1)
            if off != i * self.cb or ln != want: raise Reject("chunk %d offset/len %d/%d != %d/%d" % (i, off, ln, i * self.cb, want))
            if not HEX16.match(w[4]): raise Reject("chunk %d hash not 16 hex" % i)
            if len(w[5]) != ((ln + 2) // 3) * 4: raise Reject("chunk %d encoded length %d != %d" % (i, len(w[5]), ((ln + 2) // 3) * 4))
            try: data = base64.b64decode(w[5], validate=True)
            except ValueError: raise Reject("chunk %d base64 invalid" % i)
            if len(data) != ln or hashlib.sha256(data).hexdigest()[:16] != w[4]: raise Reject("chunk %d hash mismatch" % i)
            self.buf.extend(data); self.hasher.update(data); self.expect += 1
            if self.expect == self.K: self.state = 2
            return
        if w[0] == "STDERR-END":
            if self.state == 0: raise Reject("END before the header")
            if self.state == 1: raise Reject("END after %d of %d chunks" % (self.expect, self.K))
            if len(w) < 2 or w[1] != "v1": raise Reject("unknown end version")
            e = kv(w[2:], ("chunks", "total", "sha256"))
            if dec(e["chunks"], MAX_TOTAL) != self.K or dec(e["total"], MAX_TOTAL) != self.total or e["sha256"] != self.h["sha256"]:
                raise Reject("END disagrees with the header")
            self.state = 3; return
        raise Reject("unknown record %s" % w[0][:32])
    def finish(self):
        if self.state == 0: raise Reject("no STDERR-EXPORT header")
        if self.state == 1: raise Reject("missing chunks %d..%d" % (self.expect, self.K - 1))
        if self.state == 2: raise Reject("no STDERR-END")
        if len(self.buf) != self.total or self.hasher.hexdigest() != self.h["sha256"]: raise Reject("assembled bytes/digest do not match the header")
        return bytes(self.buf), self.h

def collect_file(path):
    """Bounded read of a log: returns (status, reasons, data, meta)."""
    c = Collector(); budget = [MAX_LOG]
    def take(n):                                                  # every byte read counts against ONE cumulative bound
        budget[0] -= n
        if budget[0] < 0: raise Reject("log exceeds %d bytes (growing, FIFO or unbounded input)" % MAX_LOG)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode): raise Reject("log is not a regular file")
            if st.st_size > MAX_LOG: raise Reject("log larger than %d bytes" % MAX_LOG)
            with os.fdopen(fd, "rb", buffering=65536) as f:
                fd = -1
                while True:
                    raw = f.readline(MAX_LINE + 1); take(len(raw))
                    if not raw: break
                    if len(raw) > MAX_LINE and not raw.endswith(b"\n"):
                        head = raw[:16]
                        while True:                               # drain the rest of an over-long line, still bounded
                            more = f.readline(MAX_LINE); take(len(more))
                            if not more or more.endswith(b"\n"): break
                        if head.startswith(b"VSOCK STDERR-") or head.startswith(b"STDERR-"): raise Reject("export record longer than %d bytes" % MAX_LINE)
                        continue
                    c.feed(raw.decode("ascii", "replace").rstrip("\r\n"))
        finally:
            if fd >= 0: os.close(fd)
        data, h = c.finish()
    except OSError as e:
        return "REJECT", ["cannot read log: %s" % e], None, {}
    except Reject as e:
        return "REJECT", [str(e)], None, {}
    if h["truncated"]: return "PARTIAL", ["engine cap: the first %d of %d bytes were NOT exported" % (h["from"], h["file_bytes"])], data, h
    return "COMPLETE", [], data, h

def collect(text):
    """In-memory variant for fixtures (same state machine)."""
    c = Collector()
    try:
        for line in text.splitlines():
            if len(line) > MAX_LINE:
                if line.startswith(("VSOCK STDERR-", "STDERR-")): raise Reject("export record longer than %d bytes" % MAX_LINE)
                continue
            c.feed(line)
        data, h = c.finish()
    except Reject as e:
        return "REJECT", [str(e)], None, {}
    if h["truncated"]: return "PARTIAL", ["engine cap: the first %d of %d bytes were NOT exported" % (h["from"], h["file_bytes"])], data, h
    return "COMPLETE", [], data, h

def write_exclusive(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o644)
    try:
        with os.fdopen(fd, "wb") as f: f.write(data); f.flush(); os.fsync(f.fileno())
    except BaseException:
        try: os.unlink(path)
        except OSError: pass
        raise

def main():
    if len(sys.argv) < 3: sys.exit(__doc__)
    log, out = sys.argv[1], sys.argv[2]; status_path = sys.argv[4] if len(sys.argv) > 4 and sys.argv[3] == "--json" else None
    for p in (out, status_path):
        if p and (os.path.lexists(p)): print("STDERR-COLLECT REJECT {} | %s already exists (outputs are exclusive)" % p); return 2
    status, reasons, data, meta = collect_file(log)
    if data is not None:
        try: write_exclusive(out, data)
        except OSError as e: status, reasons, data = "REJECT", ["output write failed: %s" % e], None
    rec = {"status": status, "reasons": reasons, "out": out if data is not None else None, "out_bytes": len(data) if data is not None else None, **meta}
    if status_path:
        try: write_exclusive(status_path, (json.dumps(rec, indent=1) + "\n").encode())
        except OSError as e: print("STDERR-COLLECT status write failed: %s" % e); return 2
    print("STDERR-COLLECT %s %s%s" % (status, json.dumps(meta), (" | " + "; ".join(reasons)) if reasons else ""))
    return {"COMPLETE": 0, "PARTIAL": 1, "REJECT": 2}[status]

if __name__ == "__main__":
    sys.exit(main())
