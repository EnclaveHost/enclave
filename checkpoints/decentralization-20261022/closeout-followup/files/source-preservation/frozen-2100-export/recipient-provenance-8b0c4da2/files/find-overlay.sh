#!/bin/bash
# Read-only: which local git repositories hold the image's overlay commits, and which receipts name the dist.
# Object existence checks only (cat-file -e) and a text search limited to small text files; no repository is modified.
W=/home/steven/Documents/Codex/2026-10-18/wo/work; export GIT_OPTIONAL_LOCKS=0
for g in $(find $W /home/steven/enclave-prod /home/steven/Projects -maxdepth 4 -name .git \( -type d -o -type f \) -not -path '*/node_modules/*' 2>/dev/null); do
  r=$(dirname $g)
  for c in deabf8f90f64902d20d48620fd911d34c445859d 2857356cde9b35c1b9b046c201d74ec8a517bca0 5a4eb9a6c070083e72a7b90f42fc58f6819821c2; do
    git -C $r cat-file -e $c^{commit} 2>/dev/null && echo "COMMIT ${c:0:9} in $r"
  done
done | sort -u
echo "== receipts naming the dist or the overlay commit"
grep -rIl --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=target --include='*.json' --include='*.md' --include='*.txt' -e 'dist-leasegas-deabf8f90' -e 'deabf8f90f64' $W /home/steven/Documents/Codex/2026-10-18/wo/outputs 2>/dev/null | head -40
