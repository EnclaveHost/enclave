#!/usr/bin/env python3
"""Derive the FIXED M10 patch from the original m10-bootstrap-anchor.patch (0a10cf86...) by ONE test-only change: inside the
engine_request_processor.rs diff, the added test module `mod bootstrap_anchor` gains `use crate::EngineError;` as its first
line (the exact rustc E0433 suggestion at line 2416), and that hunk's new-line count goes 79 -> 80. The diff's `index`
postimage blob id is replaced by the caller-supplied id of the fixed file (git hash-object, 7 hex). Nothing else changes.
Usage: make-fixed-m10-patch.py ORIGINAL OUT NEW_BLOB7 | --check ORIGINAL FIXED NEW_BLOB7"""
import hashlib, sys
ORIG_SHA = "0a10cf866718d9916add99b9119ceef9f9e7a78b28f26e1923eb1143cff903cc"
FILE = "diff --git a/crates/consensus/service/src/actors/engine/engine_request_processor.rs b/crates/consensus/service/src/actors/engine/engine_request_processor.rs\n"
def derive(orig, blob):
    raw = open(orig, "rb").read(); assert hashlib.sha256(raw).hexdigest() == ORIG_SHA, "not the original M10 patch 0a10cf86"
    s = raw.decode(); assert s.count(FILE) == 1; head, rest = s.split(FILE); i = rest.find("\ndiff --git "); sec, tail = rest[:i + 1], rest[i + 1:]
    for a, b in [("index 3bf1244..fb036e9 100644\n", f"index 3bf1244..{blob} 100644\n"),
                 ("@@ -2364,4 +2409,79 @@ mod tests {\n", "@@ -2364,4 +2409,80 @@ mod tests {\n"),
                 ("+    mod bootstrap_anchor {\n", "+    mod bootstrap_anchor {\n+        use crate::EngineError;\n")]:
        assert sec.count(a) == 1, a; sec = sec.replace(a, b)
    return head + FILE + sec + tail
if __name__ == "__main__":
    if sys.argv[1] == "--check": sys.exit(0 if derive(sys.argv[2], sys.argv[4]) == open(sys.argv[3]).read() else 1)
    open(sys.argv[2], "w").write(derive(sys.argv[1], sys.argv[3]))
