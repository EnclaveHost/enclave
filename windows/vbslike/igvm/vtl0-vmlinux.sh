#!/bin/sh
# Recover the ELF vmlinux matching a bzImage, with its provenance, for use as an OpenHCL VTL0 kernel.
#
# WHY: OpenHCL's VTL0 direct path is given a minimum start address of 0, so a bzImage is placed at
# 0x0-0x10000 and collides with the VTL0 command-line page the loader puts at 0x1000. An ELF vmlinux
# self-places at its link address (0x1000000 for the kernels here) and does not.
#
# NO REBUILD IS NEEDED: a bzImage carries the vmlinux compressed inside it, and the kernel's own
# scripts/extract-vmlinux recovers it. That script is GPL and lives in the kernel tree, so it is USED
# from there rather than copied into this repository; --script points at another copy.
#
# The output is the same build as the input by construction, and this prints what identifies it: the
# input's sha256, the ELF's sha256 and GNU build id, its version banner and its load addresses. A
# consumer that needs to prove which kernel an image carries quotes those.
#
#   vtl0-vmlinux.sh <bzImage> <out.vmlinux> [--script /path/to/extract-vmlinux]
set -e
IN=${1:?usage: vtl0-vmlinux.sh <bzImage> <out.vmlinux> [--script PATH]}
OUT=${2:?output path}
SCRIPT=
[ "$3" = "--script" ] && SCRIPT=$4
if [ -z "$SCRIPT" ]; then
  for c in /usr/src/linux/scripts/extract-vmlinux /usr/src/linux-*/scripts/extract-vmlinux "$(command -v extract-vmlinux 2>/dev/null)"; do
    [ -n "$c" ] && [ -f "$c" ] && { SCRIPT=$c; break; }
  done
fi
[ -n "$SCRIPT" ] && [ -f "$SCRIPT" ] || { echo "extract-vmlinux not found: pass --script <path to the kernel tree's scripts/extract-vmlinux>" >&2; exit 2; }

sh "$SCRIPT" "$IN" > "$OUT"
head -c 4 "$OUT" | grep -q 'ELF' || { echo "what came out of $IN is not an ELF: the bzImage may be packed in a way this tool does not handle" >&2; rm -f "$OUT"; exit 3; }

echo "input  $IN"
echo "  sha256   $(sha256sum "$IN" | cut -c1-64)"
echo "output $OUT"
echo "  sha256   $(sha256sum "$OUT" | cut -c1-64)"
echo "  build id $(readelf -nW "$OUT" 2>/dev/null | sed -n 's/.*Build ID: //p' | head -1)"
echo "  version  $(strings -a "$OUT" | grep -m1 '^Linux version' | cut -c1-90)"
echo "  extracted by $SCRIPT"
echo "load segments (physical addresses; none may touch 0x1000-0x2000, the VTL0 command-line page):"
readelf -lW "$OUT" | awk '/^  LOAD/ { printf "  %s .. paddr %s size %s\n", $1, $4, $6 }'
low=$(readelf -lW "$OUT" | awk '/^  LOAD/ { print strtonum($4) }' | sort -n | head -1)
if [ "$low" -lt 8192 ]; then echo "REFUSED: a segment loads below 0x2000 and would overlap the command-line page" >&2; exit 4; fi
echo "  lowest physical load address $(printf '0x%x' "$low"): clear of the command-line page"
