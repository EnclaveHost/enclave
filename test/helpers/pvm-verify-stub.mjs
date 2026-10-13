// The stubbed evidence verifier (see pvm-verify-stub-loader.mjs). It exports exactly what web/pvm-client.js imports:
// toHex (the real one) and verifyPvmAppEvidence, which accepts only the lab relay's fabricated envelope when it echoes the
// client's own nonce and app, and returns the fields the client's gate reads.
const real = await import(new URL(import.meta.url).searchParams.get("real"));
export const toHex = real.toHex;
export async function verifyPvmAppEvidence(env, expect) {
  const no = (m) => ({ ok: false, reasons: [m], transportSpki: null, runtimeId: null, measurement: null, freshness: "client-nonce", appId: null, appKey: null, sealedWindowSeconds: null, sealedMaxRequests: null });
  const nonceHex = typeof expect.nonce === "string" ? expect.nonce : toHex(expect.nonce);
  const appId = typeof expect.appId === "string" ? expect.appId : toHex(expect.appId);
  if (!env || env.format !== "enclave-pvm-app-evidence/v2" || env.lab !== "stub-evidence") return no("stub: not the lab relay's envelope");
  if (env.nonce !== nonceHex) return no("the evidence answers another nonce (stale or replayed)");
  if (env.app !== appId) return no("the evidence names another app");
  return { ok: true, reasons: ["stub: accepted the lab envelope for this nonce and app"], transportSpki: env.spki, runtimeId: expect.allowedRuntimeIds[0], measurement: expect.allowedCodeHashes[0],
    freshness: "client-nonce", appId, appKey: env.appKey, sealedWindowSeconds: 600, sealedMaxRequests: 256 };
}
