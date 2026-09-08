#!/usr/bin/env python3
"""Synthetic-export fixture for stderr-collect.py: complete, missing, duplicate, corrupt, wrong len, no END,
two exports, END/header disagreement, truncated chunk, engine-truncated (PARTIAL), invalid header flags,
non-canonical integers, empty log. Run: python3 stderr-collect-test.py"""
import base64, hashlib, importlib.util, os, random
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("sc", os.path.join(HERE, "..", "shielded", "anchor", "avf", "host", "stderr-collect.py")); sc = importlib.util.module_from_spec(spec); spec.loader.exec_module(sc)
def export(data, cb=1440, frm=0, file_bytes=None, prefix="VSOCK "):
    fb = file_bytes if file_bytes is not None else frm + len(data); T = len(data); K = (T + cb - 1) // cb
    sha = hashlib.sha256(data).hexdigest(); trunc = 1 if frm else 0
    lines = [f"{prefix}STDERR-EXPORT v1 scope=snapshot-after-engine-main-cleanup file_bytes={fb} from={frm} total={T} chunk_bytes={cb} chunks={K} sha256={sha} truncated={trunc}"]
    for i in range(K):
        c = data[i*cb:(i+1)*cb]; lines.append(f"{prefix}STDERR-CHUNK {i} {i*cb} {len(c)} {hashlib.sha256(c).hexdigest()[:16]} {base64.b64encode(c).decode()}")
    lines.append(f"{prefix}STDERR-END v1 chunks={K} total={T} sha256={sha}")
    return lines
random.seed(7); data = bytes(random.getrandbits(8) for _ in range(10007)); n = 0; cases = []
def check(label, lines, want, needle=None):
    global n
    st, reasons, out, meta = sc.collect("\n".join(["noise before"] + lines + ["ENGINE something after"]))
    ok = st == want and (needle is None or any(needle in r for r in reasons))
    if st == "COMPLETE": ok = ok and out == data
    print(("ok   " if ok else "FAIL ") + f"{label}: {st} {reasons[:1]}"); n += ok; cases.append(label)
