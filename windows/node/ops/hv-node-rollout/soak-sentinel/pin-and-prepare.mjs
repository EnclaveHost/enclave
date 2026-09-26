// pin-and-prepare.mjs - PINS the soak sentinel with the agent wallet's signed upload and PREPARES (never sends) the two
// transactions that would put it in the catalog (SOAK-SENTINEL.md; enclave-87: pin it, prepare the calldata, publish
// nothing and ask nothing until enclave-87 puts the one Trezor tx to Steven):
//   1. publishVersion(...) FROM the agent wallet 0x2947… - the version, EMPTY config and ports, fee 0 (simulated here
//      with eth_call from that address: it would succeed, or this says why not);
//   2. setApproval(appId, 0, 1) FROM the catalog owner 0x0b2d… (Steven's Trezor), AFTER 1.
// Run from a checkout with viem (module resolution is the cwd's), the key in the ENVIRONMENT only:
//   cd ~/Projects/enclave && SOAK_WASM=<soak_sentinel.wasm> SOAK_SHA256=<its sha256> node --input-type=module - < pin-and-prepare.mjs
// PIN_ONLY=1: pin, then fetch the CID back from the gateway's /ipfs/ and compare its sha256, and stop (enclave-63's
// authenticated-upload check once 7ae476a3, the upload gateway, serves again). A CID pinned and never listed in the
// catalog is left alone by nan's daily pin cleanup.
// The catalog is the one the on-chain address book names (as cli/enclave.mjs resolves it), never a baked address.
// It never prints or writes the key.
import fs from "node:fs";
import crypto from "node:crypto";
import { createPublicClient, http, encodeFunctionData } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const AGENT = "0x29479bf04ed889d46a7afb7f292b9bb26e12647c";
const ADDRESS_BOOK = "0xab214342d5A490150A4A977063A2f88E21F80907";   // EnclaveAddressBook (cli/enclave.mjs ADDRESS_BOOK_ADDRESS)
const OWNER = "0x0b2d009c0c9af05b12100d77f3c815fea822ee61";     // the catalog's owner(), read 2026-09-26
const SLUG = "hv-soak-sentinel", NAME = "hv soak sentinel", VERSION = "1.0.0";
const DESC = "A test app for the NucBox hv soak: it prints each request's soak token to stdout and stderr and echoes it. Not for use.";
const RES = [0, 0, 128, 1];   // vramMb, gpuGflops, memMb, cpuGflops (hello-world's 128 / 1)
const die = (m) => { console.error(`REFUSED: ${m}`); process.exit(2); };

const wasmPath = process.env.SOAK_WASM, want = String(process.env.SOAK_SHA256 || "").toLowerCase();
if (!wasmPath || !/^[0-9a-f]{64}$/.test(want)) die("set SOAK_WASM and SOAK_SHA256");
const bytes = fs.readFileSync(wasmPath);
const sha = crypto.createHash("sha256").update(bytes).digest("hex");
if (sha !== want) die(`${wasmPath} is ${sha}, not ${want}`);
let key = String(process.env.ETH_AGENT_WALLET || "").trim();
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) die("ETH_AGENT_WALLET is not set to a 32-byte hex key");
const acct = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`); key = null;
if (acct.address.toLowerCase() !== AGENT) die(`the key is ${acct.address}, not the agent wallet ${AGENT}`);

const CATALOG_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "appIdOf", stateMutability: "view", inputs: [{ type: "address" }, { type: "string" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "numVersions", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "publishVersion", stateMutability: "nonpayable",
    inputs: [{ name: "slug", type: "string" }, { name: "name", type: "string" }, { name: "description", type: "string" },
             { name: "version", type: "string" }, { name: "cid", type: "string" }, { name: "res", type: "uint32[4]" },
             { name: "ports", type: "string" }, { name: "config", type: "string" }, { name: "feePerSec6", type: "uint256" }],
    outputs: [{ type: "bytes32" }, { type: "uint256" }] },
  { type: "function", name: "setApproval", stateMutability: "nonpayable",
    inputs: [{ name: "appId", type: "bytes32" }, { name: "index", type: "uint256" }, { name: "status", type: "uint8" }], outputs: [] },
];
const c = createPublicClient({ chain: base, transport: http("https://base-rpc.publicnode.com", { retryCount: 3 }) });
// the live catalog, from the address book (the CLI's baked default 0xAc5270… is a RETIRED catalog: 2026-09-26)
const [bookKeys, bookVals] = await c.readContract({ address: ADDRESS_BOOK, functionName: "all",
  abi: [{ type: "function", name: "all", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32[]" }, { type: "address[]" }] }] });
const keyName = (kh) => { let k = ""; for (let b = 2; b < kh.length; b += 2) { const ch = parseInt(kh.slice(b, b + 2), 16); if (!ch) break; k += String.fromCharCode(ch); } return k; };
const CATALOG = bookVals[bookKeys.findIndex((kh) => keyName(kh) === "appCatalog")];
if (!/^0x[0-9a-fA-F]{40}$/.test(String(CATALOG || ""))) die("the address book names no appCatalog");
const owner = String(await c.readContract({ address: CATALOG, abi: CATALOG_ABI, functionName: "owner" })).toLowerCase();
if (owner !== OWNER) die(`the catalog's owner is ${owner}, not ${OWNER}`);
const appId = await c.readContract({ address: CATALOG, abi: CATALOG_ABI, functionName: "appIdOf", args: [AGENT, SLUG] });
const existing = Number(await c.readContract({ address: CATALOG, abi: CATALOG_ABI, functionName: "numVersions", args: [appId] }));
if (existing !== 0) die(`${SLUG} under ${AGENT} already has ${existing} version(s): this script prepares only the first`);

