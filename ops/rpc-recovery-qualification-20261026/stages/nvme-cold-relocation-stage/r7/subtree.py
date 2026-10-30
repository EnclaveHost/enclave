#!/usr/bin/env python3
"""nvme-cold-relocation-stage/r7 subtree.py (r6 + root 1523 review: no guard JSON, low source free allowed, writes pinned to /): reversible relocation of EXACTLY three closed codex-archive subtrees
  2026-10-24/home/{hf-convert,gvs5h,gguf-e2b}  from /vm (ext4 on /dev/mapper/cryptvm)
  to /home/steven/.cold-archive/codex-archive/<same relative path>  on / (ext4 on /dev/mapper/cryptroot),
with a directory-symlink cut-over that keeps every original path (and the archive manifest's home links) resolving.

A NEW mode beside the unchanged USB-image tool: relocate.py here is byte-identical to frozen r5 (sha256 pinned below) and is
only imported for its reviewed primitives (walk_meta, hash_files, logical, digest, scan_proc, restore_dir_mtimes,
safe_rsync_argv, Journal, check_mount, required_bytes, identity_now). Stdlib only. Phases (owner, never root,
except writer-check):
  plan                read-only: pinned mounts, private destination, capacity (/ keeps >= dest_floor_bytes AFTER every remaining
                      copy), manifest links of each subtree resolve into /vm, informational /proc view, /vm free from statvfs
                      (INFORMATIONAL: this mode only reads /vm until cut-over, so a low /vm is not a reason to refuse relief)
  inventory-source    metadata walk; sha256 REUSED from root's 1381 archive inventory ONLY if that journal is provably 1381
                      (its meta/logical digests equal the pinned identity/logical) AND every record of the subtree (path, type,
                      mode, owner, xattrs, size, mtime, dev, inode, ctime, link target) is identical now; otherwise refuses
                      unless --fresh-hash (full re-hash of that subtree). No partial / generic stale-hash reuse.
  copy                inside root's queue lane only (cgroup memory.max == queue_lane_bytes; the queue's memory guard enforces
                      the 16 GiB host floor every 250 ms and kills the job tree, rsync included), MemAvailable >= 16 GiB at
                      start, ALL subtrees inventoried, source identity unchanged since inventory, / avail - EVERY remaining
                      copy >= dest_floor_bytes, destination + journal proven on the pinned / filesystem (never on /vm);
                      rsync -aHAX --numeric-ids --one-file-system --bwlimit (<= 200 MiB/s) into the 0700 tree.
                      r7: the stopped RPC VM's guard-status.json (no thresholds, stale free) is NOT read: this mode writes only
                      to / and does not relax the production VM prepare/controller/guard thresholds, which keep their own checks
  verify              fresh sha256 of the DESTINATION; source identity must still equal the inventoried one (so its hashes are
                      exact); logical source == destination; each manifest entry's sha256/bytes match the destination
  emit-writer-check / writer-check (ROOT, via the emitted sha-pinned script): complete /proc scan of all three subtrees,
                      their .retire-* and destinations; incomplete visibility is a failure
  cutover             fresh complete zero-hit writer-check, attestation, identities unchanged since verify; rename source ->
                      .retire-<name> (same directory), symlink source -> destination, post-checks (manifest links resolve
                      into the destination, top mode equal); any failure rolls back automatically
  rollback            remove only OUR symlink (readlink-checked) and rename .retire-<name> back; refuses if the destination
                      changed since cut-over (writes through the symlink)
There is NO deletion phase: /vm space is freed only by a SEPARATELY reviewed reclamation of the .retire-* trees.
"""
import argparse, contextlib, hashlib, importlib.util, json, os, stat, sys

HERE = os.path.dirname(os.path.abspath(__file__))
R5_RELOCATE_SHA256 = "2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0"


def _load_relocate():
    p = os.path.join(HERE, "relocate.py")
    with open(p, "rb") as f:
        if hashlib.sha256(f.read()).hexdigest() != R5_RELOCATE_SHA256:
            raise SystemExit("relocate.py beside subtree.py is not the frozen r5 bytes")
    spec = importlib.util.spec_from_file_location("relocate_r5", p); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


