#!/usr/bin/env bash
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-final-runtime-integration-20261023
ID=(-c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com)
cd "$H/candidate"; [ "$(git rev-parse HEAD)" = 1f19ad15aaa6200e1882d148f2b43b7c25fc7058 ]
B=adf9c5bbf40483f6270048165a55ec7700ea9155 M=refs/in/main
for f in PRODUCT.md docs/security/nucbox-custom-vm-verifier.md site/js/pages/sso-authorize.js; do
  [ "$(git rev-parse HEAD:$f)" = "$(git rev-parse $B:$f)" ] || { echo "not base: $f"; exit 3; }; git show $M:$f > $f; done
T=$(mktemp -d "$H/tmp/t/m.XXXX"); git show HEAD:README.md > $T/o; git show $B:README.md > $T/b; git show $M:README.md > $T/t
git merge-file -p -L ours -L base -L main $T/o $T/b $T/t > README.md; rm -rf $T
git add PRODUCT.md docs/security/nucbox-custom-vm-verifier.md site/js/pages/sso-authorize.js README.md
git "${ID[@]}" commit -q -F "$H/msgs/c1.txt"; git log -1 --format='%h %s'
# C2: the TLS worker's exact code commit (author preserved)
git "${ID[@]}" cherry-pick 1957ff23425f6ee2e0abe2604bdc9735987eff47 >/dev/null; git log -1 --format='%h %an / %cn %s'
for f in windows/node/apptls.mjs windows/node/secrets.mjs windows/node/origin-request.mjs test/windows-node-origin-request.test.mjs; do
  [ "$(git rev-parse HEAD:$f)" = "$(git rev-parse refs/in/tls:$f)" ] || { echo "TLS file differs from 1957ff23: $f"; exit 4; }; done; echo "TLS: 4 files byte-equal to 1957ff23"
# C3: M's reviewed patch (sha256 eeab54d2...), author preserved
git "${ID[@]}" am -q --3way /home/steven/Documents/Codex/2026-10-18/wo/work/windows-memory-accounting-20261023/windows-memory-accounting.patch; git log -1 --format='%h %an / %cn %s'
for f in windows/vbslike/manager/server.mjs windows/installer/install-host.ps1 docs/operations/host-ram-budget.md test/windows-hv-memory-accounting.test.mjs \
  test/windows-installer-app-ram.test.mjs test/windows-node-preclaim.test.mjs test/windows-node-scan-slot.test.mjs; do
  [ "$(git rev-parse HEAD:$f)" = "$(git rev-parse refs/in/mem:$f)" ] && echo "M equal: $f" || echo "M DIFFERS: $f"; done
for f in windows/node/host.mjs windows/node/agent.mjs windows/node/chain.mjs; do
  a=$(git diff -U0 refs/in/mem^ refs/in/mem -- $f | grep -E '^[+-][^+-]' | sha256sum | cut -c1-12); b=$(git diff -U0 HEAD^ HEAD -- $f | grep -E '^[+-][^+-]' | sha256sum | cut -c1-12)
  echo "M lines $f: $([ $a = $b ] && echo identical || echo DIFFER) ($a/$b)"; done
