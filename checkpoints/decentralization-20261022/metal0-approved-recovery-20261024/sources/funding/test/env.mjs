// Local fixtures ONLY (loopback; THROWAWAY keys generated per run; nothing production): anvil (chain 8453, hardfork
// prague = real revm EIP-7702 processing, manual mining), two "providers" on 127.0.0.1/127.0.0.2, the reviewed
// EnclaveLeaseExecutor source rebuilt locally, a reserve stub bound to it, the mock GasPriceOracle, and an operator O
// (stands for C9) delegated to the executor with pre-existing lease state in its storage.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { encodeFunctionData, encodeDeployData, keccak256, getContractAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PRODUCTION, designatorOf, nonceSlot, authorizedSlot } from "../lib/maintenance.mjs";

const fx = (f) => JSON.parse(fs.readFileSync(new URL("./fixtures/" + f, import.meta.url), "utf8"));
export const EXEC = fx("executor-build.json"), STUB = fx("reserve-stub.json"), ORACLE = fx("oracle-mock.json"), LEDGER = fx("ledger-stub.json");
export const pad32 = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
export const ID1 = "0x" + "d1".repeat(32), ID2 = "0x" + "d2".repeat(32);
const freePort = () => new Promise((ok) => { const t = net.createServer(); t.listen(0, "127.0.0.1", () => { const p = t.address().port; t.close(() => ok(p)); }); });
const listen = (s, host) => new Promise((ok) => s.listen(0, host, () => ok(s.address().port)));

export async function startWorld({ tip = "0xf4240" } = {}) {
  const port = await freePort(), URL0 = `http://127.0.0.1:${port}`;
  const proc = spawn("anvil", ["--chain-id", "8453", "--hardfork", "prague", "--port", String(port), "--block-base-fee-per-gas", "5000000", "--no-mining", "--silent"], { stdio: "ignore" });
  let id = 0;
  const raw = async (method, params = []) => {
    const r = await fetch(URL0, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const j = await r.json(); if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { rpcError: j.error }); return j.result;
  };
  for (let i = 0; i < 100; i++) { try { await raw("eth_chainId"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const mine = async (n = 1) => { for (let i = 0; i < n; i++) await raw("evm_mine"); };
  const keys = Object.fromEntries(["O", "S", "T", "R"].map((k) => [k, privateKeyToAccount(generatePrivateKey())]));
  for (const k of Object.values(keys)) await raw("anvil_setBalance", [k.address, "0x" + (10n ** 17n).toString(16)]);
  const fees = { maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 1_000_000n };
  const nonceOf = async (a, tag = "pending") => Number(BigInt(await raw("eth_getTransactionCount", [a, tag])));
  /** test-only signer: sign with a throwaway key and send raw */
  const sendRaw = async (account, tx) => raw("eth_sendRawTransaction", [await account.signTransaction({ chainId: 8453, ...fees, ...tx })]);
  // deploy the reserve stub and the REAL executor from S, bind, then delegate O to the executor (S sponsors O's authorization)
  const S = keys.S;
  const ledger = "0x00000000000000000000000000000000000000aa";
  let sn = await nonceOf(S.address);
  const stub = getContractAddress({ from: S.address, nonce: BigInt(sn) });
  await sendRaw(S, { type: "eip1559", nonce: sn++, gas: 1_000_000n, data: encodeDeployData({ abi: STUB.abi, bytecode: STUB.creation, args: [ledger] }) });
  const executor = getContractAddress({ from: S.address, nonce: BigInt(sn) });
  await sendRaw(S, { type: "eip1559", nonce: sn++, gas: 3_000_000n, data: encodeDeployData({ abi: EXEC.abi, bytecode: EXEC.creation, args: [stub] }) });
  await mine();
  await sendRaw(S, { type: "eip1559", nonce: sn++, to: stub, gas: 200_000n, data: encodeFunctionData({ abi: STUB.abi, functionName: "bind", args: [executor] }) });
  const ledgerAddr = getContractAddress({ from: S.address, nonce: BigInt(sn) });
  await sendRaw(S, { type: "eip1559", nonce: sn++, gas: 2_000_000n, data: LEDGER.creation });
  const auth0 = await keys.O.signAuthorization({ chainId: 8453, contractAddress: executor, nonce: await nonceOf(keys.O.address) });
  await sendRaw(S, { type: "eip7702", nonce: sn++, to: S.address, gas: 100_000n, authorizationList: [auth0] });
  await raw("anvil_setCode", [PRODUCTION.oracle, ORACLE.runtime]);
  await mine();
  if ((await raw("eth_getCode", [keys.O.address, "latest"])).toLowerCase() !== designatorOf(executor)) throw Error("setup: O not delegated");
  // two leases held by O, 1500 s from now (a lease has at most ~1800 s; the timing profile needs >= 1200 s at the prepare)
  const ts0 = Number(BigInt((await raw("eth_getBlockByNumber", ["latest", false])).timestamp));
  for (const id of [ID1, ID2]) await sendRaw(S, { type: "eip1559", nonce: sn++, to: ledgerAddr, gas: 300_000n, data: encodeFunctionData({ abi: LEDGER.abi, functionName: "set", args: [id, true, keys.O.address, BigInt(ts0 + 1500)] }) });
  await mine();
  const cfg = Object.freeze({ ...PRODUCTION, operator: keys.O.address.toLowerCase(), executor: executor.toLowerCase(), reserve: stub.toLowerCase(), sponsor: S.address.toLowerCase(),
    ledger: ledgerAddr.toLowerCase(), ledgerCodeHash: keccak256(await raw("eth_getCode", [ledgerAddr, "latest"])),
    executorCodeHash: keccak256(await raw("eth_getCode", [executor, "latest"])), reserveCodeHash: keccak256(await raw("eth_getCode", [stub, "latest"])),
    delegationCodeHash: keccak256(designatorOf(executor)) });
  // pre-existing lease state in O's storage (as earlier leases through the executor would have left it) + an unrelated slot
  const slots = { [nonceSlot(cfg, ID1)]: pad32(7), [nonceSlot(cfg, ID2)]: pad32(3), [authorizedSlot(cfg)]: pad32(1), [pad32(12345)]: pad32(0xabcdef) };
  for (const [k, v] of Object.entries(slots)) await raw("anvil_setStorageAt", [keys.O.address, k, v]);
  // the sponsor's known balance (root's figure, 61.65e12 wei), set after it paid for the fixture deployments
  await raw("anvil_setBalance", [S.address, "0x" + (61_650_000_000_000n).toString(16)]);
  await mine(3);
  // two providers on two loopback hosts (tip answered Base-like unless overridden)
  const proxies = [];
  const state = { tip };
  for (const host of ["127.0.0.1", "127.0.0.2"]) {
    const s = http.createServer(async (req, res) => {
      let b = ""; for await (const c of req) b += c;
      const j = JSON.parse(b);
      if (j.method === "eth_maxPriorityFeePerGas") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: state.tip })); }
      const r = await fetch(URL0, { method: "POST", headers: { "content-type": "application/json" }, body: b });
      res.writeHead(r.status, { "content-type": "application/json" }); res.end(await r.text());
    });
    proxies.push({ s, url: `http://${host}:${await listen(s, host)}/` });
  }
  const fixtureCfg = Object.freeze({ ...cfg, rpcs: Object.freeze(proxies.map((p) => p.url)) });
  const snap = { id: await raw("evm_snapshot") };
  const reset = async () => { await raw("anvil_dropAllTransactions"); await raw("evm_revert", [snap.id]); snap.id = await raw("evm_snapshot"); state.tip = tip; };
  return { raw, mine, keys, cfg: fixtureCfg, executor, stub, ledger: ledgerAddr, slots, nonceOf, sendRaw, reset, state,
    close: async () => { for (const p of proxies) { p.s.closeAllConnections(); await new Promise((r) => p.s.close(r)); } proc.kill(); } };
}

