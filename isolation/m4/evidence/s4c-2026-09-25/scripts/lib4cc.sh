# 4c-c (sourced AFTER ../pool-rollout-20260925/lib.sh): the RELEASE-CAPABLE node image f6cbd75a (its 8 supervisor files = b18f8989's;
# gsup passes ISOLATION_RELEASE=1 when the host config's isolation.release is true), replacing 4c's b3109929 (the floor merge's
# supervisor half, d1's row-6 cert check 059fdec5, the launch-spec guard). Its gate needs the relay's /v1/expected-guest
# (LIVE since 21:02Z, the relay slice). S2's pattern: 4c-a adds the measurement to the relay allowlist beside the S2
# and pre-pool entries (both kept for their soak); 4c-b points dist at the image and restarts the node CVM.
S4C=~/enclave-bench/s4c-20260925; LOGC=$S4C/rollout-cc.log
S2M=10622d989bf4f5f3dc560dd237a845684dbda66269e43f2b2b22b82e6956eca3e4289d8d62e99dc118d51f2a49633782    # kept (S2, c42612c0)
PREM=04e953a4f856c817bd061e3fa91004c78be75f6a9951be44a02805fdd788f19c56c84b046d0fca6aa2085a6f7b99fc7b   # kept (pre-pool)
OLDM=8ab7a1590fad444c53e8bec7a08ea44452e78ed68a30de2283d599879b69feb84cb7fd0bc1cc3aa903514ab7443c30bf   # live (4c, b3109929)
OLDD=/home/steven/Projects/enclave/metal/dist-iso-b3109929; OLDC=b31099294b4916a32f9f43989044c525ca121d7a
NEWD=/home/steven/Projects/enclave/metal/dist-iso-f6cbd75a; NEWC=f6cbd75ae0c2a44163db95b657b351da7504c2d1   # 87e881a2 (gsup release opt-in) + b3109929
NEWM=$(cat $S4C/build-cc/prediction.txt)
ALLOW_NOW="$PREM,$S2M,$OLDM"; ALLOW_NEW="$PREM,$S2M,$OLDM,$NEWM"
CB4=$EV/secret/config.iso.json.bak-pre-4cc
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOGC"; } 2>/dev/null || true; }
# the prediction is the image's own (two identical builds, the hand computation, the overlay = b18f8989, clean)
check_prediction4c() {
  [[ "$NEWM" =~ ^[0-9a-f]{96}$ ]] && [ "$NEWM" != "$OLDM" ] && [ "$NEWM" != "$PREM" ] && [ "$NEWM" != "$S2M" ] || { say "BAD prediction.txt"; return 1; }
  python3 -c "import json,sys; m=json.load(open('$NEWD/manifest.json')); o=m['supervisorOverlay']; sys.exit(0 if m['expectedMeasurement']['byVcpus']['4']=='$NEWM' and m['expectedMeasurement']['ovmfSha256'].startswith('142589cc') and o['commit']=='$NEWC' and o['dirty'] is False and m['reproducible'] is True else 1)" \
    || { say "the image's manifest does not predict prediction.txt with overlay $NEWC"; return 1; }
}
allowlist() { $NAN "grep '^METAL_ALLOWED_MEASUREMENTS=' /etc/nan-relay/api-relay.env"; }
# the published availability after 4c: the pool as before, and NOW the floor's verdict (the 4c supervisor mirrors it)
avail4c() { curl -sS --max-time 20 https://api.enclave.host/t/metal-iso0/availability | python3 -c "import json,sys; a=json.load(sys.stdin); g=a.get('guestPool') or {}; sys.exit(0 if g.get('heard') and a.get('nodeRamGb')==64 and a.get('nodeVcpus')==16 and g.get('budget')=={'memMiB':65536,'cpuPct':1600} and g.get('free')=={'memMiB':60160,'cpuPct':1300} and abs(a.get('cpuShareFree',0)-0.7)<1e-9 and g.get('host')=={'floorMiB':16384,'admitsSmallestGuest':True} else 1)"; }
avail_before() { avail4c; }   # since 4c the published availability already carries the floor verdict
