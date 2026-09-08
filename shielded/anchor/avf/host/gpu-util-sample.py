#!/usr/bin/env python3
"""Bounded, READ-ONLY per-GPU utilization TRACE writer (run on the GPU host; here the V100s are local).
Streams `nvidia-smi --query-gpu ... --format=csv,noheader,nounits -lms N` (query flags only: nothing is
configured, reset or restarted) and appends one CSV row per GPU per sample, stamped with this host's UTC
epoch and monotonic clocks. It writes facts only: the per-GPU window/coverage/value summary is a separate
post-run tool that knows the measured start/end (gpu-util-window.py, Astra), so this file never claims
coverage of a window it cannot know.

Capture STATUS (summary JSON "status"): PASS only when the run stopped by MAX_SECS / STOPFILE / signal,
wrote >= 1 row, had ZERO bad rows, stayed within the row-volume bound, nvidia-smi never exited on its own
(a self-exit at the very moment of the stop is still a FAIL) and was reaped by us, and every output write
and close succeeded. Anything else is FAIL with a nonzero exit: 2 nvidia-smi failed / exited early /
unreaped / backlog, 3 invalid config or cannot start, 4 output write or close failed, 5 no rows,
6 bad rows present or row-volume bound exceeded (a flood of even valid rows means the child misbehaved).

I/O: both child pipes are read with bounded, binary, nonblocking incremental I/O (a partial or LF-less
line never blocks or hides buffered rows; stderr is drained with a tail and dropped from the poll set at
its EOF), rows are bounded in length, backlog and total volume, the deadline is re-checked while draining
a backlog, values are parsed strictly (ASCII only) and range-checked, missing power/clock/temperature is
an EMPTY field (null), and the child is always reaped in `finally`, which covers everything after Popen.

`utilization.gpu` is the driver's fraction of the sample period with a kernel executing: it quantifies
per-GPU idle vs busy time, nothing about which kernel, the phone or transport.
Env: OUT=<csv> (required)  GPUS=<comma list of FULL GPU-UUIDs, required: the selector is how the RTX 3070
     is excluded>  INTERVAL_MS=500 (50..10000)  MAX_SECS=600 (1..7200)  STOPFILE=<path>  SMI_CMD=nvidia-smi
     MAX_ROWS (default 2 x the rows a well-behaved child can produce in MAX_SECS, capped at 2,000,000)"""
import hashlib, json, math, os, re, select, signal, stat, subprocess, sys, time

FIELDS = ["timestamp", "index", "uuid", "utilization.gpu", "utilization.memory", "memory.used", "memory.total",
          "power.draw", "clocks.sm", "temperature.gpu"]