L = export(data)
check("complete (8 chunks, VSOCK prefix)", L, "COMPLETE")
check("complete, no prefix, 4096-byte chunks", export(data, cb=4096, prefix=""), "COMPLETE")
check("missing chunk 3 (seen as chunk 4 out of order)", [l for l in L if not l.startswith("VSOCK STDERR-CHUNK 3 ")], "REJECT", "out of order")
check("missing LAST chunks (stream ends early)", L[:4] + [L[-1]], "REJECT", "END after")
check("stream ends without END or last chunks", L[:4], "REJECT", "missing chunks")
check("duplicate identical chunk 2", L[:3] + [L[3]] + L[3:], "REJECT", "out of order")
corrupt = L[:]; parts = corrupt[5].split(" "); parts[-1] = base64.b64encode(b"X" * 1440).decode(); corrupt[5] = " ".join(parts)
check("corrupt chunk payload (hash mismatch)", corrupt, "REJECT", "hash mismatch")
bad = L[:]; p = bad[2].split(" "); p[3] = "1441"; bad[2] = " ".join(p)
check("wrong chunk len", bad, "REJECT", "offset/len")
check("no END", L[:-1], "REJECT", "STDERR-END")
check("two exports in one log", L + L, "REJECT", "after STDERR-END")
e2 = L[:]; e2[-1] = e2[-1].replace("total=10007", "total=10008"); check("END disagrees", e2, "REJECT", "END disagrees")
real = hashlib.sha256(data).hexdigest(); h2 = [l.replace("sha256=" + real, "sha256=" + "0" * 64) for l in L]   # header AND end agree on a wrong digest
check("wrong whole-range digest (header+END agree)", h2, "REJECT", "digest")
h3 = L[:]; h3[0] = h3[0].replace("sha256=" + real, "sha256=" + "0" * 64); check("header digest differs from END", h3, "REJECT", "END disagrees")
short = L[:]; short[-2] = " ".join(short[-2].split(" ")[:5] + [base64.b64encode(data[7*1440:7*1440+10]).decode()]); check("truncated last chunk", short, "REJECT")
check("engine-truncated export (from=500) -> PARTIAL, never COMPLETE", export(data[500:], frm=500, file_bytes=10007), "PARTIAL", "NOT exported")
check("truncated=1 with from=0 refused", [L[0].replace("truncated=0", "truncated=1")] + L[1:], "REJECT", "disagrees with from")
check("leading-zero integer refused", [L[0].replace("chunks=7", "chunks=07")] + L[1:], "REJECT", "non-canonical")
check("empty log", ["nothing"], "REJECT", "no STDERR-EXPORT")
# ordering + record discipline (streaming state machine)
check("out-of-order chunks (1 before 0)", [L[0], L[2], L[1]] + L[3:], "REJECT", "out of order")
check("chunk before the header", [L[1], L[0]] + L[2:], "REJECT", "before the header")
check("END before all chunks", L[:4] + [L[-1]] + L[4:], "REJECT", "END after")
check("header after data (second header)", L[:3] + [L[0]] + L[3:], "REJECT", "second STDERR-EXPORT")
check("record after END", L + [L[3]], "REJECT", "after STDERR-END")
check("engine STDERR-EXPORT-FAILED record", L[:5] + ["VSOCK STDERR-EXPORT-FAILED read at 5760"], "REJECT", "export failure")
check("unknown STDERR record", L[:2] + ["VSOCK STDERR-WHAT 1 2 3"] + L[2:], "REJECT", "unknown record")
check("oversized encoded chunk refused before decoding", [L[0]] + [L[1] + "AAAA"] + L[2:], "REJECT", "encoded length")
check("over-long export record", [L[0], "VSOCK STDERR-CHUNK " + "x" * 9000] + L[1:], "REJECT", "longer than")
check("over-long NON-export line is skipped", [L[0], "noise " + "y" * 9000] + L[1:], "COMPLETE")
check("file_bytes above 64 MiB with truncated tail is PARTIAL", export(data[500:], frm=(1 << 40), file_bytes=(1 << 40) + len(data) - 500), "PARTIAL", "NOT exported")
check("wrong scope token refused", [L[0].replace("scope=snapshot-after-engine-main-cleanup", "scope=full-process-stderr")] + L[1:], "REJECT", "scope")
check("missing scope field refused", [L[0].replace("scope=snapshot-after-engine-main-cleanup ", "")] + L[1:], "REJECT", "fields")
import os, tempfile
d = tempfile.mkdtemp(); fifo = os.path.join(d, "fifo"); os.mkfifo(fifo)
st, reasons, _, _ = sc.collect_file(fifo); ok = st == "REJECT" and any("regular file" in r for r in reasons); print(("ok   " if ok else "FAIL ") + f"FIFO input refused: {reasons[:1]}"); n += ok; cases.append("fifo")
link = os.path.join(d, "link"); os.symlink("/etc/hostname", link)
st, reasons, _, _ = sc.collect_file(link); ok = st == "REJECT" and any("cannot read" in r for r in reasons); print(("ok   " if ok else "FAIL ") + f"symlink input refused (O_NOFOLLOW): {reasons[:1]}"); n += ok; cases.append("symlink")
big = os.path.join(d, "big.log")
with open(big, "wb") as f:
    f.write(("\n".join(L) + "\n").encode()); f.write(b"x" * (sc.MAX_LOG + 10))          # a log that grew past the bound after fstat-time size would also trip the cumulative budget
st, reasons, _, _ = sc.collect_file(big); ok = st == "REJECT" and any("larger" in r or "exceeds" in r for r in reasons); print(("ok   " if ok else "FAIL ") + f"oversized log refused: {reasons[:1]}"); n += ok; cases.append("oversized")
print(f"stderr-collect fixture: {n}/{len(cases)} PASS"); raise SystemExit(0 if n == len(cases) else 1)
