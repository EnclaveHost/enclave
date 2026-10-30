# recovery-overlay-stage/r1 shared pins and guards (sourced by the jobs; prepared by Claude 1660; NOT run by Claude)
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$P/recovery-overlay-stage/r1
export PATH=/usr/bin:/bin:/usr/sbin LC_ALL=C
FUSE2FS=/home/steven/Documents/Codex/2026-10-26/my/work/tr004/fuse2fs-package/usr/bin/fuse2fs   # the PEER's binary: executed, never modified
FUSE2FS_SHA=6e3b5404898c2e55cb97b75c79f7bf067d1fa3381647b458fb7904b43bc4927b                    # 1.47.4
CHECKER_SHA=662291e5784a37c820f69902ef7b3c2fd6cf96d34822f60ce1df6f96db7da097
TOOLS="qemu-img:3a57bce6765bfb73a75591dba2ac40d985cccde97d371e95537ecbf16d949d30 qemu-io:085e254e8a64b25c70051b123eed1ff56cf0a70acc2d064e50377220bca53f55
qemu-nbd:b0f16ff7225e78469733132fce225b1d0af98f0b681a5092d85618936ff61934 nbdfuse:51c1a1fd18785d4fe2240c1710eb4f78590b9d333fcde4cda421871d6f010a01"
die() { echo "## REFUSED: $*"; exit 9; }
guards() {
  [ "$(id -u)" != 0 ] || die "run as the owner (unprivileged FUSE), never as root"
  (cd $S && sha256sum -c --quiet SHA256SUMS) || die "stage != SHA256SUMS"
  [ "$(sha256sum < $P/ext4-recovery-checksum-stage/r2/ext4_candidate_checksums.py | cut -c1-64)" = $CHECKER_SHA ] || die "frozen checker changed"
  [ "$(sha256sum < $FUSE2FS | cut -c1-64)" = $FUSE2FS_SHA ] || die "fuse2fs is not the pinned binary"
  for t in $TOOLS; do n=${t%%:*}; h=${t#*:}; [ "$(sha256sum < "$(command -v $n)" | cut -c1-64)" = $h ] || die "$n is not the pinned binary"; done
  [ -c /dev/fuse ] && command -v fusermount3 >/dev/null || die "FUSE (/dev/fuse + fusermount3) is required"
  [ -z "$(find $S -path $S/runs -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ] || die "bytecode in the stage"
}
# the peers' mounts and processes must be exactly the same after the run (never mutated, stopped or unmounted by us)
peer_snapshot() { { grep -E ' fuse(\.ext4)? |fuseblk' /proc/self/mountinfo | awk '{print $5, $9, $10}' | grep -v "$S/runs" | sort
                    pgrep -u "$(id -u)" -f 'qemu-nbd|nbdfuse|fuse2fs' -a | grep -v "$S/runs" | awk '{print $1}' | sort; } ; }
