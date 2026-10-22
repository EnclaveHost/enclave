// A PUBLIC, read-only funding plan for the apps the phone host (pixel10-pvm-cpu) serves: which deployments its registered
// identity holds or may claim, who owns each, and the EXACT unsigned calls each owner would make to enroll that app in the
// app-funded lease gas reserve (EnclaveLeaseGasReserve). It never signs, never simulates with anyone's balance, never reads a
// key or a wallet file. The 25-operation enrollment approved on 2026-10-20 covers 9 Windows and 2 Linux apps, NOT the phone:
// anything this prints needs its own human approval, by each app's owner.
//
//   node phone-funding-plan.mjs --endpoint <registered endpoint string> [--out plan.json]
//
// Reads (public RPCs, two must agree on every value at one block): the address book (registry, deployments), the registry
// row for keccak256(endpoint), every deployment page (runner == the phone's enclaveId: held now), the reserve's current
// reserve for each (owner of record).
import fs from "node:fs";
import { createPublicClient, http, parseAbi, keccak256, stringToBytes, hexToString, encodeFunctionData, toHex } from "../../enclave/node_modules/viem/_esm/index.js";
import { base } from "../../enclave/node_modules/viem/_esm/chains/index.js";

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const endpoint = arg("--endpoint"); if (!endpoint) { console.error("usage: --endpoint <registered endpoint>"); process.exit(2); }
const RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"];
const BOOK = "0xab214342d5a490150a4a977063a2f88e21f80907";            // standalone/build.json addressBook (public)
const RESERVE = "0x12a3f873041dec436daa0085b766a399a6fa3639";         // outputs/app-lease-gas-review/enrollment-bootstrap-proposal.json
const BOOK_ABI = parseAbi(["function all() view returns (bytes32[], address[])"]);
const REG_ABI = parseAbi(["function get(bytes32 id) view returns ((string endpoint, string repo, bytes32 measurement, address operator, uint64 registeredAt, uint64 lastSeen, bool active, uint64 cpuPricePerSec6, uint64 gpuPricePerSec6, address proofKey))"]);
const DEP_ABI = parseAbi(["function count() view returns (uint256)",
  "function getPage(uint256 start, uint256 n) view returns ((bytes32 id, address owner, string appRef, string ports, string configCid, uint16 gpuMilli, uint16 cpuMilli, uint32 appPort, bool isPublic, bool active, uint64 createdAt, uint256 rate, uint256 balance6, uint256 spent6, bytes32 runner, address runnerOperator, uint64 leaseUntil)[])"]);
const RES_ABI = parseAbi([
  "struct Policy { bool enabled; uint8 claimPolicy; bool sponsorRelease; uint8 maxClaimsPerEpoch; uint64 maxPerOpWei; uint64 epochCapWei; uint32 epochSec; uint32 renewWindow; uint32 minExtension; uint32 claimCooldown; uint64 maxGasPrice; }",
  "function deposit(bytes32 id) payable", "function configure(bytes32 id, Policy p)", "function setClaimant(bytes32 id, address operator, bool allowed)",
  "function claimantAllowed(bytes32 key, address operator) view returns (bool)", "function budgetKey(bytes32 id, address owner_) pure returns (bytes32)"]);
const VAULT_ABI = parseAbi(["function ownerCall(address to, bytes data) payable returns (bytes)"]);
// the APPROVED enrollment's per-app caps (outputs/app-lease-gas-review/enrollment-bootstrap-proposal.json apps[*].policy), with
// claimPolicy 2 (ALLOWLIST: only the phone's operator) because the phone serves apps it does not own
const POLICY = { enabled: true, claimPolicy: 2, sponsorRelease: true, maxClaimsPerEpoch: 4, maxPerOpWei: 31092172031561n, epochCapWei: 310921720315610n,
                 epochSec: 3600, renewWindow: 300, minExtension: 600, claimCooldown: 1800, maxGasPrice: 50000000n };
const PER_APP_WEI = 100000000000000n;   // the approved enrollment's per-app deposit, shown for comparison; NOT approved for these apps