// the pin, exactly as cli/enclave.mjs pinBytes does it: a signed upload authorization, then the gateway
const expiry = Math.floor(Date.now() / 1000) + 300;
const signature = await acct.signMessage({ message: `enclave-upload:${sha}:${expiry}` });
const tr = await fetch("https://api.enclave.host/v1/apps/upload-token", { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify({ hash: sha, expiry, signature }) });
const tok = await tr.json().catch(() => ({}));
if (!tr.ok || !tok.token) die(`upload authorization failed (${tr.status}): ${JSON.stringify(tok).slice(0, 200)}`);
const up = await fetch("https://ipfs.enclave.host/add-wasm", { method: "POST", body: bytes, headers: {
  "content-type": "application/wasm", "x-upload-address": tok.address, "x-upload-expiry": String(expiry), "x-upload-token": tok.token } });
const upBody = await up.text();
if (!up.ok) die(`IPFS upload failed (${up.status}): ${upBody.slice(0, 200)}`);
const cid = JSON.parse(upBody).cid;
if (!cid) die("the gateway returned no CID");
if (process.env.PIN_ONLY === "1") {
  // the pin serves: the gateway returns the same bytes for the CID it gave (a raw-leaf CID is the bytes themselves)
  const g = await fetch(`https://ipfs.enclave.host/ipfs/${cid}`, { signal: AbortSignal.timeout(60_000) }).catch((e) => ({ ok: false, status: e.message }));
  const back = g.ok ? Buffer.from(await g.arrayBuffer()) : null;
  const backSha = back ? crypto.createHash("sha256").update(back).digest("hex") : null;
  console.log(`PINNED ${cid} (${bytes.length} bytes, sha256 ${sha}; upload authorized by ${tok.address})`);
  console.log(`fetch https://ipfs.enclave.host/ipfs/${cid}: ${g.ok ? `${back.length} bytes, sha256 ${backSha} ${backSha === sha ? "= the pinned component: PASS" : "DIFFERS: FAIL"}` : `FAIL (${g.status})`}`);
  process.exit(backSha === sha ? 0 : 1);
}

const pubArgs = [SLUG, NAME, DESC, VERSION, cid, RES, "", "", 0n];
const pubData = encodeFunctionData({ abi: CATALOG_ABI, functionName: "publishVersion", args: pubArgs });
let sim;
try {
  const r = await c.simulateContract({ address: CATALOG, abi: CATALOG_ABI, functionName: "publishVersion", args: pubArgs, account: AGENT });
  sim = `OK: would create appId ${r.result[0]} index ${r.result[1]}`;
} catch (e) { sim = `WOULD REVERT: ${(e.shortMessage || e.message).split("\n")[0]}`; }
const apprData = encodeFunctionData({ abi: CATALOG_ABI, functionName: "setApproval", args: [appId, 0n, 1] });

console.log(`component  ${wasmPath}\n  sha256   ${sha} (${bytes.length} bytes)\n  PINNED   ${cid}  (ipfs.enclave.host, upload authorized by ${tok.address})`);
console.log(`appId      ${appId}  (appIdOf(${AGENT}, "${SLUG}"); version index 0)`);
console.log(`\n1. publishVersion - FROM the agent wallet ${AGENT} (NOT SENT)\n   to   ${CATALOG}\n   args ${JSON.stringify(pubArgs, (k, v) => typeof v === "bigint" ? v.toString() : v)}\n   data ${pubData}\n   simulated from ${AGENT}: ${sim}`);
console.log(`\n2. setApproval(appId, 0, 1) - FROM the catalog owner ${OWNER} (Steven's Trezor), AFTER 1 (NOT SENT)\n   to   ${CATALOG}\n   data ${apprData}`);
