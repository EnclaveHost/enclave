// Shared pieces of the release-mechanism tests (test/move-release-*.test.mjs): leases on the rig's chain, SIWE owner
// login against the actual supervisor, a scriptable JSON-RPC proxy for the supervisor's BASE_RPC, and chain counters.
import http from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { parseEventLogs, parseTransaction, toFunctionSelector, getAddress } from "viem";
import { KEYS, freePort } from "./cli-independent-rig.mjs";
import { artifactIdentity } from "../../sdk/storage/unixfs.mjs";

export const TOKEN = "7c".repeat(32);
export const RELEASE_SELECTOR = toFunctionSelector("release(bytes32)");
// ledger rev 17: the generation-named release (work/lease-generation-interface.txt)
export const RELEASE_LEASE_SELECTOR = toFunctionSelector("releaseLease(bytes32,bytes32,uint64)");
const isReleaseCall = (data) => [RELEASE_SELECTOR, RELEASE_LEASE_SELECTOR].some((sel) => String(data || "").startsWith(sel));
export const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
export const ownerAddress = privateKeyToAccount(KEYS.owner).address;
export const operatorAddress = privateKeyToAccount(KEYS.operator).address;

/** A catalog app a host can actually serve: the rig's own "hello" declares http:8080, which every supervisor refuses
 *  (8080 is reserved), so no claim or resume of it could ever happen and a "never resumed" check would hold vacuously. */
const servable = new WeakMap();
export async function servableAppRef(r) {
  if (servable.has(r)) return servable.get(r);
  const deployer = r.wc("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  await r.write(deployer, r.addresses.catalog, r.A.catalog.abi, "publishVersion", ["hello3000", "Hello 3000", "a servable test app", "1",
    artifactIdentity(new Uint8Array(Buffer.from("move-release fixture app (port 3000)"))).cid, [0, 0, 64, 1], "http:3000", "{}", 0n]);
  const appId = await r.pc.readContract({ address: r.addresses.catalog, abi: r.A.catalog.abi, functionName: "appIdOf",
    args: [deployer.account.address, "hello3000"] });
  const ref = `catalog://${appId}/0`;
  servable.set(r, ref);
  return ref;
}
/** A deployment the owner WALLET holds, funded, and leased by `runner` (default: the rig's host) from `key`'s operator. */
export async function newLease(r, { runner = r.runner, key = KEYS.operator, fund = 5_000_000n } = {}) {
  const appRef = await servableAppRef(r);
  const id = r.createdId(await r.write(r.wc(KEYS.owner), r.addresses.ledger, r.A.ledger.abi, "create",
    [appRef, 0, 100, 3000, "http:3000", true, "", "0x0000000000000000000000000000000000000000", 0n, 100000n]));
  await r.write(r.wc(KEYS.owner), r.addresses.usdc, r.A.usdc.abi, "approve", [r.addresses.ledger, 10_000_000n]);
  await r.write(r.wc(KEYS.owner), r.addresses.ledger, r.A.ledger.abi, "fund", [id, fund]);
  await r.write(r.wc(key), r.addresses.ledger, r.A.ledger.abi, "claim", [id, runner]);
  const d = await getRow(r, id);
  return { id, leaseUntil: d.leaseUntil };
}
export const getRow = (r, id) => r.pc.readContract({ address: r.addresses.ledger, abi: r.A.ledger.abi, functionName: "get", args: [id] });

