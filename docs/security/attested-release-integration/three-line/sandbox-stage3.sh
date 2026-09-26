#!/usr/bin/env bash
# Every code path of stage-release-keep3.sh and stage-retire3.sh, in a sandbox on warden-host (enclave-87). The ONLY change to
# each script: the root systemd-run sandbox is replaced by a direct run of the same check.mjs with the same env file (the check
# itself, the predictor module - nan's exact file, 5ba49756 = main 18b28218 - and the release verify are real). Real releases
# (f7888d86, 5db18199 as built) and the real catalog; synthetic ids only where a refusal needs one.
set -u
S=/tmp/claude-1000/-home-steven-Projects-enclave/fb363ddc-d505-417e-9a6b-cfe7e33f2a3b/scratchpad; O=/tmp/claude-1000/-home-steven-Projects-enclave/44a7426f-43b9-47eb-b0bf-64c73be3aa86/scratchpad
ST=/home/steven/Projects/enclave-release/docs/security/measurement-prediction/stage
MODULE=$S/wt-pc/relay/measurement-predict.mjs; VIEM=/home/steven/Projects/enclave-release/node_modules/viem; LOCAL_WORK=$S/window/xwork-5215
H=$(mktemp -d); trap 'rm -rf "$H"' EXIT; mkdir -p $H/base/work
grep -vE '^SECRETS_RELEASE_(PREDICT_RELEASES|DOMAIN_RELEASES|CERT_RELEASES|PREDICT_WORK)=' $S/check-local.env > $H/base/predict.env
cp $S/window/release-manifest.py $H/base/work/
localize() {   # $1 script -> $H/$1 with the systemd-run replaced by a direct run, the state-dir cleanup dropped
  python3 - "$ST/$1" "$H/$1" <<'PY'
import sys
s = open(sys.argv[1]).read()
a = s.index('if systemd-run --wait'); b = s.index('\n', s.index('/usr/bin/node "$DEST/check.mjs"')) + 1
env = 'CROSSCHECK="$CROSSCHECK" NEW_RELEASE="${ID:-}" KEEP_RELEASE="${keep:-}" CROSSCHECK_KEEP="${CROSSCHECK_KEEP:-}" KEEP="${KEEP:-}"'
s = s[:a] + 'if ( set -a; . "$DEST/check.env"; set +a; SECRETS_RELEASE_PREDICT_WORK=$LOCAL_WORK MODULE="$MODULE" VIEM="$VIEM" ' + env + ' node "$DEST/check.mjs" > "$DEST/CHECK.json" 2> "$DEST/CHECK.run" ); then rc=0; else rc=$?; fi\n' + s[b:]
s = "\n".join(l for l in s.split("\n") if "/var/lib/private/$U" not in l)
open(sys.argv[2], "w").write(s)
PY
}
localize stage-release-keep3.sh; localize stage-retire3.sh
K5=5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2; K6=6f14ce7537082bd2a68d96ead6a133af4a5134e97e9b43ebc210a3cb957c1adb
F=f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca; N=5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77
RF=/home/steven/enclave-bench/pub-0181bce3/cut-b63c2def/release-b63c2def; RN=/home/steven/enclave-bench/pub-0181bce3/cut-0c087de8/release-0c087de8
tar -C $RN -cf $H/rel-N.tar .; tar -C $RF -cf $H/rel-F.tar .
L() { printf 'SECRETS_RELEASE_PREDICT_RELEASES=%s\nSECRETS_RELEASE_DOMAIN_RELEASES=%s\nSECRETS_RELEASE_CERT_RELEASES=%s\n' "$1" "$2" "$3"; }
INST="$K5=$O/meas/release,$K6=$O/meas/release2,$F=$RF"
API="catalog://0x5bca36b520b80fa26272f34886e38344393e1f69098be8ad5a0d2372ec3147bc/0"
XN="$API c8ac2d720194e41668b56adbf3e4e35b35f38267f59736a3580583d42245593a5e19094a6c75828e0536321d850f0ed8"; XF=a3a4c718e812c42dba891875a25219280bd5ed0c5c0fe2a6395e680124355998fd27ebe720d4f008098b1d85ffbd5a6c
C0="catalog://0xf7e65a8fdae1dd9f8c2a897f2f372cdb7f6150d1e20526fa06d10a682cc2e9e3/4=6716ef1462e1ebabc4fd388c44dea5da1fe6902a60bedbc47aaaeae5199ee91003c8c842c34dde264b31d10c68d5871b;catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4=be2bb73c799fa8315d23101521da7f2bf944d7964a56793ce713266426af47237758961ee2b9c2ca22683e43aac13f2b"
k() {   # keep3 case: name, want rc, message, then env assignments; DEST fresh unless DEST_KEEP
  local name=$1 want=$2 msg=$3; shift 3; local d=$H/d$RANDOM; [ -n "${PREMAKE:-}" ] && mkdir -p $d
  local rc; rc=$(cd $H && env "$@" MODULE=${MODULE_O:-$MODULE} VIEM=$VIEM LOCAL_WORK=$LOCAL_WORK sh $H/stage-release-keep3.sh $d ${IDO:-$N} ${TAR:-$H/rel-N.tar} ${BASEO:-$H/base} > $H/out 2>&1; echo $?)
  local ok=$([ "$rc" = "$want" ] && grep -q "$msg" $H/out && echo PASS || echo FAIL)
  printf '%-4s keep3  %-50s rc=%-2s (want %-2s) | %s\n' "$ok" "$name" "$rc" "$want" "$(grep -E "REFUSED|STOP|FAILED|done|pass|not set" $H/out | tail -1 | cut -c1-100)"
}
r() {   # retire3 case
  local name=$1 want=$2 msg=$3; shift 3; local d=$H/r$RANDOM; [ -n "${PREMAKE:-}" ] && mkdir -p $d
  local rc; rc=$(cd $H && env "$@" MODULE=$MODULE VIEM=$VIEM LOCAL_WORK=$LOCAL_WORK sh $H/stage-retire3.sh $d ${BASEO:-$H/base} > $H/out 2>&1; echo $?)
  local ok=$([ "$rc" = "$want" ] && grep -q "$msg" $H/out && echo PASS || echo FAIL)
  printf '%-4s retire3 %-49s rc=%-2s (want %-2s) | %s\n' "$ok" "$name" "$rc" "$want" "$(grep -E "REFUSED|STOP|FAILED|done|pass" $H/out | tail -1 | cut -c1-100)"
}
echo "== stage-release-keep3.sh $(sha256sum < $ST/stage-release-keep3.sh | cut -c1-8), stage-retire3.sh $(sha256sum < $ST/stage-retire3.sh | cut -c1-8), sandbox $(date -u +%FT%TZ)"
L "$INST" "$F" "$F" > $H/before-live.env              # the live shape after cs-3/rs-8
k "success: 5db18199 beside f7888d86"          0 "done:"            BEFORE_LINES=$H/before-live.env CROSSCHECK="$XN" CROSSCHECK_KEEP=$XF
k "check fails: a wrong expected measurement"  6 "CHECK FAILED"     BEFORE_LINES=$H/before-live.env CROSSCHECK="$API $(printf '00%.0s' $(seq 48))" CROSSCHECK_KEEP=$XF
IDO=nothex k "refuse: id not 64 hex"           2 "not 64 hex"       BEFORE_LINES=$H/before-live.env CROSSCHECK="$XN" CROSSCHECK_KEEP=$XF
PREMAKE=1 k "refuse: DEST exists"              2 "exists"           BEFORE_LINES=$H/before-live.env CROSSCHECK="$XN" CROSSCHECK_KEEP=$XF
BASEO=$H/nobase k "refuse: BASE not a staging"  2 "not a predictor staging" BEFORE_LINES=$H/before-live.env CROSSCHECK="$XN" CROSSCHECK_KEEP=$XF
MODULE_O=$H/none.mjs k "refuse: no module"      2 "no "              BEFORE_LINES=$H/before-live.env CROSSCHECK="$XN" CROSSCHECK_KEEP=$XF
L "$INST" "$F" "$F" | head -2 > $H/two.env;     k "refuse: BEFORE_LINES not the three lines" 2 "not exactly the three lines" BEFORE_LINES=$H/two.env CROSSCHECK="$XN" CROSSCHECK_KEEP=$XF
L "$INST" "$F" "$K5,$F" > $H/certdiff.env;      k "refuse: live cert set != admitted set" 5 "not the admitted set" BEFORE_LINES=$H/certdiff.env CROSSCHECK="$XN" CROSSCHECK_KEEP=$XF
L "$INST" "$K5,$F" "$K5,$F" > $H/twoadm.env;    k "refuse: live admitted is not exactly one" 5 "not exactly one release" BEFORE_LINES=$H/twoadm.env CROSSCHECK="$XN" CROSSCHECK_KEEP=$XF
L "$INST,$N=$RN" "$F" "$F" > $H/inst.env;       k "refuse: the release is already installed" 5 "already installed" BEFORE_LINES=$H/inst.env CROSSCHECK="$XN" CROSSCHECK_KEEP=$XF
TAR=$H/rel-F.tar k "refuse: the tar is not this release (verify)" 4 "does not verify" BEFORE_LINES=$H/before-live.env CROSSCHECK="$XN" CROSSCHECK_KEEP=$XF
k "refuse: CROSSCHECK_KEEP missing (sh :?)"    1 "CROSSCHECK_KEEP"  BEFORE_LINES=$H/before-live.env CROSSCHECK="$XN"
L "$INST,$N=$RN" "$F,$N" "$F,$N" > $H/after9.env   # the state after rs-9
r "success: retire f7888d86, keep 5db18199"    0 "done:"            BEFORE_LINES=$H/after9.env KEEP=$N DROP=$F CROSSCHECK="$C0"
r "check fails: a wrong pin"                   6 "CHECK FAILED"     BEFORE_LINES=$H/after9.env KEEP=$N DROP=$F CROSSCHECK="${C0%%=*}=$(printf '00%.0s' $(seq 48))"
PREMAKE=1 r "refuse: DEST exists"              2 "exists"           BEFORE_LINES=$H/after9.env KEEP=$N DROP=$F CROSSCHECK="$C0"
BASEO=$H/nobase r "refuse: BASE not a staging" 2 "not a predictor staging" BEFORE_LINES=$H/after9.env KEEP=$N DROP=$F CROSSCHECK="$C0"
r "refuse: BEFORE_LINES not three lines"       2 "not exactly the three lines" BEFORE_LINES=$H/two.env KEEP=$N DROP=$F CROSSCHECK="$C0"
r "refuse: KEEP not one id"                    2 "KEEP is not one release id" BEFORE_LINES=$H/after9.env KEEP=nothex DROP=$F CROSSCHECK="$C0"
L "$INST" "$F,$N" "$F,$N" > $H/noN.env;         r "refuse: KEEP not installed" 5 "KEEP is not installed" BEFORE_LINES=$H/noN.env KEEP=$N DROP=$F CROSSCHECK="$C0"
L "$INST,$N=$RN" "$F" "$F,$N" > $H/notadm.env;   r "refuse: KEEP not admitted" 5 "KEEP is not admitted" BEFORE_LINES=$H/notadm.env KEEP=$N DROP=$F CROSSCHECK="$C0"
L "$INST,$N=$RN" "$F,$N" "$F" > $H/notcert.env; r "refuse: KEEP not in the cert set" 5 "KEEP is not in the live certificate set" BEFORE_LINES=$H/notcert.env KEEP=$N DROP=$F CROSSCHECK="$C0"
r "refuse: DROP holds KEEP"                    2 "DROP holds a non-id or KEEP" BEFORE_LINES=$H/after9.env KEEP=$N DROP=$N CROSSCHECK="$C0"
r "refuse: DROP not installed"                 5 "is not installed" BEFORE_LINES=$H/after9.env KEEP=$N DROP=$(printf 'ab%.0s' $(seq 32)) CROSSCHECK="$C0"
