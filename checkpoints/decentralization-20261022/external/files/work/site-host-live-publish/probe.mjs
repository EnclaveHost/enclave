#!/usr/bin/env node
// READ-ONLY live-publish probe for the frozen site-host package. Writes only logs/probe.json (+ CLI status logs).
// Nothing here signs, sends, uploads, funds or writes to any network service.
//   - offline: the wasm's UnixFS CID (the release tool's kubo-identical importFile: CIDv1, raw leaves, 256 KiB chunks,
//     balanced, which is what `ipfs add --cid-version 1` and the s3-ipfs-adapter mint), its world (the CLI's own
//     componentContract), the exact catalog calldata
//   - public chain (Base, RPC quorum): address book -> catalog/ledger/registry, catalog owner/schema/fee cap, the
//     enclave-site app state for the owner, balances of the owner, gas price, an eth_estimateGas SIMULATION of the
//     owner's publishVersion (no signature)
//   - public API: /v1/pricing, /availability, /enclaves
//   - local CLI status (non-secret printers only): `session list --json`, `session status --json`, `whoami --json`
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TREE = path.resolve(HERE, "../site-host-final-release/tree");           // the hash-verified copy of main
const WASM = path.resolve(HERE, "../site-host-final-release/deliver/package/site_host.wasm");
const PKG = JSON.parse(fs.readFileSync(path.resolve(HERE, "../site-host-final-release/deliver/package/PACKAGE.json"), "utf8"));
const { createPublicClient, http, fallback, encodeFunctionData, keccak256, encodePacked, formatEther, formatUnits, getAddress } =
  await import(path.join(TREE, "node_modules/viem/_esm/index.js"));
