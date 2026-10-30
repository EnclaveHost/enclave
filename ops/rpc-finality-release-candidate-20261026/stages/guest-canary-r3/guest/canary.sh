#!/bin/bash
# guest/canary.sh ID (guest, ROOT, via `sudo -n bash -s ID < canary.sh`; r3; PREPARED, NOT run). r3: the bundle is r10's own manifest
# bytes in the /opt/enclave-rpc layout (bundle/opt/...), helios path+sha from HELIOS.txt (r10 manifest), initial + recheck-capture +
# finality-core compatibility in ONE scope (2700 s); runtime identities are RECORDED here and decided by r10's own runtime_accepted.
# Bounded, private, NON-production:
#   /var/lib/enclave-rpc/canary-ID (0700 root) <- the uploaded bundle (/run/enclave-canary-ID/bundle.tar + BUNDLE.sha256) and the PINNED
#   weak-subjectivity checkpoint record + its provenance (checkpoint.json 2e8502e6..., provenance.json c8629825...), used UNCHANGED,
#   own CL/EL only (127.0.0.1:15052 / :18645), Helios on 127.0.0.1:18550, transient scope MemoryMax=512M MemorySwapMax=0 CPUQuota=100%,
#   timeout 1500 s. No production path, unit, flag or config is written; production service PIDs must be unchanged at the end.
set -uo pipefail
ID=${1:?id}; [[ $ID =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || { echo "SETUP bad id"; exit 20; }
U=/run/enclave-canary-$ID; R=/var/lib/enclave-rpc; C=$R/canary-$ID; UNIT=enclave-a1-canary-$ID
die() { echo "SETUP $*"; echo "## canary rc=20"; exit 20; }
pids() { for u in enclave-l1-el enclave-l1-cl enclave-rpc-base-snapshot enclave-rpc-fwd-l1-el enclave-rpc-fwd-l1-cl; do echo "$u $(systemctl show $u -p MainPID --value)"; done; }
[ "$(id -u)" = 0 ] || die "not root"
[ -s $U/bundle.tar ] && [ -s $U/BUNDLE.sha256 ] && [ -s $U/HELIOS.txt ] && [ -s $U/checkpoint.json ] && [ -s $U/provenance.json ] || die "upload incomplete in $U"
[ "$(sha256sum < $U/checkpoint.json | cut -c1-64)" = 2e8502e68864abb49a230a69612bd7c98c94775d8dd81f956a0185d53652ac33 ] || die "checkpoint record is not the pinned 2e8502e6"
[ "$(sha256sum < $U/provenance.json | cut -c1-64)" = c862982520d65e81041f24162f29dd9d71839161ece6b06e559f9af822c1974d ] || die "provenance is not the pinned c8629825"
# ---- 0 preflight (read-only) ----
pids > $U/pids-before.txt
for x in /usr/bin/node /usr/lib/x86_64-linux-gnu/libnode.so.109 /usr/bin/python3.12; do echo "$x $(readlink -f $x) $(sha256sum < "$(readlink -f $x)" | cut -c1-64)"; done > $U/runtime-observed.txt
[ "$(getconf GNU_LIBC_VERSION)" = "glibc 2.39" ] || die "glibc"
for p in 15052 18645; do ss -ltnH "sport = :$p" | grep -q "127.0.0.1:$p" || die "own L1 listener :$p missing"; done
[ -z "$(ss -ltnH 'sport = :18550')" ] || die "18550 taken"
[ ! -e $C ] || die "$C exists"
[ "$(df --output=avail -k / | tail -1)" -ge 2097152 ] || die "< 2 GiB free on /"
CREATED_R=0; [ -e $R ] || { mkdir -m 0755 $R && CREATED_R=1; }; echo $CREATED_R > $U/created-parent
mkdir -m 0700 $C $C/opt $C/opt/a1-capture $C/etc $C/l1 $C/l1/data $C/l1/home $C/captures $C/tmp $C/out || die "mkdir"
chmod 0700 $C/l1/data $C/l1/home
# ---- 1 bundle: extract, then every byte against BUNDLE.sha256 ----
tar -x -C $C/tmp -f $U/bundle.tar --no-same-owner || die "untar"
(cd $C/tmp/bundle && sed 's#  #  ./#' $U/BUNDLE.sha256 | sha256sum -c --quiet) || die "bundle bytes != BUNDLE.sha256"
cp -a $C/tmp/bundle/opt/. $C/opt/ || die "install bundle"
chown -R root:root $C; chmod -R go-w $C; rm -rf $C/tmp/bundle
read HREL HSHA < $U/HELIOS.txt; [[ $HREL =~ ^opt/a1-capture/bin/helios-[A-Za-z0-9._-]+$ && $HSHA =~ ^[0-9a-f]{64}$ ]] || die "HELIOS.txt"; H=$C/$HREL
[ "$(sha256sum < $H | cut -c1-64)" = $HSHA ] || die "helios != r10 manifest pin"
ldd $H > $C/out/helios-ldd.txt 2>&1; grep -q 'not found' $C/out/helios-ldd.txt && { echo "INCOMPATIBLE helios loader closure on this guest:"; grep 'not found' $C/out/helios-ldd.txt; die "helios needs the libraries above (no pin/binary change made)"; }
# ---- 2 the PINNED historical checkpoint (unchanged bytes): provenance agreement, then OUR CL/EL must hold it ----
install -m 0600 $U/checkpoint.json $C/etc/l1-checkpoint.json || die "checkpoint copy"
python3.12 -I - $C $U/checkpoint.json $U/provenance.json <<'PYCK' || die "checkpoint"
import json, sys, urllib.request, urllib.error
from urllib.parse import urlsplit
C, rec, prov = sys.argv[1], json.load(open(sys.argv[2])), json.load(open(sys.argv[3]))
root, slot = rec['root'], rec['slot']
# (a) provenance: every record source has its HTTP 200 observation (same ref + observedAt) naming THIS root/epoch;
#     >= 2 distinct hosts and not only our own beacon (l1_authority.py `check` re-applies its schema/age/provenance rules below)
obs = {(o['url'], o['observedAt']): o for o in prov}
agree = []
for s in rec['sources']:
    o = obs.get((s['ref'], s['observedAt'])); f = ((o or {}).get('body') or {}).get('data', {}).get('finalized') or {}
    if not o or str(o.get('http')) != '200' or f.get('root') != root or int(f.get('epoch', -1)) * 32 != slot:
        raise SystemExit(f'provenance does not show source {s["ref"]} agreeing on {root}/{slot}')
    agree.append((s['kind'], urlsplit(s['ref']).hostname))
if len({h for _k, h in agree}) < 2 or all(k == 'own-lighthouse' for k, _h in agree):
    raise SystemExit('fewer than two distinct agreeing sources')
# (b) OUR CL: the canonical historical block for the root, at the epoch boundary or the last block before it (skipped slots)
g = lambda p: json.load(urllib.request.urlopen('http://127.0.0.1:15052' + p, timeout=10))
def header_at(n):
    try: return g(f'/eth/v1/beacon/headers/{n}')['data']
    except urllib.error.HTTPError as e:
        if e.code == 404: return None
        raise
h = g(f'/eth/v1/beacon/headers/{root}')['data']; hs = int(h['header']['message']['slot'])
if h.get('canonical') is not True or not slot - 32 < hs <= slot:
    raise SystemExit(f'own CL: root {root} is at slot {hs} (canonical={h.get("canonical")}), not the canonical block for boundary {slot}')
for n in range(hs + 1, slot + 1):
    x = header_at(n)
    if x is not None and x.get('canonical') is True:
        raise SystemExit(f'own CL has a canonical block at slot {n} between the checkpoint block {hs} and the boundary {slot}')
fin = int(g('/eth/v1/beacon/headers/finalized')['data']['header']['message']['slot'])
if fin < slot:
    raise SystemExit(f'own CL finalized slot {fin} is below the checkpoint slot {slot}')
# (c) OUR EL holds the checkpoint block's execution payload
pl = g(f'/eth/v2/beacon/blocks/{root}')['data']['message']['body']['execution_payload']
rpc = lambda m, p: json.load(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18645', json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': m, 'params': p}).encode(),
                                                     {'content-type': 'application/json'}), timeout=10))['result']
