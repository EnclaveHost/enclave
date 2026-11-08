#!/bin/bash
# offlinetrim.sh NAME QCOW2 : export, fsck -n, punch bitmap-free ranges, fsck -n, close, qemu-img check.
set -u; S=$(dirname "$0"); N=$1; Q=$2; M=$S/ot-$N; mkdir -p $M; touch $M/d.raw
log() { echo "$(date -u +%T) $N $*"; }
log "start: file $(du -BG $Q | cut -f1)"
qemu-storage-daemon --blockdev driver=file,node-name=f,filename=$Q,discard=unmap --blockdev driver=qcow2,node-name=q,file=f,discard=unmap --export type=fuse,id=e,node-name=q,mountpoint=$M/d.raw,writable=on --daemonize --pidfile $M/qsd.pid 2>&1 | grep -v allow_other
close() { kill $(cat $M/qsd.pid); while kill -0 $(cat $M/qsd.pid) 2>/dev/null; do python3 -c 'import time;time.sleep(1)'; done; }
e2fsck -fn $M/d.raw > $M/fsck1.log 2>&1; rc=$?; log "fsck before rc=$rc $(tail -1 $M/fsck1.log)"
[ $rc -eq 0 ] || { log "ABORT: not clean, nothing punched"; close; exit 1; }
python3 -I $S/punchfree.py $M/d.raw 2>&1 | sed "s/^/$(date -u +%T) $N /"; prc=${PIPESTATUS[0]}
e2fsck -fn $M/d.raw > $M/fsck2.log 2>&1; rc=$?; log "fsck after rc=$rc $(tail -1 $M/fsck2.log)"
close; qemu-img check -q $Q > $M/check.log 2>&1; log "qemu-img check rc=$? punch rc=$prc; file now $(du -BG $Q | cut -f1)"
