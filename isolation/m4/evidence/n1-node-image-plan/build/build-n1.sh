#!/usr/bin/env bash
# N1 (enclave-87 approved plan 4b4f91e9): the metal-iso0 node image with the guest-certificate retry, from 2492e683
# (origin/isolation/guestcert-retry-e63). build-cc.sh's exact command (the same SUP/WASM/TCB/OVMF pins), TWICE, from TWO
# clean worktrees at DIFFERENT paths; the two must be identical; the hand measurement must equal the manifest; the cpio
# diff against the live f6cbd75a image must be /app/supervisor.js + opt/metal/manifest.json only. Idle class under a
# guard (MemAvailable >= 30 GiB, memory PSI full avg10 <= 1.0; a breach kills the build). INERT: nothing references
# the output (~/enclave-prod/dist-iso-2492e683) until N1-b.
set -euo pipefail
C=2492e68346597de6050763849cc0175fb8bce1ba
N=~/enclave-bench/n1-20260926; EV=$N/build; B1=/home/steven/Projects/enclave-build-${C:0:8}; B2=$N/other/checkout/path/src
OUT1=/home/steven/enclave-prod/dist-iso-${C:0:8}; OUT2=$EV/dist-2; LIVE=/home/steven/Projects/enclave/metal/dist-iso-f6cbd75a
SUP=ghcr.io/enclavehost/enclave-supervisor@sha256:2f8e84f803eb058a9cff18aa4e44dcb236cf0d326cf1c95ab59f69816d8131f4
WASM=ghcr.io/enclavehost/enclave-wasm-manager@sha256:460240856a31722907514cbd6efe0c4ef2d1f58b23b0d9ac1cf721aa25d994e4
TCB=/home/steven/.cache/enclave-isolation/m3-clean/min-tcb.json; OVMF=/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd
[ "$(git -C /home/steven/Projects/enclave rev-parse $C)" = "$C" ] && git -C /home/steven/Projects/enclave merge-base --is-ancestor $C origin/isolation/guestcert-retry-e63 || { echo "$C is not on origin/isolation/guestcert-retry-e63"; exit 2; }
[ "$(sha256sum < $TCB | cut -c1-64)" = fe90824f469db17cad41a895f45803d66bef5058ff829e36302fe35328179d9c ] || { echo "min-tcb is not fe90824f"; exit 2; }
[ "$(sha256sum < $OVMF | cut -c1-64)" = 142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9 ] || { echo "OVMF is not 142589cc"; exit 2; }
for o in $OUT1 $OUT2; do [ -e "$o" ] && { echo "REFUSING: $o exists"; exit 1; }; done
guard_ok() { local a f; a=$(awk '/^MemAvailable/{print int($2/1024)}' /proc/meminfo); f=$(awk '/^full /{for(i=1;i<=NF;i++) if($i ~ /^avg10=/){split($i,x,"="); print x[2]}}' /proc/pressure/memory)
  [ "$a" -ge 30720 ] && awk -v f="$f" 'BEGIN{exit !(f+0 <= 1.0)}' || { echo "GUARD: MemAvailable ${a} MiB, PSI full avg10 $f"; return 1; }; }
guard_ok || { echo "REFUSING to start: the guard"; exit 3; }
mkdir -p $EV "$(dirname $B2)"
for B in $B1 $B2; do
  [ -e "$B" ] || flock /tmp/enclave-git-cleanup.lock git -C /home/steven/Projects/enclave worktree add -q --detach "$B" "$C"
  [ "$(git -C $B rev-parse HEAD)" = "$C" ] && [ -z "$(git -C $B status --porcelain)" ] || { echo "the worktree $B is not clean at $C"; exit 2; }
