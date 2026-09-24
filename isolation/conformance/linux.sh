#!/bin/sh
# The Linux half of the cross-platform conformance run (record.mjs): ONE guest image and ONE bundle set,
# the same files the NucBox partitions consume, on an SEV-SNP guest through the m3 launcher, monitor,
# forwarder and client. Every verdict comes from isolation/m2/client.mjs (judge.mjs); this script only
# drives and records. Timings are what the clock said; CONTENTION is written into the record verbatim.
#
#   usage: linux.sh <workdir> <mon.cpio.gz> <appA.bundle> <appB.bundle> <tampered.bundle> <runtime.json> <vcek.der> <min-tcb.json> "<contention note>"
set -e
here=$(cd "$(dirname "$0")" && pwd); m2=$here/../m2; m3=$here/../m3
W=$1; IMG=$2; A=$3; B=$4; TAMP=$5; RT=$6; VCEK=$7; TCB=$8; CONT=$9
mkdir -p "$W"; W=$(cd "$W" && pwd)
cp "$IMG" "$W/mon.cpio.gz"; cp "$A" "$W/appA.bundle"; cp "$B" "$W/appB.bundle"; cp "$TAMP" "$W/tampered.bundle"; cp "$RT" "$W/runtime.json"; cp "$VCEK" "$W/vcek.der"; cp "$TCB" "$W/min-tcb.json"
printf '%s\n' "$CONT" > "$W/contention.txt"
(cd "$m2" && CGO_ENABLED=0 go build -trimpath -o "$W/fwd" ./fwd)
(cd "$m3" && CGO_ENABLED=0 go build -trimpath -o "$W/m3ctl" ./m3ctl)
sha256sum "$W/mon.cpio.gz" "$W/appA.bundle" "$W/appB.bundle" > "$W/inputs.sha256"
# the launch digest the clients demand: the same prediction build-domain.sh prints, for 1 vCPU
. "$m3/../m1/domain.env"
pred=$(~/.local/bin/sev-snp-measure --mode snp --vcpus 1 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 \
  --vmm-type QEMU --ovmf "$OVMF" --kernel "$KERNEL" --initrd "$W/mon.cpio.gz" --append "$APPEND")
echo "$pred" > "$W/predicted.txt"
fwdport() { for _ in $(seq 100); do p=$(sed -n 's/^FWD listening 127.0.0.1:\([0-9]*\).*/\1/p' "$1" 2>/dev/null); [ -n "$p" ] && { echo "$p"; return; }; sleep 0.05; done; echo 0; }
dport() { sed -n 's/.*"port":\([0-9]*\).*/\1/p' "$W/$1.load"; }
client() { o=$1; f=$2; shift 2; rc=0; timeout 300 node "$m2/client.mjs" "https://127.0.0.1:$(fwdport "$f")" --measurement "$pred" "$@" > "$o" 2>&1 || rc=$?; echo "RESULT exit=$rc" >> "$o"; }

t0=$(date +%s%3N)
"$m3/run-domain.sh" start "$W/mon.cpio.gz" snp conf "$W" 1 1024 100 > "$W/conf.host" 2>&1
cid=$(sed -n 's/.* cid=\([0-9]*\).*/\1/p' "$W/conf.host")
for _ in $(seq 900); do grep -aq 'MON ready' "$W/conf.serial" 2>/dev/null && break; sleep 0.1; done
echo "boot_to_mon_ready_ms=$(( $(date +%s%3N) - t0 ))" > "$W/timings.txt"
grep -aq 'MON ready' "$W/conf.serial" || { echo "monitor never came up"; "$m3/run-domain.sh" stop conf "$W"; exit 1; }

# load the two bundles AS THEY ARE (the monitor parses the bundle itself), then the tampered one
for L in A B; do
  t=$(date +%s%3N)
  "$W/m3ctl" -cid "$cid" -label "$L" load "$W/app$L.bundle" > "$W/$L.load" 2>&1 || true
  echo "load_${L}_ms=$(( $(date +%s%3N) - t ))" >> "$W/timings.txt"
done
"$W/m3ctl" -cid "$cid" -label T load "$W/tampered.bundle" > "$W/T.load" 2>&1 || true
"$W/fwd" -cid "$cid" -port "$(dport A)" > "$W/A.fwd" 2>&1 & echo $! >> "$W/pids"
"$W/fwd" -cid "$cid" -port "$(dport B)" > "$W/B.fwd" 2>&1 & echo $! >> "$W/pids"
shaA=$(sha256sum "$W/appA.bundle" | cut -c1-64); shaB=$(sha256sum "$W/appB.bundle" | cut -c1-64)
# trusted mode with no KDS: the VCEK held from an earlier fetch, AMD's chain for this product line from the
# repository fixtures, and the box's own TCB as the floor (test-m3.sh does exactly this)
product=$(python3 -c "import json,sys;print(list(json.load(open(sys.argv[1])).keys())[0])" "$W/min-tcb.json")
TR="--no-kds --vcek $W/vcek.der --amd-chain $product=$here/../../test/fixtures/amd/$product-cert_chain.pem --min-tcb @$W/min-tcb.json --runtime $W/runtime.json"
client "$W/A.client" "$W/A.fwd" --app-sha "$shaA" $TR --perf --save "$W/A.doc.json"
client "$W/B.client" "$W/B.fwd" --app-sha "$shaB" $TR --perf --save "$W/B.doc.json"
# the wrong-app client: expecting B at A's door
client "$W/A-as-B.client" "$W/A.fwd" --app-sha "$shaB" $TR

# crash independence: a bare artifact that is not wasm makes the runtime fail and the domain retire
"$W/m3ctl" -cid "$cid" state > "$W/state-before" 2>&1 || true
printf 'this is not a wasm module' > "$W/bad.wasm"
"$W/m3ctl" -cid "$cid" -label BAD load "$W/bad.wasm" > "$W/BAD.load" 2>&1 || true
badid=$(sed -n 's/.*"id":\([0-9]*\).*/\1/p' "$W/BAD.load")
for _ in $(seq 300); do grep -aq "MON domain ${badid:-0} ended" "$W/conf.serial" 2>/dev/null && break; sleep 0.1; done
"$W/m3ctl" -cid "$cid" state > "$W/state-after-crash" 2>&1 || true
"$W/m3ctl" -cid "$cid" list > "$W/list-after-crash" 2>&1 || true
client "$W/B-after-crash.client" "$W/B.fwd" --app-sha "$shaB" $TR

# lease end: destroy A, B keeps serving, A's door is closed
"$W/m3ctl" -cid "$cid" -id 1 destroy > "$W/A.destroy" 2>&1 || true
sleep 1
curl -sk --max-time 10 "https://127.0.0.1:$(fwdport "$W/A.fwd")/hello" > "$W/A.after-destroy" 2>&1 || echo "curl_rc=$?" >> "$W/A.after-destroy"
"$W/m3ctl" -cid "$cid" list > "$W/list-after-destroy" 2>&1 || true
"$W/m3ctl" -cid "$cid" state > "$W/state-after-destroy" 2>&1 || true
client "$W/B-after-destroy.client" "$W/B.fwd" --app-sha "$shaB" $TR

for p in $(cat "$W/pids"); do kill "$p" 2>/dev/null || true; done
"$m3/run-domain.sh" stop conf "$W" >> "$W/conf.host" 2>&1 || true
echo "linux half done: $W"
