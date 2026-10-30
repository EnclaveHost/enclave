#!/usr/bin/env python3
"""nvme-cold-reclaim-stage/r4 reclaim.py (r3 adapted to the FROZEN r10 scanner API: pins, format .../r10, top inode binding;
r3 = r2 + the frozen r9 API + the never-renamed top): one-time, UNPRIVILEGED reclamation of EXACTLY the three /vm
originals renamed by the r10 cut-over to
  /vm/enclave-volumes/codex-archive/2026-10-24/home/.retire-{hf-convert,gvs5h,gguf-e2b}
after their content lives, verified, at /home/steven/.cold-archive/codex-archive/2026-10-24/home/<name> (ext4, cryptroot).

Frozen r10 (subtree.py 90cd8968, relocate.py 2a037dae, jobs/root-writer-check.sh 7bcd4fbf; SHA256SUMS 2342e677) is reused in
place by sha-pinned compile+exec: its bounded no-follow reads, config/journal/path helpers, result format, key set and tool
shas. Its journal is read and flock'ed, never written. Only r10 dev+inode root scans (stdout of the reviewed r10 staged wrapper,
redirected by the owner) are accepted; this tool never runs a scanner and never runs as root.

Why visibility blocks: writes through an fd on a retired file after the copy live only in that inode and are LOST when its last
fd closes after unlink. Any incomplete or truncated scan, any user of THIS subtree's retired or destination inodes (or a path-only
hit under its paths), any alias of it and any filesystem-wide watcher block this subtree; other subtrees' users do not.

Phases (owner; all but status inside root's queue lane with the 16 GiB floor; / must stay >= its 300 GB floor):
  status          read-only
  verify          cut-over complete and consistent; original path = the symlink to the destination; pinned single source
                  mount, no nested mounts, devices; .retire identity == verified source identity (child ctimes included; the top's
                  rename ctime is excluded by the r5 walk); destination unchanged since cut-over and EVERY byte re-hashed now ==
                  verified logical + manifest; receipt with the exact plan and its bindings
  reclaim         --result SCAN_A --reclaim-retired <exact path>: r10 scan after the receipt, <= writer_check_max_age_seconds,
                  single use, complete, zero users/aliases/watchers for this subtree, bound to this tree (entries/dev/majmin/top ino);
                  the tree must still equal the plan; inner entries: identity check -> rename to .reclaim-r4-<i> (same directory,
                  so a deleted inode's /proc path keeps the .retire prefix r10 matches) -> O_PATH re-check -> unlink/rmdir ->
                  nlink 0; the TOP is never renamed: fd dev/ino check, empty, rmdir. Ends "deleted-unconfirmed" (never green)
  confirm         --result SCAN_B after the deletion: the same gates, .retire absent (ENOENT here AND in the scan), destination
                  identity == receipt, and a FRESH FULL re-hash of the retained copy == receipt -> "complete"
                  (else "post-check-failed")
  check-retained  later re-hash of the retained copy against the receipt
No recursive rm, no wildcards, nothing outside the plan; the destination, the manifest and the home links are only read.
"""
import argparse, hashlib, json, os, stat, sys

HERE = os.path.dirname(os.path.abspath(__file__))
R10_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "nvme-cold-relocation-stage", "r10"))
R10_SUMS_SHA256 = "2342e677be1e000df07928238b74fe9e0688cd69ffa6bab0c79d0250ac094991"
R10_SUBTREE_SHA256 = "90cd8968b9f7c8446faf53aed3f51a0e39339ef17ede647e6ac7ff962ee955a3"
R5_RELOCATE_SHA256 = "2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0"
R10_JOB_SHA256 = "7bcd4fbff544b059e5ca882e5e97a6d4a989a3065abaad516f340e10ef19b635"
R10_TOOLS = {"subtree.py": R10_SUBTREE_SHA256, "relocate.py": R5_RELOCATE_SHA256, "jobs/root-writer-check.sh": R10_JOB_SHA256}
R10_FORMAT = "nvme-cold-subtree-writer-check/r10"
R10_KEYS = ["format", "t", "tEnd", "euid", "tools", "prefixes", "targets", "hits", "hitsTotal", "aliases", "destAliases",
           "nsCopies", "fsWatchers", "incomplete", "entries", "complete", "scan", "limitations"]


def _load_r10():
    import types
    p = os.path.join(R10_DIR, "subtree.py")
    with open(p, "rb") as f:
        b = f.read()
    if hashlib.sha256(b).hexdigest() != R10_SUBTREE_SHA256:
        raise SystemExit("nvme-cold-relocation-stage/r10/subtree.py is not the frozen r10 bytes")
    m = types.ModuleType("subtree_r10"); m.__file__ = p
    exec(compile(b, p, "exec", dont_inherit=True), m.__dict__)
    if m.WC_FORMAT != R10_FORMAT or list(m.WC_KEYS) != R10_KEYS or tuple(m.TOOLS) != tuple(R10_TOOLS):
        raise SystemExit("frozen r10 result API differs from the one this tool was reviewed against")
    return m


