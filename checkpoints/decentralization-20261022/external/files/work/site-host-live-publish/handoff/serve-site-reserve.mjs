// Stage B alone (steps 4-5), for root to run by hand if the activation server is not used for the handover:
//   node serve-site-reserve.mjs --deployment-id 0x<64> --deposit-wei <wei> --print-only
//       -> the two exact operations and their sha256 (offline: no RPC, no server)
//   node serve-site-reserve.mjs --deployment-id 0x<64> --deposit-wei <wei> --approved-ops sha256:<hex> --serve
//       -> ONLY after the create receipt; serves the reviewed queue on http://127.0.0.1:39656. It never signs or sends.
import path from "node:path";
import { checkReusedPins, reserveOperations, reserveAbi, createReserveQueue, ENR, SIGN } from "./reserve-queue.mjs";

checkReusedPins();
const args = process.argv.slice(2), arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const id = String(arg("--deployment-id") || "").toLowerCase(), depositWei = arg("--deposit-wei") || "0";
const abi = await reserveAbi();
const { operations, opsSha256 } = reserveOperations({ id, depositWei, abi });
const { ENROLLMENT } = await import(path.join(ENR, "trust.mjs"));
if (args.includes("--print-only")) {
  console.log(JSON.stringify({ format: "site-host-reserve-operations/v1", status: "NOT SIGNED - review artifact", deploymentId: id, depositWei: String(BigInt(depositWei)), opsSha256,
    reserve: ENROLLMENT.reserve, executor: ENROLLMENT.executor, admin: ENROLLMENT.admin,
    operations: operations.map((o) => ({ index: o.index, kind: o.kind, title: o.title, from: o.from, to: o.to, value: o.value, gasCap: o.gas, data: o.data, policy: o.policy, opId: o.opId })) }, null, 1));
  process.exit(0);
}
const pin = String(arg("--approved-ops") || "");
if (!args.includes("--serve") || pin !== "sha256:" + opsSha256) throw Error("refusing to serve: pass --approved-ops sha256:<the reviewed opsSha256> --serve (after the user approved exactly these two operations)");
const { clientsFor } = await import(path.join(SIGN, "rpc-clients.mjs"));
const [publicnode, basePub, blast] = clientsFor([ENROLLMENT.rpcs[0], ENROLLMENT.rpcs[1], ENROLLMENT.receiptRpcs[0]]);
const app = await createReserveQueue({ id, depositWei, approvedOpsSha256: opsSha256, abi, clients: [publicnode, basePub], receiptClients: [blast, basePub],
  journalDir: path.join(path.dirname(new URL(import.meta.url).pathname), "journals", id.slice(2, 18)) });
console.log(JSON.stringify({ url: await app.listen(39656), opsSha256, deploymentId: id, operations: 2, purpose: "site-host lease gas: deposit + configure (each needs its own MetaMask confirmation)" }));