R = _load_relocate()
Refuse, refuse = R.Refuse, R.refuse
FORMAT, JMODE = "nvme-cold-subtree-config/v1", "subtree-r6"
GIB = 1 << 30
HOST_FLOOR = 16 * GIB
PROD = {"archive_root": "/vm/enclave-volumes/codex-archive",
        "subtrees": ["2026-10-24/home/hf-convert", "2026-10-24/home/gvs5h", "2026-10-24/home/gguf-e2b"],
        "dest_root": "/home/steven/.cold-archive/codex-archive",
        "source_mount": {"path": "/vm", "fstype": "ext4", "device": "/dev/mapper/cryptvm"},
        "dest_mount": {"path": "/", "fstype": "ext4", "device": "/dev/mapper/cryptroot"},
        "dest_floor_min_bytes": 300000000000, "bwlimit_max_kib": 204800,                  # 200 MiB/s
        "manifest": {"path": "/vm/enclave-volumes/codex-archive/2026-10-24/recovery-documents/artifact-relocation-manifest.json",
                     "sha256": "77b5cf1ce8e9f53a2333e4c6895b918b16a861b8a5e38908fa8cc15b19a8b493", "entries": 2102},
        "inventory_1381": {"identity": "d3f4775fc09ae7f0df6c6b2ce3d846cb439e737718fc8fe2125ba065cd27f4e2",
                           "logical": "fb369205b3b1962d4bd14eb46e829e51d1d1db0c5486c93ae50e5e215518d26e"}}


class Env(R.Env):
    meminfo = "/proc/meminfo"

    def check_mounts(self, cfg):
        R.check_mount(cfg["source_mount"], self, cfg["archive_root"])
        R.check_mount(cfg["dest_mount"], self, existing_ancestor(cfg["dest_root"]))
        R.check_mount(cfg["dest_mount"], self, existing_ancestor(cfg["journal_dir"]))     # r7: the journal is on / too

    def dev_of(self, p):
        return os.stat(existing_ancestor(p)).st_dev

    def cgroup_max(self):
        rel = [l for l in R.read_text("/proc/self/cgroup").splitlines() if l.startswith("0::")][0][3:]
        return R.read_text(f"/sys/fs/cgroup{rel}/memory.max").strip()

    def mem_available(self):
        for l in R.read_text(self.meminfo).splitlines():
            if l.startswith("MemAvailable:"):
                return int(l.split()[1]) * 1024
        refuse("MemAvailable unreadable (fail closed)")


