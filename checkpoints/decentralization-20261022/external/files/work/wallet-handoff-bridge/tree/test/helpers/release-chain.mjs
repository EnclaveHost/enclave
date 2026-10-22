// A local chain shaped like production for the adapter release, built from the REAL prepared requests:
//   - anvil with chain id 8453; the compiled EnclaveAppCatalog and EnclaveDeployments (contracts/foundry/out) deployed
//     by the production owner/publisher 0x0b2d… through anvil impersonation (no key exists anywhere);
//   - the app and its version 17 imported with the exact fields decoded from publication.json's calldata (slug, name,
//     description, resources, ports, config, fee), version label 1.0.17 and a different CID;
//   - the deployment record imported with the production id, owner, appRef …/17 and the production OLD config, rebuilt
//     from upgrade.json's new config and checked against upgrade.oldConfigSha256 byte for byte.
// The requests handed to the bridge are publication.json / upgrade.json themselves with only `to` and the code-hash
// pins replaced by the local contracts', so the calldata the bridge must re-derive is the reviewed production bytes.
// The compiled bytecode is NOT the production bytecode (different code hashes); it is the same source family's ABI
// behaviour, pinned here by its own observed hashes.
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createPublicClient, http as viemHttp, decodeFunctionData, encodeFunctionData, encodeAbiParameters, keccak256, defineChain } from "viem";

