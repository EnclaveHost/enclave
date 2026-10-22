// The review artifact: the exact handoff plan rebuilt from the pins. Root approves its sha256; serve.mjs refuses to start
// unless the rebuilt plan is byte-identical to the approved one.
import { createHash } from "node:crypto";
import { PUB, publisherPlan } from "./trust.mjs";

export function buildHandoffPlan(t = PUB) {
  const plan = publisherPlan(t);
  const doc = {
    format: "ipns-publisher-release-handoff-plan/v1", status: "NOT SIGNED - review artifact", chainId: t.chainId, owner: t.admin,
    app: { appId: plan.appId, slug: t.app.slug, name: t.app.name, descriptionSha256: createHash("sha256").update(t.app.description).digest("hex") },
    artifact: { file: "artifact/ipns-publisher-ensrepair.wasm", sha256: t.wasm.sha256, bytes: t.wasm.bytes, cid: t.expectedCid },
    version: { label: t.publish.version, index: t.publish.index, replaces: `${t.prev.version} (index ${t.prev.index}, ${t.prev.cid})`, res: [...t.publish.res], ports: t.publish.ports,
      configSha256: t.prev.configSha256, feePerSec6: String(t.publish.feePerSec6) },
    deployment: { id: t.deployment.id, appRefBefore: plan.appRefPrev, appRefAfter: plan.appRefNext,
      envelopeBeforeSha256: createHash("sha256").update(t.deployment.envelopeCurrent).digest("hex"), envelopeAfterSha256: createHash("sha256").update(t.deployment.envelopeNew).digest("hex"),
      envelopeChange: "config.ipni.announceAllBlocks: false -> true (the only difference)" },
    steps: plan.steps.map((s) => ({ n: s.n, step: s.step, kind: s.kind, title: s.title, destination: s.destination, amountWei: s.amountWei,
      ...(s.kind === "personal_sign" ? { message: `enclave-upload:${t.wasm.sha256}:<unix time of signing + ${t.upload.expirySec}>`, signer: t.admin }
        : { from: s.from, to: s.to, value: s.value, data: s.data, gasCap: "0x" + s.gasCap.toString(16) }) })),
    order: "upload verified (returned CID == pinned, gateway CAR == the frozen DAG) -> publish CONFIRMED on two providers -> upgrade CONFIRMED -> config",
    totals: { valueWei: "0", usdc: "0", walletConfirmations: 4, types: { personal_sign: 1, eth_sendTransaction: 3 },
      maxFeePerGasWei: String(t.maxFeePerGas), gasCaps: Object.fromEntries(Object.entries(t.gasCaps).map(([k, v]) => [k, String(v)])) },
    loopback: { url: `http://127.0.0.1:${t.port}` },
  };
  const text = JSON.stringify(doc, null, 1) + "\n";
  return { plan, doc, text, sha256: createHash("sha256").update(text).digest("hex") };
}
