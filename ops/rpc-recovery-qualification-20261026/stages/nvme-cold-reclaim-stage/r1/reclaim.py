#!/usr/bin/env python3
"""nvme-cold-reclaim-stage/r1 reclaim.py: one-time, UNPRIVILEGED reclamation of EXACTLY the three /vm originals that the frozen
nvme-cold-relocation-stage/r8 cut-over renamed to
  /vm/enclave-volumes/codex-archive/2026-10-24/home/.retire-{hf-convert,gvs5h,gguf-e2b}
after their content lives, verified, at /home/steven/.cold-archive/codex-archive/2026-10-24/home/<name> (ext4, cryptroot) and
the original path is r8's symlink to it.

r8 (subtree.py + relocate.py) is reused IN PLACE, read-only: its bytes are sha256-pinned and compile+exec'd (never a pyc). The r8
journal is only read and flock'ed (no r8 phase can run concurrently); it is never written. This tool keeps its own journal on /.
Phases (owner uid, never root; verify/reclaim/check-retained only inside root's queue lane: exact cgroup memory.max, the queue's
16 GiB host memory guard, MemAvailable >= 16 GiB at start; / must be >= its 300 GB floor):
  status          read-only per-subtree view
  verify          r8 cut-over complete and consistent; the original path is r8's symlink to the destination; pinned mounts,
                  devices and no nested/second mounts; the retired tree is the SAME inode tree r8 verified (identity incl. every
                  child ctime; the top's rename ctime is excluded by r5's walk); the destination is unchanged since cut-over and
                  its EVERY byte is re-hashed now (fresh cache, nothing reused) and equals the verified logical inventory and the
                  manifest sha256/bytes; manifest links resolve into the destination. Writes the receipt verify-<name>.json with
                  the exact deletion plan (regular files with nlink 1 and directories only, all owned by the owner).
  reclaim         explicit --reclaim-retired <exact .retire path> and --result FILE: the stdout of r8's FROZEN root scanner
                  (sudo bash nvme-cold-relocation-stage/r8/jobs/root-writer-check.sh CONFIG > FILE), complete, taken after the
                  receipt, within writer_check_max_age_seconds, never reused; a hit inside THIS retired tree blocks only this
                  tree. Then per entry, through directory fds (O_NOFOLLOW, dev/ino checked): unlink planned files whose
                  dev/ino/ctime/size/mtime/mode/owner/nlink equal the plan, rmdir planned directories, the top last. An
                  unrecognized or changed entry refuses before anything in that run is deleted (validation pass first).
                  Crash-safe: the state ("deleting" -> "rmdir-top" -> "complete") and every unlink are journalled; a re-run
                  (with a fresh scan) resumes with the same per-entry checks. No recursive rm, no wildcards, nothing outside the plan.
  check-retained  after reclaim: fresh full re-hash of the retained destination against the receipt (post-reclaim recovery check)
Nothing here touches the destination, the manifest, the home links, the production VM, its thresholds or any other path.
"""
import argparse, hashlib, json, os, stat, sys

HERE = os.path.dirname(os.path.abspath(__file__))
R8_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "nvme-cold-relocation-stage", "r8"))
R8_SUBTREE_SHA256 = "4509e043e51746fa60b873c2e6e824ff8834232bae8a04a73ad2135975585073"
R5_RELOCATE_SHA256 = "2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0"


def _load_r8():
    """the frozen r8 subtree.py, exactly the verified bytes (it loads its relocate.py the same way)"""
    import types
    p = os.path.join(R8_DIR, "subtree.py")
    with open(p, "rb") as f:
        b = f.read()
    if hashlib.sha256(b).hexdigest() != R8_SUBTREE_SHA256:
        raise SystemExit("nvme-cold-relocation-stage/r8/subtree.py is not the frozen r8 bytes")
    m = types.ModuleType("subtree_r8"); m.__file__ = p
    exec(compile(b, p, "exec", dont_inherit=True), m.__dict__)
    return m


ST = _load_r8()
R = ST.R
Refuse, refuse = R.Refuse, R.refuse
FORMAT, JMODE, RECEIPT = "nvme-cold-reclaim-config/r1", "reclaim-r1", "nvme-cold-reclaim-receipt/r1"
MAX_VERIFY_AGE = 6 * 3600
MAX_PLAN_ENTRIES = 100000
PROD = {"journal_dir": "/home/steven/.local/state/nvme-cold-reclaim-r1", "subtree_journal_dir": "/home/steven/.local/state/nvme-cold-subtree-r7",
        "owner_uid": 1000}
