#!/usr/bin/env python3
"""multipart-validation-view-stage/r6 production_import.py (prepared by Claude 1759/1770; NOT run by Claude). Python stdlib only.
r6 = r4/r5 + review 1766: P2-1a check-held refuses any fd of the PID on a bound inode or the descriptor that is not O_RDONLY
(/proc/PID/fdinfo flags); P3-1 recheck / check-held / opts re-assert --expect-kind (default production); P3-3 a write failure after
the view dir was created removes our own new files/dir (best effort; an incomplete dir has no receipt and load_view refuses it);
L2 hardening, PRODUCTION only: every commit / verify record binding must be exactly the shape the qualified r3 orchestrator writes
(a session binding with its 17 keys) and agree with this manifest (manifestSha256, planSha256, parentPath = originalPath), the pinned
r3 multipart.py and r9 overlay_session.py shas, and the session mode (commit: copy, verify: verify). This is a last defence against
accidentally MIXED records; it is NOT proof against a malicious same-user writer (records are same-user writable).

Builds the read-only VMDK FLAT view (view_descriptor.py, byte-identical to r1/r3) DIRECTLY from a recovery-multipart r3 manifest and
its recorded part / verify / session records, once EVERY part is committed and verified in the recorded state. No new verification
logic: the PINNED r3 multipart.py (sha256 below, loaded from the exact bytes that were hashed) does all manifest validation
(validate_manifest + check_production pins), record validation (load_record) and the recorded-state decision (status: production
counts only CONFIRMED sessions; stale / unconfirmed / invalid / failed lists).

Fail closed (rc 3; no view dir is created before every check passed) unless ALL of:
  * the manifest bytes hash to --manifest-sha256 and its kind is --expect-kind (default "production"; "fixture" only for tests);
  * r3 status: copyComplete, verificationCompleteRecorded, partsVerifiedRecorded == parts, and stale / unconfirmed / invalid /
    failed all empty -- evaluated TWICE (before and after the identities are captured) with identical results;
  * every part: a regular, single-link file of exactly its length (a multiple of 512) on its target's recorded device
    (MAJ:MIN), whose CURRENT identity (dev/ino/size/mtime/ctime/nlink) equals its commit record's destIdentity; distinct inodes;
    its absolute path passes the view's descriptor/image-opts rules.
Parts are NEVER chmod'ed or opened for writing (their ctime is bound by the r3 records). Their filesystems stay read-write: the
view is protected by QEMU read-only opens (`read-only=on`; use qemu-io -r / qemu-nbd --read-only) and by INODE BINDING:
`recheck` (identity + record bytes + r3 status again; `--hash` = full re-hash against the recorded logicalSha256) and
`check-held` (the running QEMU holds exactly these inodes). A writer that keeps the inode changes ctime and is detected at the next
recheck; nothing makes the bytes immutable, and a view says nothing about MDBX structure, canonical roots or state.

    production_import.py import  --manifest M --manifest-sha256 H --out-dir NEW_DIR [--expect-kind production|fixture]
    production_import.py recheck --view-dir DIR [--hash] [--expect-kind production|fixture]
    production_import.py check-held --view-dir DIR --pid PID [--expect-kind production|fixture]
    production_import.py opts --view-dir DIR [--expect-kind production|fixture]
Exit 0 ok; 3 refused; 2 usage.
"""
import argparse, hashlib, json, os, stat, sys, types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import view_descriptor as V  # noqa: E402  (the qualified r1/r3 runtime, unchanged)

R3_DIR = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-multipart-stage/r3"
R3_MULTIPART_SHA256 = "3159890b5bddcb763f578fa87b833931d695f4181dd447395bb40c2dff1c4381"   # r3 SUMS fcd8e097... (31 unit + 7 e2e PASS)
FMT_RECEIPT = "multipart-view-receipt/v2-records"
R9_OVERLAY_SESSION_SHA256 = "65d45ab79da8e134772374ec7298cd3a53fc54d68ecb3b3fd407eec4874a8153"   # = r3 orchestrate.py PINS
SESSION_BINDING_KEYS = {"kind", "sessionId", "sessionRunDir", "sessionPid", "sessionStartTime", "serverPid", "serverStartTime", "target",
                        "targetIdentity", "mntId", "planSha256", "parentPath", "manifestSha256", "requestSha256", "mode",
                        "overlaySessionSha256", "multipartSha256"}                               # = r3 orchestrate.py Provenance.binding
MEANING = ("byte-concatenation VIEW of recovery-multipart r3 parts whose RECORDED state was complete and verified (CONFIRMED sessions "
           "for production) at import; bound by inode identity, re-checked by recheck/check-held; NOT immutability, NOT integrity of "
           "the reconstructed file; MDBX structure / canonical root / state checks remain separate and required")