# ------------------------------------------------------------------------------------------------------------- config
def load_config(path, env):
    if os.path.islink(path):
        refuse("config must not be a symlink")
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o022:
        refuse("config must be a regular file, not group/world-writable")
    cfg = R.read_json(path)
    R._keys(cfg, ["format", "owner_uid", "owner_gid", "archive_root", "subtrees", "dest_root", "source_mount", "dest_mount", "manifest",
                  "inventory_1381", "journal_dir", "rsync_path", "bwlimit_kib", "queue_lane_bytes", "dest_floor_bytes",
                  "writer_check_max_age_seconds"], "top level")
    if cfg["format"] != FORMAT:
        refuse("config format")
    R._int(cfg["owner_uid"], "owner_uid", 0); R._int(cfg["owner_gid"], "owner_gid", 0)
    if st.st_uid not in (cfg["owner_uid"], 0):
        refuse("config must be owned by the configured owner or root")
    for k in ("archive_root", "dest_root", "journal_dir", "rsync_path"):
        R._abs(cfg[k], k)
    if not isinstance(cfg["subtrees"], list) or not cfg["subtrees"] or len(set(cfg["subtrees"])) != len(cfg["subtrees"]):
        refuse("subtrees must be a non-empty list of distinct relative paths")
    for s in cfg["subtrees"]:
        if not isinstance(s, str) or s.startswith("/") or os.path.normpath(s) != s or ".." in s.split("/") or not s:
            refuse(f"subtree {s!r} must be a normalized relative path inside the archive")
    for a in cfg["subtrees"]:
        for b in cfg["subtrees"]:
            if a != b and R._under(a, b):
                refuse("subtrees must not nest")
    for m in ("source_mount", "dest_mount"):
        R._keys(cfg[m], ["path", "fstype", "device"], m); R._abs(cfg[m]["path"], m); R._abs(cfg[m]["device"], m + " device")
        if cfg[m]["fstype"] != "ext4":
            refuse(f"{m} must be ext4 (metadata-exact; ntfs3/USB is the r5 image mode, not this one)")
    R._keys(cfg["manifest"], ["path", "sha256", "entries"], "manifest"); R._int(cfg["manifest"]["entries"], "manifest entries")
    R._keys(cfg["inventory_1381"], ["journal_dir", "identity", "logical"], "inventory_1381"); R._abs(cfg["inventory_1381"]["journal_dir"], "1381 journal")
    R._int(cfg["bwlimit_kib"], "bwlimit_kib"); R._int(cfg["queue_lane_bytes"], "queue_lane_bytes")
    R._int(cfg["dest_floor_bytes"], "dest_floor_bytes"); R._int(cfg["writer_check_max_age_seconds"], "writer_check_max_age_seconds")
    if cfg["bwlimit_kib"] > PROD["bwlimit_max_kib"]:
        refuse(f"bwlimit_kib {cfg['bwlimit_kib']} > {PROD['bwlimit_max_kib']} (200 MiB/s maximum)")
    if env.production:
        for k in ("archive_root", "subtrees", "dest_root", "source_mount", "dest_mount", "manifest"):
            if cfg[k] != PROD[k]:
                refuse(f"{k} differs from the reviewed pin {PROD[k]!r}")
        if {k: cfg["inventory_1381"][k] for k in ("identity", "logical")} != PROD["inventory_1381"]:
            refuse("inventory_1381 identity/logical differ from root 1381's pinned output")
        if cfg["dest_floor_bytes"] < PROD["dest_floor_min_bytes"]:
            refuse("dest_floor_bytes must be >= 300000000000 (/ keeps its 300 GB operational floor)")
    if not R._under(cfg["archive_root"], cfg["source_mount"]["path"]) or R._under(cfg["dest_root"], cfg["archive_root"]) \
            or R._under(cfg["archive_root"], cfg["dest_root"]) or R._under(cfg["journal_dir"], cfg["archive_root"]) \
            or R._under(cfg["journal_dir"], cfg["dest_root"]):
        refuse("archive_root, dest_root and journal_dir must be disjoint (archive on source_mount)")
    if cfg["journal_dir"] == cfg["inventory_1381"]["journal_dir"]:
        refuse("the subtree journal must not be root's 1381 (r5) journal")
    return cfg


def existing_ancestor(p):
    while not os.path.lexists(p):
        p = os.path.dirname(p)
    return p


def name_of(rel):
    return os.path.basename(rel)


def src_of(cfg, rel):
    return cfg["archive_root"] + "/" + rel


def dest_of(cfg, rel):
    return cfg["dest_root"] + "/" + rel


def retire_of(cfg, rel):
    return os.path.dirname(src_of(cfg, rel)) + "/.retire-" + name_of(rel)


def pick(cfg, rel):
    if rel not in cfg["subtrees"]:
        refuse(f"unknown subtree {rel!r}; only {cfg['subtrees']}")
    return rel


def open_journal(cfg, env, create):
    j = R.Journal(cfg, env, create=create)
    mode = j.state.get("mode")
    if j.state["trees"] and mode != JMODE or mode not in (None, JMODE):
        refuse("this journal is not a subtree-r6 journal (never mix with the r5 image journal)")
    j.state["mode"] = JMODE
    return j


# ------------------------------------------------------------------------------------------------------------- checks
def private_dest(cfg, create=False):
    """dest_root's ancestors are real directories (no symlinks); <home>/.cold-archive and everything below it on the path to
    each destination parent is a 0700 directory owned by the owner. With create=True, missing ones are made 0700."""
    top = os.path.dirname(cfg["dest_root"])                 # /home/steven/.cold-archive
    R.no_symlink_components(existing_ancestor(top))
    chain = [top, cfg["dest_root"]]
    for rel in cfg["subtrees"]:
        parts = rel.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            chain.append(cfg["dest_root"] + "/" + "/".join(parts[:i]))
    for d in dict.fromkeys(chain):
        if not os.path.lexists(d):
            if not create:
                continue
            os.mkdir(d, 0o700)
        st = os.lstat(d)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != cfg["owner_uid"] or stat.S_IMODE(st.st_mode) != 0o700:
            refuse(f"{d} must be a 0700 directory owned by uid {cfg['owner_uid']} (private destination)")
    return True


