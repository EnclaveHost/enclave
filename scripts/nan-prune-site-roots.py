#!/usr/bin/env python3
# nan-prune-site-roots.py — unpin superseded site-frontend roots from the nan
# Kubo node, keeping only the current one.
#
# Why: every site deploy does `ipfs add -r site` -> a NEW root CID -> pin it ->
# republish IPNS. The old root stays pinned forever, so the frontend's pins grow
# by one full site tree per deploy (200 stale roots had accumulated by
# 2026-07-12). This prunes them. nan-deploy.sh calls it after each publish
# (--keep <new cid>), and it can be run standalone to clear the backlog.
#
# What counts as a site root (positive structural signal, verified on the live
# node): a UnixFS DIRECTORY whose top-level listing contains BOTH `index.html`
# and `js`. App wasm pins have no links (raw) or unnamed chunk links; config
# pins are lone files — none match, so they are never touched.
#
# SAFETY:
#   * Only unpins pins that positively match the site signature AND are not in
#     the keep set. App wasm / config / unknown pins are left alone.
#   * The current live IPNS target is ALWAYS kept (plus any --keep CIDs).
#   * ABORTS without unpinning anything if the live IPNS root does NOT itself
#     match the site signature — that means the detector is wrong for this site
#     (structure changed), and pruning on a broken detector is unsafe.
#   * Retention is consistent with the chunk-archive: each deploy unions the
#     last 48h of hashed JS chunks into the new root, so those chunks stay
#     reachable from the live pin; only blocks unique to >48h-old roots get GC'd.
#
# Usage:
#   nan-prune-site-roots.py [--keep <cid> ...] [--dry-run] [--gc]
#
# Env: KUBO_API (default http://127.0.0.1:5001), SITE_IPNS (the frontend's IPNS
# name/key hash). Exit 0 on success (incl. nothing to do), 1 on abort.

import json, os, sys, urllib.request

API  = os.environ.get("KUBO_API", "http://127.0.0.1:5001").rstrip("/")
IPNS = os.environ.get("SITE_IPNS", "k51qzi5uqu5dma8l0w05o02gkz7l80f3r3mb536qh8fuhrr2qj4nsa2afe9b52")

DRY = "--dry-run" in sys.argv
GC  = "--gc" in sys.argv
KEEP_ARGS = [sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--keep" and i + 1 < len(sys.argv)]


def api(path):
    req = urllib.request.Request(API + "/api/v0/" + path, method="POST")
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()


def links(cid):
    """Top-level entry names of a CID, or None if it isn't a listable dir."""
    try:
        d = json.loads(api("ls?arg=" + cid))
    except Exception:
        return None
    return {o["Name"] for l in d.get("Objects", []) for o in l.get("Links", [])}


def is_site_root(cid):
    n = links(cid)
    return bool(n) and "index.html" in n and "js" in n


def main():
    # resolve the live root; it is always kept and is the detector's canary.
    try:
        live = json.loads(api(f"name/resolve?arg=/ipns/{IPNS}&nocache=true"))["Path"].removeprefix("/ipfs/")
    except Exception as e:
        print(f"ABORT: cannot resolve /ipns/{IPNS}: {e}", file=sys.stderr); return 1

    if not is_site_root(live):
        print(f"ABORT: live root {live} is not detected as a site root — the "
              f"detector is wrong for this site; refusing to prune.", file=sys.stderr)
        return 1

    keep = {live, *KEEP_ARGS}
    print(f"live root: {live}  keep: {sorted(keep)}{'  [DRY-RUN]' if DRY else ''}")

    pins = list(json.loads(api("pin/ls?type=recursive"))["Keys"].keys())
    removed = 0
    for c in pins:
        if c in keep:
            continue
        if not is_site_root(c):
            continue
        if DRY:
            print(f"  would unpin old site root {c}"); removed += 1; continue
        try:
            api("pin/rm?arg=" + c); removed += 1
            print(f"  unpinned old site root {c}")
        except Exception as e:
            print(f"  WARN could not unpin {c}: {e}")

    print(f"{'would prune' if DRY else 'pruned'} {removed} old site root(s) "
          f"(of {len(pins)} recursive pins)")

    if GC and not DRY and removed > 0:
        before = _reposize()
        try:
            api("repo/gc")
        except Exception as e:
            print(f"WARN repo gc: {e}")
        after = _reposize()
        if before and after:
            print(f"repo: {_fmt(before)} -> {_fmt(after)} (reclaimed {_fmt(before - after)})")
    return 0


def _reposize():
    try:
        return json.loads(api("repo/stat"))["RepoSize"]
    except Exception:
        return None


def _fmt(n):
    n = float(n); u = ["B", "KB", "MB", "GB", "TB"]; i = 0
    while n >= 1024 and i < len(u) - 1:
        n /= 1024; i += 1
    return f"{n:.1f} {u[i]}"


if __name__ == "__main__":
    sys.exit(main())