WC_KEYS = ["format", "hits", "incomplete", "entries", "complete", "t", "prefixes", "euid", "tools"]
DIRF = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


class Env(ST.Env):
    def check_mount(self, pin, path):
        R.check_mount(pin, self, path)

    def mounts(self):
        return R.parse_mountinfo(R.read_text(self.mountinfo))


# ------------------------------------------------------------------------------------------------------------- config
def load_config(path, env):
    if os.path.islink(path):
        refuse("config must not be a symlink")
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o022:
        refuse("config must be a regular file, not group/world-writable")
    rc = R.read_json(path)
    R._keys(rc, ["format", "subtree_config", "subtree_config_sha256", "journal_dir", "verify_max_age_seconds"], "top level")
    if rc["format"] != FORMAT:
        refuse("config format")
    R._abs(rc["subtree_config"], "subtree_config"); R._abs(rc["journal_dir"], "journal_dir")
    R._int(rc["verify_max_age_seconds"], "verify_max_age_seconds")
    if rc["verify_max_age_seconds"] > MAX_VERIFY_AGE:
        refuse(f"verify_max_age_seconds must be <= {MAX_VERIFY_AGE}")
    if hashlib.sha256(R.read_bytes(rc["subtree_config"])).hexdigest() != rc["subtree_config_sha256"]:
        refuse("the r8 subtree config is not the pinned bytes (subtree_config_sha256)")
    c8 = ST.load_config(rc["subtree_config"], env)                 # r8's own checks, incl. its production pins
    if st.st_uid not in (c8["owner_uid"], 0):
        refuse("config must be owned by the owner or root")
    jd = rc["journal_dir"]
    for k in (c8["archive_root"], c8["dest_root"], c8["journal_dir"], c8["inventory_1381"]["journal_dir"]):
        if R._under(jd, k) or R._under(k, jd):
            refuse("the reclaim journal must be disjoint from the archive, the destination and the r8/1381 journals")
    if env.production:
        if jd != PROD["journal_dir"] or c8["journal_dir"] != PROD["subtree_journal_dir"] or c8["owner_uid"] != PROD["owner_uid"]:
            refuse("journal_dir / r8 journal_dir / owner_uid differ from the reviewed pins")
    return rc, c8


def open_rj(rc, c8, env, create):
    j = R.Journal({"journal_dir": rc["journal_dir"], "owner_uid": c8["owner_uid"]}, env, create=create)
    if j.state.get("mode") not in (None, JMODE) or (j.state["trees"] and j.state.get("mode") != JMODE):
        refuse("not a reclaim-r1 journal")
    j.state["mode"] = JMODE
    return j


# ------------------------------------------------------------------------------------------------------------- checks
def ident(recs):
    return R.digest([[r["p"], r["id"], r.get("s"), r.get("mt"), r.get("l"), r["m"]] for r in recs])


def paths(c8, rel):
    return ST.src_of(c8, rel), ST.dest_of(c8, rel), ST.retire_of(c8, rel)


def gates(c8, rc, env, rel):
    """queue admission + memory floor, pinned mounts, single source mount, no nested mounts, devices, / floor"""
    ST.in_queue(c8, env)
    src, dst, ret = paths(c8, rel)
    env.check_mounts(c8)                                             # r8: archive on /vm; dest_root and r8 journal on /
    env.check_mount(c8["source_mount"], os.path.dirname(ret))
    env.check_mount(c8["dest_mount"], dst)
    env.check_mount(c8["dest_mount"], ST.existing_ancestor(rc["journal_dir"]))
    ms = env.mounts()
    vm = [m for m in ms if m["point"] == c8["source_mount"]["path"]]
    if len(vm) != 1 or vm[0]["root"] != "/":
        refuse("the source filesystem is not mounted exactly once at its pinned path")
    if [m for m in ms if m["majmin"] == vm[0]["majmin"]] != vm:
        refuse("the source filesystem is mounted more than once (a second view would escape the /proc path scan)")
    nested = [m["point"] for m in ms if any(R._under(m["point"], p) for p in (src, dst, ret))]
    if nested:
        refuse(f"mount point inside the subtree, its retired original or its destination: {nested[:3]}")
    sdev, ddev = env.dev_of(c8["archive_root"]), env.dev_of(c8["dest_root"])
    if sdev == ddev or env.dev_of(os.path.dirname(ret)) != sdev or env.dev_of(dst) != ddev or env.dev_of(rc["journal_dir"]) != ddev:
        refuse("devices: the retired tree must be on the source filesystem; destination and reclaim journal on /, not the source")
    dv = env.statvfs(ST.existing_ancestor(c8["dest_root"]))
    if dv.f_bavail * dv.f_frsize < c8["dest_floor_bytes"]:
        refuse(f"/ is below its {c8['dest_floor_bytes']} B floor: not starting")


