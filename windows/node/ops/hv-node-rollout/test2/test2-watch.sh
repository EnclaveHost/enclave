#!/bin/bash
# test2-watch.sh <deployment id> - READ-ONLY, one line per call: what the RELAY, the PUBLIC and the LEDGER say about one
# test-2 deployment right now (TEST2.md). Needs VIEM_DIR (default ~/Projects/enclave) for the ledger read.
#   relay:  the owners nucbox-k11's row serves (B's row.served, from the node's last attach, re-verified by the relay every
#           60 s, so it may lag an expiry by up to 60 s), and whether the id is in its
#           servesDeployments (enclave-e3's B), and until when
# The ledger address is the CLI's default deployments ledger (0xF9e71385…); the node resolves its own from the address
# book, and today they are the same (enclave-b4's review).
#   public: https://<id8>.app.enclave.host/ - the HTTP code with CA verification (M4) and without it (-k), and the SPKI;
#           VIA=x: the same, through nan's /x splice (xsplice.mjs), while us-west cannot reach the box (B step 1b held)
#   ledger: runner (nucbox-k11 or not), leaseUntil, active, rate (0 = self-hosted: the owner is the box's payout wallet),
#           balance6, the options envelope
set -uo pipefail
ID=${1:?usage: test2-watch.sh <0x…64 id>}; ID=$(echo "$ID" | tr 'A-F' 'a-f')
VIEM_DIR=${VIEM_DIR:-$HOME/Projects/enclave}
HERE=$(cd "$(dirname "$0")" && pwd)
now=$(date -u +%FT%TZ)
relay=$(curl -sS -m 20 https://api.enclave.host/enclaves | ID="$ID" node -e '
  let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
    const r = (JSON.parse(s).enclaves || []).find((e) => e.name === "nucbox-k11");
    if (!r) return console.log("row=absent");
    const sv = Array.isArray(r.servesDeployments) ? r.servesDeployments : null;
    const me = sv && sv.find((x) => String(x.id || x).toLowerCase() === process.env.ID);
    // the owners the relay took from the LAST attach of the node (B: row.served, sorted by owner; expires null = the operator)
    const iso = (sec) => new Date(Number(sec) * 1000).toISOString();
    const owners = Array.isArray(r.served) ? r.served.map((e) => String(e.owner).slice(0, 6) + "(" + (e.expires === null ? "op" : "until " + iso(e.expires)) + ")").join(",") : "n/a";
    console.log(`row=${r.mode} ownerOnly=${r.ownerOnly === true} owners=[${owners}] served=${sv ? (me ? "yes" : "no") : "n/a"}${me && me.until ? " until=" + iso(me.until) : ""}`);
  });' 2>/dev/null || echo "row=unreadable")
host="${ID:2:8}.app.enclave.host"
if [ "${VIA:-sni}" = x ]; then
  # through nan's data plane (xsplice.mjs: the WebSocket the SNI relay opens, B's owner-only gate at decision time), for
  # while B's step 1b on us-west is held and the public name cannot reach the box (enclave-d1's M1)
  pub="via=x $(cd "$VIEM_DIR" && timeout 60 node --input-type=module - "$ID" < "$HERE/xsplice.mjs" 2>/dev/null || echo "x=error(xsplice) ca=000 k=000 spki=none")"
else
  ca=$(curl -s -o /dev/null -m 20 -w '%{http_code}' "https://$host/" 2>/dev/null); ca=${ca:-000}
  k=$(curl -sk -o /dev/null -m 20 -w '%{http_code}' "https://$host/" 2>/dev/null); k=${k:-000}
  der=$(echo | timeout 20 openssl s_client -connect "$host:443" -servername "$host" 2>/dev/null | openssl x509 -pubkey -noout 2>/dev/null \
    | openssl pkey -pubin -outform DER 2>/dev/null | base64 -w0)
  spki=$([ -n "$der" ] && printf '%s' "$der" | base64 -d | sha256sum | cut -c1-16 || echo none)
  pub="via=sni ca=$ca k=$k spki=${spki:-none}"
fi
ledger=$(cd "$VIEM_DIR" && node --input-type=module -e '
  import { createPublicClient, http, keccak256, toHex } from "viem"; import { base } from "viem/chains";
  const c = createPublicClient({ chain: base, transport: http("https://base-rpc.publicnode.com", { retryCount: 2 }) });
  const abi = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [
    { name: "id", type: "bytes32" }, { name: "owner", type: "address" }, { name: "appRef", type: "string" }, { name: "ports", type: "string" },
    { name: "configCid", type: "string" }, { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" },
    { name: "isPublic", type: "bool" }, { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" }, { name: "rate", type: "uint256" },
    { name: "balance6", type: "uint256" }, { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" },
    { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" }] }] }];
  const d = await c.readContract({ address: "0xF9e71385C5cB49844F2457ba6567De0742f8B89a", abi, functionName: "get", args: [process.argv[1]] });
  const me = keccak256(toHex("https://api.enclave.host/t/nucbox-k11")).toLowerCase();
  const r = d.runner.toLowerCase(), lu = Number(d.leaseUntil);
  console.log(`runner=${r === me ? "nucbox-k11" : /^0x0+$/.test(r) ? "none" : r.slice(0, 10)} lease=${lu ? new Date(lu * 1000).toISOString() : "-"}${lu * 1000 > Date.now() ? "(live)" : "(lapsed)"} active=${d.active} rate=${d.rate} balance6=${d.balance6} envelope=${d.configCid}`);' "$ID" 2>/dev/null || echo "ledger=unreadable")
echo "$now $ID | $relay | public $pub | $ledger"
