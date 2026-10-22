// Pure: re-derive the stage-2/3 expectations from the accepted artifacts (final candidate code) and compare them with
// root's journaled requests and the two-provider verification outputs. No network.
import fs from "node:fs";
import { encodeDeployData, encodeFunctionData, keccak256, getContractAddress } from "../../enclave/node_modules/viem/_esm/index.js";
import { verifiedArtifacts, executorRuntime } from "../artifacts.mjs";
import { PRODUCTION } from "../trust.mjs";
import { RESERVE_ABI, delegationCodeHash } from "../stages.mjs";
const j = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const ex = j("../lease-gas-wallet-signing/executor-handoff-state.json").request, bd = j("../lease-gas-wallet-signing/bind-handoff-state.json").request;
const rs = j("../lease-gas-wallet/reserve-handoff-state.json").request;
const last = (p) => j(fs.readdirSync("logs").filter((f) => f.startsWith(p) && f.endsWith(".json")).sort().map((f) => "logs/" + f).at(-1));
const vE = last("real-verify-executor-"), vB = last("real-verify-bind-");
const art = verifiedArtifacts({ trust: PRODUCTION }).EnclaveLeaseExecutor;
const reserve = "0x12a3f873041dec436daa0085b766a399a6fa3639", executor = getContractAddress({ from: PRODUCTION.admin, nonce: BigInt(rs.transaction.nonce) + 1n });
const checks = {
  executorIsAdminsNextCreation: executor.toLowerCase() === vE.address,
  creationNonceIsReservePlusOne: BigInt(ex.transaction.nonce) === BigInt(rs.transaction.nonce) + 1n,
  creationDataIndependentlyDerived: encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: [reserve] }).toLowerCase() === ex.transaction.data.toLowerCase(),
  runtimeIndependentlyDerived: keccak256(executorRuntime(art, { reserve, ledger: PRODUCTION.ledger, self: executor })) === vE.runtimeHash,
  bindDataIndependentlyDerived: encodeFunctionData({ abi: RESERVE_ABI, functionName: "bindExecutor", args: [executor] }).toLowerCase() === bd.transaction.data.toLowerCase(),
  bindNonceIsCreationPlusOne: BigInt(bd.transaction.nonce) === BigInt(ex.transaction.nonce) + 1n,
  delegationCodeHashIndependentlyDerived: delegationCodeHash(executor).toLowerCase() === vB.delegationCodeHash,
  bothSetupTransactionsZeroValue: ex.transaction.value === "0x0" && bd.transaction.value === "0x0",
};
console.log(JSON.stringify({ executor: executor.toLowerCase(), reserve, checks, allPass: Object.values(checks).every(Boolean) }, null, 1));
if (!Object.values(checks).every(Boolean)) process.exit(1);
