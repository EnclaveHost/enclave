#!/bin/bash
# ENABLEMENT.md step 4b, the operator's side: a config- and secret-bearing acceptance deployment with NON-SENSITIVE test
# values. Prepared by enclave-5d for review by enclave-63 and enclave-d1; 63 runs it, on warden-host, as the operator.
#
#   accept-4b.sh prepare  <dir>   generate the two test values, the hookbin bin token and config.json (no host touched)
#   accept-4b.sh bin      <dir>   create the bin on the hookbin canary (0ddbd824, a release guest by then: 4b precondition)
#   accept-4b.sh deploy   <dir>   the agent wallet creates the deployment (CLI --isolation; secrets from the 0600 file)
#   accept-4b.sh proofs   <dir>   proofs 3 (expected envelope tag), 4, 5, 6 and 7, printed as hashes, codes and counts
#   accept-4b.sh teardown <dir>   delete the bin, clear the staged secrets, refund and stop; remove the values
#
# Between deploy and proofs, 63 lists the new id on the relay (SECRETS_RELEASE_DEPLOYMENTS, as step 6) and waits for
# metal-iso0 to claim it and the guest to serve. Proofs 1, 2, 8 and 9 are the relay/guestd/TLS checks of step 4, run as
# for the canaries. After teardown, 63 unlists the id.
#
# The values never reach argv, a host, or this script's output. They live only in <dir> (0700; files 0600):
#   values        the two values, one per line (grep -F -f reads them; ssh receives them on STDIN)
#   secrets.env   NAME=value for the CLI's --secrets-file
#   hdr-key       "x-api-key: <value>" for curl -H @file
# Everything printed or kept as evidence (state.env, evidence.txt) is a sha256, a code, a count, a key name or a
# public URL. The config holds only $NAME references and public URLs: it goes on chain, publicly.
# NOTE: the bin token is IN that public config, and hookbin serves a bin's captures to whoever names it. So while the
# bin exists, anyone reading the chain can read the capture, test token included. That is why the values are
# NON-SENSITIVE, generated per run and never reused, and why teardown deletes the bin first. The HOST channels
# (proof 7) never see either value.
#
# Environment:
#   CLI         cli/enclave.mjs from a checkout with `deploy --isolation` (isolation/app-config-m1 06bdcbdf or later),
#               whose node_modules resolve (e.g. a symlink to the main checkout's)
#   ETH_AGENT_WALLET  the agent wallet's key (deploy, teardown); read only from the environment, never written
#   VIEM_DIR    a directory whose node_modules has viem (default: $HOME/Projects/enclave), for the ledger read
#   GUESTD_ROOT guestd's root (default: $HOME/enclave-prod/guestd-root); RELAY_SSH the relay host alias (default: nan)
set -euo pipefail
umask 077
cmd=${1:-}; D=${2:-}
[ -n "$cmd" ] && [ -n "$D" ] || { sed -n '5,10p' "$0"; exit 2; }
HOOKBIN=https://0ddbd824.app.enclave.host
OFFLIST=https://395bed3e.app.enclave.host
LEDGER=0xF9e71385C5cB49844F2457ba6567De0742f8B89a
VIEM_DIR=${VIEM_DIR:-$HOME/Projects/enclave}
GUESTD_ROOT=${GUESTD_ROOT:-$HOME/enclave-prod/guestd-root}
RELAY_SSH=${RELAY_SSH:-nan}
say() { printf '%s\n' "$*"; }
die() { say "FAIL: $*" >&2; exit 1; }
sha() { sha256sum | cut -c1-64; }
state() { grep "^$1=" "$D/state.env" | tail -1 | cut -d= -f2-; }
setstate() { printf '%s=%s\n' "$1" "$2" >> "$D/state.env"; }
fails=0; check() { if [ "$1" = ok ]; then say "ok   $2"; else say "FAIL $2"; fails=$((fails + 1)); fi; }

