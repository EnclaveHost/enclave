// ledger-reboot.mjs - READ-ONLY ledger reads for REBOOT-GO-v42.md (enclave-bf's R2): what hvnode-accept-remote.sh does not
// print. Chain reads only (Base, public RPCs); nothing is signed or sent. viem comes from VIEM_DIR (default ~/Projects/enclave).
//   node ledger-reboot.mjs get <id>                      the block, runner, leaseUntil (and minutes left), balance6, spent6
//   node ledger-reboot.mjs events <id> <fromBlock> [<toBlock>]
//        Claimed(id) and Released(id) in [fromBlock, toBlock or latest]: PASS only when there are NONE of either (a release
//        followed by a re-claim also ends "same runner, live lease"); Renewed(id) is listed as INFO. Exit 1 on FAIL.
import { createRequire } from "node:module"; import os from "node:os"; import path from "node:path";
const req = createRequire(path.join(process.env.VIEM_DIR || path.join(os.homedir(), "Projects/enclave"), "package.json"));
const { createPublicClient, http, fallback, keccak256, toHex, parseAbiItem } = await import(req.resolve("viem"));
const { base } = await import(req.resolve("viem/chains"));
const DEPLOYMENTS = "0xF9e71385C5cB49844F2457ba6567De0742f8B89a";
const NUCBOX = keccak256(toHex("https://api.enclave.host/t/nucbox-k11")).toLowerCase();
const c = createPublicClient({ chain: base, transport: fallback(["https://base.drpc.org", "https://base-rpc.publicnode.com", "https://mainnet.base.org"]
  .map((u) => http(u, { retryCount: 2, retryDelay: 600 }))) });
const [cmd, id, from, to] = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{64}$/.test(id || "")) { console.log("usage: ledger-reboot.mjs get <id> | events <id> <fromBlock> [<toBlock>]"); process.exit(2); }
const iso = (s) => new Date(Number(s) * 1000).toISOString();
if (cmd === "get") {
  const abi = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [
    { name: "id", type: "bytes32" }, { name: "owner", type: "address" }, { name: "appRef", type: "string" }, { name: "ports", type: "string" },
    { name: "configCid", type: "string" }, { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" },
    { name: "isPublic", type: "bool" }, { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" }, { name: "rate", type: "uint256" },
    { name: "balance6", type: "uint256" }, { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" },
    { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" }] }] }];
  const b = await c.getBlock();   // the block read at: the from-block of a later `events` (step 4)
  const d = await c.readContract({ address: DEPLOYMENTS, abi, functionName: "get", args: [id], blockNumber: b.number });
  const left = (Number(d.leaseUntil) - Number(b.timestamp)) / 60;
  console.log(`block ${b.number} (${iso(b.timestamp)}); read ${new Date().toISOString()}`);
  console.log(`runner ${d.runner}${d.runner.toLowerCase() === NUCBOX ? " = nucbox-k11" : " (NOT nucbox-k11)"}; runnerOperator ${d.runnerOperator}; active ${d.active}`);
  console.log(`leaseUntil ${d.leaseUntil} = ${iso(d.leaseUntil)} (${left.toFixed(1)} min after that block)`);
  console.log(`balance6 ${d.balance6}; spent6 ${d.spent6}; rate ${d.rate}`);
} else if (cmd === "events") {
  if (!/^\d+$/.test(from || "") || (to && !/^\d+$/.test(to))) { console.log("events needs a decimal <fromBlock> (step 4's `get` block) [and <toBlock>]"); process.exit(2); }
  const last = to ? BigInt(to) : await c.getBlockNumber();
  const evs = { Claimed: parseAbiItem("event Claimed(bytes32 indexed id, bytes32 indexed enclaveId, address indexed operator, uint64 leaseUntil, uint256 burned6)"),
    Released: parseAbiItem("event Released(bytes32 indexed id, bytes32 indexed enclaveId, uint256 refunded6)"),
    Renewed: parseAbiItem("event Renewed(bytes32 indexed id, bytes32 indexed enclaveId, uint64 leaseUntil, uint256 burned6)") };
  const found = { Claimed: [], Released: [], Renewed: [] };
  for (let a = BigInt(from); a <= last; a += 1000n) {
    const b = a + 999n < last ? a + 999n : last;
    for (const [n, event] of Object.entries(evs))
      found[n].push(...await c.getLogs({ address: DEPLOYMENTS, event, args: { id }, fromBlock: a, toBlock: b }));
  }
  console.log(`blocks ${from}..${last} (${last - BigInt(from) + 1n}); Deployments ${DEPLOYMENTS}; id ${id}`);
  for (const [n, l] of Object.entries(found))
    for (const e of l) console.log(`${n === "Renewed" ? "INFO" : "FOUND"} ${n} block ${e.blockNumber} tx ${e.transactionHash} ${n === "Released" ? `refunded6 ${e.args.refunded6}` : `leaseUntil ${iso(e.args.leaseUntil)}`} enclave ${e.args.enclaveId.toLowerCase() === NUCBOX ? "nucbox-k11" : e.args.enclaveId}`);
  const bad = found.Claimed.length + found.Released.length;
  console.log(`${bad ? "FAIL" : "PASS"} Claimed ${found.Claimed.length}, Released ${found.Released.length} (both must be 0); Renewed ${found.Renewed.length} (INFO)`);
  process.exit(bad ? 1 : 0);
} else { console.log("usage: ledger-reboot.mjs get <id> | events <id> <fromBlock> [<toBlock>]"); process.exit(2); }
