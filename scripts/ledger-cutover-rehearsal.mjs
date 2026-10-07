// Pre-mainnet rehearsal of the ledger 15d cutover (not a CI test). On an anvil FORK of Base:
//   1. scripts/migrate-ledger-delegates.mjs prepare / cutover run against the fork with a test migrator;
//   2. governance (impersonated) retires the old ledger, accepts the new ledger and prover, backs the
//      escrow and flips the book, exactly in the order the cutover writes;
//   3. the vault v2 bundle is deployed and a browser session suspends a deployment its owner's WALLET
//      holds, through the owner's setDelegate on the NEW ledger - refused before, refused after revoke.
// Run: node scripts/ledger-cutover-rehearsal.mjs <vault-bundle.json>
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createPublicClient, createWalletClient, http as vhttp, encodeDeployData, encodeFunctionData, getAddress, parseUnits,
  toHex, keccak256, encodeAbiParameters } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { base } from "viem/chains";
import { createSessionsService } from "../relay/sessions.mjs";
import { JsonStore } from "../relay/store.js";
import * as sdk from "../sdk/sessions/dist/node.mjs";

const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const bundle = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const PORT = 19545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
// publicnode refuses state at a pinned (fork) block as an "archive request": drpc serves it
const anvil = spawn("anvil", ["--fork-url", process.env.FORK_URL || "https://base.drpc.org", "--port", String(PORT), "--silent",
  "--hardfork", "osaka", "--chain-id", "8453", "--retries", "30", "--fork-retry-backoff", "2000", "--compute-units-per-second", process.env.FORK_CUPS || "60"],
  { stdio: "ignore" });
const chain = { ...base, rpcUrls: { default: { http: [RPC] } } };
const pc = createPublicClient({ chain, transport: vhttp(RPC) });
const rpc = (method, params) => pc.request({ method, params });
const log = (...a) => console.log("[cutover]", ...a);
const must = (ok, m) => { if (!ok) throw new Error("CHECK FAILED: " + m); log("ok:", m); };
const BOOK = "0xab214342d5A490150A4A977063A2f88E21F80907";
const GOV = "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61";
const PROV = "0x3d447593739C3f2BaF1A7579CD874baA3e0971aA";   // a USDC float to borrow from (fork only)
const fn = (name, inputs = [], outputs = []) => ({ type: "function", name, stateMutability: outputs.length ? "view" : "nonpayable",
  inputs: inputs.map((type) => ({ type })), outputs: outputs.map((type) => ({ type })) });
const A = {
  book: [fn("addr", ["bytes32"], ["address"])],
  led: [fn("retire"), fn("retired", [], ["bool"]), fn("owner", [], ["address"]), fn("count", [], ["uint256"]), fn("importsSealed", [], ["bool"]),
    fn("setDelegate", ["address", "bool"]), fn("setActive", ["bytes32", "bool"]), fn("prover", [], ["address"]), fn("feeRouter", [], ["address"]),
    fn("create", ["string", "uint16", "uint16", "uint32", "string", "bool", "string", "address", "uint256", "uint256"])],
  erc20: [fn("transfer", ["address", "uint256"]), fn("balanceOf", ["address"], ["uint256"])],
};
const GET = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components:
  [["id","bytes32"],["owner","address"],["appRef","string"],["ports","string"],["configCid","string"],["gpuMilli","uint16"],["cpuMilli","uint16"],
   ["appPort","uint32"],["isPublic","bool"],["active","bool"],["createdAt","uint64"],["rate","uint256"],["balance6","uint256"],["spent6","uint256"],
   ["runner","bytes32"],["runnerOperator","address"],["leaseUntil","uint64"]].map(([name, type]) => ({ name, type })) }] },
  fn("getPage", ["uint256", "uint256"], [])];
