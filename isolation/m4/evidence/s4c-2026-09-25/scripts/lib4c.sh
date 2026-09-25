# 4c (sourced AFTER ../pool-rollout-20260925/lib.sh): the node image whose supervisor overlay is b3109929 (= b18f8989's 8 files) (the floor merge's
# supervisor half, d1's row-6 cert check 059fdec5, the launch-spec guard). Its gate needs the relay's /v1/expected-guest
# (LIVE since 21:02Z, the relay slice). S2's pattern: 4c-a adds the measurement to the relay allowlist beside the S2
# and pre-pool entries (both kept for their soak); 4c-b points dist at the image and restarts the node CVM.
S4C=~/enclave-bench/s4c-20260925; LOGC=$S4C/rollout.log
OLDM=10622d989bf4f5f3dc560dd237a845684dbda66269e43f2b2b22b82e6956eca3e4289d8d62e99dc118d51f2a49633782   # live (S2, c42612c0)
PREM=04e953a4f856c817bd061e3fa91004c78be75f6a9951be44a02805fdd788f19c56c84b046d0fca6aa2085a6f7b99fc7b   # kept (pre-pool)
OLDD=/home/steven/Projects/enclave/metal/dist-iso-c42612c0; OLDC=c42612c0b814591497640aee2ad5113444254a9e
NEWD=/home/steven/Projects/enclave/metal/dist-iso-b3109929; NEWC=b31099294b4916a32f9f43989044c525ca121d7a   # b18f8989 + -ffile-prefix-map (d1: v1 was path-dependent)
NEWM=$(cat $S4C/build-v2/prediction.txt)   # 8ab7a159...bf: 3 checkout paths agree (63's two, d1's own)
CB4=$EV/secret/config.iso.json.bak-pre-4c
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOGC"; } 2>/dev/null || true; }
# the prediction is the image's own (two identical builds, the hand computation, the overlay = b18f8989, clean)
check_prediction4c() {
  [[ "$NEWM" =~ ^[0-9a-f]{96}$ ]] && [ "$NEWM" != "$OLDM" ] && [ "$NEWM" != "$PREM" ] || { say "BAD prediction.txt"; return 1; }
  python3 -c "import json,sys; m=json.load(open('$NEWD/manifest.json')); o=m['supervisorOverlay']; sys.exit(0 if m['expectedMeasurement']['byVcpus']['4']=='$NEWM' and m['expectedMeasurement']['ovmfSha256'].startswith('142589cc') and o['commit']=='$NEWC' and o['dirty'] is False and m['reproducible'] is True else 1)" \
    || { say "the image's manifest does not predict prediction.txt with overlay $NEWC"; return 1; }
}
allowlist() { $NAN "grep '^METAL_ALLOWED_MEASUREMENTS=' /etc/nan-relay/api-relay.env"; }
# the published availability after 4c: the pool as before, and NOW the floor's verdict (the 4c supervisor mirrors it)
avail4c() { curl -sS --max-time 20 https://api.enclave.host/t/metal-iso0/availability | python3 -c "import json,sys; a=json.load(sys.stdin); g=a.get('guestPool') or {}; sys.exit(0 if g.get('heard') and a.get('nodeRamGb')==64 and a.get('nodeVcpus')==16 and g.get('budget')=={'memMiB':65536,'cpuPct':1600} and g.get('free')=={'memMiB':60160,'cpuPct':1300} and abs(a.get('cpuShareFree',0)-0.7)<1e-9 and g.get('host')=={'floorMiB':16384,'admitsSmallestGuest':True} else 1)"; }
avail_before() { curl -sS --max-time 20 https://api.enclave.host/t/metal-iso0/availability | python3 -c "import json,sys; a=json.load(sys.stdin); g=a.get('guestPool') or {}; sys.exit(0 if g.get('heard') and a.get('nodeRamGb')==64 and a.get('nodeVcpus')==16 and abs(a.get('cpuShareFree',0)-0.7)<1e-9 and 'host' not in g else 1)"; }
