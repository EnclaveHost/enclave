// Platform host policy mirrors (network/platform-host-policy.mjs): any HTTPS origins that serve
//   <base>/<digest>.json   the document the book anchors (content-addressed by its EIP-712 digest)
//   <base>/latest.json     the newest one (used only by an explicitly unanchored gate)
// as { document, signature }. Mirrors are UNTRUSTED transport: the gate verifies the book owner's signature and the exact
// anchored digest at an agreed block; a missing, slow or lying mirror can delay, never admit a banned host.
const HTTPS = /^https:\/\/[a-z0-9.-]{1,200}(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~-]{1,64}){0,8}$/;
export const MAX_POLICY_RESPONSE = 256 * 1024;
export function validateMirrors(list) {
  if (!Array.isArray(list) || !list.length || list.length > 8) throw Error("host policy mirrors: 1-8 HTTPS origins");
  const out = list.map((u) => String(u).replace(/\/+$/, ""));
  if (out.some((u) => !HTTPS.test(u)) || new Set(out).size !== out.length) throw Error("host policy mirrors: distinct HTTPS URLs without query, credentials or fragment");
  return out;
}
// Limit decoded network bytes before retaining them. Checking text.length after
// Response.text() both buffers the entire reply and undercounts multibyte UTF-8.
async function policyText(response) {
  const cancel = async () => { try { await response.body?.cancel(); } catch {} };
  const declared = response.headers?.get("content-length");
  if (!response.ok || (declared !== null && declared !== undefined &&
      (!/^\d+$/.test(declared) || Number(declared) > MAX_POLICY_RESPONSE))) {
    await cancel();
    return null;
  }
  if (!response.body?.getReader) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_POLICY_RESPONSE) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error;
  } finally {
    reader.releaseLock();
  }
}
export function httpPolicyMirrors(list, { fetch = globalThis.fetch, timeoutMs = 8000 } = {}) {
  return validateMirrors(list).map((base) => async (digest) => {
    if (digest !== null && !/^0x[0-9a-f]{64}$/.test(digest)) return [];
    const r = await fetch(`${base}/${digest || "latest"}.json`, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    const text = await policyText(r);
    if (text === null) return [];
    const j = JSON.parse(text);
    return [j].filter((x) => x && typeof x.signature === "string" && (typeof x.document === "string" || typeof x.document === "object"));
  });
}
