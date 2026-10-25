#!/usr/bin/env python3
"""Derive the recovery crate/src/tests.rs from the ORIGINAL v2 tests.rs (072a23a8...) by exact, counted substitutions that
touch ONLY the MDBX test fixture: an explicit small geometry (pinned reth-db 7134be3 API with_geometry_max_size /
with_growth_step: 64 MiB max, 4 MiB growth) for every fixture DB (create and the read-write reopen), plus assertions that
every fixture mdbx.dat is non-empty and within that bound. Every test name, every scan call and every assertion of the
original stays; the full byte-for-byte before/after comparison of mdbx.dat is kept. Product lib.rs/main.rs are untouched.
Usage: make-tests-fix.py ORIGINAL_TESTS OUT | --check ORIGINAL_TESTS RECOVERY_TESTS"""
import hashlib, sys
ORIG_SHA = "072a23a8c467d31748ed6c49451f8ef958ccb1ea93aba41cae9b4c57d69fc1ce"
HELPERS = '''/// Explicit small MDBX geometry for EVERY fixture DB (pinned reth-db 7134be3 API). The default geometry (8 TB max, 4 GiB
/// growth step) makes each fixture mdbx.dat a 4 GiB sparse file, which the byte-for-byte read-only test reads into memory
/// twice (the 1792 MiB cgroup OOM of the first native v2 run). Fixture-only: the product scan opens the DB as before.
const FIXTURE_MAX_BYTES: usize = 64 << 20;
const FIXTURE_GROWTH_BYTES: usize = 4 << 20;
fn fixture_args() -> DatabaseArguments {
    DatabaseArguments::default().with_geometry_max_size(Some(FIXTURE_MAX_BYTES)).with_growth_step(Some(FIXTURE_GROWTH_BYTES))
}
/// Every fixture mdbx.dat must be non-empty and within the fixture geometry; returns its size.
fn assert_bounded(f: &Path) -> u64 {
    let n = std::fs::metadata(f).expect("mdbx.dat").len();
    assert!(n > 0 && n <= FIXTURE_MAX_BYTES as u64, "fixture {} is {n} bytes: not within the {FIXTURE_MAX_BYTES}-byte fixture geometry", f.display());
    n
}
'''
SUBS = [
 ("/// v2 fixture: every DB also carries the 5 stage checkpoints at N_CP unless a test asks otherwise (make_db_with).\n",
  HELPERS + "/// v2 fixture: every DB also carries the 5 stage checkpoints at N_CP unless a test asks otherwise (make_db_with).\n"),
 ('    let db = reth_db::init_db(d.0.join("db"), DatabaseArguments::default()).expect("init_db");\n',
  '    let db = reth_db::init_db(d.0.join("db"), fixture_args()).expect("init_db");\n'),
 ('    .expect("commit");\n    drop(db);\n    d\n}\n',
  '    .expect("commit");\n    drop(db);\n    assert_bounded(&d.0.join("db/mdbx.dat"));\n    d\n}\n'),
 ('    let before = std::fs::read(&f).expect("read mdbx.dat");\n',
  '    let size = assert_bounded(&f);\n    let before = std::fs::read(&f).expect("read mdbx.dat");\n    assert_eq!(before.len() as u64, size, "the whole fixture mdbx.dat must be read");\n'),
 ('        let db = reth_db::init_db(d.0.join("db"), DatabaseArguments::default()).expect("reopen read-write");\n',
  '        let db = reth_db::init_db(d.0.join("db"), fixture_args()).expect("reopen read-write");\n'),
 ('        .expect("commit");\n    }\n    let b = scan_datadir(path(&d)).expect("scan");\n',
  '        .expect("commit");\n    }\n    assert_bounded(&d.0.join("db/mdbx.dat"));\n    let b = scan_datadir(path(&d)).expect("scan");\n'),
]
def derive(orig):
    raw = open(orig, "rb").read()
    assert hashlib.sha256(raw).hexdigest() == ORIG_SHA, "not the original v2 tests.rs 072a23a8"
    s = raw.decode()
    for a, b in SUBS:
        assert s.count(a) == 1, ("anchor not exactly once", a[:70]); s = s.replace(a, b)
    assert "DatabaseArguments::default()" not in s.replace("DatabaseArguments::default().with_geometry_max_size", ""), "an unbounded fixture DB remains"
    return s
if __name__ == "__main__":
    if sys.argv[1] == "--check": sys.exit(0 if derive(sys.argv[2]) == open(sys.argv[3]).read() else 1)
    open(sys.argv[2], "w").write(derive(sys.argv[1]))
