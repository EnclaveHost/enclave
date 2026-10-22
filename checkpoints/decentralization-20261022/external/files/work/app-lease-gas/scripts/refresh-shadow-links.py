"""Keep the isolated shadow trees (shadow-b, shadow-win, shadow-cli) complete against CURRENT main: in every REAL directory
of a shadow tree, link each main entry the shadow lacks, and drop links whose target no longer exists. The candidate files
the rebase scripts write (real files) are never touched. No main edits.
"""
from pathlib import Path
import os

root = Path(__file__).resolve().parents[1]
main = root.parent / "enclave"
for tree in ("shadow-b", "shadow-win", "shadow-cli"):
    base = root / tree
    added = removed = 0
    for dirpath, dirnames, _ in os.walk(base):
        d = Path(dirpath)
        dirnames[:] = [n for n in dirnames if not (d / n).is_symlink()]   # real directories only
        rel = d.relative_to(base)
        m = main / rel
        if not m.is_dir():
            continue
        for entry in d.iterdir():
            if entry.is_symlink() and not entry.exists():
                entry.unlink(); removed += 1
        for src in m.iterdir():
            dst = d / src.name
            if not dst.exists() and not dst.is_symlink():
                dst.symlink_to(src); added += 1
    print(f"{tree}: linked {added} new main entries, removed {removed} dangling links")
