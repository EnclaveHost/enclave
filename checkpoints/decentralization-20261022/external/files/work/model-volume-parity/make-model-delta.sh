#!/usr/bin/env bash
# make-model-delta.sh: this candidate's OWN delta, against current main + the FROZEN encrypted-volume patch.
#   model-delta.patch    git format, a/ = main + frozen patch, b/ = this tree (modes, binary-safe)
#   MODEL-INVENTORY.txt  CHANGED/NEW with base, result and current-main hashes
# Base hashes: BASE-CANDIDATE.sha256 (main + frozen patch, recorded at creation). A changed file is STALE when current
# main no longer has the hash it had at creation (BASE-MAIN.sha256) and the frozen patch does not own it: refused.
# Then proves the composition: a scratch copy of current main, the frozen patch applied (its sha checked), this delta
# applied, and every changed/new file byte-identical to the tree. The frozen patch itself is never written.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
main=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
frozen=/home/steven/Documents/Codex/2026-10-18/wo/work/volume-parity/delta.patch
frozen_sha=3b43ce9bc9eb60bea063ddb1d7e5937a344687de8acc66d36d5be81ff3c42941
[ "$(sha256sum "$frozen" | cut -c1-64)" = "$frozen_sha" ] || { echo "the frozen patch is not $frozen_sha"; exit 1; }
python3 - "$main" "$here" > "$here/MODEL-INVENTORY.txt" <<'EOF'
import hashlib, os, sys
main, here = sys.argv[1], sys.argv[2]
tree = os.path.join(here, "tree")
def h(p):
    with open(p, "rb") as f: return hashlib.sha256(f.read()).hexdigest()
def load(fn):
    d = {}
    for line in open(os.path.join(here, fn)):
        dg, rel = line.rstrip("\n").split("  ", 1)
        d[os.path.normpath(rel.removeprefix("./"))] = dg
    return d
cand, mainbase = load("BASE-CANDIDATE.sha256"), load("BASE-MAIN.sha256")
SKIP = {"target", "__pycache__", "node_modules", ".git"}
out, stale = [], []
for root, dirs, files in os.walk(tree):
    dirs[:] = [d for d in dirs if d not in SKIP]
    for f in files:
        p = os.path.join(root, f)
        if os.path.islink(p): continue
        rel = os.path.normpath(os.path.relpath(p, tree)); cur = h(p)
        m = os.path.join(main, rel); mh = h(m) if os.path.exists(m) else None
        if rel in cand:
            if cur == cand[rel]: continue
            frozen_owned = cand[rel] != mainbase.get(rel)
            if not frozen_owned and mh != mainbase.get(rel): stale.append(rel)
            out.append(("CHANGED", rel, cand[rel], cur, mh))
        else:
            if mh is not None: stale.append(rel)
            out.append(("NEW", rel, None, cur, mh))
for k, rel, b, c, mh in sorted(out, key=lambda x: (x[0], x[1])):
    print(f"{k} {rel} base={b or '-'} result={c} main={mh or '-'}")
for rel in stale: print(f"STALE {rel}")
if stale: sys.exit("STALE: current main moved under " + ", ".join(stale))
EOF
s=$(mktemp -d); trap 'rm -rf "$s"' EXIT
mkdir -p "$s/a" "$s/b"
# a/ = main + the frozen patch, per file: the frozen patch's result where it owns the file (work/volume-parity/tree,
# byte-identical to it at creation), else current main; each checked against BASE-CANDIDATE.sha256
(cd "$main" && git ls-files -z --cached --others --exclude-standard) > "$s/files"
python3 - "$s" "$here" "$main" /home/steven/Documents/Codex/2026-10-18/wo/work/volume-parity/tree <<'PY'
import hashlib, os, shutil, sys
s, here, main, ftree = sys.argv[1:]
def load(fn):
    d = {}
    for line in open(os.path.join(here, fn)):
        dg, rel = line.rstrip("\n").split("  ", 1); d[os.path.normpath(rel.removeprefix("./"))] = dg
    return d
cand, mainbase = load("BASE-CANDIDATE.sha256"), load("BASE-MAIN.sha256")
h = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
for line in open(os.path.join(here, "MODEL-INVENTORY.txt")):
    k, rel, *_ = line.split()
    dst_b = os.path.join(s, "b", rel); os.makedirs(os.path.dirname(dst_b), exist_ok=True)
    shutil.copy2(os.path.join(here, "tree", rel), dst_b)
    if k != "CHANGED": continue
    src = os.path.join(ftree if cand[rel] != mainbase.get(rel) else main, rel)
    if h(src) != cand[rel]: sys.exit(f"the base of {rel} ({src}) is not main + frozen patch")
    dst_a = os.path.join(s, "a", rel); os.makedirs(os.path.dirname(dst_a), exist_ok=True)
    shutil.copy2(src, dst_a)
PY
(cd "$s" && git diff --no-index --binary --src-prefix= --dst-prefix= a b) > "$here/model-delta.patch" || true
sed -i "s|^diff --git b/|diff --git a/|" "$here/model-delta.patch"
# the composition, proven on a scratch copy of CURRENT main
mkdir -p "$s/check"
{ (cd "$main" && tar --null --ignore-failed-read -T "$s/files" -cf - 2>/dev/null) || true; } | (cd "$s/check" && tar -xf -)
(cd "$s/check" && git init -q . && git apply "$frozen" && git apply "$here/model-delta.patch")
python3 - "$s/check" "$here" <<'EOF'
import hashlib, os, sys
chk, here = sys.argv[1], sys.argv[2]
bad = []
for line in open(os.path.join(here, "MODEL-INVENTORY.txt")):
    k, rel, b, r, *_ = line.split()
    p = os.path.join(chk, rel)
    got = hashlib.sha256(open(p, "rb").read()).hexdigest() if os.path.exists(p) else None
    if got != r.removeprefix("result="): bad.append(rel)
if bad: sys.exit("after main + frozen + model delta, not the tree: " + ", ".join(bad))
print("composition: current main + frozen patch + model-delta.patch reproduces every changed and new file")
EOF
sha256sum "$here/model-delta.patch" "$here/MODEL-INVENTORY.txt"
grep -c '^CHANGED' "$here/MODEL-INVENTORY.txt" | sed 's/^/changed: /'; grep -c '^NEW' "$here/MODEL-INVENTORY.txt" | sed 's/^/new: /'
sha256sum "$frozen"
