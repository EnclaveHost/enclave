#!/usr/bin/env bash
# enclave-87's three ways (+ edges) for s8t-rollback.sh's f7888d86-admitted guard, run on the block VERBATIM (awk between
# its BEGIN/END markers) with say4 stubbed and curl replaced per case: a fake relay answer, the REAL relay, or a real curl
# to a closed local port (unreachable). Exit 0 = every case as expected. Read-only: nothing is rolled back.
set -uo pipefail; D=$(cd "$(dirname "$0")" && pwd); W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
awk '/^# BEGIN f7888d86-admitted guard$/{f=1;next} /^# END f7888d86-admitted guard$/{f=0} f' $D/s8t-rollback.sh > $W/guard.sh
[ "$(grep -c . $W/guard.sh)" -gt 10 ] || { echo "the guard block was not found"; exit 2; }
OLD=f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca; NEW=5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77
cat > $W/run.sh <<EOS
#!/usr/bin/env bash
# \$1 = the curl mode; the rest of the environment (OVERRIDE*, FROM_APPLY) as the case sets it
set -uo pipefail; EV=\$(mktemp -d); MODE=\$1
say4() { echo "say: \$*" >&2; }
fake() {   # \$1 = the id; prints the relay's answer for this mode
  case \$MODE in
    post-rs10)  echo "{\"id\":\"\$1\",\"images\":[{\"release\":\"$NEW\",\"releaseAdmitted\":true}]}";;
    admitted)   echo "{\"id\":\"\$1\",\"images\":[{\"release\":\"$OLD\",\"releaseAdmitted\":true},{\"release\":\"$NEW\",\"releaseAdmitted\":true}]}";;
    one-missing) case \$1 in 0x4e62*) echo "{\"id\":\"\$1\",\"images\":[{\"release\":\"$NEW\",\"releaseAdmitted\":true}]}";;
                 *) echo "{\"id\":\"\$1\",\"images\":[{\"release\":\"$OLD\",\"releaseAdmitted\":true}]}";; esac;;
    not-admitted) echo "{\"id\":\"\$1\",\"images\":[{\"release\":\"$OLD\",\"releaseAdmitted\":false}]}";;
    wrong-id)   echo "{\"id\":\"0x$(printf 'ab%.0s' {1..32})\",\"images\":[{\"release\":\"$OLD\",\"releaseAdmitted\":true}]}";;
    malformed)  echo "<html>502 Bad Gateway</html>";;
  esac
}
case \$MODE in
  live) ;;   # the real curl, the real relay
  unreachable) curl() { local a=(); for x in "\$@"; do a+=("\${x/https:\/\/api.enclave.host/http://127.0.0.1:9}"); done; command curl "\${a[@]}"; };;
  *) curl() { local u="\${@: -1}"; fake "\${u##*id=}"; };;
esac
source $W/guard.sh
echo PASS; rm -rf "\$EV"
EOS
chmod +x $W/run.sh; bad=0
t() {   # $1 = expected PASS|REFUSE, $2 = name, $3 = mode, then VAR=value settings
  local want=$1 name=$2 mode=$3; shift 3; local out rc got
  out=$(env "$@" $W/run.sh "$mode" 2>&1); rc=$?
  if [ $rc = 0 ] && grep -qx PASS <<<"$out"; then got=PASS; elif [ $rc = 32 ]; then got=REFUSE; else got="rc$rc"; fi
  [ "$got" = "$want" ] && r=ok || { r=WRONG; bad=1; }
  printf '%-5s %-6s %s\n' "$r" "$got" "$name"
}
t REFUSE "post-rs-10 (f7888d86 retired: only 5db18199 listed)"         post-rs10
t PASS   "f7888d86 admitted for every canary (rs-10 rolled back)"       admitted
t REFUSE "relay unreachable (a real curl to a closed port)"             unreachable
t REFUSE "one canary without f7888d86"                                  one-missing
t REFUSE "f7888d86 listed but releaseAdmitted false"                    not-admitted
t REFUSE "an answer for another id"                                     wrong-id
t REFUSE "a malformed answer (502 page)"                                malformed
t REFUSE "post-rs-10 with OVERRIDE only (the canary gate's bypass)"     post-rs10 OVERRIDE=x
t PASS   "post-rs-10 with OVERRIDE_UNADMITTED (logged)"                  post-rs10 OVERRIDE_UNADMITTED=test
t PASS   "post-rs-10 from the apply's own fail() (FROM_APPLY, exempt)"  post-rs10 FROM_APPLY=tok
# the LIVE relay: before rs-10 f7888d86 is admitted (PASS); after rs-10 this case must REFUSE (LIVE_EXPECT=REFUSE)
t "${LIVE_EXPECT:-PASS}" "LIVE relay now (expect ${LIVE_EXPECT:-PASS})" live
exit $bad
