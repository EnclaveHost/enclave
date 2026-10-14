// scripts/deploy-secret-vault.mjs against a real chain (anvil): it deploys the vault over a given address book, verifies the
// book it reads, and only PRINTS the governance transaction that names it in the book (never sends it).
//   run: node --test test/custody-deploy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createWalletClient, http, decodeFunctionData, hexToString } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { anvilAvailable, startAnvil, compileContracts } from "./helpers/custody-rig.mjs";
import { deploySecretVault, compileSecretVault } from "../scripts/deploy-secret-vault.mjs";

test("the deploy script's vault fits EIP-170 with room", () => {
  assert.ok(compileSecretVault().size < 24576 - 4096);
});

test("deploy on anvil: the vault reads the given book, and the book step is printed, not sent", { skip: anvilAvailable() ? false : "anvil not installed" }, async () => {
  const a = await startAnvil();
  try {
    const key = generatePrivateKey(), acct = privateKeyToAccount(key);
    await a.client.request({ method: "anvil_setBalance", params: [acct.address, "0x56bc75e2d63100000"] });
    const C = compileContracts();
    const w = createWalletClient({ account: acct, chain: a.chain, transport: http(a.url) });
    const book = (await a.client.waitForTransactionReceipt({ hash: await w.deployContract({ abi: C.book.abi, bytecode: C.book.bytecode }) })).contractAddress;
    const logs = [];
    const r = await deploySecretVault({ rpc: a.url, chain: a.chain, privateKey: key, book, log: (m) => logs.push(m) });
    assert.match(logs.join("\n"), /GOVERNANCE STEP \(not sent\)/);
    const { args } = decodeFunctionData({ abi: [{ type: "function", name: "set", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [] }], data: r.setData });
    assert.equal(hexToString(args[0], { size: 32 }), "secretVault");
    assert.equal(args[1], r.vault);
    // the book still names nothing: the script did not send the governance step
    assert.equal(await a.client.readContract({ address: book, abi: C.book.abi, functionName: "addr", args: [args[0]] }), "0x0000000000000000000000000000000000000000");
  } finally { a.stop(); }
});
