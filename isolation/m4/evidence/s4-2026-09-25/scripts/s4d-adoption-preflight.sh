#!/usr/bin/env bash
# 4d's ADOPTION preflight (enclave-e3 A1). It changes nothing: it opens one attestation session per canary through its
# CURRENT forwarder, and, once the gate opens, client.mjs sends the canary's app the same GET /hello?from=client that
# adoption sends (retrying on a 502 for up to 60 s); nothing is consumed (independent attestations, --no-kds). At 4d the new guestd adopts each canary only if it verifies again
# as the same guest (persist.go adoptOne: a new forwarder to its CID, then THE NEW TREE's judge with the recorded
# measurement, AppID and HOST_DATA, this host's runtime identity, and the same key); a guest that fails even once is
# STOPPED and its workdir scrubbed, which no rollback undoes (it can only be relaunched: Codex escalation). So this proves
# it beforehand, with exactly those inputs, for all 3 canaries:
#   - the new tree's runtime-identity.sh gives the identity the live guestd uses (expected-runtime.json, byte-equal);
#   - the forwarder adoption starts (the new guestd rebuilds <root>/bin/fwd from the new tree at start) is the live one's
#     code: both trees build it byte-identical without a VCS stamp, and the live binary's build info equals the new
#     build's apart from vcs.revision/vcs.time (guestd builds in a git worktree, so Go stamps the commit; measured 09-25);
#   - each canary's record (instance.json) agrees with guestd's /vms, and the NEW tree's client.mjs, run with guestd's
#     own argument list (main.go verifyArgs) against the canary's CURRENT forwarder, says VERDICT attested, gate open,
#     and the recorded transport key.
# It writes s4/adoption-check.txt, which s4d-apply.sh requires for the same binary within 2 hours.
# Usage: s4d-adoption-preflight.sh <guestd merge commit, 40 hex> <its sha256>
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/pool-rollout-20260925/s4/lib4.sh
export PATH=/usr/local/bin:/usr/bin:/usr/sbin:/bin   # guestd's unit PATH: the wasmtime, node and go the new guestd will use
BINC=${1:?commit}; BSHA=${2:?sha256}; [[ "$BINC" =~ ^[0-9a-f]{40}$ && "$BSHA" =~ ^[0-9a-f]{64}$ ]] || { echo "40-hex commit, 64-hex sha"; exit 2; }
GR=$PROD/guestd-root; OUT=$S4/adoption-check.txt
tree_ok || { say4 "ADOPTION PREFLIGHT: the installed tree"; exit 3; }
# the new guestd adopts from EVERY gd* workdir: exactly the 3 canaries', or a stray one is "not adopted" (a needless rollback)
nd=$(find "$GR" -mindepth 1 -maxdepth 1 -type d -name 'gd*' | wc -l)
[ "$nd" = 3 ] || { say4 "ADOPTION PREFLIGHT: guestd-root holds $nd gd* workdirs, not the 3 canaries'"; exit 3; }
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
# the runtime identity the new guestd will compute (main.go: runtime-identity.sh <wasmtime>) = the live one
"$T/isolation/contract/runtime-identity.sh" "$(command -v wasmtime)" > "$W/rid.json" || { say4 "ADOPTION PREFLIGHT: runtime-identity.sh failed"; exit 4; }
cmp -s "$W/rid.json" "$GR/expected-runtime.json" || { say4 "ADOPTION PREFLIGHT: the new tree's runtime identity differs from the live one"; exit 4; }
# the forwarder the new guestd builds at start (main.go: go build -trimpath ./fwd, CGO_ENABLED=0) is the live one's code
fb() { ( cd "$1/m2" && env -u GOFLAGS CGO_ENABLED=0 go build -trimpath "${@:3}" -o "$2" ./fwd ); }
fb "$T/isolation" "$W/fwd" && fb "$T/isolation" "$W/fwd-nv" -buildvcs=false && fb "$LEG" "$W/fwd-old-nv" -buildvcs=false \
  || { say4 "ADOPTION PREFLIGHT: building fwd failed"; exit 5; }