el = rpc('eth_getBlockByHash', [pl['block_hash'], False])
if not el or int(el['number'], 16) != int(pl['block_number']):
    raise SystemExit('own EL does not hold the checkpoint block payload')
elf = rpc('eth_getBlockByNumber', ['finalized', False])
json.dump({'checkpoint': {'root': root, 'slot': slot, 'recordedAt': rec['recordedAt']}, 'agreeingSources': agree, 'clCheckpointBlockSlot': hs,
           'clFinalizedSlot': fin, 'checkpointPayload': {'number': int(pl['block_number']), 'hash': pl['block_hash']},
           'elFinalized': {'number': int(elf['number'], 16), 'hash': elf['hash']}}, open(f'{C}/out/l1-consistency.json', 'w'), indent=1)
PYCK
# ---- 3 canary-only configs (never /etc/enclave-rpc) ----
cat > $C/etc/l1-authority.json <<J
{"format": "enclave-l1-authority/v1", "network": "mainnet", "binary": {"path": "$H", "sha256": "$HSHA"},
 "consensusRpc": "http://127.0.0.1:15052", "executionRpc": "http://127.0.0.1:18645", "listen": {"ip": "127.0.0.1", "port": 18550},
 "dataDir": "$C/l1/data", "homeDir": "$C/l1/home", "checkpointFile": "$C/etc/l1-checkpoint.json", "maxCheckpointAgeSec": 604800, "maxFinalizedAgeSec": 1800, "logFilter": "info"}
