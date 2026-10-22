#!/usr/bin/env bash
# Runs nonce-series.mjs from the control VM (the relay's vantage, script piped on stdin; nothing written there) and the
# workstation, concurrently. -> nonce-series.json
cd /home/steven/Documents/Codex/2026-10-18/wo
D=work/enclavedns-upload-502-20261021/ca-fallback
timeout 200 ssh -p32423 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/control-vm/known_hosts -i /home/steven/.ssh/minipc controladmin@127.0.0.1 'node --input-type=module - control-vm' < $D/nonce-series.mjs > $D/ns-vm.json 2> $D/ns-vm.err &
timeout 200 node $D/nonce-series.mjs workstation > $D/ns-ws.json 2> $D/ns-ws.err &
wait
python3 -c "import json;print(json.dumps([json.load(open('$D/ns-vm.json')) if open('$D/ns-vm.json').read().strip() else {'vantage':'control-vm','error':open('$D/ns-vm.err').read()[-300:]}, json.load(open('$D/ns-ws.json'))],indent=1))" > $D/nonce-series.json