case "$cmd" in
prepare)
  [ ! -e "$D" ] || die "$D exists; a run uses a fresh directory"
  mkdir -m 700 "$D"
  hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
  K="acc-$(hex 12)"; T="acc-$(hex 12)"; BIN="accept-5d-$(hex 4)"
  printf '%s\n%s\n' "$K" "$T" > "$D/values"
  printf 'ACCEPT_API_KEY=%s\nACCEPT_TOKEN=%s\n' "$K" "$T" > "$D/secrets.env"
  printf 'x-api-key: %s\n' "$K" > "$D/hdr-key"
  BIN="$BIN" HOOKBIN="$HOOKBIN" OFFLIST="$OFFLIST" node -e '
    const c = { title: "release acceptance (enclave-5d)", api_key: "$ACCEPT_API_KEY", egress: [process.env.HOOKBIN],
      http: [
        { name: "hookbin_probe", description: "acceptance: one GET to the hookbin canary, carrying the substituted test token",
          parameters: { type: "object", properties: {} },
          url: `${process.env.HOOKBIN}/b/${process.env.BIN}/accept`, headers: { "x-accept-token": "$ACCEPT_TOKEN" } },
        { name: "egress_refused_probe", description: "acceptance: a destination NOT on the egress list",
          parameters: { type: "object", properties: {} }, url: `${process.env.OFFLIST}/ping` } ] };
    process.stdout.write(JSON.stringify(c));' > "$D/config.json"
  # the config must carry references, never a value
  ! grep -qF -f "$D/values" "$D/config.json" || die "a value reached config.json"
  : > "$D/state.env"
  setstate BIN "$BIN"; setstate KEY_SHA "$(printf '%s' "$K" | sha)"; setstate TOKEN_SHA "$(printf '%s' "$T" | sha)"
  setstate LITERAL_TOKEN_SHA "$(printf '%s' '$ACCEPT_TOKEN' | sha)"
  setstate CONFIG_SHA "$(sha < "$D/config.json")"
  # the size the guest will log (release line `config N bytes`, init's `DOM app config: N bytes`): the RESOLVED config,
  # i.e. config.json with each $NAME replaced by its value. appconfig.Resolve re-writes the document compact and
  # order-preserving, with printable ASCII verbatim (appconfig.go writeString), which is JSON.stringify for this config.
  setstate RESOLVED_BYTES "$(node -e '
    const fs = require("fs"); const [k, t] = fs.readFileSync(process.argv[2], "utf8").split("\n");
    const sub = (v) => typeof v === "string" ? v.replace(/\$ACCEPT_API_KEY\b/g, k).replace(/\$ACCEPT_TOKEN\b/g, t)
      : Array.isArray(v) ? v.map(sub) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([a, b]) => [a, sub(b)])) : v;
    process.stdout.write(String(Buffer.byteLength(JSON.stringify(sub(JSON.parse(fs.readFileSync(process.argv[1], "utf8")))))));' "$D/config.json" "$D/values")"
  say "prepared $D: bin $BIN; config.json $(wc -c < "$D/config.json") B sha256 $(state CONFIG_SHA); resolved in the guest: $(state RESOLVED_BYTES) B"
  say "sha256(ACCEPT_API_KEY) $(state KEY_SHA); sha256(ACCEPT_TOKEN) $(state TOKEN_SHA)   (values: $D/values, 0600)"
  ;;
bin)
  BIN=$(state BIN)
  r=$(curl -sS -m 20 -X POST -H "x-bin-id: $BIN" "$HOOKBIN/api/bins")
  [ "$r" = '{"ok":true}' ] || die "bin create answered: $r"
  say "ok   bin $BIN created on $HOOKBIN"
  ;;
deploy)
  : "${CLI:?set CLI to cli/enclave.mjs from a checkout with deploy --isolation}"
  [ -n "${ETH_AGENT_WALLET:-}" ] || die "ETH_AGENT_WALLET is not set"
  [ -z "$(state ID)" ] || die "this run already deployed $(state ID)"
  setstate CREATE_TS "$(date -u '+%Y-%m-%d %H:%M:%S')"
  H=$(mktemp -d); trap 'rm -rf "$H"' EXIT
  out=$(HOME="$H" ENCLAVE_KEY="$ETH_AGENT_WALLET" node "$CLI" deploy api-mcp-adapter:1.0.0 --cpu 0.01 --fund 0.01 \
          --isolation snp-guest-per-app --config "$(cat "$D/config.json")" --secrets-file "$D/secrets.env" --no-wait --yes 2>&1) \
    || { printf '%s\n' "$out" | grep -vF -f "$D/values"; die "deploy failed"; }
  printf '%s\n' "$out" | grep -vF -f "$D/values"
  ID=$(printf '%s\n' "$out" | sed -n 's/^created \(0x[0-9a-f]\{64\}\)$/\1/p' | head -1)
  [ -n "$ID" ] || die "no 'created 0x…' line in the CLI output"
  setstate ID "$ID"
  say "ok   created $ID; next: list it on the relay (SECRETS_RELEASE_DEPLOYMENTS), wait for metal-iso0 to serve it, then: $0 proofs $D"
  ;;
