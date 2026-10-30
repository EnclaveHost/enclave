#!/usr/bin/env python3
"""multipart-validation-view-stage/r1 view_descriptor.py (prepared by Claude 1751; NOT run by Claude). Python stdlib only.

A READ-ONLY single logical file VIEW of explicitly listed part files, without concatenating them: a small VMDK text descriptor
with one FLAT extent per part (absolute paths, offset 0, in order), opened by the pinned QEMU 11.1.2 vmdk driver with every
extent forced to the raw `file` protocol driver (no format probing of part bytes) and read-only=on. Use it with the pinned
qemu-io / qemu-img / qemu-nbd --read-only (and nbdfuse -r through an existing reviewed lifecycle) only.

Source facts (refs/qemu-v11.1.2-block-vmdk.c, sha256 75dd58a2..., = gitlab qemu-project v11.1.2 block/vmdk.c):
  * descriptor read capped at 1 MiB - 1 (vmdk_read_desc); createType must be one of six, monolithicFlat used here
  * extent line `RW <sectors> FLAT "<path>" <offset>`; a line whose access is not "RW" is SILENTLY SKIPPED (a shorter disk), so
    every line is RW (writes are impossible: read-only=on on the node and its children, and the parts carry no write bits)
  * path = sscanf %511[^\\n\\r"]: <= 511 bytes, no quote/newline; absolute paths are opened as given (any filesystem)
  * `parentFileNameHint` ANYWHERE in the descriptor opens a backing file (strstr): refused in every path and the text
  * FLAT extents have no per-extent or total sector cap (VMDK_EXTENT_MAX_SECTORS applies to sparse growth only); sizes are
    whole 512-byte sectors, so every part must be a multiple of 512 bytes
  * the extent's file size is NOT checked at open and the block layer zero-fills reads past EOF: a truncated or replaced part
    reads as zeros or other bytes. Hence: sizes + sha256 + identity are verified here, `recheck` repeats them before and after
    any use, and `check-held` proves the running QEMU holds exactly the verified inodes.

The descriptor proves NOTHING about integrity. `hashVerified` only means each part's bytes equal the sha256 listed in the input
at build time. MDBX structure, canonical root and state checks remain separate and required.

    view_descriptor.py build --parts PARTS.json --out-dir NEW_DIR
    view_descriptor.py recheck --view-dir DIR [--hash]
    view_descriptor.py check-held --view-dir DIR --pid PID
    view_descriptor.py opts --view-dir DIR          (prints the --image-opts string after a recheck)

PARTS.json (generic explicit-parts input; FIXTURE ONLY in r1):
    {"format": "multipart-view-parts/v1", "kind": "fixture", "logicalSize": N,
     "parts": [{"index": 0, "path": "/abs/part-0000.bin", "size": S, "sha256": "<hex>"}, ...]}
kind "production" and recovery-multipart manifests are REFUSED until the final recovery-multipart r2 schema is accepted.
Exit 0 ok; 3 refused; 2 usage.
"""
import argparse, hashlib, json, os, re, stat, sys

FMT_PARTS = "multipart-view-parts/v1"
FMT_RECEIPT = "multipart-view-receipt/v1"
SECTOR = 512
MAX_PATH = 511
MAX_DESC = (1 << 20) - 1
MAX_PARTS = 4096
DESC, RECEIPT = "view.vmdk", "receipt.json"
HEX = re.compile(r"[0-9a-f]{64}")
MEANING = ("byte-concatenation VIEW of the listed parts only; NOT integrity; hashVerified = part bytes equal the listed sha256 at "
           "build time; MDBX structure / canonical root / state checks are separate and still required")


class Refused(Exception):
    pass


def refuse(m):
    raise Refused(m)


def ident(st):
    return {"dev": st.st_dev, "ino": st.st_ino, "size": st.st_size, "mtimeNs": st.st_mtime_ns, "ctimeNs": st.st_ctime_ns}


def check_path(p, what):
    """absolute, normalized, QEMU-descriptor and image-opts safe, no symlink in any component"""
    if not isinstance(p, str) or not p.startswith("/") or os.path.normpath(p) != p or p == "/":
        refuse(f"{what}: not an absolute normalized path")
    if len(p.encode()) > MAX_PATH:
        refuse(f"{what}: longer than {MAX_PATH} bytes (vmdk.c %511 extent name)")
    if any(c in p for c in '",:\\') or any(ord(c) < 0x20 or ord(c) == 0x7f for c in p) or "parentFileNameHint" in p:
        refuse(f"{what}: character or token unsafe in a VMDK descriptor / image-opts string")
    cur = ""
    for comp in p.strip("/").split("/"):
        cur += "/" + comp
        try:
            if stat.S_ISLNK(os.lstat(cur).st_mode):
                refuse(f"{what}: symlink component {cur}")
        except FileNotFoundError:
            refuse(f"{what}: {cur} missing")
    return p


