// A local Base stand-in for the sessions tests: anvil + the REAL platform
// contracts (ledger, catalog, address book, PaymentRouter) from the Foundry
// build, a USDC with EIP-3009, and the SessionVault factory deployed by the
// PRODUCTION deploy script (scripts/deploy-session-vault.mjs, solc-js).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import net from "node:net";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { createPublicClient, createWalletClient, http, encodeDeployData, getAddress, parseUnits, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { linkBytecode } from "../../site/js/lib/contract-linker.js";
import { deploySessionVault } from "../../scripts/deploy-session-vault.mjs";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(REPO, "contracts", "foundry", "out");

// anvil's well-known dev keys
export const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  owner: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  relayer: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  publisher: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  stranger: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
};

export function haveFoundry() {
  try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); execFileSync("forge", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

function freePort() {
  return new Promise((ok) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
}

function artifact(file, name) {
  const p = path.join(OUT, file, `${name}.json`);
  if (!fs.existsSync(p)) execFileSync("forge", ["build"], { cwd: REPO, stdio: "ignore" });
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences };
}

export async function startChain() {
  const port = await freePort();
  const proc = spawn("anvil", ["--port", String(port), "--chain-id", "31337", "--silent", "--hardfork", "osaka",
    "--base-fee", "5000000"],
    { stdio: "ignore" });
  const rpc = `http://127.0.0.1:${port}`;
  const pc = createPublicClient({ chain: foundry, transport: http(rpc) });
  for (let i = 0; i < 100; i++) {
    try { await pc.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  // the P-256 precompile: native on newer anvil; else install Daimo's verifier (the e2e does the same).
  // Probe with a REAL signature made here: hash || r || s || x || y.
  const { privateKey: pk, publicKey: pub } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const msg = Buffer.from("p256 probe");
  const sig = cryptoSign("sha256", msg, { key: pk, dsaEncoding: "ieee-p1363" });
  const jwk = pub.export({ format: "jwk" });
  const probe = "0x" + Buffer.concat([createHash("sha256").update(msg).digest(), sig,
    Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("hex");
  const ok = await pc.call({ to: "0x0000000000000000000000000000000000000100", data: probe }).catch(() => ({}));
  if (!ok?.data || BigInt(ok.data) !== 1n) {
    const code = fs.readFileSync(path.join(REPO, "contracts/foundry/test/fixtures/p256-verifier.hex"), "utf8").trim();
    await pc.request({ method: "anvil_setCode", params: ["0x0000000000000000000000000000000000000100", code.startsWith("0x") ? code : "0x" + code] });
  }
  const wc = (key) => createWalletClient({ chain: foundry, account: privateKeyToAccount(key), transport: http(rpc) });
  const clock = { offset: 0 };
  return { rpc, pc, wc, clock, stop: () => proc.kill("SIGKILL"),
    /** chain time (wall clock + every warp so far) */
    now: () => Math.floor(Date.now() / 1000) + clock.offset,
    async warp(seconds) {
      await pc.request({ method: "evm_increaseTime", params: [toHex(seconds)] });
      await pc.request({ method: "evm_mine", params: [] });
      clock.offset += seconds;
    } };
}

export async function deployPlatform(chain, { maxVaultUsd = 1000 } = {}) {
  const { pc, wc } = chain;
  const dep = wc(KEYS.deployer);
  const deploy = async (a, args = [], libs = {}) => {
    const bytecode = Object.keys(a.linkReferences || {}).length ? linkBytecode(a.bytecode, a.linkReferences, libs) : a.bytecode;
    const hash = await dep.sendTransaction({ data: encodeDeployData({ abi: a.abi, bytecode, args }) });
    const rc = await pc.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error("deploy failed");
    return getAddress(rc.contractAddress);
  };
  const write = async (address, abi, functionName, args, who = dep) => {
    const hash = await who.writeContract({ address, abi, functionName, args });
    const rc = await pc.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${functionName} failed`);
    return rc;
  };
  const A = {
    usdc: artifact("SessionMocks.sol", "MockUSDC3009"),
    reg: artifact("SessionMocks.sol", "SessionRegistryStub"),
    book: artifact("EnclaveAddressBook.sol", "EnclaveAddressBook"),
    bw: artifact("EnclaveDeployments.sol", "EnclaveLedgerBandwidth"),
    ledger: artifact("EnclaveDeployments.sol", "EnclaveDeployments"),
    catalog: artifact("EnclaveAppCatalog.sol", "EnclaveAppCatalog"),
    router: artifact("PaymentRouter.sol", "PaymentRouter"),
  };
  const treasury = privateKeyToAccount(KEYS.stranger).address;
  const usdc = await deploy(A.usdc);
  const reg = await deploy(A.reg);
  const book = await deploy(A.book);
  const bw = await deploy(A.bw);
  const libs = {};
  for (const [file, ls] of Object.entries(A.ledger.linkReferences)) for (const n of Object.keys(ls)) libs[`${file}:${n}`] = bw;
  const ledger = await deploy(A.ledger, [usdc, treasury, reg, "0x0000000000000000000000000000000000000000"], libs);
  await write(ledger, A.ledger.abi, "setProofRequiredFrom", [0n]);
  const catalog = await deploy(A.catalog);
  const router = await deploy(A.router, [usdc, treasury]);
  const key = (s) => toHex(s, { size: 32 });
  await write(book, A.book.abi, "set", [key("deployments"), ledger]);
  await write(book, A.book.abi, "set", [key("appCatalog"), catalog]);
  const res = await deploySessionVault({ rpc: chain.rpc, chain: foundry, privateKey: KEYS.deployer, usdc, book, router,
    maxVault6: parseUnits(String(maxVaultUsd), 6), log: () => {} });
  await write(book, A.book.abi, "set", [key("sessionVaultFactory"), res.factory]);

  // a third-party, approved store app (free) for deploy flows
  const pub = wc(KEYS.publisher);
  await write(catalog, A.catalog.abi, "publishVersion", ["store", "Store", "", "1.0.0", "bafystore", [0, 0, 256, 10], "", "", 0n], pub);
  const storeAppId = await pc.readContract({ address: catalog, abi: A.catalog.abi, functionName: "appIdOf",
    args: [pub.account.address, "store"] });
  await write(catalog, A.catalog.abi, "setApproval", [storeAppId, 0n, 1]);

  const owner = privateKeyToAccount(KEYS.owner).address;
  await write(usdc, A.usdc.abi, "mint", [owner, parseUnits("5000", 6)]);
  return { usdc, book, ledger, catalog, router, treasury, factory: res.factory, lib: res.lib,
    deployBlock: res.block, storeAppId, storeRef: `catalog://${storeAppId}/0`, publisher: pub.account.address, abi: A, write };
}
