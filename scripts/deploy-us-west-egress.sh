#!/usr/bin/env bash
# deploy-us-west-egress.sh — stand up the EGRESS relay on us-west so a
# deployment routed through us-west egresses through it too (both directions
# through the designated relay). Run from a machine that has THIS repo checked
# out AND SSH access to us-west; the shared egress token comes from nan-relay
# (or pass EGRESS_RELAY_TOKEN=... in the environment).
#
# Why us-west egress is PLAIN (no EGRESS_PREFIX): us-west owns no routed /64,
# so it can't source-bind a deployment's dedicated IPv6. The enclave (v0.5.487+)
# knows this — it sends NO source for us-west-routed deployments, and the relay
# dials out from us-west's own address. Dedicated-IP egress stays on nan-relay
# (the /64 owner) via network.relay:"nan". See egress.js / relay/egress-relay.js.
#
#   Usage:  bash scripts/deploy-us-west-egress.sh [--bootstrap] [us-west-ssh-alias]
#   Env:    EGRESS_RELAY_TOKEN  the fleet egress token (optional; else pulled
#                               from nan-relay:/etc/nan-relay/egress-relay.env)
#           NAN_RELAY           ssh alias for nan-relay (default: nan-relay)
#
# SHARED RELAY DEPENDENCIES (U7 preflight, enclave-99 and enclave-5d). /opt/nan-relay on a relay host is relay/deploy.sh's:
# it ships relay.js, api-relay.js, dns-relay.js, ... and the modules they share (fleet.mjs, net-guard.mjs, connlog.mjs,
# package.json, package-lock.json) as ONE coherent set, then npm ci and a restart of every unit. This script used to copy
# the shared modules from whatever checkout it ran in, so an old checkout silently replaced them under the SNI relay that
# fronts every app: after U7, an old fleet.mjs lacks fleet.startEligibility and the relay crashes at its next restart.
# Now a READ-ONLY probe of /opt/nan-relay runs before anything is written (and before the token is fetched), and:
#   - an EXISTING host whose shared modules are byte-identical to this checkout's gets ONLY egress-relay.js and its unit;
#     no shared file is written. The egress relay was written against exactly those bytes, so its imports resolve.
#   - an EXISTING host whose shared modules differ (or lack one), in EITHER direction, is REFUSED before any write, naming
#     the files: deploy the shared set with relay/deploy.sh, or run this from the checkout the host was deployed from.
#     There is no path that replaces shared modules on an existing host (enclave-99: none is needed, and it is the one
#     path that could break the relay).
#   - --bootstrap: a FRESH host (no /opt/nan-relay, or an empty one) gets the egress relay and its dependencies, then npm
#     ci. Refused on an existing host; a fresh host without it is refused too.
# The shared set is not a hand-kept list: it is egress-relay.js's relative imports, transitively, plus the npm manifests
# (the old list missed connlog.mjs, so a bootstrapped egress relay could not start).
# Once us-west is in CI's EXTRA_RELAY_SSH_HOSTS (U7 preflight B1(a)), relay/deploy.sh ships the whole set there and
# restarts the egress relay too; this script's remaining job is then a fresh host's bootstrap and the env file.
# WHAT THIS CANNOT PROTECT: a copy of the OLD script in another checkout (only a pull brings this one); a host changed by
# someone else between the probe and the write (there is no lock); files outside /opt/nan-relay, and other hosts.
set -euo pipefail

usage() { echo "usage: bash scripts/deploy-us-west-egress.sh [--bootstrap] [us-west-ssh-alias]" >&2; exit 2; }
BOOTSTRAP=0; UW=""
for a in "$@"; do
  case "$a" in
    --bootstrap) BOOTSTRAP=1 ;;
    -*) usage ;;
    *) [ -z "$UW" ] || usage; UW="$a" ;;
  esac
done
UW="${UW:-us-west-relay}"                # us-west ssh alias (root@5.78.85.108)
NAN_RELAY="${NAN_RELAY:-nan-relay}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
R="$HERE/relay"

sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -c1-64; else shasum -a 256 "$1" | cut -c1-64; fi; }
# egress-relay.js's relative imports, transitively (flat names only: everything lands in /opt/nan-relay/), then the npm
# manifests `npm ci` installs from. A dependency missing from this checkout is fatal: nothing could be shipped whole.
shared_deps() {
  local todo="egress-relay.js" seen=" egress-relay.js " f dep
  while [ -n "$todo" ]; do
    f="${todo%% *}"; todo="${todo#"$f"}"; todo="${todo# }"
    [ -f "$R/$f" ] || { echo "FATAL: $f, imported by the egress relay, is not in $R" >&2; exit 1; }
    for dep in $(grep -oE "(from|import)[[:space:]]*[(]?[[:space:]]*['\"]\./[^'\"]+['\"]" "$R/$f" | sed -E "s/.*['\"]\.\/([^'\"]+)['\"].*/\1/"); do
      case "$dep" in */*|*[!A-Za-z0-9._-]*) echo "FATAL: $f imports ./$dep, not a flat module name" >&2; exit 1 ;; esac
      case "$seen" in *" $dep "*) ;; *) seen="$seen$dep "; todo="${todo:+$todo }$dep"; echo "$dep" ;; esac
    done
  done
  echo package.json; echo package-lock.json
}
SHARED="$(shared_deps | tr '\n' ' ')"; SHARED="${SHARED% }"

echo "[us-west-egress] target: $UW"
ssh -o BatchMode=yes -o ConnectTimeout=8 "$UW" 'echo "[us-west-egress] reached $(hostname)"' \
  || { echo "FATAL: cannot SSH to $UW — add your key to us-west or fix the alias"; exit 1; }

# 0) READ-ONLY probe of /opt/nan-relay, before the token is fetched and before anything is written
echo "[us-west-egress] shared modules this egress relay needs: $SHARED"
PROBE="d=/opt/nan-relay; if [ ! -d \"\$d\" ]; then echo 'DIR absent'; exit 0; fi; echo 'DIR present'; ls -A \"\$d\" | sed 's/^/ENTRY /'; for f in $SHARED; do if [ -f \"\$d/\$f\" ]; then echo \"SHA \$(sha256sum \"\$d/\$f\" | cut -c1-64) \$f\"; else echo \"MISSING \$f\"; fi; done"
PROBED="$(ssh -o BatchMode=yes "$UW" "$PROBE")" || { echo "FATAL: could not read /opt/nan-relay on $UW; nothing was written"; exit 1; }
ENTRIES="$(printf '%s\n' "$PROBED" | sed -n 's/^ENTRY //p')"
if printf '%s\n' "$PROBED" | grep -qx 'DIR absent' || [ -z "$ENTRIES" ]; then MODE=fresh; else MODE=existing; fi
DIFFER=""
for f in $SHARED; do
  want="$(sha256_of "$R/$f")"
  have="$(printf '%s\n' "$PROBED" | awk -v f="$f" '$1 == "SHA" && $3 == f { print $2 }')"
  hv="missing"; [ -z "$have" ] || hv="${have:0:12}…"      # compared in full; only prefixes are printed
  [ "$have" = "$want" ] || DIFFER="$DIFFER $f (host $hv, this checkout ${want:0:12}…)"
done
OTHERS=""
for e in $ENTRIES; do
  case "$e" in *.js|*.mjs) ;; *) continue ;; esac
  case " egress-relay.js $SHARED " in *" $e "*) ;; *) OTHERS="$OTHERS $e" ;; esac
done
refuse() { echo "REFUSED ($MODE host $UW): $1. Nothing was written." >&2; exit 3; }
COPY=""
if [ "$MODE" = fresh ]; then
  [ "$BOOTSTRAP" = 1 ] || refuse "/opt/nan-relay is absent or empty; to install the egress relay and its dependencies here, pass --bootstrap"
  COPY="egress-relay.js $SHARED"
  echo "[us-west-egress] FRESH host, --bootstrap: installing the egress relay and $SHARED"
else
  [ "$BOOTSTRAP" = 0 ] || refuse "--bootstrap is for a fresh host; /opt/nan-relay already holds:$(printf ' %s' $ENTRIES)"
  if [ -z "$DIFFER" ]; then
    COPY="egress-relay.js"
    echo "[us-west-egress] EXISTING host, shared modules identical to this checkout: writing egress-relay.js and its unit only"
  else
    refuse "its shared relay modules are not this checkout's:$DIFFER.${OTHERS:+ Other daemons here import them:$OTHERS;} this script never replaces shared modules on an existing host. Deploy the shared set with relay/deploy.sh, or run this from the checkout the host was deployed from"
  fi
fi

# 1) the fleet egress token (same value on every relay + enclave, like SECRET)
TOKEN="${EGRESS_RELAY_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  echo "[us-west-egress] pulling EGRESS_RELAY_TOKEN from $NAN_RELAY"
  TOKEN="$(ssh -o BatchMode=yes "$NAN_RELAY" 'grep -oP "^EGRESS_RELAY_TOKEN=\K.*" /etc/nan-relay/egress-relay.env')"
fi
[ -n "$TOKEN" ] || { echo "FATAL: no EGRESS_RELAY_TOKEN (set it in the env or ensure $NAN_RELAY has it)"; exit 1; }

# 2) code: exactly what step 0 decided (egress-relay.js alone on an existing host whose shared modules match)
echo "[us-west-egress] copying:$(printf ' %s' $COPY)"
[ "$MODE" = existing ] || ssh -o BatchMode=yes "$UW" 'mkdir -p /opt/nan-relay'
SRC=""; for f in $COPY; do SRC="$SRC $R/$f"; done
# shellcheck disable=SC2086  # $SRC: flat module names checked above, one path each
scp -o BatchMode=yes $SRC "$UW":/opt/nan-relay/
scp -o BatchMode=yes "$HERE"/relay/systemd/enclave-egress-relay.service "$UW":/etc/systemd/system/
# npm ci where the manifests were just written (a fresh host); on an existing host only if it never ran
NPM_CI=0; [ "$COPY" = "egress-relay.js" ] || NPM_CI=1

# 3) env — PLAIN egress: RELAY_NAME=us-west, fleet discovery, NO EGRESS_PREFIX.
echo "[us-west-egress] writing env + installing deps + starting"
# The token travels on STDIN, as the remote script's first line, never in an argv: `printf` is a builtin, so no local
# process carries it, and the remote side sees `bash -s`, not the token (ps on either end, sshd logs). %q also keeps a
# token with a quote in it from breaking out of the assignment. Nothing below runs `set -x`, and nothing prints it.
{ printf 'TOKEN=%q\nNPM_CI=%q\n' "$TOKEN" "$NPM_CI"; cat <<'REMOTE'
set -euo pipefail
cd /opt/nan-relay
if [ "$NPM_CI" = 1 ] || [ ! -d node_modules ]; then npm ci --omit=dev; fi
umask 077
mkdir -p /etc/nan-relay                  # a fresh host has none yet
# umask applies only when a file is CREATED: an existing env file would keep its old mode with the token in it. So the
# old contents go first, then the mode, then the token (enclave-5d); at no point is a token in a file others can read.
: > /etc/nan-relay/egress-relay.env
chmod 600 /etc/nan-relay/egress-relay.env
cat > /etc/nan-relay/egress-relay.env <<ENV
EGRESS_RELAY_TOKEN=${TOKEN}
RELAY_NAME=us-west
REGISTRY_ADDRESS=0xCB65f487eba6564D57FfB860cF9aE701584cB4a2
ADDRESS_BOOK_ADDRESS=0xab214342d5A490150A4A977063A2f88E21F80907
BASE_RPC=https://base-rpc.publicnode.com
TRUSTED_OPERATORS=0x390e2e0e0bc34b7f428f1e31c9b6770d5028ecc1
ENV
# NO EGRESS_PREFIX -> the unit's `ip -6 route add local` self-ignores, and the
# relay dials plain from us-west's own address (the enclave sends no source).
systemctl daemon-reload
systemctl enable --now enclave-egress-relay
sleep 4
systemctl is-active enclave-egress-relay
journalctl -u enclave-egress-relay --since "-30s" -o cat | grep -iE "control channel up|egress relay" | tail -4
REMOTE
} | ssh -o BatchMode=yes "$UW" 'bash -s'
echo "[us-west-egress] done — us-west now attaches to the fleet as relay 'us-west' and carries egress."
echo "[us-west-egress] verify: an app routed via us-west should egress FROM us-west (fast R2 reads)."
