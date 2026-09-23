#!/bin/sh
# Copy the host crate (sources only) and the built guest pieces to the box's isolated directory and
# run the Windows-side build. Nothing under C:\Users\claude\vbs (the live node) is touched.
#   usage: sync.sh [host]     (host = minipc | minipc-zt; default minipc-zt)
set -e
here=$(cd "$(dirname "$0")" && pwd)
H=${1:-minipc-zt}
R='C:/Users/claude/vbs-like'
ssh "$H" 'New-Item -ItemType Directory -Force C:\Users\claude\vbs-like\host\src, C:\Users\claude\vbs-like\verify, C:\Users\claude\vbs-like\apps, C:\Users\claude\vbs-like\out | Out-Null'
scp -q "$here/host/Cargo.toml" "$H:$R/host/"
scp -q "$here"/host/src/*.rs "$H:$R/host/src/"
scp -q "$here/build-win.cmd" "$here/run-lab.cmd" "$H:$R/"
[ -f "$here/evidence/initramfs.cpio.gz" ] && scp -q "$here/evidence/initramfs.cpio.gz" "$H:$R/initramfs.cpio.gz"
[ -f "$here/apps/appA.bin" ] && scp -q "$here"/apps/appA.bin "$here"/apps/appB.bin "$here"/apps/expected.json "$H:$R/apps/"
scp -q "$here"/verify/*.mjs "$H:$R/verify/" 2>/dev/null || true
echo synced to $H:$R
