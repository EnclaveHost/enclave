# composite-mdbx-validation-stage/r1 pins and guards (sourced; prepared by Claude 1782; NOT run by Claude)
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$P/composite-mdbx-validation-stage/r1
export PATH=/usr/bin:/bin LC_ALL=C
die() { echo "## REFUSED: $*"; exit 9; }
STAGES="recovery-overlay-stage/r9:17b5528fc122203708dc3cce1ddfdf4e3151ff02ec21d09b55cd651fbcd103b3
multipart-validation-view-stage/r6:18bab7be1a604699ec7e97436b30efbfc6159eecb46a1cd06fc3297fcf091ed7
recovery-multipart-stage/r3:fcd8e0973597eebb7a003becca05f8695e770dd797a974f2bf7ce1beb041fe20
mdbx-recovery-validator-stage/r4:82394b02d807f6a8e2d23efeb89f105c58acb925a563c5eb43fcfd971d221b97"
MDBX_BIN=$P/mdbx-recovery-validator-stage/r4/runs/run-20261026T210943Z-2354169/bin       # root 1685's run copies (20 PASS): executed only
MK_SHA=ca8d4192189742ccccb1b9eb0b71790dfd35974a247a85fa64fb6e68f7312275
guards() {
  [ "$(id -u)" != 0 ] || die "run as the owner (unprivileged FUSE), never as root"
  (cd $S && sha256sum -c --quiet SHA256SUMS) || die "stage != SHA256SUMS"
  for x in $STAGES; do d=${x%%:*}; h=${x#*:}
    [ "$(sha256sum < $P/$d/SHA256SUMS | cut -c1-64)" = $h ] && (cd $P/$d && sha256sum -c --quiet SHA256SUMS) || die "$d is not the pinned frozen stage"; done
  [ "$(sha256sum < $MDBX_BIN/mk_fixture | cut -c1-64)" = $MK_SHA ] || die "mk_fixture is not the pinned build"
  [ -c /dev/fuse ] || die "/dev/fuse is required"
  [ -z "$(find $S -path $S/runs -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ] || die "bytecode in the stage"
  # every binary/script pin is re-checked by composite_session.py itself (PINS) before anything runs
}
# peers' FUSE mounts and qemu-nbd/nbdfuse processes must be identical before and after (never touched by us) - r9 pattern
peer_snapshot() { { grep -E ' fuse(\.[a-z0-9]+)? |fuseblk' /proc/self/mountinfo | awk '{print $5, $9, $10}' | grep -v "$S/runs" | sort
                    pgrep -u "$(id -u)" -x -a 'qemu-nbd|nbdfuse|fuse2fs' | grep -v -F "$S/runs" | sort; } ; }