UUID_RE = re.compile(r"^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
LINE_MAX = 1024; BACKLOG_MAX = 256 * 1024; ERR_TAIL = 4096; MAX_CONSECUTIVE_BAD = 100
CLEAN_STOPS = ("MAX_SECS", "STOPFILE", "signal")

def fail(msg, code=3):
    sys.stderr.write("GPU-SAMPLER-INVALID %s\n" % msg); sys.stderr.flush(); sys.exit(code)

def num_env(name, default, lo, hi, integer=False):
    raw = os.environ.get(name, default)
    try: v = float(raw)
    except ValueError: fail("%s=%r is not a number" % (name, raw))
    if not math.isfinite(v) or not (lo <= v <= hi): fail("%s=%r outside [%s, %s]" % (name, raw, lo, hi))
    if integer and v != int(v): fail("%s=%r is not an integer" % (name, raw))
    return int(v) if integer else v

def opt_num(s, lo, hi):
    """A finite number in [lo, hi], or None for nvidia-smi's [N/A]; raises ValueError otherwise."""
    if s in ("[N/A]", "N/A", ""): return None
    v = float(s)
    if not math.isfinite(v) or not (lo <= v <= hi): raise ValueError(s)
    return v

def parse_row(raw, wanted):
    line = raw.decode("ascii")                              # strict: any non-ASCII byte is a bad row
    parts = [p.strip() for p in line.split(",")]
    if len(parts) != len(FIELDS): raise ValueError("field count")
    ts, idx, uuid = parts[0], int(parts[1]), parts[2]
    if not (0 <= idx <= 63 and UUID_RE.match(uuid)): raise ValueError("index/uuid")
    if uuid not in wanted: raise ValueError("unselected gpu")
    if not (1 <= len(ts) <= 40) or any(c < " " or c > "~" for c in ts): raise ValueError("timestamp")
    util = opt_num(parts[3], 0, 100); umem = opt_num(parts[4], 0, 100)
    if util is None or umem is None: raise ValueError("utilization N/A")
    mused = opt_num(parts[5], 0, 1 << 24); mtot = opt_num(parts[6], 1, 1 << 24)
    if mused is None or mtot is None or mused > mtot: raise ValueError("memory")
    power = opt_num(parts[7], 0, 5000); smclk = opt_num(parts[8], 0, 20000); temp = opt_num(parts[9], -50, 200)
    return ts, idx, uuid, util, umem, mused, mtot, power, smclk, temp

def fmt(v): return "" if v is None else ("%g" % v)

def write_all(fileobj, data, digest=None):
    """Write every byte of `data` through an unbuffered file object, looping on short writes and refusing a
    zero-length write; hashes ONLY the bytes actually written. Returns the byte count; raises OSError."""
    mv = memoryview(data); off = 0
    while off < len(mv):
        k = fileobj.write(mv[off:])
        if k is None or k <= 0: raise OSError("short write: %d of %d bytes" % (off, len(mv)))
        if digest is not None: digest.update(mv[off:off + k])
        off += k
    return off

def main():
    out = os.environ.get("OUT") or fail("OUT is required")
    gpus_raw = os.environ.get("GPUS") or fail("GPUS is required: a comma list of FULL GPU-UUIDs (this is how the RTX 3070 is excluded)")
    wanted = [g.strip() for g in gpus_raw.split(",")]
    if not wanted or any(not UUID_RE.match(g) for g in wanted) or len(set(wanted)) != len(wanted):
        fail("GPUS must be distinct full GPU-UUIDs (GPU-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx), got %r" % gpus_raw)
    interval_ms = num_env("INTERVAL_MS", "500", 50, 10000, integer=True)
    max_secs = num_env("MAX_SECS", "600", 1, 7200)
    default_rows = min(2_000_000, int((max_secs * 1000.0 / interval_ms + 10) * len(wanted) * 2))
    max_rows = num_env("MAX_ROWS", str(default_rows), 1, 10_000_000, integer=True)
    stopfile = os.environ.get("STOPFILE") or None
    smi = os.environ.get("SMI_CMD", "nvidia-smi")
    cmd = [smi, "--query-gpu=" + ",".join(FIELDS), "--format=csv,noheader,nounits", "-lms", str(interval_ms), "-i", ",".join(wanted)]
    # Exclusive creation: an existing REGULAR file is refused so a rerun can never pair an old PASS sidecar
    # with a rewritten CSV (a character device such as /dev/full is allowed: it holds no stale result).
    try:
        try: fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o644)
        except FileExistsError:
            if not stat.S_ISCHR(os.stat(out).st_mode): fail("OUT %s already exists: choose a new exclusive name" % out)
            fd = os.open(out, os.O_WRONLY | os.O_CLOEXEC)
    except OSError as e: fail("cannot create OUT %s: %s" % (out, e))
    f = os.fdopen(fd, "wb", buffering=0)
    digest = hashlib.sha256(); written = [0]
    def emit(text):
        written[0] += write_all(f, text.encode("ascii"), digest)   # counts and hashes only bytes actually written
    try: emit("recv_utc,recv_mono,smi_timestamp,index,uuid,util_gpu,util_mem,mem_used_mib,mem_total_mib,power_w,sm_mhz,temp_c\n")
    except OSError as e: fail("cannot write OUT %s: %s" % (out, e), 4)
    try: proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
    except OSError as e: fail("cannot run %s: %s" % (smi, e))
    # ---- from here on, `finally` owns the child ------------------------------------------------
    per = {u: {"samples": 0, "first_utc": None, "last_utc": None, "index": None} for u in wanted}
    st = {"why": None, "code": 0}; rows = bad = consecutive_bad = 0
    obuf = bytearray(); err_tail = bytearray(); out_eof = False; self_exit = None; reaped = False
    t_start = time.monotonic(); deadline = t_start + max_secs
    def stop(why, code=0):
        if st["why"] is None: st["why"] = why; st["code"] = code
    def handle_line(line):
        nonlocal rows, bad, consecutive_bad
        try:
            if len(line) > LINE_MAX: raise ValueError("line length")
            ts, idx, uuid, util, umem, mused, mtot, power, smclk, temp = parse_row(line, per)
        except (ValueError, IndexError, UnicodeDecodeError):
            bad += 1; consecutive_bad += 1; return
        recv_utc, recv_mono = time.time(), time.monotonic()
        emit("%.3f,%.6f,%s,%d,%s,%s,%s,%s,%s,%s,%s,%s\n" % (recv_utc, recv_mono, ts, idx, uuid, fmt(util), fmt(umem), fmt(mused), fmt(mtot), fmt(power), fmt(smclk), fmt(temp)))
        rows += 1; consecutive_bad = 0
        d = per[uuid]; d["samples"] += 1; d["index"] = idx; d["last_utc"] = recv_utc
        if d["first_utc"] is None: d["first_utc"] = recv_utc
    try:
        ofd, efd = proc.stdout.fileno(), proc.stderr.fileno()
        os.set_blocking(ofd, False); os.set_blocking(efd, False)
        def on_signal(signum, frame): stop("signal %d" % signum)
        signal.signal(signal.SIGTERM, on_signal); signal.signal(signal.SIGINT, on_signal)
        fds = [ofd, efd]
        print("GPU-SAMPLER START utc=%.3f interval_ms=%d max_secs=%s max_rows=%d gpus=%s" % (time.time(), interval_ms, max_secs, max_rows, ",".join(wanted)), flush=True)
        while st["why"] is None:
            if time.monotonic() >= deadline: stop("MAX_SECS"); break
            if stopfile and os.path.exists(stopfile): stop("STOPFILE"); break
            if consecutive_bad >= MAX_CONSECUTIVE_BAD: stop("too many consecutive bad rows", 6); break
            if rows > max_rows: stop("row-volume bound exceeded (%d > %d): child produced rows faster than its interval" % (rows, max_rows), 6); break
            rc = proc.poll()
            if rc is not None: self_exit = rc; stop("nvidia-smi exited rc=%s: %s" % (rc, err_tail.decode("ascii", "replace").strip()[-200:]), 2); break
            if out_eof: stop("nvidia-smi closed its output", 2); break
            readable = select.select(fds, [], [], 0.25)[0]
            for fd in readable:
                try: chunk = os.read(fd, 65536)
                except BlockingIOError: continue
                if fd == efd:
                    if chunk: err_tail.extend(chunk); del err_tail[:-ERR_TAIL]
                    else: fds.remove(efd)                                  # EOF: never poll a dead fd (busy loop)
                    continue
                if not chunk: out_eof = True; continue
                obuf.extend(chunk)
                if len(obuf) > BACKLOG_MAX: stop("row backlog exceeded %d bytes (no newline)" % BACKLOG_MAX, 2); break
                while st["why"] is None:
                    k = obuf.find(b"\n")
                    if k < 0: break
                    line = bytes(obuf[:k]); del obuf[:k + 1]
                    handle_line(line)
                    if rows > max_rows: stop("row-volume bound exceeded (%d > %d): child produced rows faster than its interval" % (rows, max_rows), 6)
                    elif time.monotonic() >= deadline: stop("MAX_SECS")      # re-check while draining a backlog
    except OSError as e:
        st["why"] = "output write failed: %s" % e; st["code"] = 4        # forced: overrides any earlier clean stop
    finally:
        pre = proc.poll()
        if pre is not None and self_exit is None: self_exit = pre           # exited on its own, even at the stop boundary
        terminated = False
        if pre is None:
            terminated = True
            try: proc.terminate(); proc.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                try: proc.kill(); proc.wait(timeout=3)
                except (OSError, subprocess.TimeoutExpired): pass
        final_rc = proc.poll(); reaped = final_rc is not None
        # A child we terminated must have died of OUR signal or exited 0 from a graceful SIGTERM handler (the real
        # nvidia-smi does that). Any NONZERO status means it failed on its own in the poll-to-terminate race or
        # trapped the signal and failed - never a clean capture.
        if terminated and reaped and final_rc not in (-signal.SIGTERM, -signal.SIGKILL, 0) and self_exit is None: self_exit = final_rc
        for p in (proc.stdout, proc.stderr):
            try: p.close()
            except OSError: pass
        try: f.close()
        except OSError as e:
            st["why"] = "output close failed: %s" % e; st["code"] = 4       # forced as well
    # ---- verdict ---------------------------------------------------------------------------------
    why = st["why"] or "unknown"; code = st["code"]
    clean = any(why == c or why.startswith(c) for c in CLEAN_STOPS)
    reasons = []
    if not clean: reasons.append(why)
    if self_exit is not None: reasons.append("nvidia-smi exited on its own (rc=%s)" % self_exit); code = code or 2
    if not reaped: reasons.append("child UNREAPED"); code = code or 2
    if rows == 0: reasons.append("no rows"); code = code or 5
    if bad: reasons.append("%d bad rows" % bad); code = code or 6
    status = "PASS" if not reasons else "FAIL"
    if status == "FAIL" and not code: code = 2
    summary = {"status": status, "stopped_by": why, "exit_code": code, "reasons": reasons, "rows": rows, "bad_rows": bad,
               "csv_path": out, "csv_bytes": written[0], "csv_sha256": digest.hexdigest(),
               "max_rows": max_rows, "interval_ms": interval_ms, "elapsed_s": round(time.monotonic() - t_start, 3),
               "child_self_exit": self_exit, "child_reaped": reaped, "child_final_rc": final_rc, "gpus": per,
               "note": "facts only; window coverage/value summary is computed post-run by gpu-util-window.py"}
    try:
        with open(out + ".summary.json", "w") as sf: json.dump(summary, sf, indent=1)
    except OSError as e:
        sys.stderr.write("GPU-SAMPLER summary write failed: %s\n" % e); code = code or 4; status = "FAIL"
    for u, d in per.items():
        print("GPU %s index=%s samples=%d first_utc=%s last_utc=%s" % (u, d["index"], d["samples"], d["first_utc"], d["last_utc"]), flush=True)
    print("GPU-SAMPLER END status=%s stopped_by=%s rows=%d bad=%d elapsed=%.1fs exit=%d%s" % (
        status, why, rows, bad, summary["elapsed_s"], code, (" reasons=" + "; ".join(reasons)) if reasons else ""), flush=True)
    return code

if __name__ == "__main__":
    sys.exit(main())