def r8_tree(j8, rel):
    ts = j8.state["trees"].get(rel, {})
    if ts.get("cutover") != "complete":
        refuse(f"r8 cut-over of {rel} is not complete ({ts.get('cutover')!r}): nothing to reclaim (r8 rollback is still the recovery)")
    v, inv = ts.get("verified") or {}, ts.get("source_inventory") or {}
    if not v or v.get("source_identity") != inv.get("identity") or v.get("logical") != inv.get("logical") or not ts.get("dest_identity_at_cutover"):
        refuse("the r8 journal is inconsistent for this subtree (verified/inventory/cut-over identities): manual review")
    return ts


def check_link(c8, rel):
    src, dst, _ = paths(c8, rel)
    R.no_symlink_components(os.path.dirname(src))
    if not os.path.islink(src) or os.readlink(src) != dst or os.path.realpath(src) != dst:
        refuse(f"{src} is not r8's symlink to {dst}")
    R.no_symlink_components(dst); ST.private_dest(c8)
    st = os.lstat(dst)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != c8["owner_uid"]:
        refuse(f"{dst} is not the owner's directory")


def check_plan(c8, recs):
    if len(recs) > MAX_PLAN_ENTRIES:
        refuse("more entries than this one-time tool reclaims")
    for r in recs:
        if r["t"] not in ("f", "d"):
            refuse(f"{r['p'] or '.'}: only regular files and directories are reclaimed by r1 (symlink found)")
        if r["u"] != c8["owner_uid"]:
            refuse(f"{r['p'] or '.'}: not owned by uid {c8['owner_uid']}")
        if r["t"] == "f" and (r.get("nl") != 1 or "h" in r):
            refuse(f"{r['p']}: hardlinked files are not reclaimed by r1")


def fresh_dest(rj, rel, dst, run):
    """every regular file of the destination read and hashed NOW (a new, empty cache path: nothing reused)"""
    cache = rj.path(f"dest-{ST.name_of(rel)}-{run}.hashcache.tsv")
    if os.path.lexists(cache):
        refuse("hash cache path exists: refusing to reuse any hash")
    recs = R.walk_meta(dst)
    hashes, counts = R.hash_files(dst, recs, cache, rj)
    if counts["reused"] or counts["hashed"] != len([r for r in recs if r["t"] == "f"]):
        refuse("not every destination file was freshly hashed")
    if R.walk_meta(dst) != recs:
        refuse("the destination changed while it was hashed")
    return recs, R.logical(recs, hashes), counts


def accept_scan(c8, env, rj, rs, rel, result_path):
    """r8's root scanner output (format, euid 0, r8 tool shas), complete, fresh, after the receipt, unused; per-tree hits"""
    if not result_path:
        refuse("--result FILE (stdout of: sudo bash nvme-cold-relocation-stage/r8/jobs/root-writer-check.sh CONFIG > FILE) is required")
    st = os.lstat(result_path)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != c8["owner_uid"] or st.st_mode & 0o022:
        refuse("the scan result must be a regular file owned by the owner, not group/world-writable")
    raw = R.read_bytes(result_path); res = json.loads(raw)
    R._keys(res, WC_KEYS, "writer-check result")
    if res["format"] != ST.WC_FORMAT or res["euid"] != 0:
        refuse("not a root scan of the r8 scanner")
    if res["tools"] != {"subtree.py": R8_SUBTREE_SHA256, "relocate.py": R5_RELOCATE_SHA256} or res["tools"] != ST.tool_shas():
        refuse("the root scan ran other tool bytes than the frozen r8 ones")
    if res["complete"] is not True or res["incomplete"]:
        refuse(f"the root scan was incomplete ({len(res['incomplete'])} unreadable): not proof of no users")
    now = env.now()
    if not rs["verified"]["t"] < res["t"] <= now + 1 or now - res["t"] > c8["writer_check_max_age_seconds"]:
        refuse("the root scan is stale, from the future, or older than the verify receipt: take a fresh one")
    if res["t"] <= max(rs.get("scans_used", [0])):
        refuse("this root scan was already used: take a fresh one")
    src, _, ret = paths(c8, rel)
    if ret not in res["prefixes"] or src not in res["prefixes"]:
        refuse("the root scan does not cover this subtree")
    mine = [h for h in res["hits"] if any(R._under(str(h[-1]).split(" (deleted)")[0], p) for p in (ret, src))]
    if mine:
        refuse(f"active users of {ret} (only this subtree is blocked): {mine[:3]}")
    name = f"writer-check-{ST.name_of(rel)}-{int(res['t'] * 1000)}.json"
    rj.write_atomic(name, raw.decode())
    return {"file": name, "t": res["t"], "other_hits": len(res["hits"])}


