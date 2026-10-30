# qcow-allocation-nbd-stage/r2 pins (sourced). Prepared by Claude 1709 (= r1 pins).
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/qcow-allocation-nbd-stage/r2
QNBD_SHA=b0f16ff7225e78469733132fce225b1d0af98f0b681a5092d85618936ff61934      # qemu-nbd 11.1.2 (= overlay stage pin)
QIMG_SHA=3a57bce6765bfb73a75591dba2ac40d985cccde97d371e95537ecbf16d949d30      # qemu-img
QIO_SHA=085e254e8a64b25c70051b123eed1ff56cf0a70acc2d064e50377220bca53f55       # qemu-io
NBDPY_SHA=4a64b120d2505de9faa5e6065bc5cf63b470ced57b99baa29fd886bfa30ae40b                                                            # /usr/lib/python3.14/site-packages/nbd.py (libnbd 1.24.4)
pins_ok() {
  (cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage != SHA256SUMS"; return 1; }
  for x in "/usr/sbin/qemu-nbd $QNBD_SHA" "$(command -v qemu-img) $QIMG_SHA" "$(command -v qemu-io) $QIO_SHA" "/usr/lib/python3.14/site-packages/nbd.py $NBDPY_SHA"; do
    set -- $x; [ "$(sha256sum < $1 | cut -c1-64)" = $2 ] || { echo "## $1 is not the pinned binary"; return 1; }; done
  [ -z "$(find $S -path $S/runs -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ] || { echo "## bytecode in the stage"; return 1; }
}
