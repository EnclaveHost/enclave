#!/bin/bash
# start|stop the two V100 workers with shared-memory rings on /dev/shm.
# Rebuilt 2026-09-23 after the scratchpad (tmpfs) was lost in an unclean reboot:
# the command line is the one the running workers had before the reboot
# (pgrep: --port 960N --vram-gb 30 --shm /dev/shm/enclave-shielded-shm/card-N),
# W= overrides the binary, and the caller's environment (SHIELDED_YIELD, ...)
# passes through unchanged, as the lost workers-shm2.sh was used.
S=/home/steven/enclave-bench/b27
W=${W:-/home/steven/Projects/enclave/shielded/worker-cuda/shielded-worker}
case "$1" in
  start)
    CUDA_VISIBLE_DEVICES=GPU-1397d8cd-27ae-e1a6-a7ed-e485e7ca002c nohup $W --port 9601 --vram-gb 30 --shm /dev/shm/enclave-shielded-shm/card-0 >> $S/worker1-shm.log 2>&1 &
    echo $! > $S/worker1.pid
    CUDA_VISIBLE_DEVICES=GPU-042eb279-e6e6-9866-5823-015b8d26946a nohup $W --port 9602 --vram-gb 30 --shm /dev/shm/enclave-shielded-shm/card-1 >> $S/worker2-shm.log 2>&1 &
    echo $! > $S/worker2.pid
    sleep 4; ss -ltn | grep -E '9601|9602' | wc -l ;;
  stop)
    for p in $S/worker1.pid $S/worker2.pid; do [ -f $p ] && kill $(cat $p) 2>/dev/null; rm -f $p; done; sleep 2; echo stopped ;;
esac
