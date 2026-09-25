#!/usr/bin/env bash
# 4c-c: the RELEASE-CAPABLE node image. f6cbd75a = 5d's 87e881a2 (gsup passes ISOLATION_RELEASE=1 when the host config's
# isolation.release is true; the 8 supervisor overlay files byte-identical to b18f8989's) + b3109929 (-ffile-prefix-map).
# S2's exact command, TWICE, from TWO clean worktrees at DIFFERENT paths: the two must be identical. Inert.
set -euo pipefail
C=$(cat ~/enclave-bench/s4c-20260925/cc-commit.txt); B1=/home/steven/Projects/enclave-build-${C:0:8}; B2=/home/steven/enclave-bench/s4c-20260925/cc-other/checkout/path/src; EV=~/enclave-bench/s4c-20260925/build-cc
SUP=ghcr.io/enclavehost/enclave-supervisor@sha256:2f8e84f803eb058a9cff18aa4e44dcb236cf0d326cf1c95ab59f69816d8131f4
WASM=ghcr.io/enclavehost/enclave-wasm-manager@sha256:460240856a31722907514cbd6efe0c4ef2d1f58b23b0d9ac1cf721aa25d994e4
TCB=/home/steven/.cache/enclave-isolation/m3-clean/min-tcb.json; OVMF=/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd
[ "$(sha256sum < $TCB | cut -c1-64)" = fe90824f469db17cad41a895f45803d66bef5058ff829e36302fe35328179d9c ] || { echo "min-tcb is not fe90824f"; exit 2; }
[ "$(sha256sum < $OVMF | cut -c1-64)" = 142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9 ] || { echo "OVMF is not 142589cc"; exit 2; }
mkdir -p $EV "$(dirname $B2)"
for B in $B1 $B2; do
  [ -e "$B" ] || flock /tmp/enclave-git-cleanup.lock git -C /home/steven/Projects/enclave worktree add -q --detach "$B" "$C"
  [ "$(git -C $B rev-parse HEAD)" = "$C" ] && [ -z "$(git -C $B status --porcelain)" ] || { echo "the worktree $B is not clean at $C"; exit 2; }
done
for n in 1 2; do
  B=$([ $n = 1 ] && echo $B1 || echo $B2); out=$([ $n = 1 ] && echo /home/steven/Projects/enclave/metal/dist-iso-${C:0:8} || echo $EV/dist-2)
  [ -e "$out" ] && { echo "REFUSING: $out exists"; exit 1; }
  echo "build $n from $B start $(date -u +%H:%M:%SZ)"
  ( cd $B && nice -n 10 node metal/build-image.mjs --supervisor $SUP --wasm $WASM --supervisor-overlay $B --isolation snp-guest-per-app \
    --isolation-min-tcb $TCB --ovmf $OVMF --out $out > $EV/image-build-$n.log 2>&1 ) || { echo "build $n FAILED (see image-build-$n.log)"; tail -5 $EV/image-build-$n.log; exit 3; }
  echo "build $n done $(date -u +%H:%M:%SZ)"
done
git -C $B1 status --porcelain | head -3; git -C $B2 status --porcelain | head -3
A=/home/steven/Projects/enclave/metal/dist-iso-${C:0:8}; B2=$EV/dist-2
for f in vmlinuz initramfs.cpio.gz cmdline; do echo "$f: $(sha256sum $A/$f | cut -c1-64) $(cmp -s $A/$f $B2/$f && echo IDENTICAL-in-build-2 || echo DIFFER)"; done
python3 - $A/manifest.json $B2/manifest.json <<'PY'
import json,sys
a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2])); em=a['expectedMeasurement']
print("prediction 4 vCPU :", em['byVcpus']['4']); print("build 2 agrees    :", em['byVcpus']['4']==b['expectedMeasurement']['byVcpus']['4'])
print("ovmf              :", em['ovmf'], em['ovmfSha256'][:16]); print("overlay           :", a['supervisorOverlay']['commit'], "dirty", a['supervisorOverlay']['dirty'], "reproducible", a['reproducible'])
print("overlay files equal across the two builds:", a['supervisorOverlay']['files']==b['supervisorOverlay']['files'])
print("images            :", a['images']['supervisor']['ref'][-16:], a['images']['wasmManager']['ref'][-16:])
PY
P=$(python3 -c "import json;print(json.load(open('$A/manifest.json'))['expectedMeasurement']['byVcpus']['4'])")
H=$(~/.local/bin/sev-snp-measure --mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU --ovmf $OVMF --kernel $A/vmlinuz --initrd $A/initramfs.cpio.gz --append "console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app" --output-format hex 2>&1 | tail -1)
echo "by hand           : $H"; [ "$P" = "$H" ] && echo "HAND == MANIFEST" || echo "MISMATCH"; echo $P > $EV/prediction.txt