cmp -s "$W/fwd-nv" "$W/fwd-old-nv" || { say4 "ADOPTION PREFLIGHT: the two trees' fwd code differs"; exit 5; }
bi() { local o; o=$(go version -m "$1") || return 1; sed -n '1s/^[^:]*: //p' <<<"$o"; sed 1d <<<"$o" | grep -vE '^[[:space:]]*build[[:space:]]+vcs\.(revision|time)=' || true; }
[ "$(bi "$W/fwd")" = "$(bi "$GR/bin/fwd")" ] && [ -n "$(bi "$GR/bin/fwd")" ] || { say4 "ADOPTION PREFLIGHT: the live fwd's build info differs beyond its VCS stamp"; exit 5; }
guestd_seam > "$W/g.json" || { say4 "ADOPTION PREFLIGHT: guestd unreadable"; exit 6; }
python3 - "$W/g.json" "$GR" > "$W/targets.tsv" <<'PY' || { say4 "ADOPTION PREFLIGHT: the records and guestd's /vms disagree, or not exactly the 3 canaries"; exit 6; }
import json,sys,os,re
vms=json.load(open(sys.argv[1]))[1]["body"]["vms"]; gr=sys.argv[2]
assert len(vms)==3, len(vms)
for v in vms:
    rec=json.load(open(os.path.join(gr, v["id"], "instance.json")))
    assert v["status"]=="running" and rec["ID"]==v["id"] and rec["Name"]==v["name"], v["id"]
    assert rec["Measurement"]==v["measurement"] and rec["AppID"]==v["appId"] and rec["HostData"]==v["hostData"], v["id"]
    assert rec["TransportKeySha256"]==v["transportKeySha256"] and rec["Unit"] and rec["CID"]>0, v["id"]
    assert isinstance(v["hostPort"],int) and 0<v["hostPort"]<65536
    for k in ("Measurement","AppID","HostData","TransportKeySha256"): assert re.fullmatch(r"[0-9a-f]+", rec[k]), k
    print("\t".join([v["id"], str(v["hostPort"]), rec["Measurement"], rec["AppID"], rec["HostData"], rec["TransportKeySha256"]]))
PY
n=0; names=""
while IFS=$'\t' read -r id port m a hd key; do
  # guestd's verifyArgs, verbatim, with the NEW tree's m2/client.mjs and chain; the live defaults for vcek and min-tcb
  out=$(node "$T/isolation/m2/client.mjs" "https://127.0.0.1:$port" --measurement "$m" --app-sha "$a" --no-kds \
        --vcek "$HOME/.cache/enclave-isolation/m3-clean/vcek.der" \
        --amd-chain "Turin=$T/test/fixtures/amd/Turin-cert_chain.pem" \
        --min-tcb "@$HOME/.cache/enclave-isolation/m3-clean/min-tcb.json" \
        --runtime "$W/rid.json" --save "$W/$id-doc.json" --host-data "$hd" 2>&1) || true
  v=$(grep -m1 '^VERDICT ' <<<"$out" || true); k=$(grep -m1 '^RESULT spki_sha256=' <<<"$out" | cut -d= -f2 || true)
  if [[ "$v" == "VERDICT attested"* ]] && grep -qx 'RESULT gate=open' <<<"$out" && [ "$k" = "$key" ]; then
    n=$((n+1)); names+="${id} "; say4 "adoption preflight: $id verifies with the new tree's judge ($v; key ${key:0:12})"
  else
    say4 "ADOPTION PREFLIGHT FAILED: $id: ${v:-no verdict}; key ${k:0:12} vs recorded ${key:0:12}"; exit 7
  fi
done < "$W/targets.tsv"
[ $n = 3 ] || { say4 "ADOPTION PREFLIGHT: $n of 3 verified"; exit 7; }
echo "guestd $BINC sha256 $BSHA tree $IMG at $(date -u +%Y-%m-%dT%H:%M:%SZ) epoch $(date +%s): 3/3 canaries verify with the new tree's judge (${names% }); runtime identity byte-equal, fwd code equal (its VCS stamp aside)" > "$OUT"
say4 "ADOPTION PREFLIGHT PASSED: $(cat "$OUT")"