proofs)
  ID=$(state ID); BIN=$(state BIN); [ -n "$ID" ] || die "no deployment id in $D/state.env"
  ORIGIN="https://${ID:2:8}.app.enclave.host"
  mcp() { curl -sS -m 60 -o "$D/resp.json" -w '%{http_code}' -H 'content-type: application/json' "$@" "$ORIGIN/mcp"; }
  # proof 3's expected tag: sha256(the ledger row's configCid field, TRIMMED)[:16] (secrets-release.mjs:363/474)
  TAG=$(cd "$VIEM_DIR" && ID="$ID" LEDGER="$LEDGER" node --input-type=module -e '
    import { createPublicClient, http } from "viem"; import { base } from "viem/chains"; import crypto from "node:crypto";
    const abi = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [
      { name: "id", type: "bytes32" }, { name: "owner", type: "address" }, { name: "appRef", type: "string" }, { name: "ports", type: "string" },
      { name: "configCid", type: "string" }, { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" },
      { name: "isPublic", type: "bool" }, { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" }, { name: "rate", type: "uint256" },
      { name: "balance6", type: "uint256" }, { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" },
      { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" }] }] }];
    const urls = ["https://base.drpc.org", "https://base-rpc.publicnode.com", "https://base-mainnet.public.blastapi.io", "https://mainnet.base.org"];
    const got = await Promise.allSettled(urls.map((u) => createPublicClient({ chain: base, transport: http(u, { retryCount: 2, retryDelay: 800 }) })
      .readContract({ address: process.env.LEDGER, abi, functionName: "get", args: [process.env.ID] })));
    const rows = got.filter((g) => g.status === "fulfilled").map((g) => g.value);
    if (rows.length < 2) { console.log("FEWER-THAN-2-RPCS"); process.exit(0); }
    if (rows.some((r) => r.configCid !== rows[0].configCid || r.appRef !== rows[0].appRef || r.isPublic !== rows[0].isPublic)) { console.log("RPCS-DISAGREE"); process.exit(0); }
    const env = String(rows[0].configCid || "").trim();
    console.log(crypto.createHash("sha256").update(Buffer.from(env)).digest("hex").slice(0, 16), rows[0].appRef, rows[0].isPublic);') || TAG=""
  set -- $TAG
  [ -n "${1:-}" ] && [ "${1}" != RPCS-DISAGREE ] && [ "${1}" != FEWER-THAN-2-RPCS ] || die "could not read the ledger row (${TAG:-no answer})"
  say "info proof 3: the serial's 'envelope' must start $1 (sha256 of the trimmed on-chain envelope)"
  [ "${2:-}" = "catalog://0x5bca36b520b80fa26272f34886e38344393e1f69098be8ad5a0d2372ec3147bc/0" ] && c=ok || c=no
  check $c "the deployment runs a69dcbba's app and version (appRef ${2:-?})"
  [ "${3:-}" = true ] && c=ok || c=no; check $c "the deployment is public"
  # proof 3's serial lines, if the guest's serial is at hand (guestd's instance.json Name = the deployment id)
  SER=""; for f in "$GUESTD_ROOT"/gd*/instance.json; do
    [ "$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).Name))}catch{}' "$f")" = "$ID" ] \
      && SER="${f%/instance.json}/$(basename "${f%/instance.json}").serial"; done
  if [ -n "$SER" ] && [ -f "$SER" ]; then
    RB=$(state RESOLVED_BYTES)
    grep -aq "DOM release: deployment 0x${ID:2:8}.* envelope $1.* 2 allowed origin(s), 0 refused, config $RB bytes" "$SER" && c=ok || c=no
    check $c "proof 3: the serial's release line names the on-chain envelope, 2 allowed origins, 0 refused, config EXACTLY $RB bytes"
    grep -aq "DOM app config: $RB bytes (ENCLAVE_CONFIG)" "$SER" && grep -aq "DOM serving" "$SER" && c=ok || c=no
    check $c "proof 3: init got EXACTLY $RB bytes of config, and the domain serves"
  else check no "proof 3: no serial for $ID under $GUESTD_ROOT"; fi
  # proof 4: substitution into the app's own key gate
  code=$(mcp -H @"$D/hdr-key" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  n=$(node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((r.result.tools||[]).map(t=>t.name).sort().join(","))}catch{process.stdout.write("?")}' "$D/resp.json")
  [ "$code" = 200 ] && [ "$n" = "egress_refused_probe,hookbin_probe" ] && c=ok || c=no
  check $c "proof 4: tools/list with the test key -> $code [$n]"
  code=$(mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'); [ "$code" = 401 ] && c=ok || c=no
  check $c "proof 4: tools/list without a key -> $code"
  code=$(mcp -H 'x-api-key: $ACCEPT_API_KEY' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'); [ "$code" = 401 ] && c=ok || c=no
  check $c "proof 4: tools/list with the LITERAL \$ACCEPT_API_KEY -> $code (a 503 everywhere would mean the key was never substituted)"
  # proof 5: substitution + egress, end to end, through the hookbin canary's capture
  curl -sS -m 20 -X POST "$HOOKBIN/api/bins/$BIN/clear" > /dev/null
  code=$(mcp -H @"$D/hdr-key" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"hookbin_probe","arguments":{}}}')
  e=$(node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(r.result&&r.result.isError===true))}catch{process.stdout.write("?")}' "$D/resp.json")
  [ "$code" = 200 ] && [ "$e" = false ] && c=ok || c=no; check $c "proof 5: tools/call hookbin_probe -> $code, isError=$e"
  curl -sS -m 20 "$HOOKBIN/api/bins/$BIN/requests" > "$D/caps.json"
  r=$(BIN="$BIN" node -e '
    const crypto = require("crypto"); const caps = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const h = (caps[0] && caps[0].headers || []).filter(([k]) => String(k).toLowerCase() === "x-accept-token").map(([, v]) => v);
    process.stdout.write([caps.length, caps[0] ? caps[0].target : "-", h.length, h.length ? crypto.createHash("sha256").update(h[0]).digest("hex") : "-"].join(" "));' "$D/caps.json")
  set -- $r
  [ "$1" = 1 ] && c=ok || c=no; check $c "proof 5: the hookbin bin holds exactly one capture ($1)"
  [ "$2" = "/b/$BIN/accept" ] && c=ok || c=no; check $c "proof 5: its target is /b/$BIN/accept ($2)"
  [ "$3" = 1 ] && [ "$4" = "$(state TOKEN_SHA)" ] && c=ok || c=no
  check $c "proof 5: its x-accept-token sha256 = the staged test token's ($4)"
  [ "$4" != "$(state LITERAL_TOKEN_SHA)" ] && c=ok || c=no; check $c "proof 5: ...and is not the literal \$ACCEPT_TOKEN"
  rm -f "$D/caps.json"
  # proof 6: a destination off the egress list is refused IN the guest, though it answers from outside
  code=$(mcp -H @"$D/hdr-key" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"egress_refused_probe","arguments":{}}}')
  e=$(node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(r.result&&r.result.isError===true))}catch{process.stdout.write("?")}' "$D/resp.json")
  [ "$code" = 200 ] && [ "$e" = true ] && c=ok || c=no; check $c "proof 6: tools/call egress_refused_probe -> $code, isError=$e"
  o=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "$OFFLIST/ping"); [ "$o" = 200 ] && c=ok || c=no
  check $c "proof 6: $OFFLIST/ping from outside -> $o (so the refusal is the guest's policy)"
  rm -f "$D/resp.json"
  # proof 7: no host channel holds either value. Values go in as a pattern FILE (local) or on STDIN (nan), never argv.
  # Each channel must also be READABLE and non-empty (a marker count > 0), or a zero would prove nothing.
  since=$(state CREATE_TS)
  chan() { local name=$1 marker=$2; shift 2; local hits mk; hits=$("$@" | grep -acF -f "$D/values" || true); mk=$("$@" | grep -ac -- "$marker" || true)
    [ "${mk:-0}" -gt 0 ] && [ "${hits:-1}" = 0 ] && c=ok || c=no; check $c "proof 7: $name: $hits value hit(s) (channel readable: $mk '$marker' line(s))"; }
  chan "warden-host user journal since create" "." journalctl --user --since "$since" --no-pager -o cat
  # the guest, guestd and launcher run as USER units (above); the system journal is checked when this user can read it
  if journalctl --since "$since" -n 1 --no-pager -q >/dev/null 2>&1 && [ -n "$(journalctl --since "$since" -n 1 --no-pager -q -o cat 2>/dev/null)" ]; then
    chan "warden-host system journal since create" "." journalctl --since "$since" --no-pager -o cat
  else say "info proof 7: the system journal is not readable by $(id -un); the guest, guestd and launcher units are user units, covered above"; fi
  [ -n "$SER" ] && chan "the test guest's serial" "DOM serving" cat "$SER" || check no "proof 7: the test guest's serial is missing"
  HS=""; for f in "$GUESTD_ROOT"/gd*/instance.json; do
    [ "$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).Name))}catch{}' "$f")" = 0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76 ] \
      && HS="${f%/instance.json}/$(basename "${f%/instance.json}").serial"; done
  [ -n "$HS" ] && chan "the hookbin canary's serial" "DOM serving" cat "$HS" || check no "proof 7: the hookbin canary's serial is missing"
  # the patterns arrive on ssh's STDIN; inside the remote pipeline grep's own stdin is the journal, so the patterns are
  # moved to fd 3 first (enclave-e3: `-f /dev/stdin` there read the JOURNAL as patterns and could never fail). The
  # positive control goes through the SAME plumbing: the pattern `secrets-release` must count > 0.
  relay_count() { ssh -o BatchMode=yes "$RELAY_SSH" "bash -c 'exec 3<&0; journalctl -u enclave-api-relay --since \"$since\" --no-pager -o cat | grep -acF -f /dev/fd/3 || true'"; }
  rh=$(relay_count < "$D/values"); rm_=$(printf 'secrets-release\n' | relay_count)
  [ "${rm_:-0}" -gt 0 ] && [ "${rh:-1}" = 0 ] && c=ok || c=no
  check $c "proof 7: $RELAY_SSH api-relay journal since create: $rh value hit(s) (same plumbing, control pattern 'secrets-release': $rm_ line(s))"
  { say "4b evidence $(date -u +%FT%TZ): deployment $ID, bin $BIN, config sha256 $(state CONFIG_SHA)"
    say "sha256(ACCEPT_API_KEY) $(state KEY_SHA); sha256(ACCEPT_TOKEN) $(state TOKEN_SHA); proofs 3-7: $fails failure(s)"; } >> "$D/evidence.txt"
  say "proofs 3-7: $fails failure(s); evidence line appended to $D/evidence.txt (no values)"
  [ "$fails" = 0 ]
  ;;
teardown)
  ID=$(state ID); BIN=$(state BIN)
  curl -sS -m 20 -X DELETE "$HOOKBIN/api/bins/$BIN" > /dev/null && say "ok   bin $BIN deleted" || say "FAIL bin delete"
  if [ -n "$ID" ]; then
    : "${CLI:?set CLI}"; [ -n "${ETH_AGENT_WALLET:-}" ] || die "ETH_AGENT_WALLET is not set"
    H=$(mktemp -d); trap 'rm -rf "$H"' EXIT
    # each CLI call's OWN status (enclave-63): a pipeline's status would be grep's
    set +e
    HOME="$H" ENCLAVE_KEY="$ETH_AGENT_WALLET" node "$CLI" secrets clear "$ID" --yes 2>&1 | grep -vF -f "$D/values"; sc=${PIPESTATUS[0]}
    HOME="$H" ENCLAVE_KEY="$ETH_AGENT_WALLET" node "$CLI" refund "$ID" --yes 2>&1 | grep -vF -f "$D/values"; rc=${PIPESTATUS[0]}
    set -e
    [ "$sc" = 0 ] && say "ok   staged secrets cleared" || say "FAIL secrets clear exited $sc"
    [ "$rc" = 0 ] && say "ok   refunded and stopped" || say "FAIL refund exited $rc"
    if [ "$sc" != 0 ] || [ "$rc" != 0 ]; then
      say "FAIL teardown incomplete: the value files are KEPT in $D for a retry (non-sensitive test values); re-run: $0 teardown $D"
      exit 1
    fi
    say "next (63): unlist $ID on the relay; check the deployment is inactive and guestd holds no guest for it"
  fi
  rm -f "$D/values" "$D/secrets.env" "$D/hdr-key"
  say "ok   the local value files are removed; $D keeps state.env, config.json and evidence.txt (hashes only)"
  ;;
*) die "unknown command $cmd" ;;
esac
