// 99's H2: which ACTIVE deployments does the chain say run on metal-iso0, other than the three canaries? Read-only.
// Prints {ok, block, count, onNode, nonCanary}; any failed read prints {ok:false} and exits 2, so a caller treats it as UNSAFE.
const NODE = "0xf7a1256d22644d59d88fd523a42820586335fb3bcf01f7ed132e9448a298c745";   // metal-iso0's EnclaveRegistry id
const CANARIES = new Set(["0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e"]);
try {
  process.env.ADDRESS_BOOK_ADDRESS ||= "0xab214342d5A490150A4A977063A2f88E21F80907";
  process.env.BASE_RPC ||= "https://base-rpc.publicnode.com";
  const WT = "/home/steven/Projects/enclave-poolacct";
  const ab = await import(WT + "/addressbook.js"); await ab.initAddressBook({ log() {}, warn() {}, error() {}, info() {} });
  if (!/^0x[0-9a-fA-F]{40}$/.test(ab.DEPLOYMENTS_ADDRESS || "")) throw new Error("no deployments address");
  const { createPublicClient, http } = await import(WT + "/node_modules/viem/_esm/index.js");
  const fs = await import("node:fs");
  const raw = JSON.parse(fs.readFileSync(WT + "/contracts/EnclaveDeployments.abi.json", "utf8")); const abi = Array.isArray(raw) ? raw : raw.abi;
  const pub = createPublicClient({ transport: http(process.env.BASE_RPC) });
  const block = await pub.getBlockNumber();
  const read = (functionName, args = []) => pub.readContract({ address: ab.DEPLOYMENTS_ADDRESS, abi, functionName, args, blockNumber: block });
  const n = Number(await read("count"));
  // the canaries by their FULL ids, from guestd's baseline listing (s0-baseline/canaries.tsv)
  for (const l of fs.readFileSync(process.env.HOME + "/enclave-bench/pool-rollout-20260925/s0-baseline/canaries.tsv", "utf8").trim().split("\n")) CANARIES.add(l.split("\t")[0].toLowerCase());
  if (CANARIES.size !== 3) throw new Error(`expected 3 canaries, have ${CANARIES.size}`);
  const onNode = [];
  for (let i = 0; i < n; i += 50) {
    const page = await read("getPage", [BigInt(i), 50n]);
    for (const r of page) if (r.active && String(r.runner).toLowerCase() === NODE) onNode.push({ id: String(r.id).toLowerCase(), leaseUntil: String(r.leaseUntil), cpuMilli: Number(r.cpuMilli) });
  }
  const seen = onNode.length;
  if (seen === 0) throw new Error("the chain lists NO deployment on metal-iso0, not even the canaries: treat the read as failed");
  console.log(JSON.stringify({ ok: true, block: String(block), count: n, onNode, nonCanary: onNode.filter((r) => !CANARIES.has(r.id)) }));
} catch (e) { console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) })); process.exit(2); }