# ------------------------------------------------------------------------------------------------------------- deletion
def _file_ok(st, r, uid):
    return (stat.S_ISREG(st.st_mode) and [st.st_dev, st.st_ino, st.st_ctime_ns] == r["id"] and st.st_size == r["s"]
            and st.st_mtime_ns == r["mt"] and stat.S_IMODE(st.st_mode) == r["m"] and st.st_uid == uid == r["u"] and st.st_nlink == 1)


def _dir_ok(st, r, uid):                     # a directory's own mtime/ctime change as its entries are removed: dev/ino/mode/owner
    return stat.S_ISDIR(st.st_mode) and [st.st_dev, st.st_ino] == r["id"][:2] and stat.S_IMODE(st.st_mode) == r["m"] and st.st_uid == uid == r["u"]


def _opendir(pfd, name, r, uid):
    fd = os.open(name, DIRF, dir_fd=pfd)
    if not _dir_ok(os.fstat(fd), r, uid):
        os.close(fd); refuse(f"{r['p'] or '.'}: directory differs from the plan")
    return fd


def _walk(fd, rel, by, kids, uid, rj, delete, tally, sub):
    names = os.listdir(fd)
    extra = sorted(set(names) - set(kids.get(rel, ())))
    if extra:
        refuse(f"unrecognized entries in {rel or '.'}: {extra[:5]} (never deleted: manual review)")
    for n in sorted(names):
        crel = f"{rel}/{n}" if rel else n
        r = by[crel]
        st = os.stat(n, dir_fd=fd, follow_symlinks=False)
        if r["t"] == "f":
            if not _file_ok(st, r, uid):
                refuse(f"{crel}: differs from the verified plan (dev/ino/ctime/size/mtime/mode/owner/nlink)")
            if delete:
                os.unlink(n, dir_fd=fd)
                tally["files"] += 1; tally["bytes"] += r["s"]
                rj.event(phase="reclaim", subtree=sub, unlink=crel, ino=r["id"][1], bytes=r["s"])
        else:
            if not _dir_ok(st, r, uid):
                refuse(f"{crel}: directory differs from the plan")
            cfd = _opendir(fd, n, r, uid)
            try:
                _walk(cfd, crel, by, kids, uid, rj, delete, tally, sub)
            finally:
                os.close(cfd)
            if delete:
                os.rmdir(n, dir_fd=fd)
                tally["dirs"] += 1; rj.event(phase="reclaim", subtree=sub, rmdir=crel, ino=r["id"][1])


