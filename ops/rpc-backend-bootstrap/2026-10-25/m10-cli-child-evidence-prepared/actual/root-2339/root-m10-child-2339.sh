#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$PWD/finality-stage/m10-cli-child-evidence
O=/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/m10-cli-child-supplement-1
REMOTE=/srv/m10-guest-validation/stage-cli-child
SSH=(ssh -F /home/steven/.local/state/enclave-rpc-production/ssh_config enclave-rpc)
test "$(sha256sum "$S/MANIFEST.sha256" | cut -d' ' -f1)" = f3d45ccbcb9fce94cd87957baacbc879b37395c3682006aa73671e1560f79708
(cd "$S" && sha256sum -c --quiet MANIFEST.sha256)
python3 -I "$S/tests/test_check_compound.py"
mkdir "$O"
"${SSH[@]}" 'test ! -e /srv/m10-guest-validation/stage-cli-child && ! sudo systemctl is-active --quiet m10-cli-child-1.service && test "$(awk '\''/^MemAvailable:/{print int($2/1024)}'\'' /proc/meminfo)" -ge 16640 && sudo install -d -m 0755 /srv/m10-guest-validation/stage-cli-child'
tar -C "$S" -cf - MANIFEST.sha256 README.md checker pins runner tests tools | "${SSH[@]}" "sudo tar -xf - -C $REMOTE"
"${SSH[@]}" "cd $REMOTE && test \"\$(sha256sum MANIFEST.sha256 | cut -d' ' -f1)\" = f3d45ccbcb9fce94cd87957baacbc879b37395c3682006aa73671e1560f79708 && sudo sha256sum -c --quiet MANIFEST.sha256 && sudo chown -R root:root $REMOTE && sudo chmod -R a-w $REMOTE"
RUNNING=0
cleanup() { if [ "$RUNNING" = 1 ]; then "${SSH[@]}" 'sudo systemctl stop m10-cli-child-1.service' > "$O/stop.out" 2>&1 || true; fi; }
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
RUNNING=1
set +e
timeout -k 30 1000 "${SSH[@]}" "sudo bash $REMOTE/runner/run-cli-child-supplement.sh 1 4e7c14f1969c5f5af3e648a82033c1f7cfee718c20f3cb1d4d49ff3d90151750" > "$O/launch.out" 2>&1
r=$?
printf '%s\n' "$r" > "$O/launch.rc"
cleanup
RUNNING=0
set -e
for file in cli-child-1.out cli-child-1.launcher.json cli-child-1.compound.json; do
 "${SSH[@]}" "sudo cat /srv/m10-guest-validation/receipts/$file" > "$O/$file"
done
"${SSH[@]}" 'sudo tar -cf - -C /srv/m10-guest-validation/supplement/cli-child-1/work out' > "$O/supplement-out.tar"
cat "$O/launch.out" "$O/cli-child-1.compound.json"
exit "$r"
