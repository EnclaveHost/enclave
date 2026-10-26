# recovery-sequential-probe-stage/r2 pins (sourced; prepared by Claude 1738/1741; NOT run by Claude) - qcow-allocation r4 pins + the qualified lifecycle
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$P/recovery-sequential-probe-stage/r2
export PATH=/usr/bin:/bin:/usr/sbin LC_ALL=C
QIO_SHA=085e254e8a64b25c70051b123eed1ff56cf0a70acc2d064e50377220bca53f55; QIMG_SHA=3a57bce6765bfb73a75591dba2ac40d985cccde97d371e95537ecbf16d949d30
die() { echo "## REFUSED: $*"; exit 9; }
pins_ok() {
  [ "$(id -u)" != 0 ] || die "run unprivileged"
  (cd $S && sha256sum -c --quiet SHA256SUMS) || die "stage != SHA256SUMS"
  [ "$(sha256sum < /usr/sbin/qemu-io | cut -c1-64)" = $QIO_SHA ] && [ "$(sha256sum < "$(command -v qemu-img)" | cut -c1-64)" = $QIMG_SHA ] || die "qemu-io/qemu-img not pinned"
  M=$P/mdbx-recovery-validator-stage/r4                          # the qualified bounded_run + cancellation (root 1685: 20 PASS)
  [ "$(sha256sum < $M/SHA256SUMS | cut -c1-64)" = 82394b02d807f6a8e2d23efeb89f105c58acb925a563c5eb43fcfd971d221b97 ] && (cd $M && sha256sum -c --quiet SHA256SUMS) || die "MDBX r4 stage changed"
  [ "$(sha256sum < $M/src/mdbx_check.py | cut -c1-64)" = f0d27e40c29271b94d2b48b9d4ab70a84de1f946709db4e9361cdfba00bac131 ] || die "the lifecycle module is not the qualified one"
  [ -z "$(find $S -path $S/runs -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ] || die "bytecode in the stage"
}