const clients = RPCS.map((u) => createPublicClient({ chain: base, transport: http(u, { timeout: 20000 }) }));
const heads = await Promise.all(clients.map((c) => c.getBlockNumber()));
const block = heads.reduce((a, b) => (a < b ? a : b)) - 2n;
const agree = async (f) => {
  const r = await Promise.all(clients.map((c) => f(c)));
  const s = r.map((x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  if (s.some((x) => x !== s[0])) throw new Error("the RPCs disagree at block " + block);
  return r[0];
};
const read = (address, abi, functionName, args = []) => agree((c) => c.readContract({ address, abi, functionName, args, blockNumber: block }));
const [keys, values] = await read(BOOK, BOOK_ABI, "all");
const book = Object.fromEntries(keys.map((k, i) => [hexToString(k, { size: 32 }).replace(/\0+$/, ""), values[i].toLowerCase()]));
const enclaveId = keccak256(stringToBytes(endpoint));
const reg = await read(book.registry, REG_ABI, "get", [enclaveId]);
const n = Number(await read(book.deployments, DEP_ABI, "count"));
const rows = [];
for (let s = 0; s < n; s += 100) rows.push(...await read(book.deployments, DEP_ABI, "getPage", [BigInt(s), BigInt(Math.min(100, n - s))]));
const now = Number((await clients[0].getBlock({ blockNumber: block })).timestamp);
const held = rows.filter((d) => d.runner.toLowerCase() === enclaveId.toLowerCase());
const op = reg.operator.toLowerCase();
const apps = [];
for (const d of held) {
  const owner = d.owner.toLowerCase();
  const code = await agree((c) => c.getCode({ address: owner, blockNumber: block }));
  const key = await read(RESERVE, RES_ABI, "budgetKey", [d.id, d.owner]);
  const allowed = await read(RESERVE, RES_ABI, "claimantAllowed", [key, reg.operator]);
  const viaVault = !!code && code !== "0x";
  const wrap = (data) => (viaVault ? { to: owner, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "ownerCall", args: [RESERVE, data] }) } : { to: RESERVE, data });
  apps.push({ id: d.id, owner, ownerIsContract: viaVault, appRef: d.appRef, active: d.active, isPublic: d.isPublic, leaseLive: Number(d.leaseUntil) > now,
              phoneOperatorAllowedNow: allowed,
              calls: [
                { who: "anyone (the owner, or a sponsor)", action: "deposit", to: RESERVE, value: "<amount: needs a new human approval>", data: encodeFunctionData({ abi: RES_ABI, functionName: "deposit", args: [d.id] }) },
                { who: `the owner of record${viaVault ? " (a contract: through its ownerCall)" : ""}`, action: "allow the phone's operator as claimant", ...wrap(encodeFunctionData({ abi: RES_ABI, functionName: "setClaimant", args: [d.id, reg.operator, true] })), value: "0x0" },
                { who: `the owner of record${viaVault ? " (a contract: through its ownerCall)" : ""}`, action: "configure lease sponsorship (allowlist, the approved enrollment's caps)", ...wrap(encodeFunctionData({ abi: RES_ABI, functionName: "configure", args: [d.id, POLICY] })), value: "0x0" },
              ] });
}
const out = { status: "PUBLIC PLAN ONLY: no transaction signed or simulated; every call needs its owner's own approval", chainId: 8453, block: String(block), rpcs: RPCS,
  addressBook: BOOK, registry: book.registry, ledger: book.deployments, reserve: RESERVE,
  phone: { endpoint, enclaveId, operator: op, active: reg.active, measurement: reg.measurement, proofKey: reg.proofKey.toLowerCase() },
  policy: Object.fromEntries(Object.entries(POLICY).map(([k, v]) => [k, typeof v === "bigint" ? String(v) : v])),
  comparison: { approvedEnrollmentPerAppWei: String(PER_APP_WEI), note: "the 25-operation enrollment (2026-10-20) covers 9 Windows and 2 Linux apps; the phone's apps are not in it" },
  apps };
const text = JSON.stringify(out, null, 1) + "\n";
if (arg("--out")) fs.writeFileSync(arg("--out"), text, { flag: "wx" });
process.stdout.write(text);