done
for n in 1 2; do
  B=$([ $n = 1 ] && echo $B1 || echo $B2); out=$([ $n = 1 ] && echo $OUT1 || echo $OUT2)
  echo "build $n from $B start $(date -u +%H:%M:%SZ)"
  ( cd $B && exec setsid nice -n 19 ionice -c3 node metal/build-image.mjs --supervisor $SUP --wasm $WASM --supervisor-overlay $B --isolation snp-guest-per-app \
    --isolation-min-tcb $TCB --ovmf $OVMF --out $out > $EV/image-build-$n.log 2>&1 ) & bp=$!
  while kill -0 $bp 2>/dev/null; do
    guard_ok || { kill -TERM -- -$bp 2>/dev/null || kill -TERM $bp; wait $bp 2>/dev/null; echo "build $n ABORTED by the guard"; rm -rf "$out"; exit 4; }
    sleep 5
  done
  wait $bp || { echo "build $n FAILED (see image-build-$n.log)"; tail -5 $EV/image-build-$n.log; exit 3; }
  echo "build $n done $(date -u +%H:%M:%SZ)"
done
git -C $B1 status --porcelain | head -3; git -C $B2 status --porcelain | head -3
for f in vmlinuz initramfs.cpio.gz cmdline; do echo "$f: $(sha256sum $OUT1/$f | cut -c1-64) $(cmp -s $OUT1/$f $OUT2/$f && echo IDENTICAL-in-build-2 || echo DIFFER)"; done
python3 - $OUT1/manifest.json $OUT2/manifest.json $LIVE/manifest.json <<'PY'
import json,sys
a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2])); l=json.load(open(sys.argv[3])); em=a['expectedMeasurement']
print("prediction 4 vCPU :", em['byVcpus']['4']); print("build 2 agrees    :", em['byVcpus']['4']==b['expectedMeasurement']['byVcpus']['4'])
print("ovmf              :", em['ovmf'], em['ovmfSha256'][:16]); print("overlay           :", a['supervisorOverlay']['commit'], "dirty", a['supervisorOverlay']['dirty'], "reproducible", a['reproducible'])
print("overlay files equal across the two builds:", a['supervisorOverlay']['files']==b['supervisorOverlay']['files'])
lf={f['path']:f['sha256'] for f in l['supervisorOverlay']['files']}; af={f['path']:f['sha256'] for f in a['supervisorOverlay']['files']}
print("overlay vs live f6cbd75a: differ =", sorted(p for p in set(lf)|set(af) if lf.get(p)!=af.get(p)))
print("images            :", a['images']['supervisor']['ref'][-16:], a['images']['wasmManager']['ref'][-16:], "(live:", l['images']['supervisor']['ref'][-16:], l['images']['wasmManager']['ref'][-16:]+")")
PY
P=$(python3 -c "import json;print(json.load(open('$OUT1/manifest.json'))['expectedMeasurement']['byVcpus']['4'])")
H=$(~/.local/bin/sev-snp-measure --mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU --ovmf $OVMF --kernel $OUT1/vmlinuz --initrd $OUT1/initramfs.cpio.gz --append "console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app" --output-format hex 2>&1 | tail -1)
echo "by hand           : $H"; [ "$P" = "$H" ] && echo "HAND == MANIFEST" || echo "MISMATCH"; echo $P > $EV/prediction.txt
# the cpio (newc) diff against the LIVE image: which entries differ (name, mode, data sha256)
python3 - $LIVE/initramfs.cpio.gz $OUT1/initramfs.cpio.gz <<'PY'
import gzip,hashlib,sys
def ents(p):
    d=gzip.open(p).read(); o=0; out={}
    while o < len(d):
        if d[o:o+6] not in (b'070701',b'070702'): o+=1; continue   # between concatenated archives (padding)
        h=d[o:o+110]; f=[int(h[6+8*i:14+8*i],16) for i in range(13)]; mode,fsz,nsz=f[1],f[6],f[11]
        o+=110; name=d[o:o+nsz-1].decode(); o=(o+nsz+3)&~3; data=d[o:o+fsz]; o=(o+fsz+3)&~3
        if name=='TRAILER!!!': continue
        out[name]=(mode,hashlib.sha256(data).hexdigest())
    return out
a=ents(sys.argv[1]); b=ents(sys.argv[2])
diff=sorted(n for n in set(a)|set(b) if a.get(n)!=b.get(n))
print("cpio entries: live %d, N1 %d; differing: %s" % (len(a),len(b),diff))
PY
echo "N1 build done $(date -u +%H:%M:%SZ)"
