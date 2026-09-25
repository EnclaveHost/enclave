# Shared for the relay expected-guest slice rollout (Codex: the next scoped relay stage; release stays 503 until U7).
RS=~/enclave-bench/relay-slice-20260925; LOG=$RS/rollout.log
NAN="ssh -i $HOME/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 nan"
MAIN=/home/steven/Projects/enclave
SLICE=$(git -C $MAIN rev-parse aeb345e6); BASE=779e5944ad7b48b38aed0a9c2b9b37bb85518e21
LINES_SHA=57eb01565dd77049469b8bf61c9ea41588f0ba5e75f8ac97bfdd91cdef353fbb   # predict.env's 11 setting lines (package 1aeadff4 = nan's staged copy)
CONF_SHA=146e686d031a1f807157c990bd70e65f319c347d2fef010a0014b078f6056cf3    # predict.conf (package 1aeadff4)
STAGED=/opt/enclave-predict/829c09adb176/predict.env; ENVF=/etc/nan-relay/api-relay.env
DROPIN=/etc/systemd/system/enclave-api-relay.service.d/predict.conf
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOG"; } 2>/dev/null || true; }
serving_nodes() { curl -sS --max-time 20 https://api.enclave.host/enclaves | python3 -c "import json,sys; print(sum(1 for e in json.load(sys.stdin).get('enclaves',[]) if e.get('serving')))"; }