const { base } = await import(path.join(TREE, "node_modules/viem/_esm/chains/index.js"));
const { importFile, cidString } = await import(path.join(TREE, "scripts/site-release/unixfs.mjs"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const out = { at: new Date().toISOString(), readOnly: true };

// ---- offline: artifact identity ------------------------------------------------------------------------------------
const bytes = fs.readFileSync(WASM);
if (sha(bytes) !== PKG.wasm.sha256) throw new Error("the frozen wasm does not match PACKAGE.json");
const imp = importFile(bytes);
const cliSrc = fs.readFileSync(path.join(TREE, "cli/enclave.mjs"), "utf8");
const grab = (startMarker) => {               // a top-level function, by brace matching
  const s = cliSrc.indexOf(startMarker); if (s < 0) throw new Error("missing " + startMarker);
  let i = cliSrc.indexOf("{", s), depth = 0;
  for (; i < cliSrc.length; i++) { if (cliSrc[i] === "{") depth++; else if (cliSrc[i] === "}" && --depth === 0) break; }
  return cliSrc.slice(s, i + 1);
};
const componentContract = new Function("Buffer", grab("function componentContract(") + "; return componentContract;")(Buffer);
const contract = componentContract(bytes);
const abiStart = cliSrc.indexOf("const APP_TUPLE"), abiEnd = cliSrc.indexOf("\n];", cliSrc.indexOf("const CATALOG_ABI = [")) + 3;
const CATALOG_ABI = new Function(cliSrc.slice(abiStart, abiEnd) + "; return CATALOG_ABI;")();
const cid = cidString(imp.cid);
out.artifact = { file: "site_host.wasm", sha256: PKG.wasm.sha256, bytes: bytes.length, unixfsCid: cid, blocks: imp.blocks.length,
  cidMethod: "scripts/site-release/unixfs.mjs importFile (kubo `ipfs add --cid-version 1` layout: raw leaves, size-262144, balanced 174)",
  world: contract, release: PKG.release };

// the version config exactly as `enclave publish --config '{"release":…}'` stamps it (wasi appended by the CLI)
const cfg = { release: PKG.release.cid };
if (contract.wasi) cfg.wasi = contract.wasi;
const config = JSON.stringify(cfg);
const res = [0, 0, 256, 10];   // [vramMb, gpuGflops, memMb, cpuGflops] = --mem 256 --cpu-gflops 10
const meta = { slug: "enclave-site", name: "Enclave site", description: "The enclave.host website, served from one embedded, CID-verified release", ports: "", fee: 0n };

// ---- public chain ----------------------------------------------------------------------------------------------------
const RPCS = ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://1rpc.io/base", "https://mainnet.base.org"];
const clients = RPCS.map((u) => createPublicClient({ chain: base, transport: http(u, { timeout: 15000, retryCount: 1 }) }));
// quorum read: >= 2 RPCs must agree on the JSON of the answer
async function q(fn, label) {
  const got = await Promise.allSettled(clients.map((c) => fn(c)));
  const ok = got.map((g, i) => g.status === "fulfilled" ? [RPCS[i], JSON.stringify(g.value, (k, v) => typeof v === "bigint" ? v.toString() : v)] : [RPCS[i], null]);
  const tally = new Map(); for (const [, v] of ok) if (v !== null) tally.set(v, (tally.get(v) || 0) + 1);
  const best = [...tally].sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 2) throw new Error(`${label}: no 2-RPC agreement (${ok.map(([u, v]) => `${u}=${v === null ? "err" : "ok"}`).join(", ")})`);
  return { value: JSON.parse(best[0]), agree: best[1], of: RPCS.length };
}
const BOOK = "0xab214342d5A490150A4A977063A2f88E21F80907";
const read = (address, abi, functionName, args = []) => (c) => c.readContract({ address, abi, functionName, args });
try {
  const head = await q((c) => c.getBlockNumber(), "block");
  out.chain = { chainId: 8453, block: head.value, rpcs: RPCS, quorum: 2 };
  const all = await q(read(BOOK, [{ type: "function", name: "all", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32[]" }, { type: "address[]" }] }], "all"), "book");
  const [keys, values] = all.value;
  const book = {}; keys.forEach((kh, i) => { let k = ""; for (let b = 2; b < kh.length; b += 2) { const c = parseInt(kh.slice(b, b + 2), 16); if (!c) break; k += String.fromCharCode(c); } book[k] = values[i]; });
  out.chain.addressBook = { address: BOOK, entries: book };
  const catalog = getAddress(book.appCatalog), ledger = getAddress(book.deployments);
  const ownerAbi = [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
  const owner = getAddress((await q(read(catalog, ownerAbi, "owner"), "catalog owner")).value);
  const schema = (await q(read(catalog, CATALOG_ABI, "catalogSchema"), "schema")).value;
  const maxFee = (await q(read(catalog, CATALOG_ABI, "maxFeePerSec6"), "fee cap")).value;
  const appId = keccak256(encodePacked(["address", "string"], [owner, meta.slug]));
  const appIdOnChain = (await q(read(catalog, CATALOG_ABI, "appIdOf", [owner, meta.slug]), "appIdOf")).value;
  const nVersions = (await q(read(catalog, CATALOG_ABI, "numVersions", [appIdOnChain]), "numVersions").catch((e) => ({ value: `revert/err: ${e.message.split("\n")[0]}` }))).value;
  const ledgerOwner = getAddress((await q(read(ledger, ownerAbi, "owner"), "ledger owner")).value);
  const leaseSec = (await q(read(ledger, [{ type: "function", name: "leaseSec", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] }], "leaseSec"), "leaseSec").catch(() => ({ value: null }))).value;
  const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const bal = async (a) => ({
    eth: formatEther(BigInt((await q((c) => c.getBalance({ address: a }), "eth " + a)).value)),
    usdc: formatUnits(BigInt((await q(read(usdc, [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], "balanceOf", [a]), "usdc " + a)).value), 6),
  });
  const version = String(Number(nVersions) + 1 || 1);
  const args = [meta.slug, meta.name, meta.description, version, cid, res, meta.ports, config, meta.fee];
  const data = encodeFunctionData({ abi: CATALOG_ABI, functionName: "publishVersion", args });
  const gasPrice = (await q((c) => c.getGasPrice(), "gas price")).value;
  let estimate;
  try { estimate = (await q((c) => c.estimateGas({ account: owner, to: catalog, data }), "estimate publishVersion")).value; }
  catch (e) { estimate = `simulation failed: ${e.message.split("\n")[0]}`; }
  out.catalog = { address: catalog, owner, schema, maxFeePerSec6: maxFee, slug: meta.slug, appIdOfOwnerSlug: appIdOnChain, appIdComputed: appId,
    existingVersions: nVersions, nextVersion: version, autoApprovedIfSentBy: owner };
  out.publishCall = { to: catalog, from: owner, function: "publishVersion(string,string,string,string,string,uint32[4],string,string,uint256)",
    args: { slug: meta.slug, name: meta.name, description: meta.description, version, cid, res, ports: meta.ports, config, feePerSec6: "0" },
    data, dataSha256: sha(Buffer.from(data.slice(2), "hex")), gasEstimate: estimate, gasPriceWei: gasPrice };
  out.ledger = { address: ledger, owner: ledgerOwner, leaseSec };
  out.balances = { catalogOwner: { address: owner, ...(await bal(owner)) } };
} catch (e) { out.chainError = String(e.message || e).split("\n")[0]; }

// ---- public API ------------------------------------------------------------------------------------------------------
const API = "https://api.enclave.host";
async function getJson(p) {
  try { const r = await fetch(API + p, { signal: AbortSignal.timeout(20000) }); return { status: r.status, body: r.ok ? await r.json() : (await r.text()).slice(0, 300) }; }
  catch (e) { return { error: String(e.message || e) }; }
}
out.api = { base: API, pricing: await getJson("/v1/pricing"), availability: await getJson("/availability"), enclaves: await getJson("/enclaves") };

// ---- local CLI status (non-secret printers; normal credential use) ----------------------------------------------------
const cli = (args) => {
  const r = spawnSync(process.execPath, [path.join(TREE, "cli/enclave.mjs"), ...args], { encoding: "utf8", timeout: 60000, env: { ...process.env, NO_COLOR: "1" } });
  return { args: args.join(" "), status: r.status, stdout: (r.stdout || "").slice(0, 4000), stderr: (r.stderr || "").slice(0, 1500) };
};
out.cliStatus = [cli(["session", "list", "--json"]), cli(["session", "status", "--json"]), cli(["whoami", "--json"])];
// belt and braces: refuse to persist anything that looks like key material
const text = JSON.stringify(out, (k, v) => typeof v === "bigint" ? v.toString() : v, 1);
if (/pkcs8|BEGIN [A-Z ]*PRIVATE|"privateKey"|ENCLAVE_SESSION=|0x[0-9a-fA-F]{64}"\s*,?\s*"?(key|secret)/i.test(text)) throw new Error("refusing to write: output contains key-like material");
fs.writeFileSync(path.join(HERE, "logs/probe.json"), text + "\n");
console.log(`probe: cid ${cid}, world ${JSON.stringify(contract)}, catalog ${out.catalog?.address} owner ${out.catalog?.owner}, versions ${out.catalog?.existingVersions}, estimate ${out.publishCall?.gasEstimate}, api ${out.api.pricing.status}/${out.api.availability.status}/${out.api.enclaves.status}${out.chainError ? ", chainError " + out.chainError : ""}`);
