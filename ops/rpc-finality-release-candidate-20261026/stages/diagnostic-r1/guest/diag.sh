#!/bin/bash
# guest/diag.sh ID (guest, ROOT, via `sudo -n bash -s ID < diag.sh`; PREPARED, NOT run). Bounded, private, READ-ONLY toward production:
# no production path/unit/config/flag is written, nothing is restarted. Own CL :15052 / EL :18645 only; no public RPC.
#  0 preflight + host-state snapshot (loadavg, PSI cpu/io/memory, Base extraction state, free)
#  A direct own-EL timings (el_probe.mjs) in scope MemoryMax=256M CPUQuota=100%
#  B Helios (the r3 bundle's pinned helios via its l1_authority.py, pinned checkpoint 2e8502e6) with executionRpc = a transparent
#    logging relay 127.0.0.1:18646 -> 127.0.0.1:18645 (rpc_log_proxy.py, its own 128M scope), the probe in the Helios scope exactly as
#    the A1 reader was; variant Q=100 (the canary's CPUQuota) then Q=400 (controlled comparison only); scope cpu.stat/memory.* recorded.
set -uo pipefail
ID=${1:?id}; [[ $ID =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || { echo "SETUP bad id"; exit 20; }
U=/run/enclave-diag-$ID; R=/var/lib/enclave-rpc; C=$R/diag-$ID; S=enclave-a1-diag-$ID
die() { echo "SETUP $*"; echo "## diag rc=20"; exit 20; }
pids() { for u in enclave-l1-el enclave-l1-cl enclave-rpc-base-snapshot enclave-rpc-fwd-l1-el enclave-rpc-fwd-l1-cl; do echo "$u $(systemctl show $u -p MainPID --value)"; done; }
state() { date -u +%FT%TZ; cat /proc/loadavg; nproc; for r in cpu io memory; do echo "== psi $r"; cat /proc/pressure/$r; done
          systemctl show enclave-rpc-base-snapshot enclave-l1-el -p Id -p ActiveState -p SubState -p CPUUsageNSec; free -m; }
[ "$(id -u)" = 0 ] || die "not root"
for f in bundle.tar BUNDLE.sha256 HELIOS.txt checkpoint.json el_probe.mjs helios_probe.mjs rpc_log_proxy.py; do [ -s $U/$f ] || die "upload $f missing"; done
[ "$(sha256sum < $U/checkpoint.json | cut -c1-64)" = 2e8502e68864abb49a230a69612bd7c98c94775d8dd81f956a0185d53652ac33 ] || die "checkpoint is not the pinned 2e8502e6"
pids > $U/pids-before.txt
for p in 15052 18645; do ss -ltnH "sport = :$p" | grep -q "127.0.0.1:$p" || die "own L1 listener :$p missing"; done
for p in 18550 18646; do [ -z "$(ss -ltnH "sport = :$p")" ] || die "$p taken"; done
[ ! -e $C ] || die "$C exists"; [ "$(df --output=avail -k / | tail -1)" -ge 2097152 ] || die "< 2 GiB free on /"
CREATED_R=0; [ -e $R ] || { mkdir -m 0755 $R && CREATED_R=1; }; echo $CREATED_R > $U/created-parent
mkdir -m 0700 $C $C/opt $C/etc $C/l1 $C/tmp $C/out || die mkdir
tar -x -C $C/tmp -f $U/bundle.tar --no-same-owner || die untar
(cd $C/tmp/bundle && sed 's#  #  ./#' $U/BUNDLE.sha256 | sha256sum -c --quiet) || die "bundle bytes != BUNDLE.sha256"
cp -a $C/tmp/bundle/opt/. $C/opt/ && rm -rf $C/tmp/bundle && chown -R root:root $C && chmod -R go-w $C || die "install bundle"
read HREL HSHA < $U/HELIOS.txt; [[ $HREL =~ ^opt/a1-capture/bin/helios-[A-Za-z0-9._-]+$ && $HSHA =~ ^[0-9a-f]{64}$ ]] || die HELIOS.txt; H=$C/$HREL
[ "$(sha256sum < $H | cut -c1-64)" = $HSHA ] || die "helios pin"
K=$C/opt/finality/deps/node_modules/@noble/hashes/sha3.js; [ -f $K ] || die "noble sha3"
install -m 0600 $U/checkpoint.json $C/etc/l1-checkpoint.json || die checkpoint
state > $C/out/state-0-before.txt 2>&1
# ---- A: direct own-EL timings ----
systemd-run --quiet --unit=$S-el --scope -p MemoryMax=256M -p MemorySwapMax=0 -p CPUQuota=100% \
  timeout -k 10 900 env -i PATH=/usr/bin:/bin K=file://$K /usr/bin/node $U/el_probe.mjs http://127.0.0.1:18645 $C/out/el-probe.json > $C/out/el-probe.out 2>&1
echo "elProbe rc=$?" >> $C/out/rc.txt; systemctl stop $S-el.scope 2>/dev/null
state > $C/out/state-1-after-el.txt 2>&1
# ---- B: Helios call flow through the logging relay, Q=100 then Q=400 ----
for Q in 100 400; do
  mkdir -m 0700 $C/l1/data-$Q $C/l1/home-$Q || die "mkdir $Q"
  cat > $C/etc/l1-authority-$Q.json <<J
{"format": "enclave-l1-authority/v1", "network": "mainnet", "binary": {"path": "$H", "sha256": "$HSHA"},
 "consensusRpc": "http://127.0.0.1:15052", "executionRpc": "http://127.0.0.1:18646", "listen": {"ip": "127.0.0.1", "port": 18550},
 "dataDir": "$C/l1/data-$Q", "homeDir": "$C/l1/home-$Q", "checkpointFile": "$C/etc/l1-checkpoint.json", "maxCheckpointAgeSec": 604800, "maxFinalizedAgeSec": 1800, "logFilter": "info"}
J
  chmod 0600 $C/etc/l1-authority-$Q.json
  /usr/bin/python3.12 -I -B $C/opt/a1-capture/l1_authority.py check $C/etc/l1-authority-$Q.json > $C/out/l1-check-$Q.json 2>&1 || { echo "l1check-$Q refused" >> $C/out/rc.txt; continue; }
  systemd-run --quiet --unit=$S-px$Q --scope -p MemoryMax=128M -p MemorySwapMax=0 -p CPUQuota=50% \
    /usr/bin/python3.12 -I -B $U/rpc_log_proxy.py 18646 http://127.0.0.1:18645 $C/out/el-requests-$Q.jsonl > $C/out/proxy-$Q.out 2>&1 &
  for i in $(seq 50); do ss -ltnH 'sport = :18646' | grep -q 127.0.0.1:18646 && break; sleep 0.2; done
  systemd-run --quiet --unit=$S-h$Q --scope -p MemoryMax=512M -p MemorySwapMax=0 -p CPUQuota=$Q% timeout -k 30 1500 bash -c '
    /usr/bin/python3.12 -I -B "$1/opt/a1-capture/l1_authority.py" run "$1/etc/l1-authority-$2.json" > "$1/out/helios-$2.out" 2>&1 & HP=$!
    env -i PATH=/usr/bin:/bin K=file://$3 /usr/bin/node "$4/helios_probe.mjs" http://127.0.0.1:18550 "$1/out/helios-probe-$2.json" > "$1/out/helios-probe-$2.out" 2>&1
    echo "heliosProbe-$2 rc=$?" >> "$1/out/rc.txt"; CG=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)
    for f in cpu.stat memory.peak memory.events memory.pressure cpu.pressure io.pressure; do echo "== $f"; cat $CG/$f 2>/dev/null; done > "$1/out/scope-$2.txt"
    kill $HP; wait $HP' _ $C $Q $K $U
  systemctl stop $S-h$Q.scope $S-px$Q.scope 2>/dev/null; sleep 2
  for p in 18550 18646; do [ -z "$(ss -ltnH "sport = :$p")" ] || echo "$p STILL BOUND after $Q" >> $C/out/rc.txt; done
  state > $C/out/state-2-after-h$Q.txt 2>&1
done
pids > $U/pids-after.txt; cp $U/pids-before.txt $U/pids-after.txt $C/out/
cmp -s $U/pids-before.txt $U/pids-after.txt || echo "PRODUCTION PIDS CHANGED" >> $C/out/rc.txt
tar -C $C -cf $U/result.tar out && echo "result $U/result.tar"; cat $C/out/rc.txt
echo "## diag rc=0"
