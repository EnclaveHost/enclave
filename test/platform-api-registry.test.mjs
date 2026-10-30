// metal/guest/platform-api-verify.mjs quorumRegistry: who may receive the platform API group's state key is decided by the
// ORIGINAL EnclaveRegistry (contracts/EnclaveRegistry.sol, the source of the audited production runtime; no new or modified
// contract), read through a quorum of distinct RPC origins. Here: the Foundry artifact of that source deployed on anvil,
// reached through two loopback RPC fronts, one of which can be made to lie.
//   run: node --test --test-concurrency=1 test/platform-api-registry.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http as viemHttp, keccak256, toHex, encodeDeployData, parseEther } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { quorumRegistry } from "../metal/guest/platform-api-verify.mjs";
import { registryIdOf } from "../metal/measured-control-verify.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ART = path.join(REPO, "contracts/foundry/out/EnclaveRegistry.sol/EnclaveRegistry.json");
const haveAnvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return fs.existsSync(ART); } catch { return false; } })();
const stops = [];
after(() => { for (const f of stops.reverse()) try { f(); } catch {} });
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const chain = { id: 8453, name: "local-base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } };

test("the original registry decides: an active entry with its operator and proof key reads the same through the quorum; unregistered is null; a lying RPC breaks agreement", { skip: !haveAnvil && "needs anvil and the Foundry build", timeout: 60000 }, async () => {
  const port = await freePort();
  const anvil = spawn("anvil", ["--port", String(port), "--chain-id", "8453", "--silent"], { stdio: "ignore" }); stops.push(() => anvil.kill("SIGKILL"));
  const rpc = `http://127.0.0.1:${port}`, pc = createPublicClient({ chain, transport: viemHttp(rpc) });
  for (let i = 0; i < 100; i++) { try { await pc.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const funded = async () => { const a = privateKeyToAccount(generatePrivateKey()); await pc.request({ method: "anvil_setBalance", params: [a.address, "0x" + parseEther("10").toString(16)] }); return a; };
  const deployer = await funded(), operator = await funded(), proof = privateKeyToAccount(generatePrivateKey());
  const art = JSON.parse(fs.readFileSync(ART, "utf8"));
  const wc = (a) => createWalletClient({ account: a, chain, transport: viemHttp(rpc) });
  const registry = (await pc.waitForTransactionReceipt({ hash: await wc(deployer).sendTransaction({ data: encodeDeployData({ abi: art.abi, bytecode: art.bytecode.object, args: [] }) }) })).contractAddress;
  const endpoint = "https://custodian-api-0.example.org";
  await pc.waitForTransactionReceipt({ hash: await wc(operator).writeContract({ address: registry, abi: art.abi, functionName: "register",
    args: [endpoint, "owner/enclave", "0x" + "00".repeat(32), 1000n, 0n, proof.address] }) });
  assert.equal(registryIdOf(endpoint), keccak256(toHex(endpoint)), "the verifier's registry id is the contract's idOf");
  // two distinct RPC origins in front of the chain; `lie` corrupts the FIRST data word of an eth_call answer (the operator)
  let lie = false;
  const front = async (host) => {
    const p = await freePort();
    const srv = http.createServer(async (req, res) => {
      const body = await new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); });
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body });
      let text = await r.text();
      if (lie && JSON.parse(body).method === "eth_call") { const j = JSON.parse(text); if (typeof j.result === "string" && j.result.length > 2 + 64 * 8) {
        // words: [0] the tuple offset, then endpoint and repo offsets, measurement, OPERATOR (word 4): flip its last nibble
        const words = j.result.slice(2).match(/.{64}/g); words[4] = words[4].slice(0, 63) + (words[4].endsWith("0") ? "1" : "0"); j.result = "0x" + words.join(""); text = JSON.stringify(j); } }
      res.writeHead(200, { "content-type": "application/json" }); res.end(text);
    });
    await new Promise((ok) => srv.listen(p, "127.0.0.1", ok)); stops.push(() => srv.close());
    return `http://${host}:${p}`;
  };
  const rpcs = [await front("127.0.0.1"), await front("localhost")];
  const clients = rpcs.map((u) => createPublicClient({ chain, transport: viemHttp(u) }));
  const read = quorumRegistry({ rpcs, quorum: 2, registry, clients });
  assert.deepEqual(await read(registryIdOf(endpoint)), { operator: operator.address.toLowerCase(), active: true, proofKey: proof.address.toLowerCase() });
  assert.equal(await read(registryIdOf("https://never-registered.example.org")), null);
  // the operator deregisters: the same quorum read now says inactive, and the role's verifier refuses such a host
  await pc.waitForTransactionReceipt({ hash: await wc(operator).writeContract({ address: registry, abi: art.abi, functionName: "deregister", args: [registryIdOf(endpoint)] }) });
  assert.equal((await read(registryIdOf(endpoint))).active, false);
  // one lying origin beside one honest one: they do not agree, so the read fails (the verifier answers "unknown", never "verified")
  lie = true;
  const honest = createPublicClient({ chain, transport: viemHttp(rpc) });
  const mixed = quorumRegistry({ rpcs: [rpcs[0], rpc], quorum: 2, registry, clients: [clients[0], honest] });
  await assert.rejects(mixed(registryIdOf(endpoint)), /did not agree/);
  lie = false;
  assert.equal((await mixed(registryIdOf(endpoint))).operator, operator.address.toLowerCase(), "both honest again: they agree");
});
