// lease-chain.mjs -- a LOCAL lease on the REAL contracts, for proving a pVM runner's checkpoints end to end without a public
// chain (shielded/anchor/avf/PROOF-KEY.md; LAB). An anvil chain (no network, no funds, nothing public) runs
// contracts/EnclaveRegistry, EnclaveDeployments and EnclaveProofOfTime, compiled here with the repo's solc-js at the
// production settings (scripts/build-contract-artifacts.mjs: the ledger viaIR at runs 100, the prover viaIR at 200), and
// the foundry suite's MockUSDC. They are wired as the foundry proof-of-time suite and the deploy scripts do: ledger, then
// prover, setProver, proof required from now. The OPERATOR (the gas wallet: register, claim) and the TENANT are separate
// anvil accounts; the proof key is whatever key the VM attested -- this file never holds it.
//   const chain = await startLeaseChain({ port })
//   await chain.register({ endpoint, proofKey })  -> enclaveId        (the operator registers the runner, the proof key in it)
//   await chain.createFunded()                   -> deployment id   (the tenant creates and funds one)
//   await chain.claim(id, enclaveId)                                 (the operator takes the lease)
//   await chain.anchor()                         -> { anchorBlock, anchorHash }   (the parent of the newest block)
//   await chain.advance(seconds)                                     (time and a block pass)
//   await chain.checkpoint({ id, enclaveId, upto, anchorBlock, anchorHash, sig }) -> { ok, reason, provenUntil }
//   chain.pins(id, enclaveId) -> the pins a VM is launched with for this lease; chain.stop()
// For the posting agent (shielded/anchor/avf/runner/proof-agent.mjs), which signs each transaction LOCALLY before journaling
// it: startLeaseChain({ operatorAccount }) makes a caller's local account (a fresh random key; funded here with test ETH) the
// operator; { addressBook: true } also deploys the repo's EnclaveAddressBook with the three entries; and
// chain.snapshot()/revert(id)/setAutomine(on)/mine(n)/dropAll() drive stuck transactions and reorganizations.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ANVIL = [process.env.ANVIL, path.join(os.homedir(), ".foundry/bin/anvil"), "anvil"].find((p) => p && (p === "anvil" || fs.existsSync(p)));
export const haveAnvil = (() => { try { return !!ANVIL && (ANVIL === "anvil" || fs.statSync(ANVIL).isFile()); } catch { return false; } })();
const DEFS = [["EnclaveRegistry", "contracts/EnclaveRegistry.sol", false, 200], ["EnclaveDeployments", "contracts/EnclaveDeployments.sol", true, 100],
              ["EnclaveProofOfTime", "contracts/EnclaveProofOfTime.sol", true, 200], ["MockUSDC", "contracts/foundry/test/mocks/MockUSDC.sol", false, 200],
              ["EnclaveAddressBook", "contracts/EnclaveAddressBook.sol", false, 200]];

/** { name: { abi, bytecode } }, compiled once per source content (cached outside the repository). */
export async function compileContracts() {
  const { default: solc } = await import("solc");
  const out = {};
  const cacheDir = path.join(os.homedir(), ".cache", "enclave-lease-chain"); fs.mkdirSync(cacheDir, { recursive: true });
  for (const [name, file, viaIR, runs] of DEFS) {
    const source = fs.readFileSync(path.join(REPO, file), "utf8");
    const key = createHash("sha256").update(`${solc.version()}\n${viaIR}\n${runs}\n${source}`).digest("hex").slice(0, 24);
    const cache = path.join(cacheDir, `${name}-${key}.json`);
    if (fs.existsSync(cache)) { out[name] = JSON.parse(fs.readFileSync(cache, "utf8")); continue; }
    const base = path.basename(file);
    const input = { language: "Solidity", sources: { [base]: { content: source } },
      settings: { optimizer: { enabled: true, runs }, ...(viaIR ? { viaIR: true } : {}), outputSelection: { "*": { [name]: ["abi", "evm.bytecode.object"] } } } };
    const res = JSON.parse(solc.compile(JSON.stringify(input)));
    const errs = (res.errors || []).filter((e) => e.severity === "error");
    if (errs.length) throw new Error(`solc ${name}: ${errs.map((e) => e.formattedMessage).join("\n")}`);
    const c = res.contracts[base][name];
    out[name] = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
    fs.writeFileSync(cache, JSON.stringify(out[name]));
  }
  return out;
}