def writes_on_dest(cfg, env):
    """r7: every path this mode writes before cut-over (destination tree, journal incl. hash caches, writer-check result, rsync
    temp files which rsync creates inside the destination directory) is on the destination filesystem, never on the source"""
    src_dev, dest_dev = env.dev_of(cfg["archive_root"]), env.dev_of(cfg["dest_root"])
    if dest_dev == src_dev:
        refuse("the destination is on the SOURCE filesystem: refused (relief must write only to /)")
    if env.dev_of(cfg["journal_dir"]) != dest_dev:
        refuse("the journal is not on the destination filesystem (journal/hash-cache writes must never land on /vm)")
    return dest_dev


def in_queue(cfg, env):
    if env.cgroup_max() != str(cfg["queue_lane_bytes"]):
        refuse(f"not inside root's queue lane (cgroup memory.max {env.cgroup_max()} != {cfg['queue_lane_bytes']}): "
               "the continuous 16 GiB host floor is the queue's memory guard; never run this phase outside it")
    if env.mem_available() < HOST_FLOOR:
        refuse("host MemAvailable below 16 GiB: not starting")


def manifest_entries(cfg, rel):
    m = cfg["manifest"]
    raw = R.read_bytes(m["path"])
    if hashlib.sha256(raw).hexdigest() != m["sha256"]:
        refuse("relocation manifest sha256 differs from the pin")
    ents = json.loads(raw)
    if not isinstance(ents, list) or len(ents) != m["entries"]:
        refuse(f"relocation manifest must have exactly {m['entries']} entries")
    return [e for e in ents if R._under(e.get("destination", ""), src_of(cfg, rel))]


def check_links(cfg, rel, base):
    """every manifest link into this subtree is a symlink resolving to the same relative path under `base`, and exists"""
    bad = []
    ents = manifest_entries(cfg, rel)
    for e in ents:
        want = os.path.join(base, os.path.relpath(e["destination"], src_of(cfg, rel)))
        if not os.path.islink(e["source"]) or os.path.realpath(e["source"]) != want or not os.path.exists(e["source"]):
            bad.append(e["source"])
    if bad:
        refuse(f"{len(bad)} manifest links of {rel} do not resolve under {base}, first: {bad[0]}")
    return len(ents)


def record_key(r, top):
    k = {x: r.get(x) for x in ("t", "m", "u", "g", "x", "s", "mt", "l", "nl", "h")}
    k["id"] = r["id"][:2] if top else r["id"]               # a subtree's own top: dev+ino (walk_meta zeroes a root's ctime)
    return k


def reuse_1381(cfg, rel, live):
    """sha256 from root's 1381 inventory, ONLY for an exact, complete identity match of this subtree"""
    jd = cfg["inventory_1381"]["journal_dir"]
    st = R.read_json(os.path.join(jd, "state.json"))
    inv = st.get("trees", {}).get("codex-archive", {}).get("source_inventory", {})
    meta = R.read_json(os.path.join(jd, "source-codex-archive.meta.json"))
    log = R.read_json(os.path.join(jd, "source-codex-archive.logical.json"))
    want = cfg["inventory_1381"]
    if inv.get("identity") != want["identity"] or inv.get("logical") != want["logical"] \
            or R.digest([[r["p"], r["id"], r.get("s"), r.get("mt"), r.get("l"), r["m"]] for r in meta]) != want["identity"] \
            or R.digest(log) != want["logical"]:
        refuse("the 1381 journal is not provably root 1381's inventory (digests differ): no reuse")
    sub = {r["p"]: r for r in meta if r["p"] == rel or r["p"].startswith(rel + "/")}
    mapped = {("" if p == rel else p[len(rel) + 1:]): r for p, r in sub.items()}
    if set(mapped) != {r["p"] for r in live}:
        refuse(f"{rel}: the set of paths differs from 1381 (added/removed entries): no reuse (use --fresh-hash)")
    for r in live:
        if record_key(r, r["p"] == "") != record_key(mapped[r["p"]], r["p"] == ""):
            refuse(f"{rel}/{r['p']}: metadata/identity differs from 1381: no reuse (use --fresh-hash)")
        if r.get("nl", 1) != 1 or "h" in r:
            refuse(f"{rel}/{r['p']}: hardlinks are not reused (use --fresh-hash)")
    sha = {x["p"]: x["sha256"] for x in log if x["t"] == "f"}
    return {("" if p == rel else p[len(rel) + 1:]): sha[p] for p in sub if sub[p]["t"] == "f"}