/** SIWE: the owner wallet signs the supervisor's own message; -> bearer token */
export async function login(h) {
  const n = await (await fetch(`${h.upstream}/v1/auth/nonce?address=${ownerAddress}`)).json();
  const signature = await privateKeyToAccount(KEYS.owner).signMessage({ message: n.message });
  const j = await (await fetch(`${h.upstream}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: n.message, signature }) })).json();
  if (!j.token) throw new Error("login failed: " + JSON.stringify(j));
  return j.token;
}
export async function api(h, method, path, token) {
  const res = await fetch(`${h.upstream}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

/** A JSON-RPC proxy in front of anvil for the supervisor. mode.staleLatest = N: every eth_call at "latest"/"pending"
 *  executes at block N (a load-balanced node behind the head), while receipts, nonces, the head and calls at an explicit
 *  block stay truthful. mode.swallowRelease = true: the next release() broadcast, and every re-broadcast at its nonce
 *  (a transport retry), is answered with an error and never reaches the chain. mode.pendingAsLatest: eth_getTransactionCount at "pending" answers "latest" (a node whose
 *  mempool does not hold this operator's transactions). */
export async function startProxy(r) {
  const mode = { staleLatest: null, swallowRelease: false, pendingAsLatest: false }, swallowed = [], calls = [];
  let swallowNonce = null;
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    let q; try { q = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400); return res.end(); }
    const one = async (m) => {
      if (m.method === "eth_sendRawTransaction" && (mode.swallowRelease || swallowNonce != null)) {
        let tx = null; try { tx = parseTransaction(m.params[0]); } catch {}
        if (tx && isReleaseCall(tx.data) && (swallowNonce == null ? mode.swallowRelease : tx.nonce === swallowNonce)) {
          if (swallowNonce == null) { swallowNonce = tx.nonce; mode.swallowRelease = false; }
          swallowed.push({ nonce: tx.nonce, at: Date.now() });
          return { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "test proxy: dropped before any mempool" } };
        }
      }
      if (m.method === "eth_call") calls.push({ to: String(m.params?.[0]?.to || "").toLowerCase(), selector: String(m.params?.[0]?.data || m.params?.[0]?.input || "").slice(0, 10) });
      let params = m.params;
      if (m.method === "eth_call" && mode.staleLatest != null && ["latest", "pending", undefined].includes(params[1]))
        params = [params[0], "0x" + mode.staleLatest.toString(16), ...params.slice(2)];
      if (m.method === "eth_getTransactionCount" && mode.pendingAsLatest && params[1] === "pending") params = [params[0], "latest"];
      const x = await fetch(r.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...m, params }) });
      return x.json();
    };
    const answer = Array.isArray(q) ? await Promise.all(q.map(one)) : await one(q);
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(answer));
  });
  r.stops.push(r.closeServer(srv));
  const port = await freePort();
  await new Promise((ok) => srv.listen(port, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${port}`, mode, swallowed, calls };
}

/** Every mined release() from `from` (inclusive) on, of deployment `id` when given: {hash, from, block, success, nonce} */
export async function releaseTxs(r, from, id = null) {
  const out = [], head = await r.pc.getBlockNumber({ cacheTime: 0 });   // viem caches the head for seconds otherwise
  for (let b = from; b <= head; b++) {
    const blk = await r.pc.getBlock({ blockNumber: b, includeTransactions: true });
    for (const tx of blk.transactions)
      if (tx.to && tx.to.toLowerCase() === r.addresses.ledger.toLowerCase() && tx.input.startsWith(RELEASE_SELECTOR)
          && (!id || tx.input.toLowerCase() === RELEASE_SELECTOR + id.slice(2).toLowerCase())) {
        const rc = await r.pc.getTransactionReceipt({ hash: tx.hash });
        out.push({ hash: tx.hash, from: getAddress(tx.from), block: Number(b), success: rc.status === "success", nonce: tx.nonce });
      }
  }
  return out;
}
/** Every mined release(id) or releaseLease(id, runner, generation) to `ledger` from block `from` on, of `id` when given,
 *  decoded: {kind, hash, from, block, success, nonce, id, runner, generation}. */
export async function anyReleaseTxs(r, from, { ledger = r.addresses.ledger, id = null } = {}) {
  const out = [], head = await r.pc.getBlockNumber({ cacheTime: 0 });   // viem caches the head for seconds otherwise
  for (let b = from; b <= head; b++) {
    const blk = await r.pc.getBlock({ blockNumber: b, includeTransactions: true });
    for (const tx of blk.transactions) {
      if (!tx.to || tx.to.toLowerCase() !== ledger.toLowerCase() || !isReleaseCall(tx.input)) continue;
      const lease = tx.input.startsWith(RELEASE_LEASE_SELECTOR);
      const x = { kind: lease ? "releaseLease" : "release", hash: tx.hash, from: getAddress(tx.from), block: Number(b), nonce: tx.nonce,
        id: "0x" + tx.input.slice(10, 74), runner: lease ? "0x" + tx.input.slice(74, 138) : null, generation: lease ? BigInt("0x" + tx.input.slice(138, 202)) : null };
      if (id && x.id.toLowerCase() !== id.toLowerCase()) continue;
      x.success = (await r.pc.getTransactionReceipt({ hash: tx.hash })).status === "success";
      out.push(x);
    }
  }
  return out;
}
export const leaseOf = (r, id, ledger = r.addresses.ledger) => r.pc.readContract({ address: ledger, abi: r.A.ledger.abi, functionName: "leaseOf", args: [id] });
export async function ledgerEvents(r, from, id) {
  return parseEventLogs({ abi: r.A.ledger.abi, logs: await r.pc.getLogs({ address: r.addresses.ledger, fromBlock: from, toBlock: "latest" }) })
    .filter((e) => !id || String(e.args.id).toLowerCase() === id.toLowerCase());
}
/** Launches since `sinceMs` that did NOT run under a lease claimed after the deployment's release: any such launch served
 *  the released lease (a resume) or a lease the release ended. -> [] when every launch is accounted for. */
export async function launchesWithoutNewLease(r, h, from, id, sinceMs) {
  const ev = await ledgerEvents(r, from, id);
  const rel = ev.find((e) => e.eventName === "Released");
  const claim = rel && ev.find((e) => e.eventName === "Claimed" && e.blockNumber > rel.blockNumber);
  const claimedAt = claim ? Number((await r.pc.getBlock({ blockNumber: claim.blockNumber })).timestamp) * 1000 : Infinity;
  return h.effects.filter((e) => e.launched && e.name === id && e.at >= sinceMs && e.at < claimedAt - 1500);
}
/** launches of deployment `id` on host h (every host of the rig shares one runner, so it may run other cases' ids) */
export const launchesOf = (h, id) => h.effects.filter((e) => e.launched && e.name === id).length;
/** the supervisor's claim/release lines, for failure messages */
export const claimLog = (h) => "\n" + h.stdout().split("\n").filter((l) => /\[claim\]|\[release\]|\[move\]|\[spawn/.test(l)).slice(-60).join("\n");
/** take a case's deployment out of the open queue so the next case's host (the same runner) never adopts it */
export async function retire(r, id) {
  await r.write(r.wc(KEYS.owner), r.addresses.ledger, r.A.ledger.abi, "setActive", [id, false]);
}
/** this operator's transactions sitting in anvil's mempool */
export async function pendingFrom(r, address) {
  const pool = await r.rpcCall("txpool_content");
  const mine = Object.entries(pool.pending || {}).find(([a]) => a.toLowerCase() === address.toLowerCase());
  return mine ? Object.values(mine[1]).map((t) => ({ hash: t.hash, nonce: Number(t.nonce), input: t.input })) : [];
}
export async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}
