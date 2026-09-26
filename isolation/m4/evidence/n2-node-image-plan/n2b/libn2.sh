# N2-b (sourced LAST, after ../pool-rollout-20260925/lib.sh, ../s4c-20260925/lib4cc.sh and ../e7-20260926/lib-e7.sh): the node
# image swap f6cbd75a -> N2 (dist-iso-6845565a: the guest-certificate retry + the next chain rev's node half, judge.mjs
# 650b931d + supervisor-guestcert.mjs 1b91d464), enclave-87's approved plan abb87c12 (N2-b DIRECTLY, N1-b skipped). ONLY
# config.iso.json's `dist` changes; the launcher (metal-578be084, 4620da5d) and its drop-in stay exactly as they are.
N2D=~/enclave-bench/n2-20260926; LOGN=$N2D/n2b.log
OLDD=/home/steven/Projects/enclave/metal/dist-iso-f6cbd75a; OLDC=f6cbd75ae0c2a44163db95b657b351da7504c2d1
OLDM=02f6e313a2c03f7f163426e03154654233ac6d8ac9bcc00f598ff94f3a1f596312f8849ea7419db0c4425bdf13bdde8b
NEWD=/home/steven/enclave-prod/dist-iso-6845565a; NEWC=6845565a9dc0df5d8b469b8f2e74699c1aaa3444
NEWM=fab9c6c76aca8d7650c05d5efdddc27b4b5aa76e7d81cd5c97365458513aedcf70ffe7d2817ac3836575b34917954bb0
N1M=b2dba54a92de62850f2624da3e84912ae940da8e966155d1e03f51d6bb580797841f90bd9c3d35ef893f60c7d04a27df   # allowlisted, N1 (5d GO), not swapped to
CBN=$EV/secret/config.iso.json.bak-pre-n2b; TOKN=$EV/secret/n2b-rollback-token
# the launcher stays: 4c-c-b's worktree and blob (lib4cc.sh's LW / LAUNCH_SHA), asserted, never changed
LW=/home/steven/enclave-prod/metal-578be084; LAUNCH_SHA=4620da5da0b4bf3e7e6c7a531d5957d96511b480b715ed6a1b260dc53a947196
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOGN"; } 2>/dev/null || true; }
# the built image is the reviewed one: the manifest predicts NEWM for 4 vCPUs with overlay NEWC, clean, and the three
# node files are b4's manifest's (item 3)
check_image_n2() {
  [ -f "$NEWD/manifest.json" ] || { say "no $NEWD/manifest.json"; return 1; }
  python3 - "$NEWD/manifest.json" "$NEWM" "$NEWC" <<'PY' || { say "the N2 image's manifest is not the reviewed one"; return 1; }
import json,sys
m=json.load(open(sys.argv[1])); o=m['supervisorOverlay']; f={x['path']:x['sha256'] for x in o['files']}
assert m['expectedMeasurement']['byVcpus']['4']==sys.argv[2] and o['commit']==sys.argv[3] and o['dirty'] is False and m['reproducible'] is True
assert m['expectedMeasurement']['ovmfSha256'].startswith('142589cc')
assert f['/app/isolation/m2/judge.mjs']=='650b931d32ef72c84459141f6deeaf0f5a7a4e8c6441ac95f47f4bd8a624f1dd'
assert f['/app/isolation/m4/guestd/supervisor-guestcert.mjs']=='1b91d46464d60ed46ff2fce43fbe53b95a5c276c7cffd0e6ff4517b4c20c83ca'
assert f['/app/supervisor.js']=='04c4993d80ea44690c3250ee6dacf65847e9d64729b1914a005986cb4d333312'
PY
  local s; s=$(sha256sum < "$NEWD/initramfs.cpio.gz" | cut -c1-64); [ "$s" = 7ad3dae8c7728b670dc4a02247b39128b825532f563c7cda13b65e9962b36942 ] || { say "the N2 initramfs is not 7ad3dae8"; return 1; }
}
# the relay's node allowlist (nan, api-relay.env) lists N2 AND the live f6cbd75a (the rollback target); an unreadable
# answer is not a yes
allow_has() { local l; l=$($NAN "grep '^METAL_ALLOWED_MEASUREMENTS=' /etc/nan-relay/api-relay.env" 2>/dev/null) || return 1
  local x; for x in "$@"; do grep -q "$x" <<<"$l" || return 1; done; }
# every canary's /v1/expected-guest lists 5db18199 admitted (their release), from the relay's public answer
eg_canaries_ok() { local cid; for cid in $CAN; do curl -sS --max-time 30 "https://api.enclave.host/v1/expected-guest?id=$cid" 2>/dev/null \
  | python3 -c "import json,sys; r=json.load(sys.stdin); sys.exit(0 if r.get('id','').lower()==sys.argv[1] and any(i.get('release')=='5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77' and i.get('releaseAdmitted') is True for i in r.get('images',[])) else 1)" "$cid" 2>/dev/null || return 1; done; }
# the published availability, unchanged by a node restart: 64 GiB / 16, the 3 canaries' draw, free 0.7
avail_n2() { curl -sS --max-time 20 https://api.enclave.host/t/metal-iso0/availability | python3 -c "import json,sys; a=json.load(sys.stdin); g=a.get('guestPool') or {}; sys.exit(0 if g.get('heard') and a.get('nodeRamGb')==64 and a.get('nodeVcpus')==16 and g.get('budget')=={'memMiB':65536,'cpuPct':1600} and g.get('free')=={'memMiB':60160,'cpuPct':1300} and abs(a.get('cpuShareFree',0)-0.7)<1e-9 else 1)" 2>/dev/null; }
# the host memory gate (plan §3): the node CVM re-takes its 6 GiB at the restart; guestd's floor and its pending draw
# must still fit; memory PSI avg60 0
mem_gate() {
  local a p; a=$(awk '/^MemAvailable/{print int($2/1024)}' /proc/meminfo)
  p=$(python3 -c "import json; h=json.load(open('$ST/.guestd.json'))[0]['body']; print(int((h.get('pool') or {}).get('host',{}).get('pendingMiB')))" 2>/dev/null) || { say "mem gate: guestd's pendingMiB unreadable"; return 1; }
  [ $(( a - 6144 )) -ge $(( 16384 + p )) ] || { say "mem gate: MemAvailable $a MiB - 6144 < 16384 + pending $p"; return 1; }
  awk 'BEGIN{f=1} /^some /{for(i=1;i<=NF;i++) if($i ~ /^avg60=/){split($i,x,"="); f=(x[2]+0==0)?0:1}} END{exit f}' /proc/pressure/memory || { say "mem gate: memory PSI avg60 not 0"; return 1; }
}
