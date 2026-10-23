// original-code-path.test.mjs: the ORIGINAL EnclaveSecretVaultV2 (9d43e63e8 source, runtime keccak == production 0x4b949b37…
// with the production immutables, placed at the production address 0xE486… on an anvil with chain id 8453) and the ORIGINAL
// digest code (orig-9d43/custody/v2/digests.mjs). Test-only keys; no production key, RPC write or signature.
//
// What it pins, for the code-admission plan (HANDOFF.md):
//   1. proposeCode needs approval weight >= t from CURRENT-epoch machines over the vault's codeDigest; nothing else counts
//      (empty -> Weight(0,1); a non-member -> NotMachine; the member's handover/genesis-type signature -> BadSignature);
//   2. a valid proposal sets codeActiveAt = block.timestamp + 604800 exactly; a handover to that code reverts at
//      activeAt - 1 and succeeds at activeAt; the full handover (propose, deal, acks) activates epoch 2 with the original
//      machine kept; gasUsed of every step is recorded;
//   3. cancel: removeCode with the same approval weight is immediate, also blocks the final ack of a pending handover to
//      that code, and the SAME measurement cannot be re-proposed in the same epoch (single-use digest);
//   4. the production digests for committee 0x4774 / measurement fbe2 / epoch 1, computed with the same original code
//      that the contract accepted in 2.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, createTestClient, http, keccak256, encodeFunctionData, decodeErrorResult, stringToHex, BaseError, ContractFunctionRevertedError } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import * as D from "../orig-9d43/custody/v2/digests.mjs";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT || path.join(HERE, "evidence", "original-code-path.json");
const A = JSON.parse(fs.readFileSync(path.join(HERE, "build", "artifacts.json"), "utf8"));
const CHAIN = 8453, VAULT = "0xe48699b8401564aace7a814ae4569b67a3f7eef5", BOOK = "0xab214342d5a490150a4a977063a2f88e21f80907";
const ENCLAVE = "0x0b2d009c0c9af05b12100d77f3c815fea822ee61", PROD_CODEHASH = "0x4b949b378382d7fa862e7bc1552b58547ce811527c9746f4d9a0d39a8b4f716b";
const OLD_CODE = "0x2530eda0796a9d16eac8e2bb3b1f02abb58a816d4a54ebbbcbfb738a9cf966cf";           // the running image (genesis code set)
const NEW_SNP = "70aadff5455fd65f752c1dcec2d6f1ac4984bebf6c63b284d15fcf47851fb96def231af40c39a3bca6fbf9748f01c429";
const NEW_CODE = "0xfbe2f581cd8da409856adcff75a149c3797111cb0c7030b824f015867b9cb8d7";            // corrected r2 ab589bf8
const PROD_COMMITTEE = "0x47742ae8c544ff66a4ad91cfbf5cecdd389013da362813ba3b55c4e247b0f7a3";
const PROD_MACHINE = "0xf0f8078459c051a89197fac73ff689c6df96506a";
const Y = "0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";               // a valid compressed point (G)
const DELAY = 604800n;
const chain = { id: CHAIN, name: "anvil-8453", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } };
const report = { at: new Date().toISOString(), testOnlyKeys: true, gasUsed: {}, checks: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok, ...(detail ? { detail } : {}) }); assert.ok(ok, name + (detail ? `: ${JSON.stringify(detail)}` : "")); };

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
async function startAnvil() {
  const port = await freePort();
  const p = spawn("anvil", ["--chain-id", String(CHAIN), "--port", String(port), "--silent", "--gas-limit", "60000000"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }); if (r.ok) return { p, url }; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill(); throw new Error("anvil did not start");
}

