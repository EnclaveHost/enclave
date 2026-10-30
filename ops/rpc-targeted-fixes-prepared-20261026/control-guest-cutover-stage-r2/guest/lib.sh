# shellcheck shell=bash
# Sourced by every r2 guest script (never run alone). Strict mode; names/hashes only - no value of any variable, key, token,
# credential or env file is ever printed or written (env values are compared as salted sha256 on the guest).
set -euo pipefail; umask 077; export LC_ALL=C
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Test seam: CUTOVER_TEST_ROOT points every absolute path into a temp tree, and is refused unless systemctl/journalctl/curl
# all resolve to stubs inside that tree (so a test run can never touch the real unit). Empty in production.
R=${CUTOVER_TEST_ROOT:-}
if [ -n "$R" ]; then
  [[ "$R" == /tmp/?* && -d "$R" && ! -L "$R" ]] || { echo "CUTOVER_TEST_ROOT must be an existing real dir under /tmp" >&2; exit 64; }
  for t in systemctl journalctl curl getent; do p=$(command -v "$t" || true)
    [[ "$p" == "$R"/* ]] || { echo "test root: $t resolves to '$p', not a stub under $R - refusing" >&2; exit 64; }; done
  SETTLE=0 OBSERVE_SECS=1 EXPECTED=$R/expected-live.txt
else SETTLE=5 OBSERVE_SECS=300 EXPECTED=$HERE/../EXPECTED-LIVE.txt; fi
UNIT=enclave-api-relay.service
LIVE=$R/opt/nan-relay
DROPD=$R/etc/systemd/system/$UNIT.d
DROPIN=$DROPD/50-chain-authority.conf
PINS=$R/etc/enclave-cutover
STATE=$R/var/lib/enclave-cutover
PROC=$R/proc
CADDY=$R/etc/enclave-control-tls/caddy.json
PROVIDER_NAMES="BASE_RPC RPC_FALLBACKS SECRETS_RELEASE_CATALOG_RPCS CUSTODY_RPCS CUSTODY_MIN_AGREE SESSIONS_RPC"
AUTH_NAMES="ENCLAVE_CHAIN_AUTHORITY ENCLAVE_CHAIN_VERIFIER ENCLAVE_CHAIN_TX_BACKEND"
VOLATILE_NAMES="INVOCATION_ID JOURNAL_STREAM SYSTEMD_EXEC_PID"     # systemd sets new values on every start
AUTH_LINE='[chain] relay chain authority: local verifier '          # relay/api-relay.js:336 @ 12b41d459
# exit codes shared by all scripts
RC_HOLD=3 RC_ROLLED_BACK=5 RC_ROLLBACK_FAILED=8 RC_MISMATCH=9 RC_NOEXECUTE=10
say() { printf '%s\n' "$*"; }
hold() { say "[HOLD] $*"; exit $RC_HOLD; }
mismatch() { say "[MISMATCH] $*"; exit $RC_MISMATCH; }
fsha() { local s; s=$(sha256sum < "$1") || return 1; printf '%s\n' "${s%% *}"; }
is_sha() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }
loopback_url() { [[ "$1" =~ ^http://127\.0\.0\.1:[0-9]{2,5}/?$ ]]; }
private_url() { [[ "$1" =~ ^http://(127(\.[0-9]{1,3}){3}|10(\.[0-9]{1,3}){3}|192\.168(\.[0-9]{1,3}){2}|172\.(1[6-9]|2[0-9]|3[01])(\.[0-9]{1,3}){2}):[0-9]{2,5}/?$ ]]; }
hostport() { local u=${1#http://}; printf '%s\n' "${u%/}"; }
unit_inv() { local i; i=$(systemctl show -p InvocationID --value $UNIT) || return 1; [[ "$i" =~ ^[0-9a-f]{32}$ ]] || return 1; printf '%s\n' "$i"; }
unit_pid() { local p; p=$(systemctl show -p MainPID --value $UNIT) || return 1; [[ "$p" =~ ^[1-9][0-9]*$ ]] || return 1; printf '%s\n' "$p"; }
inv_journal() { journalctl "_SYSTEMD_INVOCATION_ID=$1" -o cat --no-pager; }   # ONLY lines of that exact unit invocation
salted() { local s; s=$(cat "$1") || return 1; [ -n "$s" ] || return 1; printf '%s:%s' "$s" "$2" | sha256sum | cut -d' ' -f1; }
# "NAME <salted sha256 of value>" for every variable of the running unit (volatile systemd names skipped), sorted
env_hashes() { # <salt file>
  local pid kv n; pid=$(unit_pid) || return 1; [ -r "$PROC/$pid/environ" ] || return 1
  while IFS= read -r -d '' kv; do n=${kv%%=*}; case " $VOLATILE_NAMES " in *" $n "*) continue;; esac
    printf '%s %s\n' "$n" "$(salted "$1" "${kv#*=}")"; done < "$PROC/$pid/environ" | sort
}
# "sha256  relpath" for every file of the live release (node_modules excluded) - the relay/deploy.sh manifest format
live_manifest() { ( cd "$LIVE" && find . -path ./node_modules -prune -o ! -type d -printf '%P\n' | sort | while IFS= read -r f; do sha256sum -- "$f"; done ); }
dropins_manifest() { ( [ -d "$DROPD" ] || exit 0; cd "$DROPD" && find . -maxdepth 1 ! -type d -printf '%P\n' | sort | while IFS= read -r f; do sha256sum -- "$f"; done ); }
others_manifest() { local k p h s; while read -r k p h; do [ "$k" = file ] || continue; s=$(fsha "$R$p") || return 1; printf '%s  %s\n' "$s" "$p"; done < "$EXPECTED"; }
# deploy.sh 12b41d459 rules: line 287 path pattern, lines 155-156 sha256sum -c --strict and no file outside the manifest
manifest_paths_ok() { local s f; [ -s "$1" ] || return 1
  while read -r s f; do is_sha "$s" && [[ "$f" =~ ^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)?$ && "$f" != *..* ]] || return 1; done < "$1"; }
stage_ok() { ( cd "$1" && sha256sum -c --quiet --strict .deploy-manifest >/dev/null 2>&1 &&
  diff <(find . -type f ! -name .deploy-manifest | sed 's|^\./||' | sort) <(awk '{print $2}' .deploy-manifest | sort) >/dev/null ); }
baseline_ok() { [ -d "$1" ] && [ -s "$1/BASELINE.sha256" ] && ( cd "$1" && sha256sum -c --quiet --strict BASELINE.sha256 >/dev/null 2>&1 ); }
ack_get() { # <baseline dir> <key>: value from root's approval file /etc/enclave-cutover/ACK-<baseline id>
  local f; f=$PINS/ACK-$(basename "$1"); [ -f "$f" ] || return 1; sed -n "s/^$2=\([0-9a-f]\{64\}\)\$/\1/p" "$f" | head -n 1 | grep .; }
dropin_text() { printf '[Service]\nEnvironment=ENCLAVE_CHAIN_AUTHORITY=verifier\nEnvironment=ENCLAVE_CHAIN_VERIFIER=%s\nEnvironment=ENCLAVE_CHAIN_TX_BACKEND=%s\nUnsetEnvironment=%s\n' "$1" "$2" "$PROVIDER_NAMES"; }
# After activation: every baseline value preserved (salted hash), provider names gone, authority names = expected. Names only.
env_check() { # <baseline> <verifier url> <tx backend url>
  local now n h v bad=""; now=$(env_hashes "$1/salt") || { say "  cannot read the running environment"; return 1; }
  while read -r n h; do case " $PROVIDER_NAMES $AUTH_NAMES " in *" $n "*) continue;; esac
    grep -qxF "$n $h" <<<"$now" || bad+=" $n(lost-or-changed)"; done < "$1/env.hashes"
  while read -r n h; do case " $AUTH_NAMES " in *" $n "*) continue;; esac
    grep -q "^$n " "$1/env.hashes" || bad+=" $n(new)"; done <<<"$now"
  for n in $PROVIDER_NAMES; do if grep -q "^$n " <<<"$now"; then bad+=" $n(still-set)"; fi; done
  for n in $AUTH_NAMES; do case $n in ENCLAVE_CHAIN_AUTHORITY) v=verifier;; ENCLAVE_CHAIN_VERIFIER) v=$2;; *) v=$3;; esac
    grep -qxF "$n $(salted "$1/salt" "$v")" <<<"$now" || bad+=" $n(not-expected)"; done
  [ -z "$bad" ] || { say "  environment check failed for:$bad"; return 1; }
}