const bookAddr = (k) => pc.readContract({ address: BOOK, abi: A.book, functionName: "addr", args: [toHex(k, { size: 32 })] });
async function asGov(to, data, label) {
  const wc = createWalletClient({ chain, account: GOV, transport: vhttp(RPC) });
  const h = await wc.sendTransaction({ to, data });
  const rc = await pc.waitForTransactionReceipt({ hash: h });
  if (rc.status !== "success") throw new Error(`governance ${label} reverted`);
  log("governance:", label, "gas", rc.gasUsed);
}
let server;
try {
  for (let i = 0; i < 200; i++) { try { await pc.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
  log("fork at block", await pc.getBlockNumber());
  const oldLedger = getAddress(await bookAddr("deployments"));
  const oldCount = await pc.readContract({ address: oldLedger, abi: A.led, functionName: "count" });
  log("live ledger", oldLedger, "records", oldCount);

  // ---- 1. prepare (migrator) -------------------------------------------------------------
  const migKey = generatePrivateKey();
  await rpc("anvil_setBalance", [privateKeyToAccount(migKey).address, toHex(10n ** 18n)]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cutover-"));
  const stateFile = path.join(tmp, "state.json");
  const runMig = (cmd) => execFileSync(process.execPath, [path.join(REPO, "scripts/migrate-ledger-delegates.mjs"), cmd, "--rpc", RPC, "--state", stateFile],
    { env: { ...process.env, ENCLAVE_MIGRATOR_KEY: migKey }, stdio: "inherit", timeout: 1_800_000 });
  runMig("prepare");
  // the cutover refuses before the old ledger is retired
  let refused = false;
  try { execFileSync(process.execPath, [path.join(REPO, "scripts/migrate-ledger-delegates.mjs"), "cutover", "--rpc", RPC, "--state", stateFile],
    { env: { ...process.env, ENCLAVE_MIGRATOR_KEY: migKey }, stdio: "pipe" }); } catch { refused = true; }
  must(refused, "cutover refuses while the old ledger is not retired");

  // ---- 2. the cutover window: governance retires, migrator seals, governance accepts/backs/flips ----
  await rpc("anvil_impersonateAccount", [GOV]);
  await rpc("anvil_setBalance", [GOV, toHex(10n ** 18n)]);
  await asGov(oldLedger, encodeFunctionData({ abi: A.led, functionName: "retire" }), "retire the old ledger");
  runMig("cutover");
  const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const need = BigInt(st.escrow?.total6 || 0);
  const govUsdc = await pc.readContract({ address: usdc, abi: A.erc20, functionName: "balanceOf", args: [GOV] });
  log("escrow backing needed", need, "governance holds", govUsdc);
  if (govUsdc < need) {                                      // fork only: top governance up from a float
    await rpc("anvil_impersonateAccount", [PROV]); await rpc("anvil_setBalance", [PROV, toHex(10n ** 17n)]);
    const pw = createWalletClient({ chain, account: PROV, transport: vhttp(RPC) });
    await pc.waitForTransactionReceipt({ hash: await pw.writeContract({ address: usdc, abi: A.erc20, functionName: "transfer", args: [GOV, need - govUsdc + 1n] }) });
  }
  for (const c of st.governanceCalls) await asGov(c.to, c.data, c.label);

  // ---- 3. the checks ------------------------------------------------------------------------
  must(eq(await bookAddr("deployments"), st.ledger), "the book names the new ledger");
  must(eq(await bookAddr("proofOfTime"), st.proofOfTime), "the book names the new prover");
  must(eq(await bookAddr("verificationFees"), st.verificationFees), "the book names the new fee router");
  must(eq(await pc.readContract({ address: st.ledger, abi: A.led, functionName: "owner" }), GOV), "governance owns the new ledger");
  must(await pc.readContract({ address: st.ledger, abi: A.led, functionName: "importsSealed" }), "imports are sealed");
  must(await pc.readContract({ address: st.ledger, abi: A.led, functionName: "count" }) === oldCount, `all ${oldCount} records imported`);
  must(eq(await pc.readContract({ address: st.ledger, abi: A.led, functionName: "prover" }), st.proofOfTime), "the new prover is bound");
  must(eq(await pc.readContract({ address: st.ledger, abi: A.led, functionName: "feeRouter" }), st.verificationFees), "the new fee router is bound");
  must(await pc.readContract({ address: oldLedger, abi: A.led, functionName: "retired" }), "the old ledger is retired");

  // ---- 4. vault v2 on the new ledger: a session suspends a WALLET record via the delegation ----
  const dk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const dep = createWalletClient({ chain, account: privateKeyToAccount(dk), transport: vhttp(RPC) });
  await rpc("anvil_setBalance", [dep.account.address, toHex(10n ** 18n)]);
  const out = {};
  for (const s of bundle.steps) {
    let bc = s.bytecode;
    if (s.link) {
      let b = bc.slice(2);
      for (const lib of Object.values(s.linkReferences || {})) for (const slots of Object.values(lib)) for (const { start, length } of slots)
        b = b.slice(0, start * 2) + out[s.link].slice(2).toLowerCase() + b.slice((start + length) * 2);
      bc = "0x" + b;
    }
    const args = (s.args || []).map((a) => typeof a === "string" && a.startsWith("$") ? out[a.slice(1)] : a)
      .map((a) => typeof a === "string" && /^\d+n$/.test(a) ? BigInt(a.slice(0, -1)) : a);
    const rc = await pc.waitForTransactionReceipt({ hash: await dep.sendTransaction({ data: s.abi ? encodeDeployData({ abi: s.abi, bytecode: bc, args }) : bc }) });
    if (rc.status !== "success") throw new Error(s.name + " failed");
    out[s.name] = getAddress(rc.contractAddress);
  }
  log("vault v2 factory", out.sessionVaultFactory);
  const relayer = privateKeyToAccount(generatePrivateKey());
  await rpc("anvil_setBalance", [relayer.address, toHex(10n ** 17n)]);
  const svc = createSessionsService({ pc, wc: createWalletClient({ chain, account: relayer, transport: vhttp(RPC) }), account: relayer,
    chainId: 8453, factory: out.sessionVaultFactory, book: BOOK, usdc, router: bundle.meta.router, startBlock: Number(await pc.getBlockNumber()),
    store: new JsonStore(path.join(tmp, "i.json"), {}), journal: new JsonStore(path.join(tmp, "j.json"), { txs: [] }, { durable: true }),
    log: () => {}, alert: () => {} });
  server = http.createServer((req, res) => svc.handle(req, res, new URL(req.url, "http://x"), null));
  await new Promise((r) => server.listen(0, r));
  const relayUrl = `http://127.0.0.1:${server.address().port}`;

  const owner = privateKeyToAccount(generatePrivateKey());
  await rpc("anvil_setBalance", [owner.address, toHex(10n ** 17n)]);
  const ow = createWalletClient({ chain, account: owner, transport: vhttp(RPC) });
  // a free catalog app any live record already runs
  const rows = await pc.readContract({ address: st.ledger, abi: [{ ...GET[0], name: "getPage", inputs: [{ type: "uint256" }, { type: "uint256" }],
    outputs: [{ type: "tuple[]", components: GET[0].outputs[0].components }] }], functionName: "getPage", args: [0n, 70n] });
  const appRef = rows.find((r) => /^catalog:\/\/0x[0-9a-f]{64}\/\d+$/.test(r.appRef))?.appRef;
  const crc = await pc.waitForTransactionReceipt({ hash: await ow.writeContract({ address: st.ledger, abi: A.led, functionName: "create",
    args: [appRef, 0, 100, 8080, "", false, "", "0x0000000000000000000000000000000000000000", 0n, 1000n] }) });
  const id = crc.logs.find((l) => eq(l.address, st.ledger)).topics[1];
  log("wallet record", id, "on", appRef);

  const store = new sdk.MemoryStore();
  const { signer, record } = await sdk.newSessionKey(store, { relay: relayUrl, chainId: 8453, label: "cutover", extractable: true });
  const grant = sdk.buildGrant({ sessionKey: signer.keyHash, label: "cutover browser", preset: "browser", policy: { budget: 0n } });
  const vault = await sdk.vaultAddress(pc, out.sessionVaultFactory, owner.address);
  await sdk.openSession({ relay: new sdk.RelayClient(relayUrl), owner: { address: owner.address, signTypedData: (td) => owner.signTypedData(td) },
    chainId: 8453, vault, grant });
  const session = await sdk.sessionFromRecord(await sdk.completeSession(store, record, { vault, owner: owner.address, grant, rpc: RPC }));
  const row = () => pc.readContract({ address: st.ledger, abi: GET, functionName: "get", args: [id] });
  const fails = async (p) => { try { await p; return false; } catch { return true; } };
  must(await fails(session.call("deploy.setActive", { id, active: false })), "no delegation: the session can't touch the wallet's record");
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }],
    [vault, keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner.address, BigInt(st.delegateSlot)]))]));
  await pc.waitForTransactionReceipt({ hash: await ow.writeContract({ address: st.ledger, abi: A.led, functionName: "setDelegate", args: [vault, true] }) });
  must(BigInt(await pc.getStorageAt({ address: st.ledger, slot })) === 1n, "the grant reads back from the recorded slot");
  await session.call("deploy.setActive", { id, active: false });
  must((await row()).active === false, "the session suspended the wallet's record, no wallet signature");
  must(await fails(session.call("deploy.setAppRef", { id, appRef })), "what a wallet record runs stays the wallet's");
  await session.call("deploy.setActive", { id, active: true });
  await pc.waitForTransactionReceipt({ hash: await ow.writeContract({ address: st.ledger, abi: A.led, functionName: "setDelegate", args: [vault, false] }) });
  must(await fails(session.call("deploy.setActive", { id, active: false })), "revoked: refused again");
  must((await row()).owner === owner.address, "the record stayed the wallet's throughout");
  log("CUTOVER REHEARSAL OK");
} catch (e) {
  console.error("[cutover] FAILED:", e.stack || e.message);
  process.exitCode = 1;
} finally {
  server?.close();
  anvil.kill("SIGKILL");
}
function eq(a, b) { return String(a || "").toLowerCase() === String(b || "").toLowerCase(); }