test("original vault: code admission, seven-day boundary, handover, cancel; production digests", { timeout: 240000 }, async () => {
  const { p: anvil, url } = await startAnvil();
  try {
    const transport = http(url);
    const pub = createPublicClient({ chain, transport }), tc = createTestClient({ chain, mode: "anvil", transport });
    const payer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");   // anvil's public test account 0
    const w = createWalletClient({ chain, transport, account: payer });
    const deploy = async (art, args = []) => { const h = await w.deployContract({ abi: art.abi, bytecode: art.bytecode, args }); return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress; };
    const send = async (address, abi, functionName, args, gas) => {
      const hash = await w.writeContract({ address, abi, functionName, args, ...(gas ? { gas } : {}) });
      const r = await pub.waitForTransactionReceipt({ hash }); return r;
    };
    const revertOf = async (address, abi, functionName, args) => {
      try { await pub.simulateContract({ address, abi, functionName, args, account: payer }); return null; }
      catch (e) { const x = e instanceof BaseError ? e.walk((y) => y instanceof ContractFunctionRevertedError) : null; return x?.data?.errorName ? `${x.data.errorName}(${(x.data.args || []).join(",")})` : String(e.shortMessage || e.message).slice(0, 160); }
    };

    // ---- the original runtime at the production address, with the production immutables
    const tmpVault = await deploy(A.vault, [BOOK, ENCLAVE]);
    const runtime = await pub.getCode({ address: tmpVault });
    check("original vault source + deployed settings + production immutables = production runtime code hash", keccak256(runtime) === PROD_CODEHASH, { codeHash: keccak256(runtime), compiler: A.compiler });
    await tc.setCode({ address: VAULT, bytecode: runtime });
    const tmpBook = await deploy(A.book), reg = await deploy(A.registry);
    await tc.setCode({ address: BOOK, bytecode: await pub.getCode({ address: tmpBook }) });
    await send(BOOK, A.book.abi, "set", [stringToHex("registry", { size: 32 }), reg]);
    const V = A.vault.abi;
    const vread = (fn, args) => pub.readContract({ address: VAULT, abi: V, functionName: fn, args });
    check("CODE_DELAY is 7 days and HANDOVER_TTL 1 day in the original bytecode", (await vread("CODE_DELAY", [])) === DELAY && (await vread("HANDOVER_TTL", [])) === 86400n);
    check("sha256(SNP launch measurement 70aadff5…) = fbe2f581… (the vault's measurement field)", "0x" + createHash("sha256").update(Buffer.from(NEW_SNP, "hex")).digest("hex") === NEW_CODE);

    // ---- test-only identities: one Enclave-payout host operator, machines with the real measurements
    const operator = privateKeyToAccount(generatePrivateKey());
    const machine = (measurement, rid) => { const acct = privateKeyToAccount(generatePrivateKey());
      return { acct, m: { identity: acct.address.toLowerCase(), encKey: "0x" + randomBytes(32).toString("hex"), endpoint: `https://custodian-${rid.slice(2, 8)}.test`,
                          chipId: "0x" + randomBytes(32).toString("hex"), registryId: rid, measurement } }; };
    const rid = () => "0x" + randomBytes(32).toString("hex");
    const host = async (r) => send(reg, A.registry.abi, "set", [r, operator.address, true, ENCLAVE]);
    const hostSig = (m) => D.signDigest(operator, D.hostDigest({ chainId: CHAIN, vault: VAULT, machine: m }));
    async function genesis(M) {
      const salt = "0x" + randomBytes(32).toString("hex"), committeeId = D.committeeIdOf({ chainId: CHAIN, vault: VAULT, salt, Y });
      const sig = await D.signDigest(M.acct, D.genesisDigest({ chainId: CHAIN, vault: VAULT, committeeId, Y, machine: M.m, codeSet: [OLD_CODE] }));
      const r = await send(VAULT, V, "createCommittee", [salt, M.m, Y, [OLD_CODE], sig, await hostSig(M.m)]);
      return { committeeId, r };
    }
    const R0 = rid(), R1 = rid(); await host(R0); await host(R1);
    const M0 = machine(OLD_CODE, R0), M1 = machine(NEW_CODE, R1), X = machine(OLD_CODE, R0);
    const g = await genesis(M0); const cid = g.committeeId;
    check("genesis (original code set = [the running image's measurement]) succeeds", g.r.status === "success"); report.gasUsed.createCommittee = String(g.r.gasUsed);
    const genesisTs = (await pub.getBlock({ blockNumber: g.r.blockNumber })).timestamp;
    check("after genesis: running code active at genesis time, corrected code NOT in the set", (await vread("codeActiveAt", [cid, OLD_CODE])) === genesisTs && (await vread("codeActiveAt", [cid, NEW_CODE])) === 0n);

    const dealers = [1];
    const handoverArgs = async (next, signers) => {
      const digest = D.handoverDigest({ chainId: CHAIN, vault: VAULT, committeeId: cid, fromEpoch: 1, next: next.map((x) => x.m), dealerIndices: dealers });
      return [cid, next.map((x) => x.m), await Promise.all(next.map((x) => hostSig(x.m))), dealers, signers.map((s) => s.m.identity), await Promise.all(signers.map((s) => D.signDigest(s.acct, digest)))];
    };
    check("a handover to a machine running the corrected code is refused before any code proposal",
      (await revertOf(VAULT, V, "proposeHandover", await handoverArgs([M0, M1], [M0]))) === "BadCode()");

    // ---- 1. only the current machine's signature over the codeDigest counts
    const codeD = (c, epoch, add) => D.codeDigest({ chainId: CHAIN, vault: VAULT, committeeId: c, epoch, measurement: NEW_CODE, add });
    check("proposeCode with no approvals: Weight(0,1)", (await revertOf(VAULT, V, "proposeCode", [cid, NEW_CODE, [], []])) === "Weight(0,1)");
    check("proposeCode approved by a machine outside the epoch: NotMachine()",
      (await revertOf(VAULT, V, "proposeCode", [cid, NEW_CODE, [X.m.identity], [await D.signDigest(X.acct, codeD(cid, 1, true))]])) === "NotMachine()");
    const hd = D.handoverDigest({ chainId: CHAIN, vault: VAULT, committeeId: cid, fromEpoch: 1, next: [M0.m, M1.m], dealerIndices: dealers });
    check("the member's HANDOVER signature (what the original daemon can sign) is not a code approval: BadSignature()",
      (await revertOf(VAULT, V, "proposeCode", [cid, NEW_CODE, [M0.m.identity], [await D.signDigest(M0.acct, hd)]])) === "BadSignature()");
    check("a code approval for another epoch: BadSignature()",
      (await revertOf(VAULT, V, "proposeCode", [cid, NEW_CODE, [M0.m.identity], [await D.signDigest(M0.acct, codeD(cid, 2, true))]])) === "BadSignature()");

    // ---- 2. the valid proposal and the exact seven-day boundary
    const pc = await send(VAULT, V, "proposeCode", [cid, NEW_CODE, [M0.m.identity], [await D.signDigest(M0.acct, codeD(cid, 1, true))]]);
    report.gasUsed.proposeCode = String(pc.gasUsed);
    const pTs = (await pub.getBlock({ blockNumber: pc.blockNumber })).timestamp, activeAt = await vread("codeActiveAt", [cid, NEW_CODE]);
    check("proposeCode by the current machine over the codeDigest: activeAt = block.timestamp + 604800 exactly", pc.status === "success" && activeAt === pTs + DELAY, { proposedAt: String(pTs), activeAt: String(activeAt) });
    check("the same approval cannot be replayed (already proposed): BadSignature()",
      (await revertOf(VAULT, V, "proposeCode", [cid, NEW_CODE, [M0.m.identity], [await D.signDigest(M0.acct, codeD(cid, 1, true))]])) === "BadSignature()");
    const hArgs = await handoverArgs([M0, M1], [M0]);
    await tc.setNextBlockTimestamp({ timestamp: activeAt - 1n });
    const early = await send(VAULT, V, "proposeHandover", hArgs, 3_000_000n);
    check("handover to the corrected code at activeAt - 1: reverted", early.status === "reverted");
    await tc.setNextBlockTimestamp({ timestamp: activeAt });
    const ph = await send(VAULT, V, "proposeHandover", hArgs, 3_000_000n);
    check("handover to [original machine, corrected machine] at activeAt: accepted", ph.status === "success"); report.gasUsed.proposeHandover_2machines = String(ph.gasUsed);
    const [toEpoch, , enc, tNew, wNew, , expires] = await vread("pendingOf", [cid]);
    check("pending epoch 2: both Enclave-paid machines = ONE seat, t 1, W 1, expires after 1 day", toEpoch === 2 && enc.every(Boolean) && tNew === 1 && wNew === 1 && expires === activeAt + 86400n);
    const dc = Y, sealed = ["0x" + "11".repeat(120), "0x" + "22".repeat(120)];   // shape-only test envelopes (the vault checks shape + signature)
    const pd = await send(VAULT, V, "postDeal", [cid, 2, 1, dc, sealed, M0.m.identity,
      await D.signDigest(M0.acct, D.dealDigest({ chainId: CHAIN, vault: VAULT, committeeId: cid, toEpoch: 2, dealerIndex: 1, dealCommitments: dc, sealed }))]);
    report.gasUsed.postDeal_2recipients = String(pd.gasUsed);
    const ack = async (M) => send(VAULT, V, "ackHandover", [cid, 2, Y, M.m.identity, await D.signDigest(M.acct, D.ackDigest({ chainId: CHAIN, vault: VAULT, committeeId: cid, toEpoch: 2, newCommitments: Y }))]);
    const a1 = await ack(M0), a2 = await ack(M1);
    report.gasUsed.ackHandover_first = String(a1.gasUsed); report.gasUsed.ackHandover_last_activates = String(a2.gasUsed);
    const [, epoch] = await vread("committeeOf", [cid]);
    check("after deal + both acks: epoch 2 active; the original machine is still a member", pd.status === "success" && a2.status === "success" && epoch === 2);

    // ---- 3. cancel: removal is immediate, stops a pending handover's final ack, and the add cannot be repeated this epoch
    const R2 = rid(), R3 = rid(); await host(R2); await host(R3);
    const N0 = machine(OLD_CODE, R2), N1 = machine(NEW_CODE, R3);
    const g2 = await genesis(N0), c2 = g2.committeeId;
    await send(VAULT, V, "proposeCode", [c2, NEW_CODE, [N0.m.identity], [await D.signDigest(N0.acct, D.codeDigest({ chainId: CHAIN, vault: VAULT, committeeId: c2, epoch: 1, measurement: NEW_CODE, add: true }))]]);
    const at2 = await vread("codeActiveAt", [c2, NEW_CODE]);
    await tc.setNextBlockTimestamp({ timestamp: at2 });
    const hd2 = D.handoverDigest({ chainId: CHAIN, vault: VAULT, committeeId: c2, fromEpoch: 1, next: [N0.m, N1.m], dealerIndices: dealers });
    await send(VAULT, V, "proposeHandover", [c2, [N0.m, N1.m], [await hostSig(N0.m), await hostSig(N1.m)], dealers, [N0.m.identity], [await D.signDigest(N0.acct, hd2)]], 3_000_000n);
    await send(VAULT, V, "postDeal", [c2, 2, 1, dc, sealed, N0.m.identity,
      await D.signDigest(N0.acct, D.dealDigest({ chainId: CHAIN, vault: VAULT, committeeId: c2, toEpoch: 2, dealerIndex: 1, dealCommitments: dc, sealed }))]);
    const rmSig = await D.signDigest(N0.acct, D.codeDigest({ chainId: CHAIN, vault: VAULT, committeeId: c2, epoch: 1, measurement: NEW_CODE, add: false }));
    const rm = await send(VAULT, V, "removeCode", [c2, NEW_CODE, [N0.m.identity], [rmSig]]);
    report.gasUsed.removeCode = String(rm.gasUsed);
    check("removeCode (same weight) is immediate", rm.status === "success" && (await vread("codeActiveAt", [c2, NEW_CODE])) === 0n);
    const ackSig = async (M) => D.signDigest(M.acct, D.ackDigest({ chainId: CHAIN, vault: VAULT, committeeId: c2, toEpoch: 2, newCommitments: Y }));
    await send(VAULT, V, "ackHandover", [c2, 2, Y, N0.m.identity, await ackSig(N0)]);
    check("after removal the pending handover cannot activate: the final ack reverts BadCode()",
      (await revertOf(VAULT, V, "ackHandover", [c2, 2, Y, N1.m.identity, await ackSig(N1)])) === "BadCode()");
    const [, e2] = await vread("committeeOf", [c2]);
    check("the committee stays at epoch 1 (the old machine keeps serving)", e2 === 1);
    check("re-proposing the SAME measurement in the same epoch is impossible (single-use digest): BadSignature()",
      (await revertOf(VAULT, V, "proposeCode", [c2, NEW_CODE, [N0.m.identity], [await D.signDigest(N0.acct, D.codeDigest({ chainId: CHAIN, vault: VAULT, committeeId: c2, epoch: 1, measurement: NEW_CODE, add: true }))]])) === "BadSignature()");

    // ---- 4. the production digests (same original code the contract accepted above)
    const prodAdd = D.codeDigest({ chainId: CHAIN, vault: VAULT, committeeId: PROD_COMMITTEE, epoch: 1, measurement: NEW_CODE, add: true });
    const prodRemove = D.codeDigest({ chainId: CHAIN, vault: VAULT, committeeId: PROD_COMMITTEE, epoch: 1, measurement: NEW_CODE, add: false });
    report.production = {
      vault: VAULT, committeeId: PROD_COMMITTEE, epoch: 1, measurement: NEW_CODE, onlyPossibleApprover: PROD_MACHINE,
      codeDigestAdd: prodAdd, codeDigestRemove: prodRemove,
      eip191SignedHashAdd: keccak256(Buffer.concat([Buffer.from("\x19Ethereum Signed Message:\n32"), Buffer.from(prodAdd.slice(2), "hex")])),
      proposeCodeCalldataNoApprovals: encodeFunctionData({ abi: V, functionName: "proposeCode", args: [PROD_COMMITTEE, NEW_CODE, [], []] }),
      note: "A valid call needs approvers=[" + PROD_MACHINE + "] and approvals=[a 65-byte low-s EIP-191 signature by that TEE identity over codeDigestAdd]. The running image has no code that signs this digest.",
    };
    check("production add digest is deterministic and differs from the removal digest", /^0x[0-9a-f]{64}$/.test(prodAdd) && prodAdd !== prodRemove);
  } finally {
    anvil.kill();
    report.ok = report.checks.every((c) => c.ok);
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + "\n");
  }
});
