#!/usr/bin/env bash
# Reproduce 605's bundle 6bef372d: same tree sources, but PRODUCTION_MIRRORS emptied (MY copy; restored after).
set -uo pipefail
T=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-host-review-20261021/tree; cd "$T"
F=network/platform-host-policy-config.mjs; cp $F /tmp/phpc.orig; cp windows/node/host-admission.bundle.mjs /tmp/bha.mine
python3 - $F <<'PY'
import re,sys;p=sys.argv[1];s=open(p).read()
a=s.index('export const PRODUCTION_MIRRORS = Object.freeze(['); b=s.index(']);',a)+3
s=s[:a]+'export const PRODUCTION_MIRRORS = Object.freeze([]);'+s[b:]; open(p,'w').write(s)
PY
node scripts/build-host-admission.mjs >/dev/null 2>&1; echo "empty-mirrors build: $(sha256sum windows/node/host-admission.bundle.mjs | cut -c1-16) (605 = 6bef372d00a27567)"
cp /tmp/phpc.orig $F; cp /tmp/bha.mine windows/node/host-admission.bundle.mjs
echo "restored: $(sha256sum $F | cut -c1-16) $(sha256sum windows/node/host-admission.bundle.mjs | cut -c1-16)"
