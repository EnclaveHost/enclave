// Deploy the billing chain onto a running anvil: MockUSDC (EIP-2612, from the
// Foundry test mocks), PaymentRouter, EnclaveRegistry and EnclaveDeployments
// (bytecode from the committed admin-console artifacts module - the same
// bytes the deploy scripts produce). Mints USDC to the payer and provisioner
// accounts and returns every address the stack needs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletClient, createPublicClient, http, encodeDeployData, getAddress, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// anvil's well-known dev accounts
export const KEYS = {
  deployer:    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",   // account 0 - also the e2e payer wallet
  provisioner: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",   // account 1 - the relay's company wallet
  sanctioned:  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",   // account 2 - seeded into the OFAC fixture
};
export const TREASURY = "0x00000000000000000000000000000000000e2e01";   // pure sink: balances are asserted, nothing sends from it

const forgeArtifact = (name) => {
  const p = path.join(REPO, "contracts", "foundry", "out", name + ".sol", name + ".json");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
};

export async function setupChain(rpc) {
  const account = privateKeyToAccount(KEYS.deployer);
  const chain = { ...foundry, id: 8453 };
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  const deploy = async (abi, bytecode, args = []) => {
    const hash = await wallet.deployContract({ abi, bytecode, args });
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    return getAddress(rcpt.contractAddress);
  };

  // MockUSDC from the Foundry build (run `forge build` first - CI does)
  const usdcArt = forgeArtifact("MockUSDC");
  const usdc = await deploy(usdcArt.abi, usdcArt.bytecode);

  // platform contracts from the committed artifacts module (admin-console
  // deploy bytecode; ctor args are all addresses, encoded by viem here)
  const { CONTRACTS } = await import(path.join(REPO, "site", "js", "gen", "contract-artifacts.js"));
  const art = (n) => CONTRACTS[n];
  const registry = await deploy([], art("EnclaveRegistry").bytecode);   // no ctor args (open registration)
  const ZERO = "0x0000000000000000000000000000000000000000";
  const depData = encodeDeployData({
    abi: [{ type: "constructor", stateMutability: "nonpayable", inputs: [
      { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }] }],
    bytecode: art("EnclaveDeployments").bytecode,
    args: [usdc, TREASURY, registry, ZERO],           // feed 0x0 = ETH funding off
  });
  const depHash = await wallet.sendTransaction({ data: depData });
  const deployments = getAddress((await pub.waitForTransactionReceipt({ hash: depHash })).contractAddress);
  const routerData = encodeDeployData({
    abi: [{ type: "constructor", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }] }],
    bytecode: art("PaymentRouter").bytecode,
    args: [usdc, TREASURY],
  });
  const routerHash = await wallet.sendTransaction({ data: routerData });
  const router = getAddress((await pub.waitForTransactionReceipt({ hash: routerHash })).contractAddress);

  // fund the actors: payer (checkout wallet) + provisioner (company USDC)
  const mint = async (to, amount) => {
    const h = await wallet.writeContract({ address: usdc, abi: usdcArt.abi, functionName: "mint",
      args: [to, parseUnits(amount, 6)] });
    await pub.waitForTransactionReceipt({ hash: h });
  };
  await mint(account.address, "10000");
  await mint(privateKeyToAccount(KEYS.provisioner).address, "10000");
  await mint(privateKeyToAccount(KEYS.sanctioned).address, "10000");

  return { usdc, router, registry, deployments, treasury: TREASURY,
           payer: account.address, provisioner: privateKeyToAccount(KEYS.provisioner).address,
           sanctioned: privateKeyToAccount(KEYS.sanctioned).address };
}