def delete_planned(c8, rj, rs, rel, ret, plan):
    uid = c8["owner_uid"]
    by = {r["p"]: r for r in plan}
    kids = {}
    for r in plan:
        if r["p"]:
            kids.setdefault(os.path.dirname(r["p"]), []).append(os.path.basename(r["p"]))
    tally = {"files": 0, "dirs": 0, "bytes": 0}
    parent, name = os.path.dirname(ret), os.path.basename(ret)
    R.no_symlink_components(parent)
    pfd = os.open(parent, DIRF)
    try:
        if os.fstat(pfd).st_dev != by[""]["id"][0]:
            refuse("the retired tree's parent is not on the planned filesystem")
        try:
            top = os.stat(name, dir_fd=pfd, follow_symlinks=False)
        except FileNotFoundError:
            if rs["reclaim"] == "rmdir-top":                         # crash after the top's rmdir, before "complete" was saved
                return tally
            refuse(f"{ret} vanished while reclaim was {rs['reclaim']!r}: manual review")
        if not _dir_ok(top, by[""], uid):
            refuse(f"{ret} is not the planned directory (replaced, or a symlink)")
        tfd = _opendir(pfd, name, by[""], uid)
        try:
            if rs["reclaim"] == "deleting":
                _walk(tfd, "", by, kids, uid, rj, False, tally, rel)  # pass 1: everything still present is planned and exact
                _walk(tfd, "", by, kids, uid, rj, True, tally, rel)   # pass 2: the same checks again, entry by entry, then remove
                rs["reclaim"] = "rmdir-top"; rj.event(phase="reclaim", subtree=rel, step="rmdir-top-intent", ino=by[""]["id"][1]); rj.save()
            if os.listdir(tfd):
                refuse(f"unrecognized entries left in {ret}: {sorted(os.listdir(tfd))[:5]} (never deleted: manual review)")
        finally:
            os.close(tfd)
        os.rmdir(name, dir_fd=pfd)
        tally["dirs"] += 1; rj.event(phase="reclaim", subtree=rel, rmdir=".", ino=by[""]["id"][1])
    finally:
        os.close(pfd)
    return tally


# ------------------------------------------------------------------------------------------------------------- phases
def phase_status(c8, rc, env, j8, rj):
    out = {}
    for rel in c8["subtrees"]:
        src, dst, ret = paths(c8, rel)
        ts, rs = j8.state["trees"].get(rel, {}), rj.state["trees"].get(rel, {})
        out[rel] = {"r8_copy": ts.get("copy"), "r8_cutover": ts.get("cutover"), "retired_present": os.path.lexists(ret),
                    "original_is_symlink": os.path.islink(src), "reclaim": rs.get("reclaim"), "verified_t": (rs.get("verified") or {}).get("t")}
    return out


def phase_verify(c8, rc, env, j8, rj, rel):
    rs = rj.tree(rel)
    if rs.get("reclaim"):
        refuse(f"reclaim already {rs['reclaim']!r}: verify again is not possible on a partly reclaimed tree")
    ts = r8_tree(j8, rel); check_link(c8, rel)
    src, dst, ret = paths(c8, rel)
    R.no_symlink_components(os.path.dirname(ret))
    st = os.lstat(ret)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != c8["owner_uid"]:
        refuse(f"{ret} is not the owner's real directory")
    plan = R.walk_meta(ret)
    if ident(plan) != ts["verified"]["source_identity"]:
        refuse(f"{ret} is not the tree r8 verified (identity incl. ctimes differs): changed state, manual review")
    check_plan(c8, plan)
    if stat.S_IMODE(os.lstat(dst).st_mode) != stat.S_IMODE(st.st_mode):
        refuse("destination top-level mode differs from the original's")
    if R.identity_now(dst) != ts["dest_identity_at_cutover"]:
        refuse("the destination changed since cut-over: not reclaiming against a changed copy")
    run = f"{int(env.now() * 1000)}-{os.getpid()}"
    drecs, dlog, counts = fresh_dest(rj, rel, dst, run)
    if ident(drecs) != ts["dest_identity_at_cutover"]:
        refuse("the destination changed since cut-over")
    if R.digest(dlog) != ts["verified"]["logical"]:
        a = R.read_json(j8.path(f"source-{ST.name_of(rel)}.logical.json"))
        rj.write_atomic(f"verify-diff-{ST.name_of(rel)}-{run}.json", json.dumps([x for x in dlog if x not in a][:20]))
        refuse("destination content differs from the verified source (fresh full hash): NOT reclaiming; see verify-diff")
    sha = {x["p"]: x for x in dlog if x["t"] == "f"}
    for e in ST.manifest_entries(c8, rel):
        x = sha.get(os.path.relpath(e["destination"], src))
        if not x or x["sha256"] != e["sha256"] or x["s"] != e["bytes"]:
            refuse(f"destination does not match the relocation manifest at {e['destination']}")
    links = ST.check_links(c8, rel, dst)
    rj.write_atomic(f"dest-{ST.name_of(rel)}-{run}.logical.json", json.dumps(dlog))
    receipt = {"format": RECEIPT, "subtree": rel, "t": env.now(), "retired": ret, "destination": dst, "original_symlink": src,
               "retired_identity": ident(plan), "dest_identity": ident(drecs), "dest_logical": R.digest(dlog),
               "dest_logical_file": f"dest-{ST.name_of(rel)}-{run}.logical.json", "hashed_fresh": counts["hashed"],
               "plan_files": len([r for r in plan if r["t"] == "f"]), "plan_dirs": len([r for r in plan if r["t"] == "d"]),
               "plan_bytes": sum(r["s"] for r in plan if r["t"] == "f"), "manifest_links": links, "plan": plan}
    text = json.dumps(receipt, sort_keys=True)
    rj.write_atomic(f"verify-{ST.name_of(rel)}.json", text)
    rs.clear(); rs["verified"] = {"t": receipt["t"], "receipt_sha256": hashlib.sha256(text.encode()).hexdigest(),
                                  "dest_identity": receipt["dest_identity"], "retired_identity": receipt["retired_identity"]}
    rj.event(phase="verify", subtree=rel, hashed=counts["hashed"], plan_files=receipt["plan_files"]); rj.save()
    return {k: v for k, v in receipt.items() if k != "plan"}


