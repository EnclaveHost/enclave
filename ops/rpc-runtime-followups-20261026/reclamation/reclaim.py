#!/usr/bin/env python3
"""nvme-reclamation-stage/reclaim.py: free the NVMe space held by a cut-over tree's RETIRED copy
(/vm/enclave-volumes/.retire-<name>) - and nothing else - after proving, freshly, that the verified copy in the USB ext4 image
is intact, durable and the one in use. It runs as the owner (no sudo), with the frozen relocation tool's journal and config.

It loads nvme-cold-relocation-stage/r5/relocate.py ONLY if its sha256 is the reviewed pin, and executes exactly those bytes.

Phases (`reclaim.py <phase> --config C --tree N ...`):
  reclaim-plan        fresh FULL hash inventories of the retired tree and of the USB destination; both must equal the
                      verification recorded before cut-over; persistence + mount + our symlink checked; prints the IDENTITY
                      digest and a nonce. Writes only journal files; deletes nothing.
  emit-writer-check   a pinned (sha256 of reclaim.py AND relocate.py) unsigned sudo script running ONLY `writer-check`
  writer-check        ROOT: bounded /proc + loop/swap scan for users of the retired path, the .reclaim-<name>-<nonce> path,
                      the destination and the source path. Incomplete visibility fails.
  reclaim             needs: --identity <digest from reclaim-plan>, --hold-attestation, --apps-stopped-attestation, a fresh
                      complete zero-hit reclaim writer-check, and EVERY plan check again (fresh full hashes; digest equal).
                      Then: durable intent (the retired tree's full entry manifest, fsynced, BEFORE anything changes) ->
                      rename .retire-<name> -> .reclaim-<name>-<nonce> -> bottom-up deletion through directory fds:
                      before EACH unlink/rmdir the entry is lstat'ed relative to its verified parent fd and must match the
                      manifest (type, device, inode, size, mtime, mode, symlink target; ctime while the link count is
                      unchanged); an entry not in the manifest, a changed entry, another device (mount) or a symlink
                      where a directory was recorded refuses. Symlinks are removed, never followed.
                      RESUME after a crash: the same users/USB/persistence checks, then EVERY remaining entry is
                      validated and every remaining file RE-HASHED against the manifest before any further deletion.
  status              the journal's reclaim records
The USB copy is never written. Nothing outside the renamed retired tree is ever unlinked. The USB RAID5 copy is the only
copy that remains: this tool does not make or assume a backup.
"""
import argparse, contextlib, hashlib, json, os, secrets, stat, sys, time, types

RELOCATE_SHA256 = "2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0"
RELOCATE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                             "nvme-cold-relocation-stage", "r5", "relocate.py")
FORMAT = "nvme-reclamation/v1"


def load_relocate(path=RELOCATE_PATH, want=RELOCATE_SHA256):
    """Execute exactly the hashed bytes of the reviewed relocation tool (no second read after hashing)."""
    with open(path, "rb") as f:
        src = f.read()
    if hashlib.sha256(src).hexdigest() != want:
        raise SystemExit(f"REFUSED: {path} is not the reviewed relocate.py (sha256 pin {want[:12]}...)")
    mod = types.ModuleType("relocate_r5")
    mod.__file__ = path
    exec(compile(src, path, "exec"), mod.__dict__)
    return mod