def load_r3(path=None, want=None):
    """the pinned r3 multipart module, compiled from exactly the bytes that were hashed (no second read, no bytecode)"""
    path = path or os.path.join(R3_DIR, "multipart.py")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        raw = b""
        while True:
            b = os.read(fd, 1 << 20)
            if not b:
                break
            raw += b
            if len(raw) > 4 << 20:
                V.refuse("r3 multipart.py is unexpectedly large")
    finally:
        os.close(fd)
    if hashlib.sha256(raw).hexdigest() != (want or R3_MULTIPART_SHA256):
        V.refuse("r3 multipart.py is not the pinned file")
    mod = types.ModuleType("recovery_multipart_r3")
    mod.__file__ = path
    exec(compile(raw, path, "exec"), mod.__dict__)
    return mod


MP = None


def r3():
    global MP
    if MP is None:
        MP = load_r3()
    return MP


def complete(d, msha):
    s = r3().status(d, msha)
    n = len(d["parts"])
    if not (s["copyComplete"] and s["verificationCompleteRecorded"] and s["partsVerifiedRecorded"] == n and s["partsCommitted"] == n
            and not (s["stale"] or s["unconfirmed"] or s["invalidRecords"] or s["failedVerification"])):
        V.refuse("recorded state is not complete and verified: " + json.dumps(
            {k: s[k] for k in ("parts", "partsCommitted", "partsVerifiedRecorded", "stale", "unconfirmed", "invalidRecords", "failedVerification")}))
    return {k: s[k] for k in ("parts", "partsCommitted", "partsVerifiedRecorded", "copyComplete", "verificationCompleteRecorded")}


def record_bytes(dfd, p):
    fd = os.open(r3().rec_name(p), os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dfd)
    try:
        raw = os.read(fd, (1 << 20) + 1)
    finally:
        os.close(fd)
    if len(raw) > 1 << 20:
        V.refuse(f"part {p['index']}: record too large")
    return raw


def bound_parts(d, msha):
    """each part's current identity == its commit record's, on its target's device; -> view part entries"""
    M, out, inodes = r3(), [], set()
    dfds = {}
    try:
        for name, t in d["targets"].items():
            dfds[name] = M.open_dir(t["dir"], f"target {name}")
            if M.majmin(os.fstat(dfds[name]).st_dev) != t["majmin"]:
                V.refuse(f"target {name}: device differs from the manifest's {t['majmin']}")
        for p in d["parts"]:
            dfd, t = dfds[p["target"]], d["targets"][p["target"]]
            r = M.load_record(dfd, p, msha)
            raw = record_bytes(dfd, p)
            st = os.lstat(p["file"], dir_fd=dfd)
            if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size != p["length"] or M.dident(st) != r["destIdentity"]:
                V.refuse(f"part {p['index']}: not the single-link regular file of its commit record (stale or replaced)")
            if M.majmin(st.st_dev) != t["majmin"]:
                V.refuse(f"part {p['index']}: not on its target's device")
            if p["length"] % V.SECTOR:
                V.refuse(f"part {p['index']}: length is not a multiple of {V.SECTOR}")
            if (st.st_dev, st.st_ino) in inodes:
                V.refuse(f"part {p['index']}: the same inode as an earlier part")
            inodes.add((st.st_dev, st.st_ino))
            path = V.check_path(os.path.join(t["dir"], p["file"]), f"part {p['index']}")
            out.append({"index": p["index"], "path": path, "size": p["length"], "sha256": r["logicalSha256"],
                        "destIdentity": M.dident(st), "recordSha256": hashlib.sha256(raw).hexdigest(), "target": p["target"]})
    finally:
        for fd in dfds.values():
            os.close(fd)
    return out


def binding_problem(b, d, msha, mode):
    """None if b is exactly a qualified r3-orchestrator session binding for THIS manifest and mode; else the reason"""
    if not isinstance(b, dict) or b.get("kind") != "session":
        return "not a session binding"
    if set(b) != SESSION_BINDING_KEYS:
        return "not the qualified orchestrator's binding shape"
    want = {"manifestSha256": msha, "planSha256": d["source"]["planSha256"], "parentPath": d["source"]["originalPath"],
            "multipartSha256": R3_MULTIPART_SHA256, "overlaySessionSha256": R9_OVERLAY_SESSION_SHA256, "mode": mode}
    bad = sorted(k for k, v in want.items() if b.get(k) != v)
    return f"binding fields differ: {bad}" if bad else None