def load_receipt(rj, rs, rel):
    text = R.read_text(rj.path(f"verify-{ST.name_of(rel)}.json"))
    if hashlib.sha256(text.encode()).hexdigest() != rs["verified"]["receipt_sha256"]:
        refuse("the verify receipt differs from the one recorded: verify again")
    return json.loads(text)


def phase_reclaim(c8, rc, env, j8, rj, rel, result_path, confirm):
    src, dst, ret = paths(c8, rel)
    if confirm != ret:
        refuse(f"--reclaim-retired must name exactly {ret}")
    rs = rj.tree(rel)
    if rs.get("reclaim") == "complete":
        return {"already": "complete"}
    if "verified" not in rs:
        refuse("verify first")
    r8_tree(j8, rel); check_link(c8, rel)
    rec = load_receipt(rj, rs, rel)
    if R.identity_now(dst) != rs["verified"]["dest_identity"]:
        refuse("the destination changed since the verify receipt: not reclaiming")
    ST.check_links(c8, rel, dst)
    scan = accept_scan(c8, env, rj, rs, rel, result_path)
    state = rs.get("reclaim")
    if state is None:
        if env.now() - rs["verified"]["t"] > rc["verify_max_age_seconds"]:
            refuse("the verify receipt is too old: verify again")
        st = os.lstat(ret)
        if not stat.S_ISDIR(st.st_mode):
            refuse(f"{ret} is not a directory")
        recs = R.walk_meta(ret)
        if ident(recs) != rs["verified"]["retired_identity"] or recs != rec["plan"]:
            refuse(f"{ret} changed since the verify receipt: verify again (nothing deleted)")
        rs["reclaim"] = "deleting"; rs["started_t"] = env.now()
        rj.event(phase="reclaim", subtree=rel, step="intent", receipt_sha256=rs["verified"]["receipt_sha256"])
    elif state not in ("deleting", "rmdir-top"):
        refuse(f"unknown reclaim state {state!r}: manual review")
    rs.setdefault("scans_used", []).append(scan["t"]); rs.setdefault("scan_files", []).append(scan["file"]); rj.save()
    sv = env.statvfs(c8["archive_root"]); before = sv.f_bavail * sv.f_frsize
    try:
        tally = delete_planned(c8, rj, rs, rel, ret, rec["plan"])
    except OSError as e:
        rj.event(phase="reclaim", subtree=rel, error=str(e)); rj.save()
        refuse(f"reclaim interrupted ({e}): state {rs['reclaim']!r}; re-run with a FRESH root scan to resume (every entry re-checked)")
    sv = env.statvfs(c8["archive_root"]); after = sv.f_bavail * sv.f_frsize
    rs["reclaim"] = "complete"; rs["completed_t"] = env.now()
    post = {"retired_absent": not os.path.lexists(ret), "dest_identity_unchanged": R.identity_now(dst) == rs["verified"]["dest_identity"]}
    try:                                                             # report-only now: the deletion has happened
        check_link(c8, rel); ST.check_links(c8, rel, dst); post["symlink_and_manifest_links"] = True
    except (Refuse, OSError):
        post["symlink_and_manifest_links"] = False
    ev = [json.loads(l) for l in R.read_text(rj.path("events.jsonl")).splitlines() if l.strip()]
    ev = [e for e in ev if e.get("subtree") == rel and e.get("phase") == "reclaim"]
    journalled = {"files": sum(1 for e in ev if "unlink" in e), "dirs": sum(1 for e in ev if "rmdir" in e),
                  "bytes": sum(e.get("bytes", 0) for e in ev if "unlink" in e)}
    out = {"format": RECEIPT, "subtree": rel, "reclaimed": ret, "retained": dst, "deleted_journalled": journalled, "deleted_this_run": tally,
           "plan": {"files": rec["plan_files"], "dirs": rec["plan_dirs"], "bytes": rec["plan_bytes"]}, "source_free_before": before,
           "source_free_after": after, "dest_identity": rs["verified"]["dest_identity"], "dest_logical": rec["dest_logical"],
           "dest_logical_file": rec["dest_logical_file"], "verify_receipt_sha256": rs["verified"]["receipt_sha256"],
           "scan_files": rs["scan_files"], "post_checks": post, "t": env.now(),
           "recovery": "the retained destination is the copy; check-retained re-hashes it against dest_logical_file; a move back to /vm "
                       "is a separately reviewed reverse copy (r8 rollback is no longer possible)"}
    rj.write_atomic(f"reclaimed-{ST.name_of(rel)}.json", json.dumps(out, sort_keys=True))
    rj.event(phase="reclaim", subtree=rel, step="complete", **tally); rj.save()
    if not all(post.values()) or journalled["files"] > rec["plan_files"] or journalled["dirs"] > rec["plan_dirs"]:
        refuse(f"reclaim finished but a post-check failed or the journal does not balance: {journalled} {post}: manual review")
    return out


