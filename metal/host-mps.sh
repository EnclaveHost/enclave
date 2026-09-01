#!/bin/sh
# Host MPS stack for a metal box's shielded worker — the desktop adaptation of
# mps-daemon/entrypoint.sh (the hosted fleet's sidecar). Same design, same
# doctrine, smaller surface:
#
#   * control daemon on a PRIVATE pipe directory under $XDG_RUNTIME_DIR — short
#     because the control socket lives at <pipe>/control and Unix socket paths
#     cap at ~108 bytes (a longer directory makes the daemon log its banner and
#     die without a word — measured on warden-host 2026-09-01), private so the
#     desktop's own CUDA apps (games, torch) never attach by accident: only a
#     process launched with this CUDA_MPS_PIPE_DIRECTORY joins, and on a metal
#     box that is exactly the shielded worker (enclave-metal.mjs computeShare).
#   * HEALTH is judged by ATTACH, not by chat — the same /mps-probe doctrine as
#     the fleet: get_server_list can answer happily while every attach on the
#     node hangs (2026-08-07). The probe does a real cuInit + primary-context
#     retain through this pipe under timeout(1); only a HANG counts toward a
#     bounce, and it takes two strikes, because a first attach can legitimately
#     be slow and one slow probe must not cost the worker its context.
#   * NO bounce-order files: orders exist on the fleet because an in-place
#     container update strands a dead generation's device memory behind a
#     healthy attach. A metal host has no container generations — the worker is
#     one process the launcher respawns — so the only bouncer here is the
#     wedge detector itself. A bounce kills the worker's CUDA context; the
#     worker dies with it and enclave-metal.mjs respawns it within seconds
#     onto the fresh daemon. That is the designed recovery path.
#
# Install (user unit, beside enclave-metal):
#   cp metal/systemd/enclave-mps.user.service ~/.config/systemd/user/enclave-mps.service
#   systemctl --user daemon-reload && systemctl --user enable --now enclave-mps
set -eu

RUN_DIR="${ENCLAVE_MPS_RUN_DIR:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/enclave-mps}"
export CUDA_MPS_PIPE_DIRECTORY="$RUN_DIR"
export CUDA_MPS_LOG_DIRECTORY="${ENCLAVE_MPS_LOG_DIR:-$RUN_DIR/log}"
PROBE_TIMEOUT="${MPS_PROBE_TIMEOUT_S:-90}"
PROBE_INTERVAL="${MPS_PROBE_INTERVAL_S:-30}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROBE_SRC="$HERE/../mps-daemon/probe.c"
PROBE_BIN="${MPS_PROBE_BIN:-$RUN_DIR/mps-probe}"

mkdir -p "$CUDA_MPS_PIPE_DIRECTORY" "$CUDA_MPS_LOG_DIRECTORY"

# The attach probe, compiled here on first run (it dlopens libcuda.so.1 at
# runtime, so plain cc with no CUDA SDK is enough — same as the sidecar build).
if [ ! -x "$PROBE_BIN" ]; then
  echo "[mps] building attach probe from $PROBE_SRC"
  cc -O2 -o "$PROBE_BIN" "$PROBE_SRC" -ldl || { echo "[mps] probe build FAILED"; exit 1; }
fi

kill_mps() {
  # comm(2) truncates both daemon and server names to "nvidia-cuda-mps"; only
  # OUR stack though — match on the pipe dir in cmdline/environ where we can,
  # but MPS servers inherit the daemon's env, so the env check is sufficient.
  for p in /proc/[0-9]*; do
    [ "$(cat "$p/comm" 2>/dev/null)" = "nvidia-cuda-mps" ] || continue
    if tr '\0' '\n' < "$p/environ" 2>/dev/null | grep -qx "CUDA_MPS_PIPE_DIRECTORY=$CUDA_MPS_PIPE_DIRECTORY"; then
      kill -9 "${p#/proc/}" 2>/dev/null || true
    fi
  done
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
    # kill -9 cannot move a server stuck in D-state on the device; only a GPU
    # reset (or a reboot) can, and on a desktop that is the operator's call
    echo "[mps] FAILED to restart daemon (a server stuck in D-state needs a GPU reset)"
  fi
}

echo "[mps] starting control daemon (pipe=$CUDA_MPS_PIPE_DIRECTORY)"
nvidia-cuda-mps-control -d || { echo "[mps] FAILED to start daemon"; exit 1; }
trap 'echo quit | timeout 10 nvidia-cuda-mps-control >/dev/null 2>&1 || true; kill_mps' EXIT

hangs=0
while true; do
  # Liveness, BOUNDED: an unguarded pipe write could itself block forever on a
  # wedged daemon and take this loop with it.
  if ! echo get_server_list | timeout 10 nvidia-cuda-mps-control >/dev/null 2>&1; then
    echo "[mps] daemon not answering — restarting"
    bounce
    hangs=0
    sleep "$PROBE_INTERVAL"
    continue
  fi
  # Health: a real attach through the pipe.
  set +e
  timeout -k 5 "$PROBE_TIMEOUT" "$PROBE_BIN" >/dev/null 2>&1
  rc=$?
  set -e
  case "$rc" in
    0) hangs=0 ;;
    1) hangs=0; echo "[mps] probe: driver error under load (not a wedge; not bouncing)" ;;
    2) hangs=0; echo "[mps] probe: no usable libcuda on this host" ;;
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