J
O=$C/opt/a1-capture
cat > $C/etc/a1-capture-sources.json <<J
{"format": "enclave-a1-capture-sources/v1", "initialDir": "$O/l1-anchor-a1", "recheckDir": "$O/a1-original-game-prepared", "l1Authority": "$O/l1_authority.py",
 "l1Config": "$C/etc/l1-authority.json", "portalResult": "$O/inputs/portal-result.json", "depsRoot": "$O/deps", "node": "/usr/bin/node", "elUrl": "http://127.0.0.1:18645"}
J
chmod 0600 $C/etc/*.json
/usr/bin/python3.12 -I -B $O/l1_authority.py check $C/etc/l1-authority.json > $C/out/l1-authority-check.json || die "l1_authority check refused (see out/l1-authority-check.json)"
# ---- 4 the real capture + verify, bounded and owned ----
date -u +%FT%TZ > $C/out/started.utc
systemd-run --quiet --unit=$UNIT --scope -p MemoryMax=512M -p MemorySwapMax=0 -p CPUQuota=100% \
  timeout -k 30 2700 /usr/bin/python3.12 -I -B $U/canary_driver.py $C $C/etc/a1-capture-sources.json > $C/out/driver.out 2>&1; rc=$?
date -u +%FT%TZ > $C/out/finished.utc
# ---- 5 owned cleanup + invariants ----
systemctl stop $UNIT.scope 2>/dev/null; sleep 2
[ -z "$(ss -ltnH 'sport = :18550')" ] && echo "18550 released" > $C/out/listener-after.txt || { echo "18550 STILL BOUND" > $C/out/listener-after.txt; rc=1; }
pids > $U/pids-after.txt; cmp -s $U/pids-before.txt $U/pids-after.txt || { echo "PRODUCTION PIDS CHANGED"; diff $U/pids-before.txt $U/pids-after.txt; rc=1; }
cp $U/pids-before.txt $U/pids-after.txt $U/runtime-observed.txt $C/out/
tar -C $C -cf $U/result.tar out captures && echo "result $U/result.tar"
echo "## canary rc=$rc"; exit $rc