def phase_check_retained(c8, rc, env, j8, rj, rel):
    rs = rj.tree(rel)
    if rs.get("reclaim") != "complete":
        refuse("check-retained is for reclaimed subtrees")
    check_link(c8, rel)
    _, dst, _ = paths(c8, rel)
    rec = load_receipt(rj, rs, rel)
    run = f"{int(env.now() * 1000)}-{os.getpid()}"
    drecs, dlog, counts = fresh_dest(rj, rel, dst, run)
    ok = R.digest(dlog) == rec["dest_logical"]
    rj.event(phase="check-retained", subtree=rel, ok=ok, identity_unchanged=ident(drecs) == rec["dest_identity"]); rj.save()
    if not ok:
        refuse("the retained destination no longer matches the reclaim receipt: it is the only copy, do not modify it; manual review")
    return {"ok": True, "hashed_fresh": counts["hashed"], "identity_unchanged": ident(drecs) == rec["dest_identity"]}


def main(argv=None, env=None):
    env = env or Env()
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("phase", choices=["status", "verify", "reclaim", "check-retained"])
    ap.add_argument("--config", required=True); ap.add_argument("--subtree"); ap.add_argument("--result"); ap.add_argument("--reclaim-retired")
    a = ap.parse_args(argv)
    try:
        if env.production and env.euid() == 0:
            refuse("run as the owner, never root (root only runs r8's frozen read-only scanner)")
        rc, c8 = load_config(a.config, env)
        if env.euid() != c8["owner_uid"] and env.production:
            refuse("run as the owner")
        j8 = ST.open_journal(c8, env, create=False)
        if not os.path.isdir(c8["journal_dir"]):
            refuse("no r8 journal")
        if a.phase == "status":
            out = phase_status(c8, rc, env, j8, open_rj(rc, c8, env, create=False))
        else:
            rel = ST.pick(c8, a.subtree)
            gates(c8, rc, env, rel)                                   # before the reclaim journal is created or written
            rj = open_rj(rc, c8, env, create=True)
            with j8.locked(), rj.locked():                           # no r8 phase (cutover/rollback/copy) can run meanwhile
                out = {"verify": lambda: phase_verify(c8, rc, env, j8, rj, rel),
                       "reclaim": lambda: phase_reclaim(c8, rc, env, j8, rj, rel, a.result, a.reclaim_retired),
                       "check-retained": lambda: phase_check_retained(c8, rc, env, j8, rj, rel)}[a.phase]()
        print(json.dumps(out, indent=1, sort_keys=True, default=str))
        return 0
    except Refuse as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
