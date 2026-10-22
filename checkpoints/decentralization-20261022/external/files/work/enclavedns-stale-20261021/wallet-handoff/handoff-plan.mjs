// The review artifact: the exact handoff plan rebuilt from the pins. Root approves its sha256; serve.mjs refuses to start
// unless the rebuilt plan is byte-identical to the approved one.
import { createHash } from "node:crypto";
import { DNS, releasePlan } from "./trust.mjs";

export function buildHandoffPlan(t = DNS) {
  const plan = releasePlan(t);
  const doc = {
    format: "enclavedns-release-handoff-plan/v1", status: "NOT SIGNED - review artifact", chainId: t.chainId, owner: t.admin,
    app: { appId: plan.appId, slug: t.app.slug, name: t.app.name, descriptionSha256: createHash("sha256").update(t.app.description).digest("hex") },
    artifact: { file: "artifact/enclavedns-0.1.5.wasm", sha256: t.wasm.sha256, bytes: t.wasm.bytes, cid: t.expectedCid },
    version: { label: t.publish.version, index: t.publish.index, replaces: `${t.prev.version} (index ${t.prev.index}, ${t.prev.cid})`, res: [...t.publish.res], ports: t.publish.ports,
      configSha256: t.prev.configSha256, feePerSec6: String(t.publish.feePerSec6) },
    deployment: { id: t.deployment.id, owner: t.vault.address, appRefBefore: plan.appRefPrev, appRefAfter: plan.appRefNext,
      envelopeSha256: createHash("sha256").update(t.deployment.envelope).digest("hex"), envelopeChange: "none",
      vault: { address: t.vault.address, owner: t.admin, factory: t.vault.factory, held: { ...t.vault.held }, change: "none (stays STAGING; no promote)" },
      innerCall: { to: t.ledger, function: "setAppRef(bytes32,string)", data: plan.setAppRefData } },
    steps: plan.steps.map((s) => ({ n: s.n, step: s.step, kind: s.kind, title: s.title, destination: s.destination, amountWei: s.amountWei,
      ...(s.kind === "personal_sign" ? { message: `enclave-upload:${t.wasm.sha256}:<unix time of signing + ${t.upload.expirySec}>`, signer: t.admin }
        : { from: s.from, to: s.to, value: s.value, data: s.data, gasCap: "0x" + s.gasCap.toString(16) }) })),
    order: "upload verified (returned CID == pinned, gateway CAR == the frozen DAG) -> publish CONFIRMED on two providers -> upgrade CONFIRMED",
    totals: { valueWei: "0", usdc: "0", walletConfirmations: 3, types: { personal_sign: 1, eth_sendTransaction: 2 },
      maxFeePerGasWei: String(t.maxFeePerGas), gasCaps: Object.fromEntries(Object.entries(t.gasCaps).map(([k, v]) => [k, String(v)])) },
    rollback: { note: "NOT part of this handoff: the same vault ownerCall with catalog://<appId>/4 (unsigned-txs.json rollback); version 4 stays approved",
      appRef: plan.appRefPrev },
    loopback: { url: `http://127.0.0.1:${t.port}` },
  };
  const text = JSON.stringify(doc, null, 1) + "\n";
  return { plan, doc, text, sha256: createHash("sha256").update(text).digest("hex") };
}
