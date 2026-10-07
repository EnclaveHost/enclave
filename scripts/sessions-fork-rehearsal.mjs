// Pre-mainnet rehearsal (not a CI test): anvil FORK of Base mainnet, the exact
// deploy bundle, the REAL USDC / ledger / catalog / router / book, and the SDK
// driving the real relayer service end to end. Run: node scripts/sessions-fork-rehearsal.mjs <bundle.json>
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createPublicClient, createWalletClient, http as vhttp, encodeDeployData, getAddress, parseUnits, toHex, keccak256 } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { base } from "viem/chains";
import { createSessionsService, createCustodyGate } from "../relay/sessions.mjs";
import { JsonStore } from "../relay/store.js";
import * as sdk from "../sdk/sessions/dist/node.mjs";

const bundle = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const PORT = 18545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn("anvil", ["--fork-url", "https://base-rpc.publicnode.com", "--port", String(PORT), "--silent",
  "--hardfork", "osaka", "--chain-id", "8453"], { stdio: "ignore" });
const chain = { ...base, rpcUrls: { default: { http: [RPC] } } };
const pc = createPublicClient({ chain, transport: vhttp(RPC) });
const rpc = (method, params) => pc.request({ method, params });
const log = (...a) => console.log("[fork]", ...a);
let server;
try {
  for (let i = 0; i < 200; i++) { try { await pc.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
  log("fork at block", await pc.getBlockNumber());
  // deployer: an anvil dev key with ETH on the fork (impersonation-free)
  const dk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const dep = createWalletClient({ chain, account: privateKeyToAccount(dk), transport: vhttp(RPC) });
  await rpc("anvil_setBalance", [dep.account.address, toHex(10n ** 18n)]);
  const out = {};
  for (const st of bundle.steps) {
    let bc = st.bytecode;
    if (st.link) {
      let b = bc.slice(2);
      for (const lib of Object.values(st.linkReferences || {})) for (const slots of Object.values(lib)) for (const { start, length } of slots)
        b = b.slice(0, start * 2) + out[st.link].slice(2).toLowerCase() + b.slice((start + length) * 2);
      bc = "0x" + b;
    }
    const args = (st.args || []).map((a) => typeof a === "string" && a.startsWith("$") ? out[a.slice(1)] : a)
      .map((a) => typeof a === "string" && /^\d+n$/.test(a) ? BigInt(a.slice(0, -1)) : a);
    const data = st.abi ? encodeDeployData({ abi: st.abi, bytecode: bc, args }) : bc;
    const h = await dep.sendTransaction({ data });
    const rc = await pc.waitForTransactionReceipt({ hash: h });
    if (rc.status !== "success") throw new Error(st.name + " failed");
    out[st.name] = getAddress(rc.contractAddress);
    log(st.name, out[st.name], "gas", rc.gasUsed);
  }
  const { usdc, book, router } = bundle.meta;
  // the real address book doesn't name our factory yet: the relay is told explicitly (as nan will be)
  const relayerKey = generatePrivateKey();
  const relayer = privateKeyToAccount(relayerKey);
  await rpc("anvil_setBalance", [relayer.address, toHex(10n ** 17n)]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fork-rehearsal-"));
  const svc = createSessionsService({ pc, wc: createWalletClient({ chain, account: relayer, transport: vhttp(RPC) }), account: relayer,
    chainId: 8453, factory: out.sessionVaultFactory, book, usdc, router, startBlock: Number(await pc.getBlockNumber()),
    store: new JsonStore(path.join(tmp, "i.json"), {}), journal: new JsonStore(path.join(tmp, "j.json"), { txs: [] }, { durable: true }),
    log: (...a) => log("relay:", ...a), alert: (k, d) => log("ALERT", k, JSON.stringify(d)) });
  server = http.createServer((req, res) => svc.handle(req, res, new URL(req.url, "http://x"), null));
  await new Promise((r) => server.listen(0, r));
  const relayUrl = `http://127.0.0.1:${server.address().port}`;

  // an owner with real USDC: borrow 10 from the provisioner float (fork only)
  const ownerKey = generatePrivateKey();
  const owner = privateKeyToAccount(ownerKey);
  const PROV = "0x3d447593739C3f2BaF1A7579CD874baA3e0971aA";
  await rpc("anvil_impersonateAccount", [PROV]);
  await rpc("anvil_setBalance", [PROV, toHex(10n ** 17n)]);
  const provWc = createWalletClient({ chain, account: PROV, transport: vhttp(RPC) });
  const ERC20 = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
    { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
  await pc.waitForTransactionReceipt({ hash: await provWc.writeContract({ address: usdc, abi: ERC20, functionName: "transfer", args: [owner.address, parseUnits("10", 6)] }) });
  const bal = (a) => pc.readContract({ address: usdc, abi: ERC20, functionName: "balanceOf", args: [a] });
  log("owner", owner.address, "USDC", await bal(owner.address));

  // agent flow with the REAL USDC EIP-3009 deposit
  const store = new sdk.MemoryStore();
  const { signer, record } = await sdk.newSessionKey(store, { relay: relayUrl, chainId: 8453, label: "fork", extractable: true });
  const grant = sdk.buildGrant({ sessionKey: signer.keyHash, label: "fork agent", preset: "staging-publish",
    policy: { apps: ["fork-staging"], budget: parseUnits("3", 6) } });
  const vault = await sdk.vaultAddress(pc, out.sessionVaultFactory, owner.address);
  const usdcDom = await sdk.usdcDomain(pc, usdc, 8453);
  log("usdc domain", JSON.stringify(usdcDom));
  const ownerSigner = { address: owner.address, signTypedData: (td) => owner.signTypedData(td) };
  const opened = await sdk.openSession({ relay: new sdk.RelayClient(relayUrl), owner: ownerSigner, chainId: 8453, vault, grant, usdc: usdcDom });
  log("opened", opened.sid, "vault", vault, "vault USDC", await bal(vault));
  const rec = await sdk.completeSession(store, record, { vault, owner: owner.address, grant, rpc: RPC });
  const session = await sdk.sessionFromRecord(rec);

  // publish to the REAL catalog (vault-held app), then a staging deployment on the REAL ledger, funded
  const p = await session.call("app.publish", { slug: "fork-staging", name: "Fork staging", description: "", version: "0.0.1",
    cid: "bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4", res: [0, 0, 128, 0], ports: "", config: "", configCid: "" });
  const [appId, idx] = [`0x${p.result.slice(2, 66)}`, BigInt(`0x${p.result.slice(66, 130)}`)];
  log("published", appId, "#" + idx, "fee", p.fee);
  const c = await session.call("deploy.create", { appRef: `catalog://${appId}/${idx}`, gpuMilli: 0, cpuMilli: 100, appPort: 8080, ports: "",
    isPublic: false, configCid: "", maxRate6: 100n, env: "staging", fund6: parseUnits("1", 6) });
  const id = `0x${c.result.slice(2, 66)}`;
  log("created + funded", id, "fee", c.fee);
  const st = await session.status();
  log("session: balance", st.balance6, "spent", st.spent6);

  // the custody gate against the real ledger row
  const gate = createCustodyGate({ pc, book, factory: out.sessionVaultFactory, ttlMs: 0 });
  const LEDGER_GET = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components:
    [["id","bytes32"],["owner","address"],["appRef","string"],["ports","string"],["configCid","string"],["gpuMilli","uint16"],["cpuMilli","uint16"],
     ["appPort","uint32"],["isPublic","bool"],["active","bool"],["createdAt","uint64"],["rate","uint256"],["balance6","uint256"],["spent6","uint256"],
     ["runner","bytes32"],["runnerOperator","address"],["leaseUntil","uint64"]].map(([name, type]) => ({ name, type })) }] }];
  const BOOK = [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }];
  const ledger = await pc.readContract({ address: book, abi: BOOK, functionName: "addr", args: [toHex("deployments", { size: 32 })] });
  const row = await pc.readContract({ address: ledger, abi: LEDGER_GET, functionName: "get", args: [id] });
  log("ledger row owner", row.owner, "balance6", row.balance6, "custody gate:", await gate.custodyRefusal(row) ?? "releases (staging)");

  // API auth + sign-out with refund
  const hdr = await session.apiAuthorization("GET", "https://api.enclave.host/v1/deployments/" + id);
  const who = await svc.verifyApiRequest({ header: hdr, method: "GET", hostPath: "api.enclave.host/v1/deployments/" + id, scope: "api.status" });
  log("API auth owner", who.owner);
  const before = await bal(owner.address);
  const end = await session.terminate();
  log("terminated; refund", end.refund6, "owner USDC", before, "->", await bal(owner.address));
  log("REHEARSAL OK; journal gas:", svc.store && JSON.stringify(svc.queue.journal.data.txs.map((t) => [t.label.replace(/ 0x\w+/, ""), t.gasUsed])));
} catch (e) {
  console.error("[fork] FAILED:", e.stack || e.message);
  process.exitCode = 1;
} finally {
  server?.close();
  anvil.kill("SIGKILL");
}
