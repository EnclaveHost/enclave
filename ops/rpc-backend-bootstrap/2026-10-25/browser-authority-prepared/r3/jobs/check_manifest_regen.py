#!/usr/bin/env python3
"""check_manifest_regen.py <clone> <rev> <old-manifest-json> <js-sha-before> <out.json>
Validates that `node scripts/build-management-vendor.mjs` (run by root in a fresh private full-history clone at <rev>)
changed ONLY provenance: site/vendor/management.js bytes unchanged; the manifest's file/sha256/bytes/entry/esbuild/deps
and every source's sha256 unchanged; the source set unchanged; each source's commit recomputed INDEPENDENTLY here
(`git log -1 --format=%H -- <path>`), present in history and an ancestor of HEAD; committedClean true; and git status
shows exactly ` M site/vendor/management.MANIFEST.json`. No commit ID is typed by anyone: they come from git."""
import hashlib, json, subprocess, sys
clone, rev, old_p, js_before, out_p = sys.argv[1:6]
git = lambda *a: subprocess.run(["git", "-C", clone, *a], capture_output=True, text=True)
fails = []
need = lambda c, w: c or fails.append(w)
old = json.load(open(old_p)); new = json.load(open(f"{clone}/site/vendor/management.MANIFEST.json"))
js = open(f"{clone}/site/vendor/management.js", "rb").read(); js_sha = hashlib.sha256(js).hexdigest()
need(git("rev-parse", "HEAD").stdout.strip() == rev, "HEAD is not the pinned rev")
need(js_sha == js_before == old["sha256"], f"management.js bytes changed ({js_sha[:16]} vs {js_before[:16]} / manifest {old['sha256'][:16]})")
need(set(new) == set(old), f"manifest keys differ: {sorted(set(new) ^ set(old))}")
for k in ("file", "sha256", "bytes", "entry", "esbuild", "deps"): need(new.get(k) == old.get(k), f"manifest {k} changed: {old.get(k)!r} -> {new.get(k)!r}")
need(new.get("bytes") == len(js), "manifest bytes != file length")
need(set(new.get("sources", {})) == set(old.get("sources", {})), "source set changed")
changes = {}
for p, v in sorted(new.get("sources", {}).items()):
    o = old["sources"].get(p, {})
    need(set(v) == {"sha256", "commit", "committedClean"}, f"{p}: unexpected fields {sorted(v)}")
    need(v.get("sha256") == o.get("sha256"), f"{p}: source sha256 changed")
    need(v.get("sha256") == hashlib.sha256(open(f"{clone}/{p}", "rb").read()).hexdigest(), f"{p}: sha256 is not the file's")
    c = git("log", "-1", "--format=%H", "--", p).stdout.strip()
    need(v.get("commit") == c and len(c) == 40, f"{p}: commit {v.get('commit')} != git log -1 {c}")
    need(git("merge-base", "--is-ancestor", c, "HEAD").returncode == 0, f"{p}: commit {c} is not an ancestor of HEAD")
    need(git("cat-file", "-e", f"{o.get('commit')}^{{commit}}").returncode != 0 or o.get("commit") == c, f"{p}: old commit still exists yet differs")
    need(v.get("committedClean") is True, f"{p}: committedClean is not true")
    changes[p] = {"oldCommit": o.get("commit"), "oldCommitInHistory": git("cat-file", "-e", f"{o.get('commit')}^{{commit}}").returncode == 0,
                  "newCommit": c, "oldCommittedClean": o.get("committedClean"), "newCommittedClean": v.get("committedClean")}
st = git("status", "--porcelain", "--untracked-files=all").stdout.splitlines()
st = [l for l in st if l != "?? node_modules"]          # the pinned node_modules link is the only allowed extra
need(st == [" M site/vendor/management.MANIFEST.json"], f"clone status is not exactly the manifest: {st[:6]}")
res = {"rev": rev, "jsSha256": js_sha, "jsBytes": len(js), "newManifestSha256": hashlib.sha256(open(f"{clone}/site/vendor/management.MANIFEST.json", "rb").read()).hexdigest(),
       "provenanceChanges": changes, "failures": fails}
json.dump(res, open(out_p, "w"), indent=1); print(f"## manifest regen: {len(changes)} sources, js {js_sha[:16]} unchanged={js_sha == old['sha256']}, failures {len(fails)}")
for f in fails: print("## REGEN FAIL:", f)
sys.exit(1 if fails else 0)