export const instantClock = () => { const c = { t: Date.now(), now: () => c.t, sleepUntil: async (at) => { c.t = Math.max(c.t, at); } }; return c; };

/** root's quiesce facts for the local chain (all deadlines past; expiries = the chain's leaseUntil) */
export async function quiesceFor(w, patch = {}) {
  const ts = Number(BigInt((await w.raw("eth_getBlockByNumber", ["latest", false])).timestamp));
  const { decodeFunctionResult } = await import("viem");
  const until = async (id) => Number(decodeFunctionResult({ abi: LEDGER.abi, functionName: "get", data: await w.raw("eth_call", [{ to: w.ledger, data: encodeFunctionData({ abi: LEDGER.abi, functionName: "get", args: [id] }) }, "latest"]) }).leaseUntil);
  return { providedBy: "root", providedAt: ts, signersStopped: ["test: no signer running"], lastSponsoredLeaseDeadline: ts - 600,
    leases: [{ id: ID1, expiry: await until(ID1) }, { id: ID2, expiry: await until(ID2) }], ...patch };
}
/** the ledger stub's lease for id (test setup only) */
export async function setLease(w, id, until, operator = w.keys.O.address, active = true) {
  await w.sendRaw(w.keys.S, { type: "eip1559", nonce: await w.nonceOf(w.keys.S.address), to: w.ledger, gas: 300_000n, data: encodeFunctionData({ abi: LEDGER.abi, functionName: "set", args: [id, active, operator, BigInt(until)] }) });
  await w.mine();
}

/** TEST-ONLY signing of an unsigned plan with throwaway keys (production has no signer). -> { rawA, rawB, auths } */
export async function signPlanForTest(plan, O, S) {
  const auths = [];
  for (const a of plan.authorizationsToSign) auths.push(await O.signAuthorization({ chainId: a.tuple.chainId, contractAddress: a.tuple.address, nonce: a.tuple.nonce }));
  const raw = [];
  for (const [i, t] of plan.transactions.entries()) {
    const u = t.unsigned;
    raw.push(await S.signTransaction({ type: "eip7702", chainId: u.chainId, nonce: Number(u.nonce), to: u.to, value: BigInt(u.value), data: u.data, gas: BigInt(u.gas),
      maxFeePerGas: BigInt(u.maxFeePerGas), maxPriorityFeePerGas: BigInt(u.maxPriorityFeePerGas), authorizationList: [auths[i]] }));
  }
  return { rawA: raw[0], rawB: raw[1], auths };
}