const WO = "/home/steven/Documents/Codex/2026-10-18/wo";
export const OUT = `${WO}/work/enclave/contracts/foundry/out`;
export const RELEASE = `${WO}/outputs/adapter-contract-wallet-release`;
export const ARTIFACT = `${WO}/work/enclave-apps/s3-ipfs-adapter/target/wasm32-wasip2/release/s3-ipfs-adapter.wasm`;
export const OWNER = "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61";
export const base = defineChain({ id: 8453, name: "local-base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
export const rpc = async (url, method, params = []) => {
  const j = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (j.error) throw Object.assign(new Error(j.error.message), { rpcError: j.error });
  return j.result;
};

export async function releaseChain() {
  const port = await freePort();
  const proc = spawn("anvil", ["--port", String(port), "--chain-id", "8453", "--silent", "--base-fee", "5000000"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const pc = createPublicClient({ chain: base, transport: viemHttp(url) });
  for (let i = 0; i < 100; i++) { try { await pc.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const send = async (tx) => {
    let h;
    try { h = await rpc(url, "eth_sendTransaction", [{ from: OWNER, ...tx }]); } catch (e) { throw new Error(`setup tx refused: ${String(e.message).slice(0, 160)}`); }
    const r = await pc.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`setup tx reverted (to ${tx.to || "create"})`);
    return r;
  };
  await rpc(url, "anvil_impersonateAccount", [OWNER]);
  await rpc(url, "anvil_setBalance", [OWNER, "0x56bc75e2d63100000"]);   // 100 ETH

  const art = (n) => JSON.parse(fs.readFileSync(`${OUT}/${n}.sol/${n}.json`, "utf8"));
  const catArt = art("EnclaveAppCatalog"), ledArt = art("EnclaveDeployments");
  const catalog = (await send({ data: catArt.bytecode.object })).contractAddress;
  // the ledger links one external library: deploy it, then write its address into every placeholder
  const lib = (await send({ data: JSON.parse(fs.readFileSync(`${OUT}/EnclaveDeployments.sol/EnclaveLedgerBandwidth.json`, "utf8")).bytecode.object })).contractAddress;
  let ledCode = ledArt.bytecode.object.slice(2);
  for (const refs of Object.values(ledArt.bytecode.linkReferences)) for (const list of Object.values(refs))
    for (const { start, length } of list) ledCode = ledCode.slice(0, start * 2) + lib.slice(2).toLowerCase() + ledCode.slice((start + length) * 2);
  const ctor = ledArt.abi.find((x) => x.type === "constructor");
  const dummy = (n) => "0x" + n.toString(16).padStart(40, "0");
  const ledger = (await send({ data: "0x" + ledCode + encodeAbiParameters(ctor.inputs, [dummy(0xa11ce), OWNER, dummy(0xb0b), dummy(0)]).slice(2) })).contractAddress;
  const catalogAbi = catArt.abi, ledgerAbi = ledArt.abi;

  const publication = JSON.parse(fs.readFileSync(`${RELEASE}/publication.json`, "utf8"));
  const upgrade = JSON.parse(fs.readFileSync(`${RELEASE}/upgrade.json`, "utf8"));
  const [slug, name, description, , , res, ports, config, fee] = decodeFunctionData({ abi: catalogAbi, data: publication.transaction.data }).args;
  const appId = await pc.readContract({ address: catalog, abi: catalogAbi, functionName: "appIdOf", args: [OWNER, slug] });
  if (appId !== publication.appId) throw new Error(`appIdOf(${OWNER}, ${slug}) is ${appId}, not production ${publication.appId}`);
  const now = BigInt(Math.floor(Date.now() / 1000)) - 86400n;
  await send({ to: catalog, data: encodeFunctionData({ abi: catalogAbi, functionName: "importApps", args: [[{ appId, publisher: OWNER, slug, name, description,
    versionCount: 18, createdAt: now, updatedAt: now, active: true }]] }) });
  const versions = Array.from({ length: 18 }, (_, i) => ({ cid: `bafkreifakeoldversion${String(i).padStart(2, "0")}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, version: `1.0.${i}`,
    vramMb: res[0], gpuGflops: res[1], memMb: res[2], cpuGflops: res[3], createdAt: now, verified: false, yanked: false, ports, approval: 1, config }));
  await send({ to: catalog, data: encodeFunctionData({ abi: catalogAbi, functionName: "importVersions", args: [appId, versions] }) });
  if (BigInt(fee) !== 0n) await send({ to: catalog, data: encodeFunctionData({ abi: catalogAbi, functionName: "importVersionFees", args: [appId, [17n], [fee]] }) });

  const mc = decodeFunctionData({ abi: ledgerAbi, data: upgrade.transaction.data }).args[0].map((d) => decodeFunctionData({ abi: ledgerAbi, data: d }));
  const after = JSON.parse(mc[1].args[1]);
  for (const p of Object.keys(upgrade.changedConfigFields)) { const ks = p.split("."), last = ks.pop(); delete ks.reduce((o, k) => o[k], after)[last]; }
  const oldConfig = JSON.stringify(after);
  if (sha256(oldConfig) !== upgrade.oldConfigSha256) throw new Error("could not rebuild the production old config byte for byte");
  const record = { id: upgrade.deployment, owner: OWNER, appRef: upgrade.oldAppRef, ports, configCid: oldConfig, gpuMilli: 0, cpuMilli: 100, appPort: 8000,
    isPublic: true, active: true, createdAt: now, rate: 0n, balance6: 0n, spent6: 0n, runner: "0x" + "0".repeat(64), runnerOperator: dummy(0), leaseUntil: 0n };
  await send({ to: ledger, data: encodeFunctionData({ abi: ledgerAbi, functionName: "importDeployments", args: [[record]] }) });

  const codeHash = async (a) => keccak256(await pc.getCode({ address: a }));
  const profile = { contracts: { appCatalog: { address: catalog.toLowerCase(), codeHash: await codeHash(catalog) }, deployments: { address: ledger.toLowerCase(), codeHash: await codeHash(ledger) } } };
  const localPub = structuredClone(publication), localUp = structuredClone(upgrade);
  localPub.transaction.to = catalog; localPub.catalogCodeHash = profile.contracts.appCatalog.codeHash;
  localUp.transaction.to = ledger; localUp.ledgerCodeHash = profile.contracts.deployments.codeHash;

  // a second RPC origin for the quorum: a plain forwarder (counts what it forwards)
  const seen = [];
  const fwd = http.createServer(async (req, res) => {
    let b = ""; for await (const c of req) b += c;
    const m = JSON.parse(b); seen.push(m.method);
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: b });
    res.writeHead(200, { "content-type": "application/json" }); res.end(await r.text());
  });
  await new Promise((r) => fwd.listen(0, "127.0.0.1", r));
  const forwarder = `http://127.0.0.1:${fwd.address().port}`;

  /** As the owner, outside the bridge (drift, a "MetaMask" send, a competing transaction). */
  const asOwner = (to, abi, functionName, args) => send({ to, data: encodeFunctionData({ abi, functionName, args }) });
  return { url, forwarder, pc, catalog, ledger, catalogAbi, ledgerAbi, profile, publication: localPub, upgrade: localUp, productionPublication: publication, productionUpgrade: upgrade,
    artifact: fs.readFileSync(ARTIFACT), appId, oldConfig, asOwner, seen,
    snapshot: () => rpc(url, "evm_snapshot"), revert: (id) => rpc(url, "evm_revert", [id]),
    stop: () => { proc.kill("SIGKILL"); fwd.closeAllConnections(); fwd.close(); } };
}