def read_json(path, cap, what):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > cap:
            refuse(f"{what}: not a regular file <= {cap} bytes")
        raw = b""
        while len(raw) < st.st_size + 1:
            b = os.read(fd, cap + 1 - len(raw))
            if not b:
                break
            raw += b
    finally:
        os.close(fd)
    if len(raw) > cap:
        refuse(f"{what}: larger than {cap} bytes")
    try:
        return raw, json.loads(raw)
    except ValueError:
        refuse(f"{what}: not JSON")


def load_parts(path):
    raw, d = read_json(path, 4 << 20, "--parts")
    if isinstance(d, dict) and str(d.get("format", "")).startswith("recovery-multipart"):
        refuse("--parts: recovery-multipart manifests are not view input in r1 (await the accepted r2 schema)")
    if not isinstance(d, dict) or set(d) != {"format", "kind", "logicalSize", "parts"} or d["format"] != FMT_PARTS:
        refuse(f"--parts: not exactly {FMT_PARTS}")
    if d["kind"] != "fixture":
        refuse("--parts: only kind 'fixture' in r1; production views need the accepted recovery-multipart r2 schema")
    ps, L = d["parts"], d["logicalSize"]
    if not (isinstance(L, int) and not isinstance(L, bool) and L > 0 and isinstance(ps, list) and 0 < len(ps) <= MAX_PARTS):
        refuse("--parts: logicalSize / parts")
    total, seen = 0, set()
    for i, p in enumerate(ps):
        if not (isinstance(p, dict) and set(p) == {"index", "path", "size", "sha256"} and p["index"] == i
                and isinstance(p["size"], int) and not isinstance(p["size"], bool) and p["size"] > 0
                and isinstance(p["sha256"], str) and HEX.fullmatch(p["sha256"])):
            refuse(f"--parts: part {i}: not the next indexed part with an exact size and sha256")
        if p["size"] % SECTOR:
            refuse(f"--parts: part {i}: size {p['size']} is not a multiple of {SECTOR} (FLAT extents are whole sectors)")
        check_path(p["path"], f"part {i}")
        if p["path"] in seen:
            refuse(f"--parts: part {i}: path listed twice")
        seen.add(p["path"]); total += p["size"]
    if total != L:
        refuse(f"--parts: parts cover {total} bytes, logicalSize {L}")
    return raw, d


def hash_part(p):
    """sha256 of one part, with its identity stable across the read (no write bits; regular; not replaced meanwhile)"""
    fd = os.open(p["path"], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size != p["size"]:
            refuse(f"part {p['index']}: not a regular file of exactly {p['size']} bytes")
        if st.st_mode & 0o222:
            refuse(f"part {p['index']}: has write permission bits (parts must be read-only)")
        h = hashlib.sha256()
        while True:
            b = os.read(fd, 8 << 20)
            if not b:
                break
            h.update(b)
        if ident(os.fstat(fd)) != ident(st) or ident(os.lstat(p["path"])) != ident(st):
            refuse(f"part {p['index']}: changed or replaced while hashing")
    finally:
        os.close(fd)
    if h.hexdigest() != p["sha256"]:
        refuse(f"part {p['index']}: sha256 differs from the listed hash")
    return ident(st)


def descriptor(parts):
    lines = ["# Disk DescriptorFile", "# generated read-only concatenation view (multipart-validation-view-stage r1)",
             "version=1", "CID=fffffffe", "parentCID=ffffffff", 'createType="monolithicFlat"', "", "# Extent description"]
    lines += [f'RW {p["size"] // SECTOR} FLAT "{p["path"]}" 0' for p in parts]
    text = "\n".join(lines) + "\n"
    # vmdk.c finds CID / parentCID / createType by strstr (FIRST occurrence): the header lines precede every path
    if len(text.encode()) > MAX_DESC or "parentFileNameHint" in text or not text.startswith("\n".join(lines[:8]) + "\n"):
        refuse("descriptor: too large or unsafe")
    return text


def image_opts(view_dir, n):
    desc = check_path(os.path.join(view_dir, DESC), "descriptor")
    return ",".join(["driver=vmdk", "read-only=on", "file.driver=file", f"file.filename={desc}"]
                    + [f"extents.{i}.driver=file" for i in range(n)])


def write_new(dfd, name, data):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o400, dir_fd=dfd)
    try:
        os.write(fd, data); os.fsync(fd)
    finally:
        os.close(fd)


