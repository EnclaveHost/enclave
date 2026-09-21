// windows/node/keys.mjs -- the two chain keys a hosting node needs, generated ON the box.
//   node keys.mjs [dir]        print the addresses, creating either key if it is missing
// operator.key signs register / heartbeat / claim / renew / release and the tunnel attach; it needs
// a few dollars of Base ETH for gas and controls nothing else (earnings go to the payout wallet).
// proof.key signs EnclaveProofOfTime checkpoints. On a fleet enclave that key is minted inside the
// CVM so the operator cannot forge "it was running"; here it sits beside the operator key on a
// machine its owner controls, which is worth saying out loud rather than implying otherwise.
import fs from "node:fs";
import path from "node:path";
import * as chain from "./chain.mjs";

const dir = process.argv[2] || path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const opFile = path.join(dir, "operator.key"), pkFile = path.join(dir, "proof.key");
const madeOp = !fs.existsSync(opFile), madePk = !fs.existsSync(pkFile);
if (madeOp) chain.newOperatorKey(opFile);
if (madePk) chain.newProofKey(pkFile);
const op = chain.loadOperator(opFile), pk = chain.loadProofKey(pkFile);
await chain.resolveAddresses();
const id = chain.enclaveIdOf(process.env.PUBLIC_URL || `https://api.enclave.host/t/${process.env.NODE_NAME || "nucbox-k11"}`);
const e = await chain.readEnclave(id).catch(() => null);
const bal = await chain.operatorBalance();
console.log(JSON.stringify({
  dir, operator: op.address, operatorCreated: madeOp, proofKey: pk.address, proofKeyCreated: madePk,
  operatorEth: (Number(bal) / 1e18).toFixed(6), enclaveId: id,
  endpoint: process.env.PUBLIC_URL || `https://api.enclave.host/t/${process.env.NODE_NAME || "nucbox-k11"}`,
  registered: !!(e && e.endpoint), registeredOperator: e && e.endpoint ? e.operator : null,
  needs: bal === 0n ? "gas: send a few dollars of Base ETH to the operator address, then the node registers itself" : "nothing: it can register and claim",
}, null, 1));
