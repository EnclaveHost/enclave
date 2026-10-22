#!/usr/bin/env bash
# ROOT runs this on its workstation for ONE front at a time (existing ssh alias = that front's root login):
#   bash activate-front.sh <alias> check                 stage a NEW run dir on the front, verify the staged bytes, front-activate.py --mode check
#   bash activate-front.sh <alias> activate <run-id>     front-activate.py --mode activate in that already-checked run dir
#   bash activate-front.sh <alias> rollback <run-id>     front-activate.py --mode rollback (restores that run's backup by CAS)
# The run dir is /root/ens-site-activation/<run-id> (0700, create-only). Every staged file's sha256 is compared ON the front
# with the pinned local stage/ before anything runs. Output: logs/<alias>-<run-id>-<mode>.json (the program's one JSON line).
set -euo pipefail
cd "$(dirname "$0")"
A=${1:?alias}; MODE=${2:?mode}; RUN=${3:-}
case "$A" in us-west|ca-east|ap-southeast|eu-central) ;; *) echo "refused: unknown front $A"; exit 2 ;; esac
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 "$A")
mkdir -p logs
if [ "$MODE" = check ]; then
  [ -z "$RUN" ] || { echo "usage: check takes no run id (a new one is created)"; exit 2; }
  RUN=ens-$(date -u +%Y%m%dT%H%M%SZ)
  "${SSH[@]}" "mkdir -p -m 0700 /root/ens-site-activation && mkdir -m 0700 /root/ens-site-activation/$RUN"
  scp -q -o BatchMode=yes stage/* "$A:/root/ens-site-activation/$RUN/"
  want=$(cd stage && sha256sum * | sort -k2)
  got=$("${SSH[@]}" "cd /root/ens-site-activation/$RUN && sha256sum * | sort -k2")
  [ "$want" = "$got" ] || { echo "REFUSED: the staged files on $A are not the local pinned stage/"; exit 2; }
  echo "run-id $RUN (staged, bytes verified)"
else
  [[ "$RUN" =~ ^ens-[0-9]{8}T[0-9]{6}Z$ ]] || { echo "usage: $MODE needs the run id printed by check"; exit 2; }
  case "$MODE" in activate|rollback) ;; *) echo "usage: check | activate <run-id> | rollback <run-id>"; exit 2 ;; esac
  want=$(cd stage && sha256sum * | sort -k2); got=$("${SSH[@]}" "cd /root/ens-site-activation/$RUN && sha256sum front-activate.py snippet.caddy extract-site-blocks.mjs blocks-manifest.json pins.json | sort -k2")
  [ "$want" = "$got" ] || { echo "REFUSED: the run dir's program/pins on $A are not the local pinned stage/"; exit 2; }
fi
set +e
"${SSH[@]}" "cd /root/ens-site-activation/$RUN && timeout 900 python3 front-activate.py --mode $MODE" | tee "logs/$A-$RUN-$MODE.json"
rc=${PIPESTATUS[0]}; set -e
echo "exit $rc ($A $RUN $MODE)"; exit $rc