ST = _load_r10()
R = ST.R
Refuse, refuse = R.Refuse, R.refuse
FORMAT, JMODE, RECEIPT = "nvme-cold-reclaim-config/r4", "reclaim-r4", "nvme-cold-reclaim-receipt/r4"
MAX_VERIFY_AGE = 6 * 3600
MAX_PLAN_ENTRIES = 100000
TMP = ".reclaim-r4-"
PROD = {"journal_dir": "/home/steven/.local/state/nvme-cold-reclaim-r4", "subtree_journal_dir": "/home/steven/.local/state/nvme-cold-subtree-r7",
        "owner_uid": 1000}
DIRF = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
PATHF = getattr(os, "O_PATH", os.O_RDONLY | os.O_NONBLOCK) | os.O_NOFOLLOW | os.O_CLOEXEC


class Env(ST.Env):
    def check_mount(self, pin, path):
        R.check_mount(pin, self, path)

    def mounts(self):
        return R.parse_mountinfo(R.read_text(self.mountinfo))


def sha_bytes(b):
    return hashlib.sha256(b).hexdigest()


def absent(p):
    """True only for ENOENT; any other error (EACCES, EIO, ...) is never read as absence"""
    try:
        os.lstat(p)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return False


def absent_at(fd, n):
    try:
        os.stat(n, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return True
    return False


# ------------------------------------------------------------------------------------------------------------- config
def load_config(path, env):
    st, raw = ST.read_bounded(path, ST.CONFIG_MAX, "reclaim config")
    rc = ST.parse_json(raw, "reclaim config")
    R._keys(rc, ["format", "subtree_config", "subtree_config_sha256", "journal_dir", "verify_max_age_seconds"], "top level")
    if rc["format"] != FORMAT:
        refuse("config format")
    R._abs(rc["subtree_config"], "subtree_config"); R._abs(rc["journal_dir"], "journal_dir")
    R._int(rc["verify_max_age_seconds"], "verify_max_age_seconds")
    if rc["verify_max_age_seconds"] > MAX_VERIFY_AGE:
        refuse(f"verify_max_age_seconds must be <= {MAX_VERIFY_AGE}")
    if sha_bytes(ST.read_bounded(rc["subtree_config"], ST.CONFIG_MAX, "subtree config")[1]) != rc["subtree_config_sha256"]:
        refuse("the subtree config is not the pinned bytes (subtree_config_sha256)")
    c8 = ST.load_config(rc["subtree_config"], env)
    if st.st_uid not in (c8["owner_uid"], 0):
        refuse("config must be owned by the owner or root")
    jd = rc["journal_dir"]
    for k in (c8["archive_root"], c8["dest_root"], c8["journal_dir"], c8["inventory_1381"]["journal_dir"]):
        if R._under(jd, k) or R._under(k, jd):
            refuse("the reclaim journal must be disjoint from the archive, the destination and the subtree/1381 journals")
    if env.production and (jd != PROD["journal_dir"] or c8["journal_dir"] != PROD["subtree_journal_dir"] or c8["owner_uid"] != PROD["owner_uid"]):
        refuse("journal_dir / subtree journal_dir / owner_uid differ from the reviewed pins")
    rc["_sha"] = sha_bytes(raw)
    return rc, c8


def open_rj(rc, c8, env, create):
    j = R.Journal({"journal_dir": rc["journal_dir"], "owner_uid": c8["owner_uid"]}, env, create=create)
    if j.state.get("mode") not in (None, JMODE) or (j.state["trees"] and j.state.get("mode") != JMODE):
        refuse("not a reclaim-r4 journal")
    j.state["mode"] = JMODE
    return j


# ------------------------------------------------------------------------------------------------------------- checks
def ident(recs):
    return R.digest([[r["p"], r["id"], r.get("s"), r.get("mt"), r.get("l"), r["m"]] for r in recs])


def paths(c8, rel):
    return ST.src_of(c8, rel), ST.dest_of(c8, rel), ST.retire_of(c8, rel)


def gates(c8, rc, env, rel):
    ST.in_queue(c8, env)
    src, dst, ret = paths(c8, rel)
    env.check_mounts(c8)
    env.check_mount(c8["source_mount"], os.path.dirname(ret))
    env.check_mount(c8["dest_mount"], dst)
    env.check_mount(c8["dest_mount"], ST.existing_ancestor(rc["journal_dir"]))
    ms = env.mounts()
    vm = [m for m in ms if m["point"] == c8["source_mount"]["path"]]
    if len(vm) != 1 or vm[0]["root"] != "/":
        refuse("the source filesystem is not mounted exactly once at its pinned path")
    if [m for m in ms if m["majmin"] == vm[0]["majmin"]] != vm:
        refuse("the source filesystem is mounted more than once")
    nested = [m["point"] for m in ms if any(R._under(m["point"], p) for p in (src, dst, ret))]
    if nested:
        refuse(f"mount point inside the subtree, its retired original or its destination: {nested[:3]}")
    sdev, ddev = env.dev_of(c8["archive_root"]), env.dev_of(c8["dest_root"])
    if sdev == ddev or env.dev_of(os.path.dirname(ret)) != sdev or env.dev_of(dst) != ddev or env.dev_of(rc["journal_dir"]) != ddev:
        refuse("devices: the retired tree must be on the source filesystem; destination and reclaim journal on /, not the source")
    dv = env.statvfs(ST.existing_ancestor(c8["dest_root"]))
    if dv.f_bavail * dv.f_frsize < c8["dest_floor_bytes"]:
        refuse(f"/ is below its {c8['dest_floor_bytes']} B floor: not starting")


def cut_tree(j8, rel):
    ts = j8.state["trees"].get(rel, {})
    if ts.get("cutover") != "complete":
        refuse(f"cut-over of {rel} is not complete ({ts.get('cutover')!r}): nothing to reclaim (rollback is still the recovery)")
    v, inv = ts.get("verified") or {}, ts.get("source_inventory") or {}
    if not v or v.get("source_identity") != inv.get("identity") or v.get("logical") != inv.get("logical") or not ts.get("dest_identity_at_cutover"):
        refuse("the subtree journal is inconsistent for this subtree (verified/inventory/cut-over identities): manual review")
    return ts


def bindings(c8, rc, j8, ts, rel):
    n = ST.name_of(rel)
    return {"subtree_journal_entry": R.digest(ts), "source_meta": sha_bytes(R.read_bytes(j8.path(f"source-{n}.meta.json"))),
            "source_logical": sha_bytes(R.read_bytes(j8.path(f"source-{n}.logical.json"))),
            "subtree_config": rc["subtree_config_sha256"], "reclaim_config": rc["_sha"]}


def check_link(c8, rel):
    src, dst, _ = paths(c8, rel)
    R.no_symlink_components(os.path.dirname(src))
    if not os.path.islink(src) or os.readlink(src) != dst or os.path.realpath(src) != dst:
        refuse(f"{src} is not the cut-over symlink to {dst}")
    R.no_symlink_components(dst); ST.private_dest(c8)
    st = os.lstat(dst)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != c8["owner_uid"]:
        refuse(f"{dst} is not the owner's directory")


def check_plan(c8, recs):
    if len(recs) > MAX_PLAN_ENTRIES:
        refuse("more entries than this one-time tool reclaims")
    for r in recs:
        if r["t"] not in ("f", "d"):
            refuse(f"{r['p'] or '.'}: only regular files and directories are reclaimed (symlink found)")
        if r["u"] != c8["owner_uid"]:
            refuse(f"{r['p'] or '.'}: not owned by uid {c8['owner_uid']}")
        if r["t"] == "f" and (r.get("nl") != 1 or "h" in r):
            refuse(f"{r['p']}: hardlinked files are not reclaimed")
        if os.path.basename(r["p"]).startswith(TMP):
            refuse(f"{r['p']}: a name in the tool's own namespace ({TMP}*)")


def fresh_dest(rj, rel, dst, run):
    cache = rj.path(f"dest-{ST.name_of(rel)}-{run}.hashcache.tsv")
    if not absent(cache):
        refuse("hash cache path exists: refusing to reuse any hash")
    recs = R.walk_meta(dst)
    hashes, counts = R.hash_files(dst, recs, cache, rj)
    if counts["reused"] or counts["hashed"] != len([r for r in recs if r["t"] == "f"]):
        refuse("not every destination file was freshly hashed")
    if R.walk_meta(dst) != recs:
        refuse("the destination changed while it was hashed")
    return recs, R.logical(recs, hashes), counts


# ------------------------------------------------------------------------------------------------------------- r10 scan
def _target(res, cls, rel):
    ts = [t for t in res["targets"] if isinstance(t, dict) and t.get("class") == cls and t.get("subtree") == rel]
    if len(ts) != 1:
        refuse(f"the root scan has no single {cls} target for {rel}")
    return ts[0]


def bound(t, top, entries):
    """r4: the scan walked exactly this tree: its top (dev, ino) (r10 `ino`), the filesystem and the entry count"""
    dev, ino = top
    return t.get("state") == "dir" and t.get("dev") == dev and t.get("ino") == ino and t.get("majmin") == f"{os.major(dev)}:{os.minor(dev)}" \
        and t.get("entries") == entries


def accept_scan(c8, env, rj, rs, rel, result_path, after_t, which):
    """a frozen-r10 root scan: authentic format/keys/tools, complete, fresh, after `after_t`, single use, zero users/aliases/
    watchers of THIS subtree (retired and destination by inode; path-only under its paths, incl. deleted inodes, A7)"""
    if not result_path:
        refuse("--result FILE (stdout of the reviewed r10 staged root wrapper, redirected by the owner) is required")
    _, raw = ST.read_bounded(result_path, ST.RESULT_MAX, "r10 scan result", {c8["owner_uid"]})
    res = ST.parse_json(raw, "r10 scan result")
    if not isinstance(res, dict) or res.get("format") != R10_FORMAT:
        refuse("not an r10 dev+inode root scan (r8 path-string scans are not accepted)")
    R._keys(res, R10_KEYS, "r10 scan result")
    if res["euid"] != 0 or res["tools"] != R10_TOOLS or res["tools"] != ST.tool_shas():
        refuse("not a root scan by the frozen r10 tool bytes")
    if not all(isinstance(res[k], list) for k in ("targets", "hits", "aliases", "destAliases", "fsWatchers", "incomplete", "prefixes")) \
            or not isinstance(res["hitsTotal"], int) or not isinstance(res["t"], (int, float)) or not isinstance(res["tEnd"], (int, float)):
        refuse("malformed r10 scan result")
    if res["complete"] is not True or res["incomplete"]:
        refuse(f"the root scan was incomplete ({len(res['incomplete'])} problems): missed visibility can lose writes; not proof")
    now = env.now()
    if not (after_t < res["t"] <= res["tEnd"] <= now + 1) or now - res["t"] > c8["writer_check_max_age_seconds"]:
        refuse(f"the root scan is stale, inconsistent, from the future, or not taken after the {which}: take a fresh one")
    if res["t"] <= max([s["t"] for s in rs.get("scans", [])] or [0]):
        refuse("this root scan was already used: take a fresh one")
    src, dst, ret = paths(c8, rel)
    if not all(p in res["prefixes"] for p in (src, dst, ret)):
        refuse("the root scan's prefixes do not cover this subtree")
    if res["hitsTotal"] != len(res["hits"]):
        refuse(f"the root scan truncated its hits ({res['hitsTotal']} > {len(res['hits'])}): users cannot be attributed")
    mine = [h for h in res["hits"] if not isinstance(h, dict) or h.get("subtree") == rel or
            any(R._under(str(h.get("target", "")).split(" (deleted)")[0], p) for p in (src, dst, ret))]
    if mine:
        refuse(f"users of {rel} (retired or destination inodes, or its paths; writes could be lost): {mine[:3]}"
               + (" - after a deletion: copy the data out via /proc/<pid>/fd/<n> before that process closes it" if which == "deletion" else ""))
    al = [a for a in res["aliases"] + res["destAliases"] if not isinstance(a, dict) or a.get("subtree") in (rel, None)]
    if al:
        refuse(f"{rel} is exposed at another path (mount alias): {al[:2]}")
    if res["fsWatchers"]:
        refuse(f"filesystem/mount-wide watchers on the source/destination device ({len(res['fsWatchers'])}): not attributable per tree")
    s = _target(res, "source", rel)
    if s.get("state") != "symlink" or s.get("target") != dst:
        refuse("the root scan does not see the original path as the cut-over symlink")
    name = f"scan-{ST.name_of(rel)}-{which.replace(' ', '-')}-{int(res['t'] * 1000)}.json"
    rj.write_atomic(name, raw.decode())
    return res, {"t": res["t"], "tEnd": res["tEnd"], "file": name, "sha256": sha_bytes(raw), "phase": which,
                 "otherHits": len(res["hits"]), "nsCopies": res["nsCopies"], "scan": res["scan"]}


# ------------------------------------------------------------------------------------------------------------- deletion
def _same(st, r, uid, ctime):
    if r["t"] == "f":
        ok = (stat.S_ISREG(st.st_mode) and st.st_size == r["s"] and st.st_mtime_ns == r["mt"] and st.st_nlink == 1
              and (not ctime or st.st_ctime_ns == r["id"][2]))
    else:
        ok = stat.S_ISDIR(st.st_mode)
    return ok and [st.st_dev, st.st_ino] == r["id"][:2] and stat.S_IMODE(st.st_mode) == r["m"] and st.st_uid == uid == r["u"]


def make_plan(recs):
    return {"recs": recs, "by": {r["p"]: r for r in recs}, "idx": {r["p"]: i for i, r in enumerate(recs)}}


def _entries(fd, rel, plan):
    """present names of one directory -> {name: (record, renamed_by_us)}; unknown names refuse"""
    out, seen = {}, set()
    for n in os.listdir(fd):
        k = n[len(TMP):]
        if n.startswith(TMP) and k.isdigit() and 0 < int(k) < len(plan["recs"]) and os.path.dirname(plan["recs"][int(k)]["p"]) == rel:
            r, moved = plan["recs"][int(k)], True
        elif (f"{rel}/{n}" if rel else n) in plan["by"]:
            r, moved = plan["by"][f"{rel}/{n}" if rel else n], False
        else:
            refuse(f"unrecognized entry in {rel or '.'}: {n!r} (never deleted: manual review)")
        if r["p"] in seen:
            refuse(f"{r['p']} is present twice (original and tool name): manual review")
        seen.add(r["p"]); out[n] = (r, moved)
    return out


def _walk(fd, rel, plan, uid, rj, sub, delete, tally):
    """pass 1 (delete=False) validates and returns the present count; pass 2 re-checks and removes, children first"""
    n_present = 0
    for n, (r, moved) in sorted(_entries(fd, rel, plan).items()):
        n_present += 1
        st = os.stat(n, dir_fd=fd, follow_symlinks=False)
        if not _same(st, r, uid, ctime=not moved):          # planned name: exact incl. ctime; our tool name: no ctime (rename)
            refuse(f"{r['p']}: differs from the verified plan")
        if r["t"] == "d":
            cfd = os.open(n, DIRF, dir_fd=fd)
            try:
                if not _same(os.fstat(cfd), r, uid, False):
                    refuse(f"{r['p']}: directory differs from the plan")
                n_present += _walk(cfd, r["p"], plan, uid, rj, sub, delete, tally)
            finally:
                os.close(cfd)
        if delete:
            _remove(fd, n, r, plan["idx"][r["p"]], uid, rj, sub, tally)
    return n_present


def _remove(fd, n, r, i, uid, rj, sub, tally):
    """rename to the tool name in the SAME directory (atomic; a deleted inode's path keeps the .retire prefix), re-check THAT
    inode through an O_PATH fd, then unlink/rmdir it"""
    tmp = f"{TMP}{i}"
    if n != tmp:
        if not absent_at(fd, tmp):
            refuse(f"{r['p']}: the tool name {tmp} is already taken: manual review")
        os.rename(n, tmp, src_dir_fd=fd, dst_dir_fd=fd)
        rj.event(phase="reclaim", subtree=sub, renamed=r["p"], to=tmp, ino=r["id"][1])
    pfd = os.open(tmp, PATHF, dir_fd=fd)
    try:
        if not _same(os.fstat(pfd), r, uid, False):           # our rename changed ctime: compared without it
            if n != tmp and absent_at(fd, n):
                os.rename(tmp, n, src_dir_fd=fd, dst_dir_fd=fd)
            refuse(f"{r['p']}: the inode under the tool name is not the planned one (replaced during the check?): never deleted")
        if r["t"] == "f":
            os.unlink(tmp, dir_fd=fd)
            if os.fstat(pfd).st_nlink != 0:
                refuse(f"{r['p']}: the removed name's inode is still linked: manual review")
            tally["files"] += 1; tally["bytes"] += r["s"]
            rj.event(phase="reclaim", subtree=sub, unlink=r["p"], ino=r["id"][1], bytes=r["s"])
        else:
            os.rmdir(tmp, dir_fd=fd)
            tally["dirs"] += 1; rj.event(phase="reclaim", subtree=sub, rmdir=r["p"], ino=r["id"][1])
    finally:
        os.close(pfd)


def delete_planned(c8, rj, rs, rel, ret, plan, bind):
    uid, top_r = c8["owner_uid"], plan["by"][""]
    parent, name = os.path.dirname(ret), os.path.basename(ret)
    tally = {"files": 0, "dirs": 0, "bytes": 0}
    R.no_symlink_components(parent)
    pfd = os.open(parent, DIRF)
    try:
        if os.fstat(pfd).st_dev != top_r["id"][0]:
            refuse("the retired tree's parent is not on the planned filesystem")
        if absent_at(pfd, name):
            refuse(f"{ret} vanished while reclaim was {rs['reclaim']!r}: manual review")
        tfd = os.open(name, DIRF, dir_fd=pfd)
        try:
            if not _same(os.fstat(tfd), top_r, uid, False):
                refuse(f"{ret} is not the planned directory (replaced, or a symlink)")
            bind(1 + _walk(tfd, "", plan, uid, rj, rel, False, tally))    # pass 1 + the scan walked exactly this remaining tree
            if rs["reclaim"] == "deleting":
                _walk(tfd, "", plan, uid, rj, rel, True, tally)          # pass 2
                rs["reclaim"] = "rmdir-top"; rj.event(phase="reclaim", subtree=rel, step="rmdir-top-intent"); rj.save()
            left = os.listdir(tfd)
            if left:
                refuse(f"unrecognized entries left in {ret}: {sorted(left)[:5]} (never deleted: manual review)")
            st = os.stat(name, dir_fd=pfd, follow_symlinks=False)     # the name still refers to the fd's inode
            if [st.st_dev, st.st_ino] != [os.fstat(tfd).st_dev, os.fstat(tfd).st_ino]:
                refuse(f"{ret} was replaced: never deleted")
        finally:
            os.close(tfd)
        os.rmdir(name, dir_fd=pfd)                                   # NOT renamed first (D1): holders' paths keep the prefix
        tally["dirs"] += 1; rj.event(phase="reclaim", subtree=rel, rmdir=".", ino=top_r["id"][1])
    finally:
        os.close(pfd)
    return tally


# ------------------------------------------------------------------------------------------------------------- phases
def phase_status(c8, rc, env, j8, rj):
    out = {}
    for rel in c8["subtrees"]:
        src, dst, ret = paths(c8, rel)
        ts, rs = j8.state["trees"].get(rel, {}), rj.state["trees"].get(rel, {})
        out[rel] = {"copy": ts.get("copy"), "cutover": ts.get("cutover"), "retired_absent": absent(ret),
                    "original_is_symlink": os.path.islink(src), "reclaim": rs.get("reclaim"), "verified_t": (rs.get("verified") or {}).get("t")}
    return out


def phase_verify(c8, rc, env, j8, rj, rel):
    rs = rj.tree(rel)
    if rs.get("reclaim"):
        refuse(f"reclaim already {rs['reclaim']!r}: verify is only possible before any deletion")
    ts = cut_tree(j8, rel); check_link(c8, rel)
    src, dst, ret = paths(c8, rel)
    R.no_symlink_components(os.path.dirname(ret))
    st = os.lstat(ret)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != c8["owner_uid"]:
        refuse(f"{ret} is not the owner's real directory")
    plan = R.walk_meta(ret)
    if ident(plan) != ts["verified"]["source_identity"]:
        refuse(f"{ret} is not the tree that was verified (identity incl. ctimes differs: written after the cut-over?): manual review")
    check_plan(c8, plan)
    if stat.S_IMODE(os.lstat(dst).st_mode) != stat.S_IMODE(st.st_mode):
        refuse("destination top-level mode differs from the original's")
    if R.identity_now(dst) != ts["dest_identity_at_cutover"]:
        refuse("the destination changed since cut-over")
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
    lname = f"dest-{ST.name_of(rel)}-{run}.logical.json"; ltext = json.dumps(dlog)
    rj.write_atomic(lname, ltext)
    receipt = {"format": RECEIPT, "subtree": rel, "t": env.now(), "retired": ret, "destination": dst, "original_symlink": src,
               "retired_identity": ident(plan), "dest_identity": ident(drecs), "dest_entries": len(drecs), "dest_dev": drecs[0]["id"][0], "dest_top": drecs[0]["id"][:2],
               "dest_logical": R.digest(dlog), "dest_logical_file": lname, "dest_logical_sha256": sha_bytes(ltext.encode()),
               "hashed_fresh": counts["hashed"], "plan_files": len([r for r in plan if r["t"] == "f"]),
               "plan_dirs": len([r for r in plan if r["t"] == "d"]), "plan_bytes": sum(r["s"] for r in plan if r["t"] == "f"),
               "manifest_links": links, "bind": bindings(c8, rc, j8, ts, rel), "plan": plan}
    text = json.dumps(receipt, sort_keys=True)
    rj.write_atomic(f"verify-{ST.name_of(rel)}.json", text)
    rs.clear(); rs["verified"] = {"t": receipt["t"], "receipt_sha256": sha_bytes(text.encode()), "dest_identity": receipt["dest_identity"]}
    rj.event(phase="verify", subtree=rel, hashed=counts["hashed"], plan_entries=len(plan)); rj.save()
    return {k: v for k, v in receipt.items() if k != "plan"}


def load_receipt(c8, rc, j8, rj, rs, rel):
    text = R.read_text(rj.path(f"verify-{ST.name_of(rel)}.json"))
    if sha_bytes(text.encode()) != rs["verified"]["receipt_sha256"]:
        refuse("the verify receipt differs from the one recorded: verify again")
    rec = json.loads(text)
    if rec["bind"] != bindings(c8, rc, j8, j8.state["trees"][rel], rel):
        refuse("the subtree journal entry, its inventory files or a config changed since the verify receipt: verify again")
    if sha_bytes(R.read_bytes(rj.path(rec["dest_logical_file"]))) != rec["dest_logical_sha256"]:
        refuse("the retained destination's logical file changed")
    return rec


def common(c8, rc, j8, rj, rs, rel):
    if "verified" not in rs:
        refuse("verify first")
    cut_tree(j8, rel); check_link(c8, rel)
    rec = load_receipt(c8, rc, j8, rj, rs, rel)
    _, dst, _ = paths(c8, rel)
    if R.identity_now(dst) != rec["dest_identity"]:
        return rec, False
    ST.check_links(c8, rel, dst)
    return rec, True


def phase_reclaim(c8, rc, env, j8, rj, rel, result_path, confirm):
    src, dst, ret = paths(c8, rel)
    if confirm != ret:
        refuse(f"--reclaim-retired must name exactly {ret}")
    rs = rj.tree(rel); state = rs.get("reclaim")
    if state in ("deleted-unconfirmed", "complete", "post-check-failed"):
        refuse(f"deletion already finished ({state}): use confirm / manual review")
    rec, dest_ok = common(c8, rc, j8, rj, rs, rel)
    if not dest_ok:
        refuse("the destination changed since the verify receipt: not reclaiming (users of the retained copy?)")
    res, scan = accept_scan(c8, env, rj, rs, rel, result_path, rs["verified"]["t"], "verify receipt")
    if not bound(_target(res, "dest", rel), rec["dest_top"], rec["dest_entries"]):
        refuse("the root scan's destination walk does not match this tree (state/dev/ino/majmin/entries): take a fresh scan")
    rt, top = _target(res, "retire", rel), rec["plan"][0]["id"][:2]
    if state is None:
        if env.now() - rs["verified"]["t"] > rc["verify_max_age_seconds"]:
            refuse("the verify receipt is too old: verify again")
        recs = R.walk_meta(ret)
        if ident(recs) != rec["retired_identity"] or recs != rec["plan"]:
            refuse(f"{ret} changed since the verify receipt (a late writer?): verify again (nothing deleted)")
        if not bound(rt, top, len(rec["plan"])):
            refuse("the root scan's retired walk does not match this tree (state/dev/ino/majmin/entries): take a fresh scan")
        rs["reclaim"] = "deleting"; rs["started_t"] = env.now()
        rj.event(phase="reclaim", subtree=rel, step="intent", receipt_sha256=rs["verified"]["receipt_sha256"])
    elif state not in ("deleting", "rmdir-top"):
        refuse(f"unknown reclaim state {state!r}: manual review")
    rs.setdefault("scans", []).append(scan); rj.save()

    def bind(count):
        if not bound(rt, top, count):
            refuse("the root scan's retired walk does not match the remaining tree: take a fresh scan")
    sv = env.statvfs(c8["archive_root"]); rs.setdefault("source_free_before", sv.f_bavail * sv.f_frsize)
    try:
        tally = delete_planned(c8, rj, rs, rel, ret, make_plan(rec["plan"]), bind)
    except OSError as e:
        rj.event(phase="reclaim", subtree=rel, error=str(e)); rj.save()
        refuse(f"reclaim interrupted ({e}): state {rs['reclaim']!r}; re-run with a FRESH root scan to resume (every entry re-checked)")
    rs["reclaim"] = "deleted-unconfirmed"; rs["deleted_t"] = env.now()
    rj.event(phase="reclaim", subtree=rel, step="deleted-unconfirmed", **tally); rj.save()
    return {"state": "deleted-unconfirmed", "this_run": tally,
            "next": "take a FRESH r10 root scan now, then: confirm --result SCAN_B (only confirm can mark this subtree complete)"}


def phase_confirm(c8, rc, env, j8, rj, rel, result_path):
    src, dst, ret = paths(c8, rel)
    rs = rj.tree(rel)
    if rs.get("reclaim") == "complete":
        return {"already": "complete"}
    if rs.get("reclaim") != "deleted-unconfirmed":
        refuse(f"nothing to confirm (state {rs.get('reclaim')!r})")
    rec, dest_ok = common(c8, rc, j8, rj, rs, rel)
    res, scan = accept_scan(c8, env, rj, rs, rel, result_path, rs["deleted_t"], "deletion")
    if not absent(ret) or _target(res, "retire", rel).get("state") != "absent":
        refuse(f"cannot prove {ret} is gone (only ENOENT, seen both by this tool and by the root scan, counts): state unchanged")
    rs.setdefault("scans", []).append(scan)
    post = {"dest_identity_unchanged": dest_ok, "scan_dest_bound": bound(_target(res, "dest", rel), rec["dest_top"], rec["dest_entries"])}
    hashed = 0
    if dest_ok:                                                       # the retained copy, re-hashed in full NOW
        drecs, dlog, counts = fresh_dest(rj, rel, dst, f"{int(env.now() * 1000)}-{os.getpid()}-confirm")
        post["retained_copy_rehash_equal"] = R.digest(dlog) == rec["dest_logical"] and ident(drecs) == rec["dest_identity"]
        hashed = counts["hashed"]
    else:
        post["retained_copy_rehash_equal"] = False
    ev = [json.loads(l) for l in R.read_text(rj.path("events.jsonl")).splitlines() if l.strip()]
    ev = [e for e in ev if e.get("subtree") == rel and e.get("phase") == "reclaim"]
    jr = {"files": sum(1 for e in ev if "unlink" in e), "dirs": sum(1 for e in ev if "rmdir" in e), "bytes": sum(e.get("bytes", 0) for e in ev if "unlink" in e)}
    post["journal_balances"] = jr["files"] <= rec["plan_files"] and jr["dirs"] <= rec["plan_dirs"]
    sv = env.statvfs(c8["archive_root"])
    green = all(post.values())
    rs["reclaim"] = "complete" if green else "post-check-failed"; rs["confirmed_t"] = env.now()
    out = {"format": RECEIPT, "subtree": rel, "state": rs["reclaim"], "reclaimed": ret, "retained": dst, "post_checks": post,
           "hashed_fresh": hashed, "deleted_journalled": jr, "plan": {"files": rec["plan_files"], "dirs": rec["plan_dirs"], "bytes": rec["plan_bytes"]},
           "source_free_before": rs.get("source_free_before"), "source_free_after": sv.f_bavail * sv.f_frsize,
           "dest_identity": rec["dest_identity"], "dest_logical": rec["dest_logical"], "dest_logical_file": rec["dest_logical_file"],
           "verify_receipt_sha256": rs["verified"]["receipt_sha256"], "scans": rs["scans"], "t": env.now(),
           "recovery": "the retained destination is the copy; check-retained re-hashes it against dest_logical_file; a move back to /vm "
                       "is a separately reviewed reverse copy (rollback is no longer possible)"}
    rj.write_atomic(f"reclaimed-{ST.name_of(rel)}.json", json.dumps(out, sort_keys=True))
    rj.event(phase="confirm", subtree=rel, state=rs["reclaim"], post=post); rj.save()
    if not green:
        refuse(f"post-checks failed, NOT complete: {post}: manual review (the destination is the only copy; do not modify it)")
    return out


def phase_check_retained(c8, rc, env, j8, rj, rel):
    rs = rj.tree(rel)
    if rs.get("reclaim") not in ("complete", "post-check-failed", "deleted-unconfirmed"):
        refuse("check-retained is for reclaimed subtrees")
    check_link(c8, rel)
    _, dst, _ = paths(c8, rel)
    rec = load_receipt(c8, rc, j8, rj, rs, rel)
    drecs, dlog, counts = fresh_dest(rj, rel, dst, f"{int(env.now() * 1000)}-{os.getpid()}")
    ok = R.digest(dlog) == rec["dest_logical"]
    rj.event(phase="check-retained", subtree=rel, ok=ok, identity_unchanged=ident(drecs) == rec["dest_identity"]); rj.save()
    if not ok:
        refuse("the retained destination no longer matches the receipt: it is the only copy, do not modify it; manual review")
    return {"ok": True, "hashed_fresh": counts["hashed"], "identity_unchanged": ident(drecs) == rec["dest_identity"]}


def main(argv=None, env=None):
    env = env or Env()
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("phase", choices=["status", "verify", "reclaim", "confirm", "check-retained"])
    ap.add_argument("--config", required=True); ap.add_argument("--subtree"); ap.add_argument("--result"); ap.add_argument("--reclaim-retired")
    a = ap.parse_args(argv)
    try:
        if env.production and env.euid() == 0:
            refuse("run as the owner, never root (root only runs the reviewed r10 read-only scanner)")
        rc, c8 = load_config(a.config, env)
        if env.production and env.euid() != c8["owner_uid"]:
            refuse("run as the owner")
        j8 = ST.open_journal(c8, env, create=False)
        if not os.path.isdir(c8["journal_dir"]):
            refuse("no subtree journal")
        if a.phase == "status":
            out = phase_status(c8, rc, env, j8, open_rj(rc, c8, env, create=False))
        else:
            rel = ST.pick(c8, a.subtree)
            gates(c8, rc, env, rel)
            rj = open_rj(rc, c8, env, create=True)
            with j8.locked(), rj.locked():
                out = {"verify": lambda: phase_verify(c8, rc, env, j8, rj, rel),
                       "reclaim": lambda: phase_reclaim(c8, rc, env, j8, rj, rel, a.result, a.reclaim_retired),
                       "confirm": lambda: phase_confirm(c8, rc, env, j8, rj, rel, a.result),
                       "check-retained": lambda: phase_check_retained(c8, rc, env, j8, rj, rel)}[a.phase]()
        print(json.dumps(out, indent=1, sort_keys=True, default=str))
        return 0
    except Refuse as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
