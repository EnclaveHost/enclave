# multipart-validation-view-stage/r3 pins (sourced). Prepared by Claude 1751. Same QEMU 11.1.2 pins as qcow-allocation-nbd-stage/r3.
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/multipart-validation-view-stage/r3
QNBD_SHA=b0f16ff7225e78469733132fce225b1d0af98f0b681a5092d85618936ff61934      # /usr/sbin/qemu-nbd 11.1.2
QIMG_SHA=3a57bce6765bfb73a75591dba2ac40d985cccde97d371e95537ecbf16d949d30      # /usr/bin/qemu-img
QIO_SHA=085e254e8a64b25c70051b123eed1ff56cf0a70acc2d064e50377220bca53f55       # /usr/bin/qemu-io
pins_ok() {
  (cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage != SHA256SUMS"; return 1; }
  for x in "/usr/sbin/qemu-nbd $QNBD_SHA" "/usr/bin/qemu-img $QIMG_SHA" "/usr/bin/qemu-io $QIO_SHA"; do
    set -- $x; [ "$(sha256sum < $1 | cut -c1-64)" = $2 ] || { echo "## $1 is not the pinned binary"; return 1; }; done
  [ -z "$(find $S -path $S/runs -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ] || { echo "## bytecode in the stage"; return 1; }
}
