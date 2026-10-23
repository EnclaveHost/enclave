// Shared local fixtures (loopback only; no production endpoint, upload, key or chain write):
//   - anvil (chain id 8453, manual mining) carrying, AT THE PRODUCTION ADDRESSES, the deployed catalog's and book's exact
//     runtimes (rebuilt offline, custody-proof-app publish/fixtures) with their constructor state, a ledger placeholder
//     and a mock GasPriceOracle;
//   - two "providers" on different loopback hosts (127.0.0.1 / 127.0.0.2) proxying to it (eth_maxPriorityFeePerGas
//     answered Base-like, 0.001 gwei), so the two-provider code paths run unmodified;
//   - a fake relay + gateway on 127.0.0.3 that does what the real ones do (recover the personal_sign signer, mint an
//     HMAC token over address:sha256:expiry, check it on /add-wasm, compute the raw CIDv1, serve /ipfs/<cid>?format=raw),
//     with failure modes;
//   - an EPHEMERAL test key standing in for the administrator's upload signature only (the publish transaction is sent
//     from the production administrator address by anvil impersonation; no real key exists here).
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHmac, createHash } from "node:crypto";
import { encodeFunctionData, keccak256, recoverMessageAddress, stringToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PRODUCTION as PUB } from "../vendor/publish.mjs";
import { PRODUCTION } from "../trust.mjs";
import { rawCid } from "../upload.mjs";

const fx = (f) => JSON.parse(fs.readFileSync(new URL("./fixtures/" + f, import.meta.url), "utf8"));
export const CAT = fx("catalog-build.json"), BOOK = fx("book-build.json"), ORACLE = fx("oracle-mock.json");
const pad32 = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const listen = (server, host) => new Promise((ok, fail) => { server.once("error", fail); server.listen(0, host, () => ok(server.address().port)); });

export async function startChain() {
  const anvilPort = await new Promise((ok) => { const t = net.createServer(); t.listen(0, "127.0.0.1", () => { const p = t.address().port; t.close(() => ok(p)); }); });
  const proc = spawn("anvil", ["--chain-id", "8453", "--port", String(anvilPort), "--host", "127.0.0.1", "--block-base-fee-per-gas", "5000000", "--no-mining", "--silent"], { stdio: "ignore" });
  const URL0 = `http://127.0.0.1:${anvilPort}`;
  const raw = async (method, params = []) => {
    const r = await fetch(URL0, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json(); if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { rpcError: j.error }); return j.result;
  };
  for (let i = 0; i < 100; i++) { try { await raw("eth_chainId"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const mine = async (n = 1) => { for (let i = 0; i < n; i++) await raw("evm_mine"); };
  const sendAs = async (from, tx) => { await raw("anvil_impersonateAccount", [from]); try { return await raw("eth_sendTransaction", [{ from, ...tx }]); } finally { await raw("anvil_stopImpersonatingAccount", [from]); } };
  await raw("anvil_setBalance", [PUB.publisher, "0x" + (10n ** 17n).toString(16)]);
  const h = await sendAs(PUB.publisher, { data: CAT.creation, gas: "0x1c9c380" }); await mine();
  const tmp = (await raw("eth_getTransactionReceipt", [h])).contractAddress;
  await raw("anvil_setCode", [PUB.catalog, await raw("eth_getCode", [tmp, "latest"])]);
  let ownerSlot;
  for (let s = 0; s < 64; s++) { const v = await raw("eth_getStorageAt", [tmp, pad32(s), "latest"]); if (BigInt(v) !== 0n) { await raw("anvil_setStorageAt", [PUB.catalog, pad32(s), v]); if (BigInt(v) === BigInt(PUB.publisher) && ownerSlot === undefined) ownerSlot = s; } }
  await raw("anvil_setCode", [PUB.book, BOOK.runtime]);
  await raw("anvil_setStorageAt", [PUB.book, pad32(0), pad32(BigInt(PUB.publisher))]);
  const SET = [{ type: "function", name: "setMany", inputs: [{ type: "bytes32[]" }, { type: "address[]" }], outputs: [], stateMutability: "nonpayable" }];
  await sendAs(PUB.publisher, { to: PUB.book, data: encodeFunctionData({ abi: SET, functionName: "setMany",
    args: [[stringToHex("deployments", { size: 32 }), stringToHex("appCatalog", { size: 32 })], [PUB.ledger, PUB.catalog]] }) });
  await raw("anvil_setCode", [PUB.ledger, "0x6001600055"]);
  await raw("anvil_setCode", [PUB.oracle, ORACLE.runtime]);
  await mine(3);
  if (keccak256(await raw("eth_getCode", [PUB.catalog, "latest"])) !== PUB.catalogCodeHash) throw Error("local catalog is not the deployed runtime");
  // two providers on two loopback hosts
  const proxies = [];
  for (const host of ["127.0.0.1", "127.0.0.2"]) {
    const s = http.createServer(async (req, res) => {
      let b = ""; for await (const c of req) b += c;
      const j = JSON.parse(b);
      if (j.method === "eth_maxPriorityFeePerGas") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: "0xf4240" })); }
      const r = await fetch(URL0, { method: "POST", headers: { "content-type": "application/json" }, body: b });
      res.writeHead(r.status, { "content-type": "application/json" }); res.end(await r.text());
    });
    proxies.push({ s, url: `http://${host}:${await listen(s, host)}/` });
  }
  return { raw, mine, sendAs, ownerSlot, urls: proxies.map((p) => p.url),
    close: async () => { for (const p of proxies) { p.s.closeAllConnections(); await new Promise((r) => p.s.close(r)); } proc.kill(); } };
}

