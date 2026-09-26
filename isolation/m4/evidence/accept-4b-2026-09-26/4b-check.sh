#!/usr/bin/env bash
# enclave-63's side of step 4b, one subcommand per stage, all READ-ONLY except `names` (the owner's `secrets ls`, which
# needs ENCLAVE_KEY in its environment and only reads):
#   record  <run>  the ledger row (>= 2 RPCs agreeing): appRef = a69dcbba's app/version, owner = the agent wallet, public,
#                  active, the envelope = {"isolation":{"require":"snp-guest-per-app"},"config":<config.json>} (parsed equal)
#   names   <run>  `enclave secrets ls <id>` lists exactly ACCEPT_API_KEY and ACCEPT_TOKEN (names only)
#   refused <run>  UNLISTED: metal-iso0's claim sweep refuses it for its app config, and guestd holds no guest for it
#   served  <run>  LISTED: a release guest for it runs and its serial reaches DOM serving
#   proofs  <run>  proofs 1 + 9 (one release to a verified guest, one ticket), 2 (release/attested/its own prediction =
#                  a69dcbba's 20319b02...ef47), 8 (public TLS via us-west on the guest's key, the gated certificate)
#   gone    <run>  after teardown + unlist: the row inactive, guestd holds no guest for it, release-status listed:false
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s4c-20260925/lib4cc.sh; source ~/enclave-bench/release-on-20260925/lib-ro.sh; source ~/enclave-bench/e4-20260925/lib-e4.sh; source ~/enclave-bench/accept-4b-20260926/lib-4b.sh
cmd=${1:?}; R=${2:?run dir}; [ -r "$R/state.env" ] || { say "no $R/state.env"; exit 2; }
ID=$(run_id "$R"); [[ "$ID" =~ ^0x[0-9a-f]{64}$ ]] || { say "no deployment id in $R/state.env"; exit 2; }
ID8=${ID:2:8}; HOST4=$ID8.app.enclave.host
st() { grep "^$1=" "$R/state.env" | tail -1 | cut -d= -f2-; }
fail() { say "4b $cmd FAIL: $*"; exit 1; }
row() {   # the ledger row as JSON, from >= 2 agreeing RPCs
  (cd /home/steven/Projects/enclave && ID="$ID" node --input-type=module -e '
    import { createPublicClient, http } from "viem"; import { base } from "viem/chains";
    const abi = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [
      { name: "id", type: "bytes32" }, { name: "owner", type: "address" }, { name: "appRef", type: "string" }, { name: "ports", type: "string" },
      { name: "configCid", type: "string" }, { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" },
      { name: "isPublic", type: "bool" }, { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" }, { name: "rate", type: "uint256" },
      { name: "balance6", type: "uint256" }, { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" },
      { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" }] }] }];
    const urls = ["https://base.drpc.org", "https://base-rpc.publicnode.com", "https://base-mainnet.public.blastapi.io", "https://mainnet.base.org"];
    const got = await Promise.allSettled(urls.map((u) => createPublicClient({ chain: base, transport: http(u, { retryCount: 2, retryDelay: 800 }) })
      .readContract({ address: "0xF9e71385C5cB49844F2457ba6567De0742f8B89a", abi, functionName: "get", args: [process.env.ID] })));
    const rows = got.filter((g) => g.status === "fulfilled").map((g) => JSON.stringify(g.value, (k, v) => typeof v === "bigint" ? v.toString() : v));
    if (rows.length < 2 || rows.some((r) => r !== rows[0])) { console.log("{}"); process.exit(1); }
    console.log(rows[0]);')
}
case $cmd in
record)
  J=$(row) || fail "the ledger row: fewer than 2 RPCs agree"
  python3 - "$J" "$R/config.json" "$APPREF" <<'PY' || fail "the ledger row is not what 4b created (see above)"
import json,sys
r=json.loads(sys.argv[1]); cfg=json.load(open(sys.argv[2])); appref=sys.argv[3]
env=json.loads(r["configCid"].strip())
checks={"appRef":r["appRef"]==appref,"owner=agent wallet":r["owner"].lower()=="0x29479bf04ed889d46a7afb7f292b9bb26e12647c",
  "public":r["isPublic"] is True,"active":r["active"] is True,"balance 0.01":int(r["balance6"])==10000,
  "envelope keys":sorted(env)==["config","isolation"],"isolation":env["isolation"]=={"require":"snp-guest-per-app"},"config = config.json":env["config"]==cfg}
for k,v in checks.items(): print(("ok   " if v else "FAIL ")+k)
sys.exit(0 if all(checks.values()) else 1)
PY
  say "4b record ok: $ID on chain as created (a69dcbba's app/version, the agent wallet's, public, active, 0.01 funded, the envelope = isolation + config.json)";;
names)
  [[ "${ENCLAVE_KEY:-}" =~ ^(0x)?[0-9a-fA-F]{64}$ ]] || fail "ENCLAVE_KEY is not in this process's environment"
  out=$( ( H=$(mktemp -d); trap 'rm -rf "$H"' EXIT; cd $CLIWT && HOME="$H" node cli/enclave.mjs secrets ls "$ID" 2>&1 ) ) || fail "secrets ls failed"
  unset ENCLAVE_KEY
  n=$(grep -oE '\bACCEPT_(API_KEY|TOKEN)\b' <<<"$out" | sort -u | paste -sd,); other=$(grep -oE '\b[A-Z][A-Z0-9_]{2,}\b' <<<"$out" | grep -vxE 'ACCEPT_API_KEY|ACCEPT_TOKEN' | sort -u | paste -sd, || true)
  [ "$n" = "ACCEPT_API_KEY,ACCEPT_TOKEN" ] || fail "secrets ls names: '${n}' (want ACCEPT_API_KEY,ACCEPT_TOKEN)"
  say "4b names ok: the staged secret names are ACCEPT_API_KEY and ACCEPT_TOKEN (other capitalised words in the listing: ${other:-none})";;
refused)
  T=$(st CREATE_TS); [ -n "$T" ] || fail "no CREATE_TS"
  rf() { journalctl --user -u enclave-metal-iso.service --since "$T UTC" --no-pager -o cat | grep -qF "[claim] sweep skips $ID: the deployment carries app config"; }
  wait_for 600 rf || fail "no 'sweep skips … carries app config' refusal for $ID within 10 min of the create"
  vms4 >/dev/null || fail "guestd unreadable"; ! entry4 $ID >/dev/null 2>&1 || fail "guestd holds a guest for the UNLISTED $ID"
  for id in $CAN; do rstat_listed $id || fail "canary ${id:0:10} not listed:true"; done
  say "4b refused ok (the negative control): unlisted, metal-iso0 refuses $ID for its app config and guestd holds no guest for it";;
served)
  up() { vms4 >/dev/null && E=$(entry4 $ID) && python3 -c "import json,sys; e=json.loads(sys.argv[1]); sys.exit(0 if e['status']=='running' and e.get('release') is True else 1)" "$E"; }
  wait_for 900 up || fail "no running release guest for $ID within 15 min"
  GID=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['id'])" "$E"); SER=$PROD/guestd-root/$GID/$GID.serial
  sv() { [ -r "$SER" ] && serial_clean "$SER" | grep -qE '^DOM serving vsock=443 spki_sha256=[0-9a-f]{64} '; }
  wait_for 300 sv || fail "$GID's serial never reached DOM serving"
  echo "GID=$GID" >> "$R/state.env"
  say "4b served ok: release guest $GID for $ID runs and serves";;
proofs)
  GID=$(st GID); L=$(st LIST_TS); [[ "$GID" =~ ^gd[0-9a-f]{8}$ ]] && [ -n "$L" ] || fail "no GID / LIST_TS in state.env (run served, and record LIST_TS at the listing)"
  vms4 >/dev/null || fail "guestd unreadable"; E=$(entry4 $ID) || fail "no guestd entry"
  # proof 2
  M=$(expected_rel $ID) || fail "proof 2: the relay has no admitted 79c5ecf2 prediction for $ID"
  python3 -c "import json,sys; e=json.loads(sys.argv[1]); sys.exit(0 if e['id']=='$GID' and e.get('release') is True and e.get('verdict')=='attested' and e['measurement']=='$M' else 1)" "$E" \
    || fail "proof 2: guestd's entry is not $GID release:true attested with the relay's prediction ${M:0:16}"
  [[ "$M" == $A69M_HEAD*$A69M_TAIL ]] || fail "proof 2: the prediction ${M:0:8}…${M: -4} is not a69dcbba's ${A69M_HEAD}…${A69M_TAIL}"
  KEY=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['transportKeySha256'])" "$E")
  say "4b proof 2 ok: $GID release:true, attested, measurement $M = the relay's prediction for $ID = a69dcbba's (${A69M_HEAD}…${A69M_TAIL})"
  # proofs 1 + 9
  RJ=$($NANX "journalctl -u enclave-api-relay --since '$L UTC' --no-pager -o cat") || fail "proof 1: the relay journal could not be read"
  grep -iF "[secrets-release] $ID:" <<<"$RJ" > $R/relay-lines.txt || true
  [ "$(grep -c . $R/relay-lines.txt || [ $? = 1 ])" = 1 ] && grep -qE "released to a verified guest on .* \(runtime $RUNTIME" $R/relay-lines.txt \
    || fail "proofs 1/9: the relay's lines for $ID are not exactly one 'released to a verified guest … (runtime $RUNTIME…)' (relay-lines.txt)"
  NJ=$(journalctl --user -u enclave-metal-iso.service --since "$L UTC" --no-pager -o cat) || fail "the node journal could not be read"
  grep -F "[isolation] 0x$ID8:" <<<"$NJ" > $R/node-lines.txt || true
  [ "$(grep -cF "release ticket handed to guest $GID" $R/node-lines.txt || [ $? = 1 ])" = 1 ] && ! grep -qE 'did not take the release ticket|release ticket pump for|release ticket for ' $R/node-lines.txt \
    || fail "proofs 1/9: not exactly one ticket handed to $GID (node-lines.txt)"
  say "4b proofs 1+9 ok: one relay release to a verified guest (runtime $RUNTIME…), no REFUSED / no-prediction line; one ticket handed to $GID"
  # proof 8
  certd() { NJ=$(journalctl --user -u enclave-metal-iso.service --since "$L UTC" --no-pager -o cat) && grep -qF "[isolation] 0x$ID8: certificate for $HOST4 installed in guest $GID (key ${KEY:0:16}…" <<<"$NJ"; }
  wait_for 600 certd || fail "proof 8: no certificate installed for $HOST4 in $GID on key ${KEY:0:16}"
  grep -F "[isolation] 0x$ID8:" <<<"$NJ" > $R/node-lines.txt || true
  grep -F "installed in guest $GID" $R/node-lines.txt | grep -qF '; guest attested)' && ! grep -qE 'REFUSED|not an eligible|is no predicted image' $R/node-lines.txt || fail "proof 8: the certificate line is not 'guest attested', or a refusal line"
  [ "$(getent ahostsv4 $HOST4 | awk '{print $1}' | sort -u | paste -sd,)" = 5.78.85.108 ] || fail "proof 8: $HOST4 does not resolve to us-west alone"
  tlsok() { local v s; v=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}/%{ssl_verify_result}' https://$HOST4/ 2>/dev/null); s=$(timeout 20 openssl s_client -connect $HOST4:443 -servername $HOST4 </dev/null 2>/dev/null | openssl x509 -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform der 2>/dev/null | sha256sum | cut -c1-64); [[ "$v" =~ ^[1-5][0-9][0-9]/0$ ]] && [ "$s" = "$KEY" ]; }
  wait_for 300 tlsok || fail "proof 8: https://$HOST4/ is not valid public TLS on the guest's key ${KEY:0:16}"
  cert_names $HOST4 | grep -qF "$HOST4" || fail "proof 8: the certificate does not name $HOST4"
  say "4b proof 8 ok: https://$HOST4/ valid public TLS via us-west on $GID's key ${KEY:0:16}, serial $(cert_serial $HOST4), certificate through the gate (guest attested)";;
gone)
  J=$(row) || fail "the ledger row: fewer than 2 RPCs agree"
  python3 -c "import json,sys; sys.exit(0 if json.loads(sys.argv[1])['active'] is False else 1)" "$J" || fail "the deployment is still active on chain"
  ng() { vms4 >/dev/null && ! entry4 $ID >/dev/null 2>&1; }
  wait_for 600 ng || fail "guestd still holds a guest for $ID"
  curl -sS -m 15 "https://api.enclave.host/v1/secrets/release-status?id=$ID" | grep -q '"listed":false' || fail "release-status for $ID is not listed:false"
  for id in $CAN; do rstat_listed $id || fail "canary ${id:0:10} not listed:true"; done
  say "4b gone ok: $ID inactive on chain, no guest in guestd, unlisted; the 3 canaries still listed";;
*) echo "unknown $cmd"; exit 2;;
esac
