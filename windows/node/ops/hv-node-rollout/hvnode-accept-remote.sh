#!/bin/bash
# hvnode-accept-remote.sh [<deployment id> [<the manager's transportKeySha256 for it>]] - READ-ONLY acceptance of the
# NucBox hv node from OUTSIDE (ROLLOUT.md step 7r): the relay's row, the live restart check, the operator's gas and,
# with a deployment id, the test app served over the guest's TLS. Needs VIEM_DIR (default ~/Projects/enclave) for the
# chain reads. Prints PASS / FAIL / INFO; exits 1 on any FAIL.
set -uo pipefail
ID=${1:-}; KEY=${2:-}
VIEM_DIR=${VIEM_DIR:-$HOME/Projects/enclave}
OPERATOR=0x389C3f030a209D04D026228D2D053fEB75DbadcA
fails=0
check() { if [ "$1" = ok ]; then echo "PASS $2"; else echo "FAIL $2"; fails=$((fails + 1)); fi; }

# R1: the relay's row for nucbox-k11
row=$(curl -sS -m 20 https://api.enclave.host/enclaves | node -e '
  let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
    const r = (JSON.parse(s).enclaves || []).find((e) => e.name === "nucbox-k11");
    if (!r) { console.log("none"); return; }
    const h = r.hvNode || {};
    console.log([r.mode, h.hostExcluded, h.verifiedAt || "-", (h.omissions || []).join(","), r.eligible, r.serving].join(" "));
  });')
set -- $row
[ "${1:-none}" = hv-node ] && c=ok || c=no; check $c "R1 /enclaves row nucbox-k11 mode ${1:-none}"
[ "${2:-}" = false ] && c=ok || c=no; check $c "R1 hvNode.hostExcluded ${2:-?}"
echo "INFO R1 verifiedAt ${3:-?}; omissions ${4:-?}; eligible ${5:-?}; serving ${6:-?}"

# R2: b4's live check: a restart with NO session is refused, never run
rid=${ID:-0x$(printf '0%.0s' $(seq 1 64))}
code=$(curl -sS -o /dev/null -m 20 -w '%{http_code}' -X POST "https://api.enclave.host/t/nucbox-k11/v1/deployments/$rid/restart")
case "$code" in 401|403|404|409|503) c=ok ;; *) c=no ;; esac
check $c "R2 POST /t/nucbox-k11/v1/deployments/${rid:0:10}…/restart without a session -> $code (refused)"

# R3: the operator's gas, and no stuck nonce
g=$(cd "$VIEM_DIR" && node --input-type=module -e '
  import { createPublicClient, http, formatEther } from "viem"; import { base } from "viem/chains";
  const c = createPublicClient({ chain: base, transport: http("https://base.drpc.org", { retryCount: 2 }) });
  const a = process.argv[1];
  const [b, l, p] = await Promise.all([c.getBalance({ address: a }), c.getTransactionCount({ address: a }), c.getTransactionCount({ address: a, blockTag: "pending" })]);
  console.log(formatEther(b), l, p);' "$OPERATOR")
set -- $g
awk -v b="${1:-0}" 'BEGIN { exit !(b >= 0.0005) }' && c=ok || c=no; check $c "R3 operator gas ${1:-?} ETH (>= 0.0005; GAS.md)"
[ "${2:-x}" = "${3:-y}" ] && c=ok || c=no; check $c "R3 operator nonce latest ${2:-?} = pending ${3:-?}"

# R4 (with a deployment id): the ledger names this box, and the app answers over the guest's TLS with the manager's key
if [ -n "$ID" ]; then
  l=$(cd "$VIEM_DIR" && node --input-type=module -e '
    import { createPublicClient, http, keccak256, toHex } from "viem"; import { base } from "viem/chains";
    const c = createPublicClient({ chain: base, transport: http("https://base.drpc.org", { retryCount: 2 }) });
    const abi = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [
      { name: "id", type: "bytes32" }, { name: "owner", type: "address" }, { name: "appRef", type: "string" }, { name: "ports", type: "string" },
      { name: "configCid", type: "string" }, { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" },
      { name: "isPublic", type: "bool" }, { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" }, { name: "rate", type: "uint256" },
      { name: "balance6", type: "uint256" }, { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" },
      { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" }] }] }];
    const d = await c.readContract({ address: "0xF9e71385C5cB49844F2457ba6567De0742f8B89a", abi, functionName: "get", args: [process.argv[1]] });
    const me = keccak256(toHex("https://api.enclave.host/t/nucbox-k11"));
    console.log(d.runner.toLowerCase() === me.toLowerCase(), Number(d.leaseUntil) * 1000 > Date.now(), d.owner, d.appRef, d.configCid);' "$ID")
  set -- $l
  [ "${1:-}" = true ] && c=ok || c=no; check $c "R4 the ledger runner is nucbox-k11 (0xd497d065…)"
  [ "${2:-}" = true ] && c=ok || c=no; check $c "R4 the lease is live"
  echo "INFO R4 owner ${3:-?}; appRef ${4:-?}; envelope ${5:-?}"
  host="${ID:2:8}.app.enclave.host"
  body=$(curl -sk -m 30 "https://$host/"); code=$(curl -sk -o /dev/null -m 30 -w '%{http_code}' "https://$host/")
  [ "$code" = 200 ] && printf '%s' "$body" | grep -q 'Hello' && c=ok || c=no; check $c "R4 https://$host/ -> $code, body has Hello"
  spki=$(echo | openssl s_client -connect "$host:443" -servername "$host" 2>/dev/null | openssl x509 -pubkey -noout 2>/dev/null \
    | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | cut -c1-64)
  echo "INFO R4 the served TLS key: SPKI sha256 $spki (the guest's self-signed certificate until M4)"
  if [ -n "$KEY" ]; then [ "$spki" = "$KEY" ] && c=ok || c=no; check $c "R4 the served key = the manager's transportKeySha256 (A7)"; fi
fi
[ $fails = 0 ] && echo "ACCEPT (remote): all PASS" || { echo "ACCEPT (remote): $fails FAIL(s)"; exit 1; }