# ------------------------------------------------------------------------------------------------------------- phases
def phase_inventory(cfg, env, journal, rel, fresh=False):
    ts = journal.tree(rel)
    if ts.get("cutover") in ("renaming", "renamed", "complete"):
        refuse("already cut over")
    env.check_mounts(cfg)
    src = src_of(cfg, rel)
    recs = R.walk_meta(src)
    if fresh:
        in_queue(cfg, env)
        hashes, counts = R.hash_files(src, recs, journal.path(f"source-{name_of(rel)}.hashcache.tsv"), journal)
        how = "fresh"
    else:
        hashes, counts, how = reuse_1381(cfg, rel, recs), {"hashed": 0, "reused1381": len([r for r in recs if r["t"] == "f"])}, "1381"
    if R.walk_meta(src) != recs:
        refuse("the subtree changed during inventory")
    log = R.logical(recs, hashes)
    tag = f"source-{name_of(rel)}"
    journal.write_atomic(tag + ".meta.json", json.dumps(recs)); journal.write_atomic(tag + ".logical.json", json.dumps(log))
    inv = {"identity": R.digest([[r["p"], r["id"], r.get("s"), r.get("mt"), r.get("l"), r["m"]] for r in recs]), "logical": R.digest(log),
           "entries": len(recs), "counts": counts, "hashes": how,
           "bytes": sum(r["s"] for r in recs if r["t"] == "f")}
    ts.clear(); ts["source_inventory"] = inv
    journal.event(phase="inventory-source", subtree=rel, how=how, identity=inv["identity"]); journal.save()
    return inv


def remaining_need(cfg, journal):
    tot = 0
    for rel in cfg["subtrees"]:
        ts = journal.tree(rel)
        if ts.get("copy") != "done" and "source_inventory" in ts:
            tot += R.required_bytes(journal, name_of(rel))[0]
    return tot


def phase_plan(cfg, env, journal):
    rep = {"checks": [], "notes": []}
    ok = rep["checks"].append
    env.check_mounts(cfg); ok("source /vm (cryptvm ext4) and destination / (cryptroot ext4) are the pinned mounts")
    R.no_symlink_components(cfg["archive_root"])
    st = os.lstat(cfg["archive_root"])
    if st.st_uid != cfg["owner_uid"] or stat.S_IMODE(st.st_mode) != 0o700:
        refuse("the archive root must be the owner's 0700 directory")
    private_dest(cfg); ok("destination path private (0700, owner) where it exists; no symlinks")
    writes_on_dest(cfg, env); ok("destination and journal are on the pinned / filesystem, not on /vm")
    for rel in cfg["subtrees"]:
        ts = journal.state["trees"].get(rel, {})
        if ts.get("cutover") == "complete":
            ok(f"{rel}: cut over"); continue
        s = src_of(cfg, rel); R.no_symlink_components(s)
        if os.lstat(s).st_uid != cfg["owner_uid"] or os.path.lexists(retire_of(cfg, rel)):
            refuse(f"{rel}: not the owner's, or {retire_of(cfg, rel)} exists")
        ok(f"{rel}: {check_links(cfg, rel, s)} manifest links resolve into /vm")
    dv = env.statvfs(existing_ancestor(cfg["dest_root"])); avail = dv.f_bavail * dv.f_frsize
    need = remaining_need(cfg, journal)
    sv = env.statvfs(cfg["archive_root"])
    rep["capacity"] = {"destAvail": avail, "remainingInventoriedNeed": need, "destFloor": cfg["dest_floor_bytes"],
                       "destAvailAfter": avail - need, "sourceFreeInformational": sv.f_bavail * sv.f_frsize,
                       "notInventoried": [r for r in cfg["subtrees"] if "source_inventory" not in journal.state["trees"].get(r, {})]}
    if need and avail - need < cfg["dest_floor_bytes"]:
        refuse(f"/ would fall to {avail - need} < floor {cfg['dest_floor_bytes']}")
    rep["notes"] += ["/vm space is freed ONLY by a separately reviewed reclamation of the .retire-* trees (no deletion here)",
                     "the three subtrees free about 328 GB, about 22 GB above the current qualification threshold; the live Qwen "
                     "padbank can still grow by about 64 GB: if it resumes, that margin (and the qualification capacity) is lost",
                     "source free is informational only; the production RPC VM prepare/controller/guard thresholds are unchanged "
                     "and are enforced by their own tools, not by this relief copy (which writes only to /)"]
    vis = R.scan_proc([src_of(cfg, r) for r in cfg["subtrees"]], env)
    rep["notes"].append(f"as uid {env.euid()}: /proc complete={vis['complete']} hits={len(vis['hits'])} (informational only)")
    return rep