def self_sha():
    with open(os.path.abspath(__file__), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


class Reclaim:
    def __init__(self, R, cfg, env, journal, name):
        self.R, self.cfg, self.env, self.j, self.name = R, cfg, env, journal, name
        self.t = R.tree_cfg(cfg, name)
        self.ts = journal.tree(name)
        self.src, self.dst, self.ret = self.t["source"], R.dest_of(cfg, name), R.retire_of(cfg, name)
        self.rc = self.ts.setdefault("reclaim", {})

    def refuse(self, msg):
        self.R.refuse(msg)

    def reclaim_path(self):
        return self.cfg["source_parent"] + "/.reclaim-" + self.name.lstrip(".") + "-" + self.rc["nonce"]

    # ---------------------------------------------------------------------------------------------------- checks
    def common_checks(self):
        R, ts = self.R, self.ts
        if ts.get("cutover") != "complete":
            self.refuse("the tree is not cut over: there is no retired copy to reclaim")
        if "verified" not in ts:
            self.refuse("no verification record for this tree")
        self.env.check_mounts(self.cfg)
        self.env.check_target(self.cfg, self.j)
        if not self.j.state.get("persistence_verified"):
            self.refuse("no verified persistent mount configuration")
        R.check_persistence(self.cfg, self.env)
        if not os.path.islink(self.src) or os.readlink(self.src) != self.dst or os.path.realpath(self.src) != self.dst:
            self.refuse(f"{self.src} is not our symlink to the verified USB copy")
        R.no_symlink_components(self.cfg["source_parent"])

    def dest_unchanged(self):
        """The USB copy is the verified tree, byte for byte (fresh FULL hash) and unchanged in metadata since cut-over."""
        d = self.R.inventory(self.dst, "reclaim-dest", self.name, self.j)
        if d["logical"] != self.ts["verified"]["logical"]:
            self.refuse("the USB copy differs from the verified tree (changed after cut-over): reclaiming would discard the "
                        "pre-change versions that exist only on NVMe; re-baseline needs a separate decision")
        base = self.ts.get("dest_identity_at_cutover") or self.ts["verified"]["dest_identity"]
        if d["identity"] != base:
            self.refuse("the USB copy's metadata changed since cut-over")
        return d

    def retired_verified(self):
        R = self.R
        R.no_symlink_components(self.ret)
        st = os.lstat(self.ret)
        if not stat.S_ISDIR(st.st_mode) or st.st_dev != os.lstat(self.cfg["source_parent"]).st_dev:
            self.refuse(f"{self.ret} is not a directory on the source filesystem")
        r = R.inventory(self.ret, "reclaim-retired", self.name, self.j)
        if r["identity"] != self.ts["verified"]["source_identity"] or r["logical"] != self.ts["verified"]["logical"]:
            self.refuse("the retired tree differs from the verified source (written after verification?): it may hold data "
                        "that exists only on NVMe - not reclaimed")
        return r, [st.st_dev, st.st_ino]

    def plan_digest(self, r, root, d):
        return self.R.digest({"format": FORMAT, "tree": self.name, "retired": self.ret, "root": root, "identity": r["identity"],
                              "logical": r["logical"], "entries": r["entries"], "bytes": r["bytes"], "dest_logical": d["logical"],
                              "nonce": self.rc["nonce"]})

    def writer_check_fresh(self):
        R, p = self.R, self.j.path("reclaim-writer-check.json")
        if not os.path.exists(p):
            self.refuse("no root reclaim writer-check result: run the emitted reclaim-writer-check.sh right before reclaim")
        st = os.lstat(p)
        if st.st_uid not in (self.cfg["owner_uid"], 0) or st.st_mode & 0o077:
            self.refuse("reclaim writer-check result must be private (0600)")
        wc = R.read_json(p)
        if not wc["complete"]:
            self.refuse("reclaim writer-check visibility was incomplete: not proof of no users")
        if wc["hits"]:
            self.refuse(f"active users: {wc['hits'][:3]}")
        need = {self.ret, self.reclaim_path(), self.dst}
        if self.env.now() - wc["t"] > self.cfg["writer_check_max_age_seconds"] or not need <= set(wc["prefixes"]):
            self.refuse("reclaim writer-check result is stale or does not cover this tree's retired/reclaim/USB paths")

    # ---------------------------------------------------------------------------------------------------- phases
    def plan(self):
        if self.rc.get("state") in ("intent", "renamed", "deleting"):
            self.refuse(f"a reclaim is in progress ({self.rc['state']}): run `reclaim` to resume it")
        if self.rc.get("state") == "complete":
            return {"already": "reclaimed", "freed_bytes": self.rc.get("freed_bytes")}
        self.common_checks()
        d = self.dest_unchanged()
        r, root = self.retired_verified()
        self.rc.clear()
        self.rc.update(state="planned", nonce=secrets.token_hex(8), t=self.env.now())
        self.rc["digest"] = self.plan_digest(r, root, d)
        self.j.event(phase="reclaim-plan", tree=self.name, digest=self.rc["digest"], entries=r["entries"], bytes=r["bytes"])
        self.j.save()
        return {"tree": self.name, "retired": self.ret, "identity": self.rc["digest"], "entries": r["entries"], "bytes": r["bytes"],
                "next": "emit-writer-check, sudo bash reclaim-writer-check.sh, then reclaim --identity <identity> "
                        "--hold-attestation ... --apps-stopped-attestation ..."}

    def emit_writer_check(self, config_path, R_path):
        if self.rc.get("state") not in ("planned", "intent", "renamed", "deleting"):
            self.refuse("reclaim-plan first")
        q = self.R.q
        me, cp = os.path.abspath(__file__), os.path.abspath(config_path)
        script = f"""#!/bin/bash
# nvme-reclamation: root writer-check (UNSIGNED local sudo script; review, then: sudo bash <this file>). Read-only scan.
set -euo pipefail
TOOL={q(me)}
RELOCATE={q(R_path)}
CONFIG={q(cp)}
TREE={q(self.name)}
[ "$(id -u)" = 0 ] || {{ printf '%s\\n' 'run with sudo'; exit 2; }}
printf '%s  %s\\n' {q(self_sha())} "$TOOL" | sha256sum -c --quiet
printf '%s  %s\\n' {q(RELOCATE_SHA256)} "$RELOCATE" | sha256sum -c --quiet
exec python3 -I "$TOOL" writer-check --config "$CONFIG" --tree "$TREE"
"""
        self.j.write_atomic("reclaim-writer-check.sh", script)
        return {"script": self.j.path("reclaim-writer-check.sh")}

    def writer_check(self):
        if self.env.euid() != 0:
            self.refuse("writer-check must run as root (use the emitted reclaim-writer-check.sh)")
        if "nonce" not in self.rc:
            self.refuse("reclaim-plan first")
        prefixes = sorted({self.ret, self.reclaim_path(), self.dst, os.path.realpath(self.src) if os.path.exists(self.src) else self.src})
        res = self.R.scan_proc(prefixes, self.env)
        res.update(t=self.env.now(), prefixes=prefixes)
        self.j.write_atomic("reclaim-writer-check.json", json.dumps(res))
        with contextlib.suppress(PermissionError):
            os.chown(self.j.path("reclaim-writer-check.json"), self.cfg["owner_uid"], self.cfg["owner_gid"])
        return {"complete": res["complete"], "hits": len(res["hits"])}

    def reclaim(self, identity, hold, stop):
        R, rc = self.R, self.rc
        if rc.get("state") == "complete":
            return {"already": "reclaimed", "freed_bytes": rc.get("freed_bytes")}
        if rc.get("state") not in ("planned", "intent", "renamed", "deleting"):
            self.refuse("reclaim-plan first")
        if not identity or identity != rc.get("digest"):
            self.refuse("--identity does not match the reclaim-plan digest (stale or mistaken plan): nothing deleted")
        R.require_attestation(stop)
        if not hold or len(hold.strip()) < 8:
            self.refuse("--hold-attestation is required: the hold period's end and who exercised the USB location")
        self.common_checks()
        self.writer_check_fresh()
        d = self.dest_unchanged()                               # fresh FULL hash of the USB copy, every run and resume
        resumed = rc["state"] != "planned"                      # a previous run already wrote the durable intent
        rc.setdefault("attestations", []).append({"hold": hold, "stop": stop, "t": self.env.now(), "resume": resumed})
        if not resumed:
            r, root = self.retired_verified()
            if self.plan_digest(r, root, d) != identity:
                self.refuse("the fresh inventory no longer matches the plan digest: re-plan")
            self.write_intent(root)
        if rc["state"] == "intent":
            self.do_rename()
        return self.delete(resumed)

    # --------------------------------------------------------------------------------------- intent and deletion
    def write_intent(self, root):
        R = self.R
        recs = R.read_json(self.j.path(f"reclaim-retired-{self.name.lstrip('.')}.meta.json"))
        hashes = {x["p"]: x.get("sha256") for x in R.read_json(self.j.path(f"reclaim-retired-{self.name.lstrip('.')}.logical.json"))}
        blocked = [r["p"] or "." for r in recs if r["t"] == "d" and (r["u"] != self.cfg["owner_uid"] or r["m"] & 0o300 != 0o300)]
        if blocked:                                             # refuse BEFORE the intent: never stop half-way on EACCES
            self.refuse(f"{len(blocked)} directories are not owner-owned with u+wx (first: {blocked[0]!r}): "
                        "the owner could not empty them; nothing changed (no automatic chmod/chown)")
        man = {"format": FORMAT, "tree": self.name, "root": root, "entries": {}}
        for r in recs:
            man["entries"][r["p"]] = {"t": r["t"], "dev": r["id"][0], "ino": r["id"][1], "ctime": r["id"][2], "m": r["m"],
                                     "s": r.get("s"), "mt": r.get("mt"), "l": r.get("l"), "nl": r.get("nl"), "sha256": hashes.get(r["p"])}
        text = json.dumps(man, sort_keys=True)
        mname = f"reclaim-{self.name.lstrip('.')}-{self.rc['nonce']}.manifest.json"
        self.j.write_atomic(mname, text)                        # fsync + rename + directory fsync BEFORE any change
        self.rc.update(state="intent", manifest=mname, manifest_sha=hashlib.sha256(text.encode()).hexdigest(), root=root,
                       free_before=self.free_bytes())
        self.j.event(phase="reclaim", tree=self.name, step="intent", manifest_sha=self.rc["manifest_sha"])
        self.j.save()

    def manifest(self):
        with open(self.j.path(self.rc["manifest"]), "rb") as f:
            raw = f.read()
        if hashlib.sha256(raw).hexdigest() != self.rc["manifest_sha"]:
            self.refuse("the reclaim manifest changed on disk: stop, manual review")
        return json.loads(raw)

    def free_bytes(self):
        v = os.statvfs(self.cfg["source_parent"])
        return v.f_bavail * v.f_frsize

    def do_rename(self):
        rp = self.reclaim_path()
        if os.path.lexists(rp) and not os.path.lexists(self.ret):       # crashed after the rename
            pass
        elif os.path.lexists(self.ret) and not os.path.lexists(rp):
            st = os.lstat(self.ret)
            if not stat.S_ISDIR(st.st_mode) or [st.st_dev, st.st_ino] != self.rc["root"]:
                self.refuse(f"{self.ret} is no longer the inventoried directory (inode changed): nothing deleted")
            os.rename(self.ret, rp)
        else:
            self.refuse("inconsistent retired/reclaim paths after a crash: manual review")
        self.rc["state"] = "renamed"
        self.j.event(phase="reclaim", tree=self.name, step="renamed", path=rp); self.j.save()

    def check_entry(self, st, m, rel, name, dfd):
        kind = "d" if stat.S_ISDIR(st.st_mode) else "f" if stat.S_ISREG(st.st_mode) else "l" if stat.S_ISLNK(st.st_mode) else "?"
        if kind != m["t"]:
            self.refuse(f"{rel!r}: type changed ({m['t']} -> {kind})")
        if st.st_dev != self.rc["root"][0]:
            self.refuse(f"{rel!r}: on another device (mount point?)")
        if st.st_ino != m["ino"] or stat.S_IMODE(st.st_mode) != m["m"]:
            self.refuse(f"{rel!r}: not the inventoried inode/mode")
        if kind == "f":
            if st.st_size != m["s"] or st.st_mtime_ns != m["mt"] or (st.st_nlink == m["nl"] and st.st_ctime_ns != m["ctime"]):
                self.refuse(f"{rel!r}: changed since the inventory")
        if kind == "l" and os.readlink(name, dir_fd=dfd) != m["l"]:
            self.refuse(f"{rel!r}: symlink target changed")

    def walk(self, dfd, rel, man, visit):
        """Depth-first over an already-verified directory fd; children are verified before descending or deleting."""
        for name in sorted(os.listdir(dfd)):
            crel = name if not rel else rel + "/" + name
            m = man["entries"].get(crel)
            if m is None:
                self.refuse(f"{crel!r} is not in the original inventory (injected after the plan): stopped, nothing more deleted")
            st = os.lstat(name, dir_fd=dfd)
            self.check_entry(st, m, crel, name, dfd)
            if m["t"] == "d":
                cfd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dfd)
                try:
                    fs = os.fstat(cfd)
                    if (fs.st_dev, fs.st_ino) != (st.st_dev, st.st_ino):
                        self.refuse(f"{crel!r} was replaced while being opened")
                    self.walk(cfd, crel, man, visit)
                    visit(dfd, name, crel, m, cfd)
                finally:
                    os.close(cfd)
            else:
                visit(dfd, name, crel, m, None)

    def open_root(self):
        pfd = os.open(self.cfg["source_parent"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        base = os.path.basename(self.reclaim_path())
        try:
            rfd = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=pfd)
        except FileNotFoundError:
            return pfd, None, base
        fs = os.fstat(rfd)
        if [fs.st_dev, fs.st_ino] != self.rc["root"]:
            os.close(rfd); os.close(pfd)
            self.refuse("the reclaim directory is not the inventoried root inode")
        return pfd, rfd, base

    def delete(self, resume):
        man = self.manifest()
        pfd, rfd, base = self.open_root()
        try:
            if rfd is None:
                if self.rc["state"] != "deleting":
                    self.refuse("the renamed tree is missing before any deletion: manual review")
                return self.finish()
            if resume:                                          # validate AND re-hash every remaining entry first
                def rehash(dfd, name, crel, m, cfd):
                    if m["t"] == "f":
                        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
                        h = hashlib.sha256()
                        with os.fdopen(fd, "rb") as f:
                            for b in iter(lambda: f.read(1 << 20), b""):
                                h.update(b)
                        if h.hexdigest() != m["sha256"]:
                            self.refuse(f"{crel!r}: content differs from the inventory: stopped")
                self.walk(rfd, "", man, rehash)
                self.j.event(phase="reclaim", tree=self.name, step="resume-validated"); self.j.save()
            self.rc["state"] = "deleting"; self.j.event(phase="reclaim", tree=self.name, step="deleting"); self.j.save()
            count = [0]
            def remove(dfd, name, crel, m, cfd):
                if m["t"] == "d":
                    if os.listdir(cfd):
                        self.refuse(f"{crel!r} is not empty after its verified children were removed")
                    os.rmdir(name, dir_fd=dfd)
                else:
                    st = os.lstat(name, dir_fd=dfd)               # re-check immediately before the irreversible step
                    self.check_entry(st, m, crel, name, dfd)
                    os.unlink(name, dir_fd=dfd)
                count[0] += 1
                if count[0] % 10000 == 0:
                    self.rc["deleted_so_far"] = self.rc.get("deleted_so_far", 0) + 10000; self.j.save()
            ms = os.fstat(rfd)
            if stat.S_IMODE(ms.st_mode) & 0o200 == 0:
                self.refuse("the reclaim root is not owner-writable: manual review")
            self.walk(rfd, "", man, remove)
            if os.listdir(rfd):
                self.refuse("the reclaim root is not empty after deletion")
            os.rmdir(base, dir_fd=pfd)
        finally:
            if rfd is not None:
                os.close(rfd)
            os.close(pfd)
        return self.finish()

    def finish(self):
        R = self.R
        if not (os.path.islink(self.src) and os.readlink(self.src) == self.dst and os.path.isdir(self.dst)):
            self.refuse("after reclamation the source path must still be our symlink to the USB copy")
        if "manifest" in self.t:
            R.check_manifest(self.t, base=self.dst)
        else:
            R.check_inbound(self.t, base=self.dst)
        after = self.free_bytes()
        self.rc.update(state="complete", free_after=after, freed_bytes=after - self.rc.get("free_before", after))
        self.j.event(phase="reclaim", tree=self.name, step="complete", freed_bytes=self.rc["freed_bytes"]); self.j.save()
        return {"reclaimed": self.name, "freed_bytes": self.rc["freed_bytes"], "kept": self.dst}


def main(argv=None, env=None, R=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("phase", choices=["reclaim-plan", "emit-writer-check", "writer-check", "reclaim", "status"])
    ap.add_argument("--config", required=True)
    ap.add_argument("--tree", required=True)
    ap.add_argument("--identity")
    ap.add_argument("--hold-attestation")
    ap.add_argument("--apps-stopped-attestation")
    a = ap.parse_args(argv)
    R = R or load_relocate()
    env = env or R.Env()
    try:
        cfg = R.load_config(a.config, env)
        if a.phase != "writer-check" and env.euid() == 0 and env.production:
            R.refuse("run as the owner, not root (only writer-check runs as root)")
        j = R.Journal(cfg, env, create=False)
        if getattr(j, "readonly", False) and not os.path.isdir(cfg["journal_dir"]):
            R.refuse("no relocation journal: nothing was cut over")
        j = R.Journal(cfg, env, create=True)
        with j.locked():
            rc = Reclaim(R, cfg, env, j, a.tree)
            if a.phase == "status":
                out = rc.rc
            elif a.phase == "reclaim-plan":
                out = rc.plan()
            elif a.phase == "emit-writer-check":
                out = rc.emit_writer_check(a.config, R.__file__)
            elif a.phase == "writer-check":
                out = rc.writer_check()
            else:
                out = rc.reclaim(a.identity, a.hold_attestation, a.apps_stopped_attestation)
        print(json.dumps(out, indent=1, sort_keys=True, default=str))
        return 0
    except R.Refuse as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
