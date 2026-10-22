#!/usr/bin/env bash
# Negative controls: re-introduce the OLD slash-stripped id at ONE call site at a time (seams kept); the B7 test must fail.
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021; C=$H/compose2; cd "$C"
R=network/host-services/runner.mjs; S=network/host-services/stage-tool.mjs
declare -A M F
M[runner-gate]="s|hostId: cfg.host.endpoint ? registryIdOfEndpoint(cfg.host.endpoint) : null,|endpoint: cfg.host.endpoint,|"; F[runner-gate]=$R
M[runner-endpoint]="s|host: { endpoint: cfg.host.endpoint ? String(cfg.host.endpoint) : null,|host: { endpoint: cfg.host.endpoint ? String(cfg.host.endpoint).replace(/\\\\/+\$/, '') : null,|"; F[runner-endpoint]=$R
M[health-gate]="s|hostId: registryIdOfEndpoint(cfg.host.endpoint), stateDir: tmp|endpoint: cfg.host.endpoint, stateDir: tmp|"; F[health-gate]=$S
M[capture-id]="s|  const hostId = registryIdOfEndpoint(endpoint);|  const hostId = hostIdOfEndpoint(endpoint);|"; F[capture-id]=$S
bad=0
for k in ${ONLY:-"${!M[@]}"}; do
  f=${F[$k]}; cp "$f" /tmp/b7-orig.mjs     # compose2's own bytes (stage-tool there = main + e49 + this patch)
  sed -i "${M[$k]}" "$f"
  if cmp -s "$f" /tmp/b7-orig.mjs; then echo "$k: sed NOT applied"; bad=1; continue; fi
  node --test test/host-services-registry-id.test.mjs > "$H/logs/b7-control-$k.out" 2>&1; rc=$?
  n=$(grep -c '^not ok' "$H/logs/b7-control-$k.out")
  [ $rc -ne 0 ] && [ "$n" -gt 0 ] && echo "$k: KILLED ($n failing)" || { echo "$k: SURVIVED"; bad=1; }
  cp /tmp/b7-orig.mjs "$f"
done
cmp "$H/tree/$R" "$R" || bad=1; sha256sum "$S" > "$H/logs/b7-control-stage-tool.sha256"; echo "restored, bad=$bad"; exit $bad
