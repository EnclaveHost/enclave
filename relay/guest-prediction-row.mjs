// The live verifier always predicts the confirmed ledger reference. Update
// preparation has a separate entry point and can only warm the same app's
// current/next published version; it never changes what the live gate accepts.
export function expectedForRow(row, options, deps) {
  return predictRow(row, null, options, deps);
}

export function prepareForRow(row, ref, options, deps) {
  return predictRow(row, ref, { ...options, forPrivate: false }, deps);
}

async function predictRow(row, preparedRef, options, { confirmRow, readVersionConfig, predict, preferFor }) {
  const confirmed = await confirmRow(row.id);
  if (confirmed.appRef !== row.appRef || confirmed.configCid !== row.configCid)
    return { ok: false, code: "deployment_changed", reason: "deployment changed during prediction" };
  let ref = confirmed.appRef;
  if (preparedRef !== null) {
    const pattern = /^catalog:\/\/(0x[0-9a-f]{64})\/(0|[1-9][0-9]{0,9})$/;
    const current = pattern.exec(String(ref).toLowerCase()), next = pattern.exec(String(preparedRef).toLowerCase());
    if (confirmed.isPublic === false || !current || !next || current[1] !== next[1]
        || Number(next[2]) < Number(current[2]) || Number(next[2]) > Number(current[2]) + 1)
      return { ok: false, code: "version_not_admitted", reason: "not the current or next public version of the same app" };
    ref = String(preparedRef).toLowerCase();
  }
  const gpuMilli = Number(confirmed.gpuMilli);
  if (!Number.isInteger(gpuMilli) || gpuMilli < 0 || gpuMilli > 1000)
    return { ok: false, code: "unsupported_inference", reason: "invalid confirmed GPU allocation" };
  let inference = null;
  if (gpuMilli > 0) {
    const envelope = confirmed.configCid ? JSON.parse(confirmed.configCid) : {};
    let config;
    if (Object.hasOwn(envelope, "config") || Object.hasOwn(envelope, "configCid")) config = envelope.config || {};
    else { const version = await readVersionConfig(ref); config = JSON.parse(version?.config || "{}"); }
    const vols = config?.volumes;
    if (gpuMilli < 65 || !Array.isArray(vols) || vols.length !== 1
        || !["qwen2.5-0.5b-q8-gguf", "qwen3.8-27b-mtp-q4-vl-gguf"].includes(vols[0])
        || (vols[0] === "qwen3.8-27b-mtp-q4-vl-gguf" && gpuMilli < 500))
      return { ok: false, code: "unsupported_inference", reason: "unsupported isolated model or GPU allocation" };
    inference = { model: vols[0], gpuMilli };
  }
  // the release this deployment's guest last ran is measured first (measurement-predict.mjs `prefer`); ordering only
  const prefer = typeof preferFor === "function" ? preferFor(String(row.id).toLowerCase()) || [] : [];
  return predict(ref, { ...options, inference, ...(prefer.length ? { prefer } : {}) });
}