export async function startLeaseChain({ port = 18545 + Math.floor(Math.random() * 400), chainId = 31337, operatorAccount = null, addressBook = false, blockTime = 0 } = {}) {
  const V = await import("viem");
  const C = await compileContracts();
  const anvil = spawn(ANVIL, ["--port", String(port), "--chain-id", String(chainId), "--disable-code-size-limit", "--silent", ...(blockTime ? ["--block-time", String(blockTime)] : [])],
                      { stdio: ["ignore", "pipe", "pipe"] });   // blockTime > 0: a block every N s, like a real chain (Base: 2 s); transactions wait for it
  const rpc = `http://127.0.0.1:${port}`;
  const chain = { id: chainId, name: "local", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
  const pub = V.createPublicClient({ chain, transport: V.http(rpc) });
  for (let i = 0; ; i++) { try { await pub.getBlockNumber(); break; } catch { if (i > 100) throw new Error("anvil did not start"); await new Promise((r) => setTimeout(r, 100)); } }
  const [deployer, unlockedOperator, tenant, payout, stranger] = await pub.request({ method: "eth_accounts" });   // anvil's unlocked accounts
  const operator = operatorAccount || unlockedOperator, operatorAddress = operatorAccount ? operatorAccount.address : unlockedOperator;
  if (operatorAccount) await pub.request({ method: "anvil_setBalance", params: [operatorAccount.address, "0x56bc75e2d63100000"] });   // 100 test ETH
  const w = (account) => V.createWalletClient({ chain, transport: V.http(rpc), account });
  const deploy = async (name, args) => {
    const hash = await w(deployer).deployContract({ abi: C[name].abi, bytecode: C[name].bytecode, args });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
  };
  const send = async (from, address, name, fn, args) => {
    const hash = await w(from).writeContract({ address, abi: C[name].abi, functionName: fn, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${fn} reverted`);
    return r;
  };
  const registry = await deploy("EnclaveRegistry", []);
  const usdc = await deploy("MockUSDC", []);
  const ledger = await deploy("EnclaveDeployments", [usdc, payout, registry, "0x0000000000000000000000000000000000000000"]);
  const pot = await deploy("EnclaveProofOfTime", [ledger, registry]);
  await send(deployer, ledger, "EnclaveDeployments", "setProver", [pot]);
  const now = Number((await pub.getBlock()).timestamp);
  await send(deployer, ledger, "EnclaveDeployments", "setProofRequiredFrom", [BigInt(now)]);
  await send(deployer, usdc, "MockUSDC", "mint", [tenant, 1_000_000_000_000n]);
  await send(tenant, usdc, "MockUSDC", "approve", [ledger, (1n << 256n) - 1n]);
  let book = null;
  if (addressBook) {
    book = await deploy("EnclaveAddressBook", []);
    await send(deployer, book, "EnclaveAddressBook", "setMany", [["proofOfTime", "registry", "deployments"].map((k) => V.stringToHex(k, { size: 32 })), [pot, registry, ledger]]);
  }
  const read = (address, name, fn, args) => pub.readContract({ address, abi: C[name].abi, functionName: fn, args });
  return {
    rpc, chainId, chain, publicClient: pub, abis: C, accounts: { deployer, operator: operatorAddress, tenant, stranger },
    addresses: { registry, ledger, proofOfTime: pot, usdc, ...(book ? { addressBook: book } : {}) },
    pins: (id, enclaveId) => ({ chainId: String(chainId), proofOfTime: pot.toLowerCase(), registry: registry.toLowerCase(), deployment: id, enclaveId,
                                operator: operatorAddress.toLowerCase() }),
    async register({ endpoint, proofKey, from = operator }) {
      await send(from, registry, "EnclaveRegistry", "register", [endpoint, "lab", "0x" + "00".repeat(32), 834n, 0n, proofKey]);
      return V.keccak256(V.stringToBytes(endpoint));
    },
    setProofKey: (enclaveId, proofKey, from = operator) => send(from, registry, "EnclaveRegistry", "setProofKey", [enclaveId, proofKey]),
    registeredProofKey: async (enclaveId) => (await read(registry, "EnclaveRegistry", "get", [enclaveId])).proofKey.toLowerCase(),
    async createFunded() {
      const r = await send(tenant, ledger, "EnclaveDeployments", "create", ["catalog://pvm-lab/0", 0, 100, 8080, "", true, "", "0x0000000000000000000000000000000000000000", 0n, 1_000_000n]);
      const ev = V.parseEventLogs({ abi: C.EnclaveDeployments.abi, logs: r.logs }).find((l) => l.args && l.args.id);
      await send(tenant, ledger, "EnclaveDeployments", "fund", [ev.args.id, 100_000_000n]);
      return ev.args.id;
    },
    claim: (id, enclaveId, from = operator) => send(from, ledger, "EnclaveDeployments", "claim", [id, enclaveId]),
    deregister: (enclaveId, from = operator) => send(from, registry, "EnclaveRegistry", "deregister", [enclaveId]),   // the entry goes inactive; its proof key stays
    setActive: (id, active, from = tenant) => send(from, ledger, "EnclaveDeployments", "setActive", [id, active]),    // the owner's switch; the runner stays
    setClaimBond: (bond6) => send(deployer, ledger, "EnclaveDeployments", "setClaimBond", [BigInt(bond6), 3600n]),   // the ledger owner's anti-sybil gate
    deployment: (id) => read(ledger, "EnclaveDeployments", "get", [id]),
    usdcBalance: (who) => read(usdc, "MockUSDC", "balanceOf", [who]),
    earned6: (who) => read(ledger, "EnclaveDeployments", "earned6", [who]),
    events: (contract, eventName) => pub.getContractEvents({ address: contract === "registry" ? registry : contract === "prover" ? pot : ledger,
                                                              abi: C[contract === "registry" ? "EnclaveRegistry" : contract === "prover" ? "EnclaveProofOfTime" : "EnclaveDeployments"].abi, eventName, fromBlock: 0n }),
    async anchor() { const b = await pub.getBlock(); return { anchorBlock: Number(b.number) - 1, anchorHash: b.parentHash }; },
    async advance(seconds) { await pub.request({ method: "evm_increaseTime", params: [seconds] }); await pub.request({ method: "evm_mine", params: [] }); },
    now: async () => Number((await pub.getBlock()).timestamp),
    provenUntil: async (id) => Number(await read(ledger, "EnclaveDeployments", "provenUntil", [id])),
    async checkpoint({ id, enclaveId, upto, anchorBlock, anchorHash, sig, from = stranger }) {   // permissionless posting
      const args = [id, enclaveId, BigInt(upto), BigInt(anchorBlock), anchorHash, sig];
      // simulate FIRST, on the state the transaction will meet: a refusal comes back as the contract's own reason (a first
      // device run recorded only "checkpoint reverted" -- the reason was lost by simulating after the fact)
      try { await pub.simulateContract({ account: from, address: pot, abi: C.EnclaveProofOfTime.abi, functionName: "checkpoint", args }); }
      catch (x) { return { ok: false, reason: (x.cause && (x.cause.reason || (x.cause.data && x.cause.data.errorName))) || x.shortMessage || x.message, provenUntil: await this.provenUntil(id) }; }
      const hash = await w(from).writeContract({ address: pot, abi: C.EnclaveProofOfTime.abi, functionName: "checkpoint", args, gas: 3_000_000n });
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== "success") return { ok: false, reason: `mined but reverted (gas used ${r.gasUsed} of 3000000)`, provenUntil: await this.provenUntil(id) };
      return { ok: true, provenUntil: await this.provenUntil(id), block: Number(r.blockNumber) };
    },
    snapshot: () => pub.request({ method: "evm_snapshot", params: [] }),
    revert: (id) => pub.request({ method: "evm_revert", params: [id] }),
    setAutomine: (on) => pub.request({ method: "evm_setAutomine", params: [on] }),
    async mine(n = 1) { for (let i = 0; i < n; i++) await pub.request({ method: "evm_mine", params: [] }); },
    dropAll: () => pub.request({ method: "anvil_dropAllTransactions", params: [] }),
    setIntervalMining: (sec) => pub.request({ method: "evm_setIntervalMining", params: [sec] }),   // 0 pauses block production
    stop: () => anvil.kill("SIGKILL"),
  };
}