def phase_copy(cfg, env, journal, rel):
    ts = journal.tree(rel)
    if "source_inventory" not in ts:
        refuse("inventory-source first")
    if ts.get("cutover") in ("renaming", "renamed", "complete"):
        refuse("already cut over")
    env.check_mounts(cfg); in_queue(cfg, env); writes_on_dest(cfg, env)
    missing = [r for r in cfg["subtrees"] if "source_inventory" not in journal.tree(r)]
    if missing:
        refuse(f"inventory every subtree first ({missing}): the / floor is checked against ALL remaining copies")
    src, dst = src_of(cfg, rel), dest_of(cfg, rel)
    if R.identity_now(src) != ts["source_inventory"]["identity"]:
        refuse("the source changed since inventory: inventory-source again")
    if os.path.lexists(dst) and ts.get("copy") not in ("running", "failed"):
        refuse(f"{dst} exists but is not this journal's copy")
    dv = env.statvfs(existing_ancestor(cfg["dest_root"])); avail = dv.f_bavail * dv.f_frsize
    need = remaining_need(cfg, journal)                    # this subtree + every other one not yet copied
    if ts.get("copy") is None and avail - need < cfg["dest_floor_bytes"]:
        refuse(f"/ free {avail} - remaining need {need} < floor {cfg['dest_floor_bytes']} (insufficient capacity)")
    private_dest(cfg, create=True)
    argv = R.safe_rsync_argv([cfg["rsync_path"], "-aHAX", "--numeric-ids", "--one-file-system", "--protect-args",
                              f"--bwlimit={cfg['bwlimit_kib']}", src, os.path.dirname(dst) + "/"])
    ts["copy"] = "running"; ts.pop("verified", None); journal.event(phase="copy", subtree=rel, argv=argv); journal.save()
    rc = env.run(argv)
    if rc == 0:
        journal.event(phase="copy", subtree=rel, dir_mtimes_restored=R.restore_dir_mtimes(src, dst))
    ts["copy"] = "done" if rc == 0 else "failed"; journal.event(phase="copy", subtree=rel, rc=rc); journal.save()
    if rc != 0:
        refuse(f"rsync rc {rc}: resumable (re-run copy); nothing was deleted")
    return {"rc": 0, "dest": dst}


def phase_verify(cfg, env, journal, rel):
    ts = journal.tree(rel)
    if ts.get("copy") != "done":
        refuse("copy first")
    if ts.get("cutover") in ("renaming", "renamed", "complete"):
        refuse("already cut over")
    env.check_mounts(cfg); in_queue(cfg, env); private_dest(cfg)
    src, dst = src_of(cfg, rel), dest_of(cfg, rel)
    if R.identity_now(src) != ts["source_inventory"]["identity"]:
        refuse("the source changed since inventory: its hashes are no longer exact (inventory-source + copy again)")
    d = R.inventory(dst, "dest", name_of(rel), journal)
    if d["logical"] != ts["source_inventory"]["logical"]:
        a = R.read_json(journal.path(f"source-{name_of(rel)}.logical.json")); b = R.read_json(journal.path(f"dest-{name_of(rel)}.logical.json"))
        journal.write_atomic(f"verify-diff-{name_of(rel)}.json", json.dumps([x for x in a if x not in b][:20] + [["dest-only", x] for x in b if x not in a][:20]))
        journal.event(phase="verify", subtree=rel, ok=False); journal.save()
        refuse("destination differs from the source (differences in the journal)")
    hashes = {x["p"]: x for x in R.read_json(journal.path(f"dest-{name_of(rel)}.logical.json")) if x["t"] == "f"}
    for e in manifest_entries(cfg, rel):
        x = hashes.get(os.path.relpath(e["destination"], src))
        if not x or x["sha256"] != e["sha256"] or x["s"] != e["bytes"]:
            refuse(f"destination does not match the relocation manifest at {e['destination']}")
    ts["verified"] = {"source_identity": ts["source_inventory"]["identity"], "dest_identity": d["identity"], "logical": d["logical"], "t": env.now()}
    journal.event(phase="verify", subtree=rel, ok=True); journal.save()
    return ts["verified"]


