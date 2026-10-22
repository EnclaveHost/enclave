#!/usr/bin/env bash
# 7d gap tests on MY copy (integrated host 5c38014c), then two mutation controls (restored after each).
set -uo pipefail
T=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-host-review-20261021/tree; I=$T/../integrated; cd "$T"
run(){ timeout 180 node --test --test-concurrency=1 test/host-hold-review-7d.test.mjs 2>&1 | grep -E "^(not )?ok|^# (pass|fail)" | tr '\n' ' '; echo; }
echo "integrated: $(run)"
mut(){ cp $I/host.mjs windows/node/host.mjs; python3 - windows/node/host.mjs "$2" "$3" <<'PY'
import sys;p,o,n=sys.argv[1:];s=open(p).read();assert s.count(o)==1,o;open(p,'w').write(s.replace(o,n))
PY
 echo "$1: $(run)"; }
mut M-stopApp-no-revoke '  async #stopApp(id, why) {
    this.#walletRevoke(id);' '  async #stopApp(id, why) {'
mut M-reclaim-no-revoke '        this.#walletRevoke(id);
        await this.consider(id)' '        await this.consider(id)'
cp $I/host.mjs windows/node/host.mjs; echo "restored host $(sha256sum windows/node/host.mjs | cut -c1-16)"