/** The fake relay + gateway (127.0.0.3). mode: { token: 200|4xx, reflect: bool (error bodies echo the request's signature),
 *  add: "ok"|"wrongcid"|"hang"|"500"|"reflect403" (echoes the token)|"cidecho" (answers the token as the "cid"),
 *  serve: "ok"|"wrong"|"404"|"502" } */
export async function startUploadServices(component) {
  const KEY = "test-upload-key", store = new Map(), calls = { token: 0, add: 0, fetch: 0, signatures: [], tokens: [] };
  const mode = { token: 200, add: "ok", serve: "ok", reflect: false };
  const s = http.createServer(async (req, res) => {
    const json = (code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    const u = new URL(req.url, "http://x");
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (req.method === "POST" && u.pathname === "/v1/apps/upload-token") {
      calls.token++;
      const b = JSON.parse(body.toString()); calls.signatures.push(b.signature);
      if (mode.token !== 200) return json(mode.token, mode.reflect ? { error: "bad signature " + b.signature, got: b } : { error: "refused_by_test" });
      const now = Math.floor(Date.now() / 1000);
      if (!/^[0-9a-f]{64}$/.test(b.hash) || !(b.expiry >= now && b.expiry <= now + 600) || !/^0x[0-9a-fA-F]{130}$/.test(b.signature)) return json(422, { error: "bad" });
      const address = (await recoverMessageAddress({ message: `enclave-upload:${b.hash}:${b.expiry}`, signature: b.signature })).toLowerCase();
      return json(200, { token: createHmac("sha256", KEY).update(`${address}:${b.hash}:${b.expiry}`).digest("hex"), address, expiry: b.expiry });
    }
    if (req.method === "POST" && u.pathname === "/add-wasm") {
      calls.add++;
      if (mode.add === "hang") { store.set(rawCid(body), body); return; }          // stores, never answers
      if (mode.add === "500") return json(502, { error: "ipfs add failed" });
      const address = req.headers["x-upload-address"], exp = Number(req.headers["x-upload-expiry"]), token = req.headers["x-upload-token"];
      calls.tokens.push(token);
      if (mode.add === "reflect403") return json(403, { error: "token " + token + " does not cover these bytes", signatureSeen: calls.signatures.at(-1) });
      if (mode.add === "cidecho") return json(200, { cid: token });
      const want = createHmac("sha256", KEY).update(`${address}:${createHash("sha256").update(body).digest("hex")}:${exp}`).digest("hex");
      if (token !== want) return json(403, { error: "upload authorization does not cover these bytes" });
      if (body.length < 8 || body.readUInt32LE(0) !== 0x6d736100 || (body[6] | (body[7] << 8)) !== 1) return json(415, { error: "not a component" });
      const cid = rawCid(body); store.set(cid, body);
      return json(200, { cid: mode.add === "wrongcid" ? "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy" : cid, wasi: "0.2" });
    }
    if (req.method === "GET" && u.pathname.startsWith("/ipfs/")) {
      calls.fetch++;
      const b = store.get(u.pathname.slice(6));
      if (mode.serve === "502") return json(502, { error: "upstream " + (calls.tokens.at(-1) || "") });
      if (!b || mode.serve === "404") return json(404, { error: "not found" });
      res.writeHead(200, { "content-type": "application/vnd.ipld.raw" });
      return res.end(mode.serve === "wrong" ? Buffer.concat([b.subarray(0, b.length - 1), Buffer.from([b[b.length - 1] ^ 1])]) : b);
    }
    json(404, { error: "no route" });
  });
  const port = await listen(s, "127.0.0.3");
  const base = `http://127.0.0.3:${port}`;
  return { mode, store, calls, base, close: async () => { s.closeAllConnections(); await new Promise((r) => s.close(r)); } };
}

export function memoryJournal(init = { status: "ready" }) {
  let v = structuredClone(init), text = JSON.stringify(v);
  return { read: () => structuredClone(v), write(x) { v = structuredClone(x); text = JSON.stringify(x); }, get text() { return text; } };
}

/** The production trust with ONLY the endpoints, timeouts and a test-only upload signer (ephemeral key) added. The
 *  administrator address stays the production one everywhere (the publish is sent from it by anvil impersonation). */
export function fixtureTrust({ rpcs, uploadBase, componentFile = PRODUCTION.component.file, admin }) {
  return Object.freeze({ ...PRODUCTION, uploadSigner: admin, rpcs,
    component: Object.freeze({ ...PRODUCTION.component, file: componentFile }),
    upload: Object.freeze({ ...PRODUCTION.upload, tokenUrl: uploadBase + "/v1/apps/upload-token", addUrl: uploadBase + "/add-wasm", fetchUrl: uploadBase + "/ipfs/", timeoutMs: 800 }),
    rpcTimeoutMs: 5_000, deadlineMs: 20_000 });
}
export function ephemeralSigner() { const a = privateKeyToAccount(generatePrivateKey()); return { address: a.address.toLowerCase(), sign: (message) => a.signMessage({ message }) }; }
export const instantClock = () => { const c = { t: Date.now(), now: () => c.t, sleepUntil: async (at) => { c.t = Math.max(c.t, at); } }; return c; };