def qualified_records(d, msha):
    """every commit record (mode copy) and EVERY verify record (mode verify) of every part carries a qualified binding"""
    M, dfds = r3(), {}
    try:
        for name, t in d["targets"].items():
            dfds[name] = M.open_dir(t["dir"], f"target {name}")
        names = {name: sorted(os.listdir(fd)) for name, fd in dfds.items()}
        for p in d["parts"]:
            dfd = dfds[p["target"]]
            why = binding_problem(M.load_record(dfd, p, msha)["source"], d, msha, "copy")
            if why:
                V.refuse(f"part {p['index']}: commit record: {why}")
            pref = p["file"][:-4] + ".verify-"
            for n in names[p["target"]]:
                if n.startswith(pref) and n.endswith(".json"):
                    x = M.read_json_in(dfd, n, "verify")
                    why = binding_problem(x.get("source") if isinstance(x, dict) else None, d, msha, "verify")
                    if why:
                        V.refuse(f"part {p['index']}: {n}: {why}")
    finally:
        for fd in dfds.values():
            os.close(fd)


def cmd_import(a):
    M = r3()
    d, msha = M.load_manifest(a.manifest, a.manifest_sha256)       # validate_manifest (+ check_production pins for production)
    if d["kind"] != a.expect_kind:
        V.refuse(f"manifest kind {d['kind']!r} is not the expected {a.expect_kind!r}")
    out = a.out_dir
    V.check_path(os.path.dirname(out), "--out-dir parent")
    if not out.startswith("/") or os.path.normpath(out) != out or os.path.lexists(out):
        V.refuse("--out-dir must be a NEW absolute normalized directory")
    if len(os.path.join(out, V.DESC).encode()) > V.MAX_PATH or any(c in out for c in '",:\\\n\r'):
        V.refuse("--out-dir: unsafe for the image-opts string")
    before = complete(d, msha)
    if d["kind"] == "production":
        qualified_records(d, msha)
    parts = bound_parts(d, msha)
    if complete(d, msha) != before or bound_parts(d, msha) != parts:     # nothing moved while we looked
        V.refuse("records or parts changed during the import")
    if sum(p["size"] for p in parts) != d["source"]["logicalSize"]:
        V.refuse("parts do not cover the logical size")
    text = V.descriptor(parts).encode()
    os.mkdir(out, 0o700)                                               # the ONLY writes: this new dir and its two 0400 files
    dfd = os.open(out, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    ok = False
    try:
        V.write_new(dfd, V.DESC, text)
        rec = {"format": FMT_RECEIPT, "kind": d["kind"], "manifestPath": a.manifest, "manifestSha256": msha,
               "r3MultipartSha256": R3_MULTIPART_SHA256, "statusAtImport": before, "descriptor": V.DESC,
               "descriptorSha256": hashlib.sha256(text).hexdigest(), "logicalSize": d["source"]["logicalSize"],
               "sectors": d["source"]["logicalSize"] // V.SECTOR, "imageOpts": V.image_opts(out, len(parts)), "parts": parts,
               "partsChmodded": False, "meaning": MEANING}
        V.write_new(dfd, V.RECEIPT, (json.dumps(rec, indent=1, sort_keys=True) + "\n").encode())
        ok = True
    finally:
        if not ok:                                                     # P3-3: remove only OUR new files and dir (best effort)
            for n in (V.RECEIPT, V.DESC):
                try:
                    os.unlink(n, dir_fd=dfd)
                except OSError:
                    pass
        os.close(dfd)
        if not ok:
            try:
                os.rmdir(out)
            except OSError:
                pass
    print(json.dumps({"viewDir": out, "kind": d["kind"], "parts": len(parts), "manifestSha256": msha, "descriptorSha256": rec["descriptorSha256"]}))
    return 0


def load_view(view_dir, kind):
    V.check_path(view_dir, "--view-dir")
    _, rec = V.read_json(os.path.join(view_dir, V.RECEIPT), 16 << 20, "receipt")
    if not isinstance(rec, dict) or rec.get("format") != FMT_RECEIPT or rec.get("r3MultipartSha256") != R3_MULTIPART_SHA256 \
            or not isinstance(rec.get("parts"), list):
        V.refuse("receipt: not a records-bound view receipt of the pinned r3")
    if rec.get("kind") != kind:                                         # P3-1: a fixture view is never a production view
        V.refuse(f"view kind {rec.get('kind')!r} is not the expected {kind!r}")
    fd = os.open(os.path.join(view_dir, V.DESC), os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        text = b""
        while len(text) <= V.MAX_DESC:
            b = os.read(fd, V.MAX_DESC + 1 - len(text))
            if not b:
                break
            text += b
    finally:
        os.close(fd)
    if hashlib.sha256(text).hexdigest() != rec["descriptorSha256"] or text != V.descriptor(rec["parts"]).encode() \
            or rec["imageOpts"] != V.image_opts(view_dir, len(rec["parts"])):
        V.refuse("descriptor / image-opts differ from the receipt")
    return rec


def recheck(rec, rehash=False):
    """the same manifest bytes, still complete+verified in r3's recorded state, every part the same inode/record as at import"""
    d, msha = r3().load_manifest(rec["manifestPath"], rec["manifestSha256"])
    if d["kind"] != rec["kind"]:
        V.refuse("manifest kind differs from the receipt")
    complete(d, msha)
    if d["kind"] == "production":
        qualified_records(d, msha)
    if bound_parts(d, msha) != rec["parts"]:
        V.refuse("a part or its commit record differs from the view receipt (stale, replaced or re-recorded)")
    if rehash:
        for p in rec["parts"]:
            fd = os.open(p["path"], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                st, h = os.fstat(fd), hashlib.sha256()
                while True:
                    b = os.read(fd, 8 << 20)
                    if not b:
                        break
                    h.update(b)
                if r3().dident(os.fstat(fd)) != p["destIdentity"] or r3().dident(st) != p["destIdentity"]:
                    V.refuse(f"part {p['index']}: changed while re-hashing")
            finally:
                os.close(fd)
            if h.hexdigest() != p["sha256"]:
                V.refuse(f"part {p['index']}: content differs from its recorded logicalSha256")


def cmd_recheck(a):
    rec = load_view(a.view_dir, a.expect_kind); recheck(rec, a.hash)
    print(json.dumps({"recheck": "ok", "rehashed": a.hash, "parts": len(rec["parts"]), "kind": rec["kind"]}))
    return 0


def cmd_check_held(a):
    rec = load_view(a.view_dir, a.expect_kind); recheck(rec)
    desc = os.lstat(os.path.join(a.view_dir, V.DESC))
    bound = {(p["destIdentity"]["dev"], p["destIdentity"]["ino"]) for p in rec["parts"]} | {(desc.st_dev, desc.st_ino)}
    held, fdd = set(), f"/proc/{a.pid}/fd"
    for n in os.listdir(fdd):                                           # P2-1a: EVERY fd of the PID is examined
        try:
            st = os.stat(os.path.join(fdd, n))
        except OSError:
            continue
        key = (st.st_dev, st.st_ino)
        if key not in bound:
            continue
        try:
            with open(f"/proc/{a.pid}/fdinfo/{n}") as f:
                flags = [l.split()[1] for l in f if l.startswith("flags:")]
        except OSError:
            V.refuse(f"pid {a.pid} fd {n}: fdinfo unreadable for a bound file")
        if len(flags) != 1 or int(flags[0], 8) & os.O_ACCMODE != os.O_RDONLY:
            V.refuse(f"pid {a.pid} fd {n}: a bound file is open with a writable access mode ({flags})")
        held.add(key)
    missing = [p["index"] for p in rec["parts"] if (p["destIdentity"]["dev"], p["destIdentity"]["ino"]) not in held]
    if missing or (desc.st_dev, desc.st_ino) not in held:
        V.refuse(f"pid {a.pid} does not hold the bound files (parts {missing[:8]}"
                 f"{'' if (desc.st_dev, desc.st_ino) in held else ' and the descriptor'})")
    recheck(rec)
    print(json.dumps({"held": "ok", "pid": a.pid, "parts": len(rec["parts"])}))
    return 0


def cmd_opts(a):
    rec = load_view(a.view_dir, a.expect_kind); recheck(rec)
    print(rec["imageOpts"])
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("import"); i.add_argument("--manifest", required=True); i.add_argument("--manifest-sha256", required=True)
    i.add_argument("--out-dir", required=True); i.add_argument("--expect-kind", choices=("production", "fixture"), default="production")
    r = sub.add_parser("recheck"); r.add_argument("--view-dir", required=True); r.add_argument("--hash", action="store_true")
    h = sub.add_parser("check-held"); h.add_argument("--view-dir", required=True); h.add_argument("--pid", type=int, required=True)
    o = sub.add_parser("opts"); o.add_argument("--view-dir", required=True)
    for x in (r, h, o):
        x.add_argument("--expect-kind", choices=("production", "fixture"), default="production")
    a = ap.parse_args(argv)
    try:
        r3()
        return {"import": cmd_import, "recheck": cmd_recheck, "check-held": cmd_check_held, "opts": cmd_opts}[a.cmd](a)
    except Exception as e:                                         # every failure is a refusal; nothing was written on refusal
        if MP is not None and isinstance(e, (MP.Refuse, MP.Fail)) or isinstance(e, (V.Refused, OSError, ValueError, KeyError, TypeError)):
            print(f"REFUSED: {type(e).__name__}: {e}", file=sys.stderr)
            return 3
        raise


if __name__ == "__main__":
    sys.exit(main())
