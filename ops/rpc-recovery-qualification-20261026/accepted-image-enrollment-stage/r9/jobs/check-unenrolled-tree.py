# accepted-image-enrollment-stage/r9: the EXACT tree an unenrolled derived-reader start may leave (logs/claude-enrollment-r9.md).
#   python3 -I check-unenrolled-tree.py ROOT        -> JSON {ok, entries, violations}; exit 0 only if ok
#   python3 -I check-unenrolled-tree.py --self-test -> JSON {ok, fixtures, results}; 13 fixtures (1 positive, 12 negative)
# ROOT is the role root the stage helper composed into (accepted-image-assets-stage/r3/jobs/unenrolled-startup-config.mjs) after the
# REAL relay refused to start without an enrollment. Allowed, by the frozen KVM r3 source (network/derived-reader/provider.mjs
# startDerivedReader: journalDir and runs are created 0700 and privacy-checked BEFORE openDerivedJournal; network/runtime-lock.mjs:
# the lock file is created 0600 O_NOFOLLOW, never written, never unlinked) and the role (the composed config):
#   .  DERIVED-READER-IMAGE.json  derived-reader/  derived-reader/derived-reader-v3.json  derived-reader-v3/
#   derived-reader-v3/derived-state.lock (EMPTY)  derived-reader-v3/runs/ (EMPTY)
# Anything else - a journal, coverage, anchor journal, run directory, runs.lock, a symlink, an unknown file, a missing entry,
# a non-private mode - is a violation. No authority, floor, journal or coverage state may exist without an enrollment.
import json, os, stat, sys, tempfile, shutil

# rel -> (type "d"|"f", private: no group/other bits, empty: a file of size 0 / a directory with no entries)
ALLOWED = {
    ".": ("d", True, False),
    "DERIVED-READER-IMAGE.json": ("f", False, False),
    "derived-reader": ("d", True, False),
    "derived-reader/derived-reader-v3.json": ("f", True, False),
    "derived-reader-v3": ("d", True, False),
    "derived-reader-v3/derived-state.lock": ("f", True, True),
    "derived-reader-v3/runs": ("d", True, True),
}

def check(root):
    entries, violations = {}, []
    def visit(rel, full):
        st = os.lstat(full)
        t = "l" if stat.S_ISLNK(st.st_mode) else "d" if stat.S_ISDIR(st.st_mode) else "f" if stat.S_ISREG(st.st_mode) else "o"
        entries[rel] = {"type": t, "mode": oct(st.st_mode & 0o777), "size": st.st_size if t == "f" else None}
        want = ALLOWED.get(rel)
        if want is None:
            violations.append(f"unexpected {t} {rel}")
        else:
            wt, private, empty = want
            if t != wt: violations.append(f"{rel} is {t}, expected {wt} (no symlink, no special file)")
            elif private and st.st_mode & 0o077: violations.append(f"{rel} mode {oct(st.st_mode & 0o777)} is not private")
            elif empty and t == "f" and st.st_size != 0: violations.append(f"{rel} is not empty ({st.st_size} bytes)")
            elif empty and t == "d" and os.listdir(full): violations.append(f"{rel} is not empty")
        if t == "d":
            for name in sorted(os.listdir(full)):
                visit(name if rel == "." else f"{rel}/{name}", os.path.join(full, name))
    visit(".", root)
    for rel in ALLOWED:
        if rel not in entries: violations.append(f"missing {rel} (the tree is exact)")
    return {"ok": not violations, "entries": entries, "violations": violations}

def build(root):
    os.chmod(root, 0o700)
    for d in ("derived-reader", "derived-reader-v3", "derived-reader-v3/runs"): os.makedirs(os.path.join(root, d), mode=0o700)
    def f(rel, data, mode):
        p = os.path.join(root, rel)
        with open(p, "w") as h: h.write(data)
        os.chmod(p, mode)
    f("DERIVED-READER-IMAGE.json", "{}", 0o644)
    f("derived-reader/derived-reader-v3.json", "{}", 0o600)
    f("derived-reader-v3/derived-state.lock", "", 0o600)

def self_test():
    def touch(rel, data="x"):
        return lambda r: open(os.path.join(r, rel), "w").write(data)
    def mkdir(rel, mode=0o700):
        return lambda r: os.makedirs(os.path.join(r, rel), mode=mode)
    def symlink_lock(r):
        p = os.path.join(r, "derived-reader-v3/derived-state.lock"); os.unlink(p); os.symlink("/dev/null", p)
    extra = []
    def symlink_runs(r):                             # an empty private directory OUTSIDE the tree, linked in as runs
        p = os.path.join(r, "derived-reader-v3/runs"); os.rmdir(p)
        t = tempfile.mkdtemp(prefix="unenrolled-target-"); os.chmod(t, 0o700); extra.append(t); os.symlink(t, p)
    fixtures = [
        ("baseline: exactly the allowed tree", None, True),
        ("a reader journal", touch("derived-reader-v3/derived-state.json", "{}"), False),
        ("a coverage directory", mkdir("derived-reader-v3/coverage"), False),
        ("an anchor journal", touch("derived-reader-v3/anchor-journal.json", "{}"), False),
        ("a saved run directory", mkdir("derived-reader-v3/runs/run-abc"), False),
        ("a runs.lock (the runs lock is only taken after the journal opens)", touch("derived-reader-v3/runs/runs.lock", ""), False),
        ("the lock replaced by a symlink", symlink_lock, False),
        ("an unknown root file", touch("x.txt"), False),
        ("a split journal directory", mkdir("derived-reader-v3/journal"), False),
        ("a non-empty lock", touch("derived-reader-v3/derived-state.lock", "pid 1"), False),
        ("runs with mode 0755", lambda r: os.chmod(os.path.join(r, "derived-reader-v3/runs"), 0o755), False),
        ("runs replaced by a symlink", symlink_runs, False),
        ("runs missing", lambda r: os.rmdir(os.path.join(r, "derived-reader-v3/runs")), False),
    ]
    results = []
    for name, mutate, expect_ok in fixtures:
        tmp = tempfile.mkdtemp(prefix="unenrolled-tree-")
        try:
            build(tmp)
            if mutate: mutate(tmp)
            r = check(tmp)
            results.append({"fixture": name, "expected": "accepted" if expect_ok else "refused", "got": "accepted" if r["ok"] else "refused",
                            "pass": r["ok"] == expect_ok, "violations": r["violations"]})
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
            while extra: shutil.rmtree(extra.pop(), ignore_errors=True)
    return {"ok": all(x["pass"] for x in results) and len(results) == 13, "fixtures": len(results), "results": results}

if __name__ == "__main__":
    out = self_test() if sys.argv[1:] == ["--self-test"] else check(sys.argv[1])
    print(json.dumps(out, indent=1)); sys.exit(0 if out["ok"] else 1)
