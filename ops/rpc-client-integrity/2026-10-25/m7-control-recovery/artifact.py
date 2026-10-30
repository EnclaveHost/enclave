#!/usr/bin/env python3
"""From `cargo test --no-run --message-format=json` output (stdin): the base-consensus-providers lib TEST artifact.
Prints '<fresh> <executable>' and exits 3 unless exactly one such artifact was reported."""
import json, sys
hits = []
for line in sys.stdin:
    try: m = json.loads(line)
    except ValueError: continue
    if m.get("reason") != "compiler-artifact": continue
    t = m.get("target", {})
    if t.get("name") == "base_consensus_providers" and "lib" in t.get("kind", []) and m.get("profile", {}).get("test") and m.get("executable"):
        hits.append((m["fresh"], m["executable"]))
if len(hits) != 1: print(f"expected exactly one providers lib test artifact, got {len(hits)}", file=sys.stderr); sys.exit(3)
print(("fresh" if hits[0][0] else "rebuilt"), hits[0][1])
