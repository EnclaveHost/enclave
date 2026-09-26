#!/usr/bin/env bash
# enclave-87's three ways (+ edges) for s9t-rollback.sh's 5db18199-admitted guard, run on the block VERBATIM (awk between
# its BEGIN/END markers) with say4 stubbed and curl replaced per case: a fake relay answer, the REAL relay, or a real curl
# to a closed local port (unreachable). Exit 0 = every case as expected. Read-only: nothing is rolled back.
set -uo pipefail; D=$(cd "$(dirname "$0")" && pwd); W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
awk '/^# BEGIN 5db18199-admitted guard$/{f=1;next} /^# END 5db18199-admitted guard$/{f=0} f' $D/s9t-rollback.sh > $W/guard.sh
[ "$(grep -c . $W/guard.sh)" -gt 10 ] || { echo "the guard block was not found"; exit 2; }
# enclave-87's hard rule (09-26): nothing here may reach production. ssh/systemctl/journalctl/sudo/node/systemd-run are
# FAILING shims that record any call, and the run asserts none was made. curl stays real ONLY for the LIVE case (a read-only
# public GET) and the unreachable case (a closed local port); every other case replaces it with a fixture function.
SHIMD=$W/shim; mkdir -p $SHIMD; CALLS=$W/calls; : > $CALLS
for c in ssh systemctl journalctl sudo node systemd-run; do printf '#!/bin/sh\necho "%s $*" >> %s\nexit 97\n' "$c" "$CALLS" > $SHIMD/$c; chmod +x $SHIMD/$c; done
NOPY=$W/nopy; mkdir -p $NOPY; printf '#!/bin/sh\nexit 127\n' > $NOPY/python3; chmod +x $NOPY/python3   # an interpreter error
export PATH="$SHIMD:$PATH"
OLD=5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77; NEW=aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532
cat > $W/run.sh <<EOS
#!/usr/bin/env bash
# \$1 = the curl mode; the rest of the environment (OVERRIDE*, FROM_APPLY) as the case sets it
set -uo pipefail; EV=\$(mktemp -d); MODE=\$1
say4() { echo "say: \$*" >&2; }
fake() {   # \$1 = the id; prints the relay's answer for this mode
  case \$MODE in
    post-rs12)  echo "{\"id\":\"\$1\",\"images\":[{\"release\":\"$NEW\",\"releaseAdmitted\":true}]}";;
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
t REFUSE "post-rs-12 (5db18199 retired: only aee2059f listed)"         post-rs12
t PASS   "5db18199 admitted for every canary (rs-12 not run, or rolled back)"       admitted
t REFUSE "relay unreachable (a real curl to a closed port)"             unreachable
t REFUSE "one canary without 5db18199"                                  one-missing
t REFUSE "5db18199 listed but releaseAdmitted false"                    not-admitted
t REFUSE "an answer for another id"                                     wrong-id
t REFUSE "a malformed answer (502 page)"                                malformed
t REFUSE "post-rs-12 with OVERRIDE only (the canary gate's bypass)"     post-rs12 OVERRIDE=x
t PASS   "post-rs-12 with OVERRIDE_UNADMITTED (logged)"                  post-rs12 OVERRIDE_UNADMITTED=test
t PASS   "post-rs-12 from the apply's own fail() (FROM_APPLY, exempt)"  post-rs12 FROM_APPLY=tok
# the LIVE relay: before rs-12 5db18199 is admitted (PASS); after rs-12 this case must REFUSE (LIVE_EXPECT=REFUSE)
t "${LIVE_EXPECT:-PASS}" "LIVE relay now (expect ${LIVE_EXPECT:-PASS})" live
t REFUSE "python3 missing (an interpreter error) with 5db18199 admitted: fails CLOSED"  admitted PATH="$NOPY:$PATH"
[ ! -s "$CALLS" ] && echo "ok    no ssh/systemctl/journalctl/sudo/node/systemd-run call was made" || { echo "WRONG a production tool was called: $(cat "$CALLS")"; bad=1; }
exit $bad
