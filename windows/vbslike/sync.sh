#!/bin/sh
# Copy the host crate (sources only) and the built guest pieces to the box's isolated directory and
# run the Windows-side build. Nothing under C:\Users\claude\vbs (the live node) is touched.
#   usage: sync.sh [host]     (host = minipc | minipc-zt; default minipc-zt)
set -e
here=$(cd "$(dirname "$0")" && pwd)
H=${1:-minipc-zt}
R='C:/Users/claude/vbs-like'
ssh "$H" 'New-Item -ItemType Directory -Force C:\Users\claude\vbs-like\host\src, C:\Users\claude\vbs-like\windows\vbslike\verify, C:\Users\claude\vbs-like\isolation\contract, C:\Users\claude\vbs-like\isolation\m2, C:\Users\claude\vbs-like\relay, C:\Users\claude\vbs-like\apps, C:\Users\claude\vbs-like\out | Out-Null'
scp -q "$here/host/Cargo.toml" "$H:$R/host/"
scp -q "$here"/host/src/*.rs "$H:$R/host/src/"
scp -q "$here/build-win.cmd" "$here/run-lab.cmd" "$H:$R/"
[ -f "$here/evidence/initramfs.cpio.gz" ] && scp -q "$here/evidence/initramfs.cpio.gz" "$H:$R/initramfs.cpio.gz"
[ -f "$here/apps/appA.bin" ] && scp -q "$here"/apps/appA.bin "$here"/apps/appB.bin "$here"/apps/expected.json "$H:$R/apps/"
# the verifier tree mirrors the repository layout: judge-hv.mjs imports the Linux judge's checkRuntime and
# the contract mirror by the same relative paths as in the repo
scp -q "$here"/verify/*.mjs "$H:$R/windows/vbslike/verify/"
scp -q "$here/../../isolation/contract/runtime.mjs" "$H:$R/isolation/contract/"
scp -q "$here/../../isolation/m2/judge.mjs" "$H:$R/isolation/m2/"
scp -q "$here/../../relay/snp-verify.mjs" "$H:$R/relay/"
# the runtime identity the image carries, so the lab can pin exactly it
if [ -f "$here/evidence/mon.cpio.gz" ]; then
  t=$(mktemp -d); (cd "$t" && zcat "$here/evidence/mon.cpio.gz" | cpio -id --quiet plat/rt/runtime.json 2>/dev/null)
  scp -q "$t/plat/rt/runtime.json" "$H:$R/apps/runtime.json"; rm -rf "$t"
fi
echo synced to $H:$R