def tool_shas():
    return {p: hashlib.sha256(R.read_bytes(os.path.join(HERE, p))).hexdigest() for p in ("subtree.py", "relocate.py")}


def phase_writer_check(cfg, env, journal, emit=False, config_path=None):
    if emit:
        q, me, cp, s = R.q, os.path.join(HERE, "subtree.py"), os.path.abspath(config_path), tool_shas()
        script = (f"#!/bin/bash\n# nvme-cold-relocation r6 subtree: ROOT writer-check (UNSIGNED local sudo script; review, then: sudo bash <this>).\n"
                  f"# Runs ONLY the reviewed tool (both files sha256-pinned) in its read-only writer-check phase.\nset -euo pipefail\n"
                  f"[ \"$(id -u)\" = 0 ] || {{ printf '%s\\n' 'run with sudo'; exit 2; }}\n"
                  f"printf '%s  %s\\n' {q(s['subtree.py'])} {q(me)} {q(s['relocate.py'])} {q(os.path.join(HERE, 'relocate.py'))} | sha256sum -c --quiet\n"
                  f"exec python3 -I {q(me)} writer-check --config {q(cp)}\n")
        journal.write_atomic("writer-check.sh", script)
        return {"script": journal.path("writer-check.sh")}
    if env.euid() != 0:
        refuse("writer-check must run as root (complete /proc visibility); use the emitted writer-check.sh")
    prefixes = sorted({p for rel in cfg["subtrees"] for p in (os.path.realpath(src_of(cfg, rel)), src_of(cfg, rel), retire_of(cfg, rel), dest_of(cfg, rel))})
    res = R.scan_proc(prefixes, env); res.update(t=env.now(), prefixes=prefixes)
    journal.write_atomic("writer-check.json", json.dumps(res))
    with contextlib.suppress(PermissionError):
        os.chown(journal.path("writer-check.json"), cfg["owner_uid"], cfg["owner_gid"])
    return {"complete": res["complete"], "hits": len(res["hits"]), "entries": res["entries"]}


def require_writer_check(cfg, env, journal, path):
    p = journal.path("writer-check.json")
    if not os.path.exists(p):
        refuse("no root writer-check result: run writer-check.sh (root) right before cut-over")
    st = os.lstat(p)
    if st.st_uid not in (cfg["owner_uid"], 0) or st.st_mode & 0o077:
        refuse("writer-check result must be private (0600)")
    wc = R.read_json(p)
    if not wc["complete"]:
        refuse(f"writer-check visibility was incomplete ({len(wc['incomplete'])} unreadable): not proof of no users")
    if wc["hits"]:
        refuse(f"active users: {wc['hits'][:3]}")
    if env.now() - wc["t"] > cfg["writer_check_max_age_seconds"] or path not in wc["prefixes"]:
        refuse("writer-check result is stale or not for this subtree: re-run it")


def post_checks(cfg, rel):
    src, dst = src_of(cfg, rel), dest_of(cfg, rel)
    if os.readlink(src) != dst or os.path.realpath(src) != dst:
        refuse("the original path does not resolve to the destination")
    if stat.S_IMODE(os.stat(dst).st_mode) != stat.S_IMODE(os.lstat(retire_of(cfg, rel)).st_mode):
        refuse("destination top-level mode differs from the source's")
    check_links(cfg, rel, dst)


