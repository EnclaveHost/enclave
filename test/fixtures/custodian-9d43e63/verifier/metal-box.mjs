// verifier/metal-box.mjs: verify an attached metal SEV-SNP box (metal0 today) the way a client reaches it - through the relay -
// with no Cloud Provider code, proxy or release format anywhere in the path. Shared by the Node consumer (verifier/consumer.mjs
// verifyMetalBox, the CLI's `enclave attest`) and the browser build (verifier/web/index.mjs verifyMetalBoxWeb, the site);
// every environment-specific piece (fetch, the SNP verdict, AMD collateral, randomness) is passed in.
//
// What is checked, and what each check rests on:
//   1. FRESHNESS: the box is challenged with OUR 32-byte nonce (GET <api>/v1/enclaves/<name>/attestation?nonce=); the relay
//      forwards it over the box's tunnel and returns the box's document verbatim. report_data[0:32] must equal
//      sha256(the document's transport SPKI || our nonce), so the report was produced for this request, by the key it names.
//   2. GENUINENESS: the report is AMD-signed (VCEK from the box's own cert table or AMD KDS, chained to the pinned ARK), the
//      guest policy refuses DEBUG/migration, VMPL 0, and the TCB meets the published floor (TCB_FLOORS below).
//   3. WHAT RUNS: the launch measurement must be one we expect. A caller may pin it (expected.measurements: its own
//      reproduction or a value it trusts). Otherwise the relay's admitted list is used and the verdict says so: the omission
//      "expected-measurement-operator-stated" keeps it "limited", never "verified" - an operator vouching for its own box is
//      not an independent expectation, and metal images are built on the host (its kernel), so there is no signed release
//      measurement a client could compare with today.
// The relay is never trusted for 1 or 2: it can withhold or delay a document, not forge one. The TLS of the request itself
// ends at the relay (api.enclave.host); the key the report binds is the box's transport key, which the result names.
//
// TCB floors: a "no-downgrade" floor per product line, the firmware this fleet ran when the floor was set; a report under it
// is refused. Raise them when AMD publishes a security bulletin; a product line with no floor stays "limited".
export const TCB_FLOORS = Object.freeze({
  Genoa: Object.freeze({ bootloader: 10, tee: 0, snp: 23, microcode: 84 }),
  // metal0 (EPYC Turin), reported TCB 2026-10-14: fmc 1, bootloader 3, tee 2, snp 5, microcode 0x75
  Turin: Object.freeze({ fmc: 1, bootloader: 3, tee: 2, snp: 5, microcode: 117 }),
});
export const FRESH_ATTESTATION_PATH = (name) => `/v1/enclaves/${encodeURIComponent(name)}/attestation`;
export const OPERATOR_STATED = "expected-measurement-operator-stated";
const NAME = /^[A-Za-z0-9_-]{1,64}$/, HEX96 = /^[0-9a-f]{96}$/;
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const b64ToBytes = (s) => { const bin = atob(String(s)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

// deps: { fetchImpl, verify(doc, { policy, context, collateral }) -> verdict, collateral, randomBytes(n) -> Uint8Array,
//         sha256(bytes) -> Promise<Uint8Array>, toBytes(Uint8Array) -> the verifier's byte type, now() -> Date }
export async function verifyMetalBoxWith(deps, { apiBase = "https://api.enclave.host", name, expected = null, minTcb = undefined, timeoutMs = 20000 } = {}) {
  const at = (deps.now ? deps.now() : new Date()).toISOString();
  const result = (fields) => ({ verifier: "enclave", subject: { kind: "metal-box", name: name ?? null, via: apiBase }, at, ...fields });
  const unavailable = (why) => result({ status: "unavailable", admissionSafe: false, omissions: [], failedChecks: [], checks: {}, reasons: [why], measurement: null });
  if (typeof name !== "string" || !NAME.test(name)) return unavailable("no box name (an attached box's name, e.g. metal0)");
  const pinned = expected && Array.isArray(expected.measurements) && expected.measurements.length
    ? expected.measurements.map((m) => String(m).toLowerCase()) : null;
  if (pinned && !pinned.every((m) => HEX96.test(m))) return unavailable("expected measurements must be 96 hex characters each");
  const nonce = deps.randomBytes(32);
  let body;
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const fetchImpl = deps.fetchImpl;   // called unbound: a browser's fetch refuses any other `this` ("Illegal invocation")
      const r = await fetchImpl(`${apiBase}${FRESH_ATTESTATION_PATH(name)}?nonce=${toHex(nonce)}`, { signal: ctrl.signal, redirect: "error", credentials: "omit", headers: { accept: "application/json" } });
      const text = await r.text();
      if (text.length > 512 * 1024) throw new Error("the answer exceeds 512 KiB");
      body = JSON.parse(text);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${body?.message || body?.error || "no document"}`);
    } finally { clearTimeout(t); }
  } catch (e) { return unavailable(`fresh attestation of ${name}: ${e && e.name === "AbortError" ? `no answer within ${timeoutMs} ms` : e.message}`); }
  const doc = body?.document;
  if (!doc || typeof doc !== "object" || doc.format !== "sev-snp-guest-metal-v1" || typeof doc.transportKey !== "string")
    return unavailable(`${name} did not return a metal SEV-SNP document (format ${doc?.format ?? "none"})`);
  if (body.nonce && body.nonce !== toHex(nonce)) return unavailable("the relay answered for another nonce");
  const operator = (body.operatorAllowlist?.measurements || []).map((m) => String(m).toLowerCase()).filter((m) => HEX96.test(m));
  const allowed = pinned || operator;
  const source = pinned ? (expected.source || "caller") : "operator allowlist (the relay's METAL_ALLOWED_MEASUREMENTS)";
  let spki;
  try { spki = b64ToBytes(doc.transportKey); } catch { return unavailable("the document's transport key is not base64"); }
  const floor = minTcb ?? TCB_FLOORS;
  const policy = { snp: { allowedMeasurements: allowed, minTcb: floor } };
  const context = { transportKeySpki: deps.toBytes(spki), nonce: deps.toBytes(nonce), now: at,
                    ...(typeof doc.certs === "string" && doc.certs ? { auxblob: deps.toBytes(b64ToBytes(doc.certs)) } : {}) };
  let v;
  try { v = await deps.verify(doc, { policy, context, collateral: deps.collateral }); }
  catch (e) { return unavailable(`verifier: ${e.message}`); }
  const omissions = [...(v.omissions || [])], reasons = [...(v.reasons || [])];
  let status = v.status;
  if (!pinned && (status === "verified" || status === "limited")) {
    omissions.push(OPERATOR_STATED);
    reasons.push(`OMITTED (${OPERATOR_STATED}): the measurement matched the relay operator's own allowlist, not an expectation independent of the operator (pin one with expected.measurements / --expect)`);
    status = "limited";
  }
  const failedChecks = Object.entries(v.checks || {}).filter(([, x]) => x === false).map(([k]) => k);
  const keySha = toHex(await deps.sha256(spki));
  return result({
    status, admissionSafe: status === "verified", omissions, failedChecks, checks: v.checks || {}, reasons,
    measurement: v.claims?.measurement ?? null, product: v.claims?.product ?? null, tcb: v.claims?.tcb ?? null,
    nonce: toHex(nonce), transportKeySha256: keySha,
    expected: { source, measurements: allowed, admittedAtAttach: body.operatorAllowlist?.admittedAtAttach ?? null },
    channel: `this request's TLS ends at the relay (${apiBase}); the report binds the box's transport key sha256:${keySha.slice(0, 16)}..., use that key for an end-to-end channel`,
    claims: v.claims || null, document: doc,
  });
}
