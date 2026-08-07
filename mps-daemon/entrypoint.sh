#!/bin/sh
# Enclave MPS control daemon. Runs in its own GPU container so per-tenant worker
# processes (in the worker container, sharing /tmp/nvidia-mps + ipc:host) get
# hardware-enforced SM% (CUDA_MPS_ACTIVE_THREAD_PERCENTAGE) and VRAM
# (CUDA_MPS_PINNED_DEVICE_MEM_LIMIT) caps — both validated enforced under CC.
#
# HEALTH is judged by ATTACH, not by chat. `get_server_list` only proves the
# control daemon answers its pipe; on 2026-08-07 it answered happily for hours
# while every attach on the node hung — tenants blocked forever inside cuInit,
# the fleet's GPU sat empty, and the loop here saw nothing wrong. /mps-probe
# performs a real cuInit + primary-context retain through the pipe (exactly a
# tenant's first CUDA call) under timeout(1):
#   0        healthy (stamps $HEALTH_FILE for the container healthcheck)
#   1        the driver answered with an ERROR (resource pressure; NEVER
#            bounce on this — live tenants may legitimately hold the card)
#   2        environment broken (no libcuda) — log it, nothing here to fix
#   124/137  the attach HUNG: the wedge signature; two consecutive hangs
#            bounce the whole MPS stack (quit + kill + fresh daemon)
# Two strikes, because the FIRST attach after a CC boot can legitimately take
# tens of seconds (encrypted bounce-buffered init) and one slow probe must not
# cost every live tenant its context. A bounce kills every MPS server, so all
# tenant CUDA contexts die with it — their nn watchdogs abort them and the
# supervisor respawns onto the fresh daemon. That is the designed recovery
# path: worth its cost only against a wedge that would otherwise last until a
# human notices, which is why only a HANG (twice) triggers it.
set -e
export CUDA_MPS_PIPE_DIRECTORY="${CUDA_MPS_PIPE_DIRECTORY:-/tmp/nvidia-mps}"
export CUDA_MPS_LOG_DIRECTORY="${CUDA_MPS_LOG_DIRECTORY:-/tmp/nvidia-mps-log}"
PROBE_TIMEOUT="${MPS_PROBE_TIMEOUT_S:-90}"
PROBE_INTERVAL="${MPS_PROBE_INTERVAL_S:-30}"
HEALTH_FILE="${MPS_HEALTH_FILE:-/tmp/mps-attach-ok}"
mkdir -p "$CUDA_MPS_PIPE_DIRECTORY" "$CUDA_MPS_LOG_DIRECTORY"

echo "[mps] starting control daemon (pipe=$CUDA_MPS_PIPE_DIRECTORY)"
nvidia-cuda-mps-control -d || { echo "[mps] FAILED to start daemon"; exit 1; }

# Kill every MPS process, control daemon and servers alike. comm(2) truncates
# both names to 15 chars ("nvidia-cuda-mps"), which is also what makes this
# work without procps in the base image.
kill_mps() {
  for p in /proc/[0-9]*; do
    [ "$(cat "$p/comm" 2>/dev/null)" = "nvidia-cuda-mps" ] && kill -9 "${p#/proc/}" 2>/dev/null
  done
  return 0
}

bounce() {
  echo "[mps] BOUNCE: quitting the control daemon and killing MPS servers"
  echo quit | timeout 10 nvidia-cuda-mps-control >/dev/null 2>&1 || true
  sleep 1
  kill_mps
  sleep 1
  if nvidia-cuda-mps-control -d; then
    echo "[mps] fresh control daemon up"
  else
    # kill -9 cannot move a server stuck in D-state on the device; only a
    # GPU reset (or a host reboot) can, and that is an operator's call
    echo "[mps] FAILED to restart daemon (a server stuck in D-state needs a GPU reset)"
  fi
}

hangs=0
while true; do
  # Liveness, BOUNDED: the old unguarded `echo | nvidia-cuda-mps-control`
  # could itself block forever on a wedged pipe and take this loop with it.
  if ! echo get_server_list | timeout 10 nvidia-cuda-mps-control >/dev/null 2>&1; then
    echo "[mps] daemon not answering — restarting"
    bounce
    hangs=0
    sleep "$PROBE_INTERVAL"
    continue
  fi
  # Health: a real attach.
  set +e
  timeout -k 5 "$PROBE_TIMEOUT" /mps-probe >/dev/null 2>&1
  rc=$?
  set -e
  case "$rc" in
    0) hangs=0; touch "$HEALTH_FILE" ;;
    1) hangs=0; echo "[mps] probe: driver error under load (not a wedge; not bouncing)" ;;
    2) hangs=0; echo "[mps] probe: no usable libcuda in this container" ;;
    *)
      hangs=$((hangs + 1))
      echo "[mps] probe HUNG (${PROBE_TIMEOUT}s, strike $hangs/2)"
      if [ "$hangs" -ge 2 ]; then
        bounce
        hangs=0
      fi
      ;;
  esac
  sleep "$PROBE_INTERVAL"
done