def cmd_build(a):
    raw, d = load_parts(a.parts)
    out = a.out_dir
    check_path(os.path.dirname(out), "--out-dir parent")
    if not out.startswith("/") or os.path.normpath(out) != out or os.path.lexists(out):
        refuse("--out-dir must be a NEW absolute normalized directory")
    if len(os.path.join(out, DESC).encode()) > MAX_PATH or any(c in out for c in '",:\\\n\r'):
        refuse("--out-dir: unsafe for the image-opts string")
    ids, inodes = [], set()
    for p in d["parts"]:
        i = hash_part(p)
        if (i["dev"], i["ino"]) in inodes:
            refuse(f"part {p['index']}: the same file as an earlier part")
        inodes.add((i["dev"], i["ino"])); ids.append(i)
    for p, i in zip(d["parts"], ids):                    # every identity still the hashed one after ALL parts were read
        if ident(os.lstat(p["path"])) != i:
            refuse(f"part {p['index']}: changed after hashing")
    text = descriptor(d["parts"]).encode()
    os.mkdir(out, 0o700)                                # the ONLY writes: this new dir and its two 0400 files
    dfd = os.open(out, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        write_new(dfd, DESC, text)
        rec = {"format": FMT_RECEIPT, "partsFile": a.parts, "partsSha256": hashlib.sha256(raw).hexdigest(),
               "descriptor": DESC, "descriptorSha256": hashlib.sha256(text).hexdigest(), "logicalSize": d["logicalSize"],
               "sectors": d["logicalSize"] // SECTOR, "imageOpts": image_opts(out, len(d["parts"])), "hashVerified": True,
               "parts": [{**p, "identity": i} for p, i in zip(d["parts"], ids)], "meaning": MEANING}
        write_new(dfd, RECEIPT, (json.dumps(rec, indent=1, sort_keys=True) + "\n").encode())
    finally:
        os.close(dfd)
    print(json.dumps({"viewDir": out, "parts": len(ids), "logicalSize": d["logicalSize"], "descriptorSha256": rec["descriptorSha256"]}))
    return 0


def load_view(view_dir):
    check_path(view_dir, "--view-dir")
    _, rec = read_json(os.path.join(view_dir, RECEIPT), 8 << 20, "receipt")
    if not isinstance(rec, dict) or rec.get("format") != FMT_RECEIPT or not isinstance(rec.get("parts"), list):
        refuse("receipt: not a view receipt")
    fd = os.open(os.path.join(view_dir, DESC), os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        text = b""
        while len(text) <= MAX_DESC:
            b = os.read(fd, MAX_DESC + 1 - len(text))
            if not b:
                break
            text += b
    finally:
        os.close(fd)
    if hashlib.sha256(text).hexdigest() != rec["descriptorSha256"] or text != descriptor(rec["parts"]).encode() \
            or rec["imageOpts"] != image_opts(view_dir, len(rec["parts"])):
        refuse("descriptor / image-opts differ from the receipt")
    return rec


def recheck(rec, rehash=False):
    for p in rec["parts"]:
        try:
            now = ident(os.lstat(p["path"]))
        except FileNotFoundError:
            refuse(f"part {p['index']}: missing")
        if now != p["identity"]:
            refuse(f"part {p['index']}: identity changed since the view was built")
        if rehash and hash_part(p) != p["identity"]:
            refuse(f"part {p['index']}: identity changed while re-hashing")


def cmd_recheck(a):
    rec = load_view(a.view_dir); recheck(rec, a.hash)
    print(json.dumps({"recheck": "ok", "rehashed": a.hash, "parts": len(rec["parts"])}))
    return 0


def cmd_check_held(a):
    """the running QEMU (our child) holds EXACTLY the verified inodes for every part and the descriptor"""
    rec = load_view(a.view_dir); recheck(rec)
    held, fdd = set(), f"/proc/{a.pid}/fd"
    for n in os.listdir(fdd):
        try:
            st = os.stat(os.path.join(fdd, n))
        except OSError:
            continue
        held.add((st.st_dev, st.st_ino))
    d = os.lstat(os.path.join(a.view_dir, DESC))
    missing = [p["index"] for p in rec["parts"] if (p["identity"]["dev"], p["identity"]["ino"]) not in held]
    if missing or (d.st_dev, d.st_ino) not in held:
        refuse(f"pid {a.pid} does not hold the verified files (parts {missing[:8]}{' and the descriptor' if (d.st_dev, d.st_ino) not in held else ''})")
    recheck(rec)
    print(json.dumps({"held": "ok", "pid": a.pid, "parts": len(rec["parts"])}))
    return 0


def cmd_opts(a):
    rec = load_view(a.view_dir); recheck(rec)
    print(rec["imageOpts"])
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build"); b.add_argument("--parts", required=True); b.add_argument("--out-dir", required=True)
    r = sub.add_parser("recheck"); r.add_argument("--view-dir", required=True); r.add_argument("--hash", action="store_true")
    h = sub.add_parser("check-held"); h.add_argument("--view-dir", required=True); h.add_argument("--pid", type=int, required=True)
    o = sub.add_parser("opts"); o.add_argument("--view-dir", required=True)
    a = ap.parse_args(argv)
    try:
        return {"build": cmd_build, "recheck": cmd_recheck, "check-held": cmd_check_held, "opts": cmd_opts}[a.cmd](a)
    except (Refused, OSError) as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
