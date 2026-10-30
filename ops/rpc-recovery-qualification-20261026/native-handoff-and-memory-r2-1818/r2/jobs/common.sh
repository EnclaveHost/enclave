# composite-memory-fixture-stage/r2 pins and guards (sourced; prepared by Claude 1810/1813; NOT run by Claude)
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
M=$P/composite-memory-fixture-stage/r2
R6=$P/composite-mdbx-validation-stage/r6
R6_SUMS=06705b02eab351a718234f22c9a53acdbefe3977122682f8f3f7ac25d5b9914a     # qualified r6 lifecycle (4+12 PASS); its guards are reused
export PATH=/usr/bin:/bin LC_ALL=C
mdie() { echo "## REFUSED: $*"; exit 9; }
mguards() {
  [ "$(id -u)" != 0 ] || mdie "run as the owner (unprivileged FUSE, user manager scope), never as root"
  (cd $M && sha256sum -c --quiet SHA256SUMS) || mdie "stage != SHA256SUMS"
  [ "$(sha256sum < $R6/SHA256SUMS | cut -c1-64)" = $R6_SUMS ] && (cd $R6 && sha256sum -c --quiet SHA256SUMS) || mdie "r6 is not the qualified stage"
  [ -z "$(find $M -path $M/runs -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ] || mdie "bytecode in the stage"
}
# the FUSE fixture only: the QUALIFIED r6 guards (pinned stages, /dev/fuse, session_guard.py refusing a LIVE orchestrate / overlay /
# composite session with PID+argv, recovery/overlay/composite stage-mount refusal) + our own stage mounts. Exclusion from preservation
# jobs is the queue's single exclusive main flock (768 >= 512).
fixture_guards() {
  source $R6/jobs/common.sh                                         # defines S (=r6), guards, peer_snapshot, die
  guards
  if grep -qF '/composite-memory-fixture-stage/' /proc/self/mountinfo; then mdie "a memory-fixture stage mount exists"; fi
}
