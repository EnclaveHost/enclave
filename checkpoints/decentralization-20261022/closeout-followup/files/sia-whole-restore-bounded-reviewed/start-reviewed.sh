#!/usr/bin/env bash
set -uo pipefail
for attempt_no in 1 2 3 4 5 6; do
  python3 work/claude-test-queue.py --mib 1024 --log "work/resume-after-checkpoint-20261022/sia-whole-restore-bounded-reviewed/start-reviewed-${attempt_no}.guard.log" -- python3 -I work/resume-after-checkpoint-20261022/sia-whole-restore-bounded-reviewed/whole_restore.py start --run work/private/sia-whole-restore-vm/20261023T032514Z-fccd01cf --target vm --vm-root /home/storageadmin --ssh-dest storageadmin@127.0.0.1 --ssh-port 32422 --ssh-identity /home/steven/.ssh/minipc --ssh-known-hosts work/storage-vm/known_hosts --binary work/resume-after-checkpoint-20261022/sia-whole-bucket-recovery/target/x86_64-unknown-linux-gnu/debug/sia-s3 --binary-sha 3ef760ede4e46b5a944f429a78706b0822900434246bd8a24aeb22ceaba388aa --max-total-bytes 23000000000 --deadline-secs 14400 --memory-max-mib 768 --cpu-quota 100 --bridge maxConns=128
  result=$?
  if [ "$result" -ne 98 ]; then exit "$result"; fi
  sleep 2
done
exit 98
