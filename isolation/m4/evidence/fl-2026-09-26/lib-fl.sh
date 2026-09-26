# First launches of Steven's 3 apps on 52156652 (after his S5 names check and S6 setConfig adding isolation.require),
# watched READ-ONLY by enclave-63 (enclave-87: detect the envelope change on chain, then check the launch; report, never
# retry by hand). Sourced AFTER ../pool-rollout-20260925/lib.sh, ../s4c-20260925/lib4cc.sh, ../release-on-20260925/lib-ro.sh
# and ../e5-20260926/lib-e5.sh (REL=52156652, vms4/entry4, serial_clean/serial_foreign, expected_rel, cert_*).
FL=~/enclave-bench/fl-20260926; LOGF=$FL/fl.log; FST=$FL/state
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOGF"; } 2>/dev/null || true; }
app() {
  case $1 in
    a69dcbba) AFULL=0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77;;
    d9798e4c) AFULL=0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a;;
    a77d0c57) AFULL=0xa77d0c577c1ca48510ff72545f9e050dc7d1fc9c6d1129f056494a5190cb8371;;
    7ae476a3) AFULL=0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33;;   # s3-ipfs-adapter: its envelope keeps {"network":{"relay":"us-west"}}
    *) return 1;;
  esac
  AID=$1; AHOST=$1.app.enclave.host
}
# the ledger row's configCid (the envelope, TRIMMED) as >= 2 of 4 RPCs agree on it; prints
# "<sha256 of it> <requires-snp true|false> <network.relay or ->"
envelope() {
  (cd /home/steven/Projects/enclave && ID="$1" node --input-type=module -e '
    import { createPublicClient, http } from "viem"; import { base } from "viem/chains"; import crypto from "node:crypto";
    const abi = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [
      { name: "id", type: "bytes32" }, { name: "owner", type: "address" }, { name: "appRef", type: "string" }, { name: "ports", type: "string" },
      { name: "configCid", type: "string" }, { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" },
      { name: "isPublic", type: "bool" }, { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" }, { name: "rate", type: "uint256" },
      { name: "balance6", type: "uint256" }, { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" },
      { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" }] }] }];
    const urls = ["https://base.drpc.org", "https://base-rpc.publicnode.com", "https://base-mainnet.public.blastapi.io", "https://mainnet.base.org"];
    const got = await Promise.allSettled(urls.map((u) => createPublicClient({ chain: base, transport: http(u, { retryCount: 1, retryDelay: 500, timeout: 10000 }) })
      .readContract({ address: "0xF9e71385C5cB49844F2457ba6567De0742f8B89a", abi, functionName: "get", args: [process.env.ID] })));
    const envs = got.filter((g) => g.status === "fulfilled").map((g) => String(g.value.configCid || "").trim());
    const agree = envs.filter((e) => e === envs[0]).length;
    if (envs.length < 2 || agree < 2) process.exit(1);
    let req = false, relay = "-"; try { const j = JSON.parse(envs[0]); req = !!(j && j.isolation && j.isolation.require === "snp-guest-per-app"); if (j && j.network && typeof j.network.relay === "string" && /^[a-z0-9-]{1,40}$/.test(j.network.relay)) relay = j.network.relay; } catch {}
    console.log(crypto.createHash("sha256").update(Buffer.from(envs[0])).digest("hex"), req, relay);')
}