def phase_cutover(cfg, env, journal, rel, attest):
    ts = journal.tree(rel)
    src, dst, ret = src_of(cfg, rel), dest_of(cfg, rel), retire_of(cfg, rel)
    if ts.get("cutover") == "complete":
        post_checks(cfg, rel); return {"already": True}
    if "verified" not in ts:
        refuse("verify first")
    R.require_attestation(attest)
    env.check_mounts(cfg); private_dest(cfg)
    if ts.get("cutover") == "renaming":
        if not os.path.lexists(src) and os.path.isdir(ret):
            ts["cutover"] = "renamed"; journal.save()
        elif os.path.isdir(src) and not os.path.islink(src) and not os.path.lexists(ret):
            ts.pop("cutover"); journal.save()
        else:
            refuse("inconsistent cut-over state after a crash: manual review")
    if ts.get("cutover") != "renamed":
        require_writer_check(cfg, env, journal, os.path.realpath(src))
        if R.identity_now(src) != ts["verified"]["source_identity"]:
            refuse("source changed after verify (a writer?): copy + verify again")
        if R.identity_now(dst) != ts["verified"]["dest_identity"]:
            refuse("destination changed after verify")
        if os.path.lexists(ret):
            refuse(f"{ret} exists")
        ts["cutover"] = "renaming"; ts["attestation"] = attest
        journal.event(phase="cutover", subtree=rel, step="rename-intent", attest=attest); journal.save()
        os.rename(src, ret)
        ts["cutover"] = "renamed"; journal.event(phase="cutover", subtree=rel, step="renamed"); journal.save()
    if not os.path.lexists(src):
        os.symlink(dst, src)
    try:
        if os.readlink(src) != dst:
            refuse(f"{src} exists and is not our symlink")
        post_checks(cfg, rel)
    except Exception as e:
        journal.event(phase="cutover", subtree=rel, step="post-check-failed", error=str(e)); journal.save()
        phase_rollback(cfg, env, journal, rel)
        refuse(f"post-cutover check failed and was rolled back: {e}")
    ts["cutover"] = "complete"; ts["dest_identity_at_cutover"] = R.identity_now(dst)
    journal.event(phase="cutover", subtree=rel, step="complete"); journal.save()
    return {"cutover": "complete", "retired": ret, "note": "nothing deleted; reclamation of the .retire tree is a separate review"}


def phase_rollback(cfg, env, journal, rel):
    ts = journal.tree(rel)
    src, dst, ret = src_of(cfg, rel), dest_of(cfg, rel), retire_of(cfg, rel)
    if os.path.isdir(src) and not os.path.islink(src) and not os.path.lexists(ret):
        ts.pop("cutover", None); journal.save(); return {"already": "source is in place"}
    if not (os.path.isdir(ret) and not os.path.islink(ret)):
        refuse(f"{ret} is missing: manual review (nothing changed)")
    base = ts.get("dest_identity_at_cutover") or (ts.get("verified") or {}).get("dest_identity")
    if os.path.lexists(dst) and (base is None or R.identity_now(dst) != base):
        refuse("the destination changed since cut-over (writes through the symlink): rolling back would discard them")
    if R._our_symlink(src, dst):
        journal.event(phase="rollback", subtree=rel, step="unlink-our-symlink"); journal.save()
        os.unlink(src)                                   # the ONLY unlink: our own readlink-verified symlink
    os.rename(ret, src)
    ts.pop("cutover", None); journal.event(phase="rollback", subtree=rel, step="restored"); journal.save()
    return {"rolled_back": True, "kept": dst}


def main(argv=None, env=None):
    env = env or Env()
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("phase", nargs="?", default="plan", choices=["plan", "status", "inventory-source", "copy", "verify",
                    "emit-writer-check", "writer-check", "cutover", "rollback"])
    ap.add_argument("--config", required=True); ap.add_argument("--subtree")
    ap.add_argument("--fresh-hash", action="store_true"); ap.add_argument("--apps-stopped-attestation")
    a = ap.parse_args(argv)
    try:
        cfg = load_config(a.config, env)
        if a.phase != "writer-check" and env.euid() == 0 and env.production:
            refuse("run as the owner, not root (only writer-check runs as root)")
        if a.phase in ("plan", "status"):
            j = open_journal(cfg, env, create=False)
            out = j.state if a.phase == "status" else phase_plan(cfg, env, j)
        else:
            env.check_mounts(cfg); writes_on_dest(cfg, env)        # r7: before the journal is created or written at all
            j = open_journal(cfg, env, create=True)
            with j.locked():
                rel = pick(cfg, a.subtree) if a.phase in ("inventory-source", "copy", "verify", "cutover", "rollback") else None
                out = {"inventory-source": lambda: phase_inventory(cfg, env, j, rel, a.fresh_hash), "copy": lambda: phase_copy(cfg, env, j, rel),
                       "verify": lambda: phase_verify(cfg, env, j, rel), "writer-check": lambda: phase_writer_check(cfg, env, j),
                       "emit-writer-check": lambda: phase_writer_check(cfg, env, j, emit=True, config_path=a.config),
                       "cutover": lambda: phase_cutover(cfg, env, j, rel, a.apps_stopped_attestation),
                       "rollback": lambda: phase_rollback(cfg, env, j, rel)}[a.phase]()
        print(json.dumps(out, indent=1, sort_keys=True, default=str))
        return 0
    except Refuse as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
