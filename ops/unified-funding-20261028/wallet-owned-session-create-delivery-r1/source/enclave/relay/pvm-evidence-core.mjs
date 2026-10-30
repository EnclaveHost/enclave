// relay/pvm-evidence-core.mjs: the pVM app evidence rules of relay/pvm-app-attest.mjs (formats v1..v4, Bind2/Bind3, the
// runtime identity and self-test, the instance, app and TLS keys) with the cryptography PASSED IN, so the relay and the
// browser run one copy of every rule, message and order. Nothing here hashes or verifies a signature by itself:
// relay/pvm-app-attest.mjs supplies node:crypto and relay/avf-verify.mjs; verifier/web/pvm-host.mjs supplies @noble (SHA-256,
// Ed25519, the P-256 curve) and verifier/web/avf.mjs (the AVF chain on WebCrypto). Buffer is Node's, or the `buffer` package
// the browser build injects (verifier/web/build.mjs). The text below is relay/pvm-app-attest.mjs's, moved: only each
// createHash / verify / createPublicKey call became a call of the matching function in `c`.
//   c: { sha256(bytes) -> Buffer, ed25519Verify(spki, message, signature) -> boolean (a throw counts as false),
//        isP256Spki(der) -> boolean (a point on the curve), verifyAvf({ chain, challenge }, opts) -> verifyAvfEvidence's result }

export const BIND2_DOMAIN = "enclave-bind-v2\n";
// v3 (shielded/anchor/avf/INSTANCE-BINDING.md, agreed with the verifier session): the VM INSTANCE inside the challenge
export const BIND3_DOMAIN = "enclave-bind-v3-instance\n";
export const INSTANCE_SIG_DOMAIN = "enclave-pvm-instance-sig-v1\n";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const FIELDS = ["name", "version", "execution", "targetIsa", "hostIsa", "cpuFeatures", "wx", "cache"];

/** Canonical JSON: compact, keys sorted at every level (the contract's Canonical()). */
export function canonical(v) {
  const sort = (x) => Array.isArray(x) ? x.map(sort)
    : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x;
  return Buffer.from(JSON.stringify(sort(v)));
}

/** null when the identity is admissible, else the reason (the contract's Validate(); every reason is a refusal). */
export function validateRuntimeIdentity(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return "the runtime identity is not an object";
  for (const k of Object.keys(r)) if (!FIELDS.includes(k)) return `the runtime identity carries an unknown field ${JSON.stringify(k)}`;
  for (const k of FIELDS) if (typeof r[k] !== "string") return `the runtime identity field ${k} is missing or not a string`;
  if (r.name === "" || r.version === "") return "runtime name and version are required";
  if (r.hostIsa !== "x86_64" && r.hostIsa !== "aarch64") return `host ISA ${JSON.stringify(r.hostIsa)} is not one of x86_64, aarch64`;
  if (r.execution === "jit") { if (r.targetIsa !== r.hostIsa) return `a JIT emits the host's own ISA: target ${JSON.stringify(r.targetIsa)} must equal host ${JSON.stringify(r.hostIsa)}`; }
  else if (r.execution === "interpreter") { if (r.targetIsa !== "pulley64") return `an interpreter runs pulley64 bytecode, not ${JSON.stringify(r.targetIsa)}`; }
  else return `execution ${JSON.stringify(r.execution)} is not one of jit, interpreter`;
  if (r.cpuFeatures === "") return 'the CPU-feature policy must be stated ("baseline" if none)';
  if (r.wx !== "enforced") return "a runtime that cannot state W^X as enforced is not admissible";
  if (r.cache !== "none" && r.cache !== "authenticated") return `cache mode ${JSON.stringify(r.cache)} is not one of none, authenticated`;
  return null;
}

/** What instanceSig signs: the domain and the whole 64-byte challenge. */
export const instanceSigMessage = (challenge) => Buffer.concat([Buffer.from(INSTANCE_SIG_DOMAIN), Buffer.from(challenge)]);
const isEd25519Spki = (b) => Buffer.isBuffer(b) && b.length === 44 && b.subarray(0, 12).equals(ED25519_SPKI_PREFIX);

/** The runtime self-test tuple, `exec_pages=... wx=clean maps=N scope=...`, under the shared judge's rules, with the
 * exec_pages value also held to its grammar. Returns { ok, reasons }. */
export function checkRuntimeSelfTest(selfTest, identity) {
  const no = (m) => ({ ok: false, reasons: [m] });
  if (typeof selfTest !== "string" || selfTest === "") return no("no runtime self-test: nothing says this domain checked W^X");
  if (selfTest.length > 300) return no("the runtime self-test is not a short string");
  const f = {};
  for (const part of selfTest.trim().split(/\s+/)) {
    const i = part.indexOf("=");
    if (i <= 0) return no(`malformed runtime self-test ${JSON.stringify(selfTest)}`);
    const k = part.slice(0, i);
    if (k in f) return no(`the runtime self-test names ${k} more than once`);
    f[k] = part.slice(i + 1);
  }
  for (const k of Object.keys(f)) if (!["exec_pages", "wx", "maps", "scope"].includes(k)) return no(`the runtime self-test carries an unknown key ${k}`);
  for (const k of ["exec_pages", "wx", "maps", "scope"]) if (!(k in f)) return no(`the runtime self-test is missing ${k}`);
  if (!/^(allowed|refused:[A-Za-z0-9]{1,16}|no-mapping:[A-Za-z0-9]{1,16})$/.test(f.exec_pages)) return no(`exec_pages=${JSON.stringify(f.exec_pages)} is not allowed | refused:<errno> | no-mapping:<errno>`);
  if (f.wx !== "clean") return no(`wx=${JSON.stringify(f.wx)}: W^X holds only when no writable-and-executable mapping was found`);
  if (!/^[1-9][0-9]{0,6}$/.test(f.maps)) return no(`maps=${JSON.stringify(f.maps)}: a scan that saw nothing is not a clean scan`);
  const maps = Number(f.maps), reasons = [];
  if (f.scope === "self") {
    if (maps !== 1) return no(`scope=self scanned maps=${maps}; the reporting process alone is exactly one`);
    reasons.push("the scan covered the reporting process alone (scope=self): complete only because the runtime is a library in that process, which the hardware does not attest");
  } else if (f.scope === "all-processes") reasons.push(`the scan covered every process in the domain (${maps})`);
  else if (f.scope.startsWith("cgroup:/")) reasons.push(`the scan covered the domain's cgroup ${f.scope.slice(7)} (${maps})`);
  else return no(`scope=${JSON.stringify(f.scope)} is not one of all-processes, cgroup:/<path>, self`);
  if (identity.execution === "jit" && f.exec_pages !== "allowed") return no(`execution=jit but exec_pages=${f.exec_pages}: no JIT runs where an executable page is refused`);
  reasons.push(`exec_pages=${f.exec_pages}, wx=clean; the tuple is the measured payload's own word, not the hardware's`);
  return { ok: true, reasons };
}

export const hex32 = (v, what) => {
  const b = Buffer.isBuffer(v) ? v : typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? Buffer.from(v, "hex") : null;
  if (!b || b.length !== 32) throw new Error(`${what} must be 32 bytes`);
  return b;
};

export const PVM_APP_EVIDENCE_FORMAT = "enclave-pvm-app-evidence/v1";
// v2 (the browser channel): the same evidence plus appKey, an X25519 key made in the VM for HPKE-sealed requests
// (payload + runtime/pvm-rt sealed.rs), and appKeySig, the attested transport key's Ed25519 signature over
// APP_KEY_DOMAIN || nonce || AppID || appKey. Both fields are mandatory in v2 and forbidden in v1: a relay that strips
// them has malformed evidence, not a downgrade; a VM with no browser key answers v1.
export const PVM_APP_EVIDENCE_FORMAT_V2 = "enclave-pvm-app-evidence/v2";
export const APP_KEY_DOMAIN = "enclave-pvm-app-key-v1\n";
// constants of the v2 format, enforced by the VM: a sealed request is accepted only under an evidence nonce the VM answered
// this boot, for SEALED_WINDOW_SECONDS after the answer and at most SEALED_MAX_REQUESTS times, each (nonce, enc) once
export const SEALED_WINDOW_SECONDS = 600, SEALED_MAX_REQUESTS = 256;
/** The message appKeySig signs. */
export function appKeyMessage(nonce, appId, appKey) {
  return Buffer.concat([Buffer.from(APP_KEY_DOMAIN), hex32(nonce, "nonce"), hex32(appId, "appId"), hex32(appKey, "appKey")]);
}
// v3: the same evidence bound to the VM INSTANCE (INSTANCE-BINDING.md) -- plus instanceKey (the instance key's SPKI, hex) and
// instanceSig; appKeySig then signs under APP_KEY_DOMAIN_V3 and covers the InstanceID
export const PVM_APP_EVIDENCE_FORMAT_V3 = "enclave-pvm-app-evidence/v3";
export const APP_KEY_DOMAIN_V3 = "enclave-pvm-app-key-v2\n";
export function appKeyMessageV3(nonce, appId, instanceId, appKey) {
  return Buffer.concat([Buffer.from(APP_KEY_DOMAIN_V3), hex32(nonce, "nonce"), hex32(appId, "appId"), hex32(instanceId, "instanceId"), hex32(appKey, "appKey")]);
}
// v4 (the marketplace host, PVM-CPU.md "Serving buyers"): v3 plus the TLS key a browser trusts. tlsSpki is the DER SPKI (hex)
// of a P-256 key the VM derived from its instance secret for this app; tlsKeySig is the attested transport key's Ed25519
// signature over TLS_KEY_DOMAIN || nonce || AppID || InstanceID || SHA-256(tlsSpki); appSha256 (= app) and transportKey
// (= base64 of tlsSpki) restate them in the names a route probe reads (network/guest-probe.mjs). The same document answers
// the evidence endpoint and the app's own TLS port (GET /.well-known/enclave-attestation), so a client pins tlsSpki for the
// very connection it was served on.
export const PVM_APP_EVIDENCE_FORMAT_V4 = "enclave-pvm-app-evidence/v4";
export const TLS_KEY_DOMAIN = "enclave-pvm-tls-key-v1\n";   // gitleaks:allow -- a public domain-separation string (PVM-CPU.md), not a key
const P256_SPKI_RE = /^3059301306072a8648ce3d020106082a8648ce3d03010703420004[0-9a-f]{128}$/;

// The functions that hash or verify, over the cryptography `c` supplies (see the head of this file).
export function pvmEvidenceRules(c) {
  /** SHA-256 of the identity's canonical JSON; an inadmissible identity has no ID. */
  function runtimeId(r) {
    const why = validateRuntimeIdentity(r);
    if (why) throw new Error(`inadmissible runtime identity: ${why}`);
    return c.sha256(canonical(Object.fromEntries(FIELDS.map((k) => [k, r[k]]))));
  }

  /** report_data[0:32] under ABI/2: SHA-256(domain || spki || nonce || runtime id). */
  function bind2(spki, nonce, rid) {
    if (nonce.length !== 32) throw new Error("nonce must be 32 bytes");
    if (rid.length !== 32) throw new Error("runtime id must be 32 bytes");
    return c.sha256(Buffer.concat([Buffer.from(BIND2_DOMAIN), Buffer.from(spki), Buffer.from(nonce), Buffer.from(rid)]));
  }

  /** v3: SHA-256(domain || spki || nonce || runtime id || InstanceID); the challenge is this || AppID. */
  function bind3(spki, nonce, rid, instanceId) {
    if (nonce.length !== 32 || rid.length !== 32 || instanceId.length !== 32) throw new Error("nonce, runtime id and instance id must be 32 bytes each");
    return c.sha256(Buffer.concat([Buffer.from(BIND3_DOMAIN), Buffer.from(spki), Buffer.from(nonce), Buffer.from(rid), Buffer.from(instanceId)]));
  }
  /** InstanceID = SHA-256(the instance key's 44-byte Ed25519 SPKI). */
  const instanceIdOf = (instanceSpki) => c.sha256(Buffer.from(instanceSpki));

  function tlsKeyMessage(nonce, appId, instanceId, tlsSpki) {
    const spki = Buffer.isBuffer(tlsSpki) ? tlsSpki : Buffer.from(String(tlsSpki), "hex");
    return Buffer.concat([Buffer.from(TLS_KEY_DOMAIN), hex32(nonce, "nonce"), hex32(appId, "appId"), hex32(instanceId, "instanceId"),
                          c.sha256(spki)]);
  }

  /**
   * Verify a pVM app's ABI/2 evidence.
   *   evidence: { chain: [DER...], identity: "<the ABI2 runtime line's JSON, verbatim>", selftest: "<the tuple>",
   *               spki: Buffer (the transport key the verifier holds for this session), nonce: 32 bytes (the verifier's
   *               own), appId: 32 bytes (the component the verifier expects) }
   *               v3 (optional, together): instanceKey: Buffer (the instance key's 44-byte Ed25519 SPKI), instanceSig: Buffer
   *               (64 bytes) -- the challenge is then Bind3(spki, nonce, RuntimeID, SHA-256(instanceKey)) || AppID, and
   *               instanceSig must be the instance key's signature over it
   *   opts: relay/avf-verify.mjs options (allowedCodeHashes, allowedAuthorityHashes, rootPins, now), plus
   *         allowedRuntimeIds: hex runtime IDs this verifier admits (fail closed when empty), and verifyAvf (tests only).
   * Returns { ok, reasons, runtimeId, bind2 (v2), bind3 (v3), instanceId (v3), measurement }.
   */
  function verifyPvmAppAbi2(evidence = {}, opts = {}) {
    const reasons = [];
    const fail = (m) => ({ ok: false, reasons: [...reasons, m], runtimeId: null, bind2: null, bind3: null, instanceId: null, measurement: null });
    const { chain, identity, selftest, spki } = evidence;
    const v3 = evidence.instanceKey !== undefined || evidence.instanceSig !== undefined;
    if (v3 && !isEd25519Spki(evidence.instanceKey)) return fail("the instance key is not a 44-byte Ed25519 SPKI");
    if (v3 && (!Buffer.isBuffer(evidence.instanceSig) || evidence.instanceSig.length !== 64)) return fail("the instance signature is not 64 bytes");
    if (v3 && Buffer.isBuffer(spki) && evidence.instanceKey.equals(spki)) return fail("the instance key is the transport key: an instance key is its own, never the boot's");
    let nonce, appId;
    try { nonce = hex32(evidence.nonce, "nonce"); appId = hex32(evidence.appId, "appId"); } catch (e) { return fail(e.message); }
    if (!Buffer.isBuffer(spki) || spki.length < 32 || spki.length > 512) return fail("the transport SPKI is missing");
    if (typeof identity !== "string" || identity.length > 1024) return fail("the runtime identity line is missing");
    let r;
    try { r = JSON.parse(identity); } catch { return fail("the runtime identity is not JSON"); }
    const why = validateRuntimeIdentity(r);
    if (why) return fail(`the runtime identity is not admissible: ${why}`);
    if (!canonical(r).equals(Buffer.from(identity))) return fail("the runtime identity is not in canonical form (the VM hashes exactly what it prints)");
    const rid = runtimeId(r);
    const allowed = new Set([...(opts.allowedRuntimeIds || [])].map((h) => String(h).toLowerCase()));
    if (!allowed.size) return fail("no pinned runtime IDs: refusing (fail closed)");
    if (!allowed.has(rid.toString("hex"))) return fail(`runtime ${rid.toString("hex").slice(0, 16)}… (${r.name}/${r.version} ${r.execution} ${r.targetIsa}) is not an admitted runtime`);
    reasons.push(`runtime ${r.name}/${r.version} execution=${r.execution} target=${r.targetIsa} host=${r.hostIsa} features=${r.cpuFeatures} cache=${r.cache}`);
    const st = checkRuntimeSelfTest(selftest, r);
    if (!st.ok) return fail(st.reasons[0]);
    reasons.push(...st.reasons);
    const iid = v3 ? instanceIdOf(evidence.instanceKey) : null;
    const b = v3 ? bind3(spki, nonce, rid, iid) : bind2(spki, nonce, rid);
    const challenge = Buffer.concat([b, appId]);
    const avf = (opts.verifyAvf || c.verifyAvf)({ chain, challenge }, opts);
    if (!avf.ok) return fail(`attestation: ${avf.reasons.join("; ")}`);
    reasons.push(v3 ? `the AVF certificate's challenge is Bind3(transport key, nonce, runtime, instance ${iid.toString("hex").slice(0, 16)}…) || app ${appId.toString("hex").slice(0, 16)}…`
                    : `the AVF certificate's challenge is Bind2(transport key, nonce, runtime) || app ${appId.toString("hex").slice(0, 16)}…`);
    if (v3) {
      let ok = false;
      try { ok = c.ed25519Verify(evidence.instanceKey, instanceSigMessage(challenge), evidence.instanceSig); } catch { ok = false; }
      if (!ok) return fail("the instanceSig is not the instance key's signature over this challenge");
      reasons.push(`the instance key signed this challenge: instance ${iid.toString("hex").slice(0, 16)}…`);
    }
    return { ok: true, reasons, runtimeId: rid.toString("hex"), bind2: v3 ? null : b.toString("hex"), bind3: v3 ? b.toString("hex") : null,
             instanceId: v3 ? iid.toString("hex") : null, measurement: avf.measurement };
  }

  /**
   * A CLIENT's verification of a pVM app's evidence envelope (LAB, PVM-CPU.md "client-verified channel"): the VM answered
   * the client's own nonce with a fresh AVF certificate over Bind2(transport SPKI, THAT nonce, RuntimeID) || AppID. The
   * envelope is untrusted input from whoever carried it (the relay, the phone's Android app): its `nonce` and `app` fields
   * are compared, never used -- the challenge is recomputed from the CALLER's nonce and the CALLER's expected app, so a
   * replayed, re-labelled or re-keyed envelope does not verify. Every pin is the caller's (roots, code hash, authority,
   * runtime IDs). v2 also carries appKey; it is returned only after appKeySig verifies under the attested transport key
   * for the caller's nonce and app. Returns { ok, reasons, transportSpki (hex, the key to pin for TLS), runtimeId,
   * measurement, freshness, appId, appKey (v2), sealedWindowSeconds, sealedMaxRequests (v2) }.
   *   envelope: { format, nonce, app, spki, identity, selftest, chain: [b64 DER], (v2, v3) appKey, appKeySig, (v3) instanceKey, instanceSig }
   *   expect:   { nonce (32 bytes), appId (hex), allowedRuntimeIds, allowedCodeHashes, allowedAuthorityHashes, rootPins?, now?,
   *               instanceIds? -- a deployment bound to instances: only v3 for a listed instance verifies, v1/v2 are refused as a
   *               downgrade by name }
   * The browser runs this same function (verifier/web/pvm-host.mjs; test/verifier-web-pvm-host.test.mjs: parity).
   */
  function verifyPvmAppEvidence(envelope, expect = {}) {
    const base = { transportSpki: null, runtimeId: null, measurement: null, freshness: "client-nonce", appId: null, appKey: null, sealedWindowSeconds: null, sealedMaxRequests: null, instanceId: null, instanceKey: null,
                   tlsSpki: null, tlsSpkiSha256: null };
    const no = (m, reasons = []) => ({ ok: false, reasons: [...reasons, m], ...base });
    const e = envelope;
    // a closed shape per version: exactly these fields, each at its exact form (an unknown field is refused, never ignored)
    if (!e || typeof e !== "object" || Array.isArray(e)) return no("the evidence is not an object");
    let bound = null;   // a deployment bound to instances takes v3 only: an unbound format is a downgrade, refused by name first
    if (expect.instanceIds !== undefined) {
      if (!Array.isArray(expect.instanceIds) || !expect.instanceIds.length || !expect.instanceIds.every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)))
        return no("the caller's instanceIds are not a non-empty list of 64 lowercase hex: refusing (fail closed)");
      bound = new Set(expect.instanceIds);
      if (e.format !== PVM_APP_EVIDENCE_FORMAT_V3 && e.format !== PVM_APP_EVIDENCE_FORMAT_V4)
        return no(`${JSON.stringify(e.format)} is an unbound evidence format for a deployment bound to instances: refused as a downgrade (v3 required)`);
    }
    // a caller that serves buyers over TLS (the relay's marketplace, a route probe) needs the TLS key: v4 only, refused by name
    if (expect.requireTls === true && e.format !== PVM_APP_EVIDENCE_FORMAT_V4)
      return no(`${JSON.stringify(e.format)} binds no TLS key: refused (v4 required)`);
    const v4 = e.format === PVM_APP_EVIDENCE_FORMAT_V4, v3 = e.format === PVM_APP_EVIDENCE_FORMAT_V3 || v4, v2 = e.format === PVM_APP_EVIDENCE_FORMAT_V2 || v3;
    const KEYS = v4 ? ["app", "appKey", "appKeySig", "appSha256", "chain", "format", "identity", "instanceKey", "instanceSig", "nonce", "selftest", "spki", "tlsKeySig", "tlsSpki", "transportKey"]
               : v3 ? ["app", "appKey", "appKeySig", "chain", "format", "identity", "instanceKey", "instanceSig", "nonce", "selftest", "spki"]
               : v2 ? ["app", "appKey", "appKeySig", "chain", "format", "identity", "nonce", "selftest", "spki"] : ["app", "chain", "format", "identity", "nonce", "selftest", "spki"];
    if (Object.keys(e).sort().join() !== KEYS.join()) return no(`the evidence fields must be exactly ${KEYS.join(",")} (got ${Object.keys(e).sort().join(",")})`);
    if (!v2 && e.format !== PVM_APP_EVIDENCE_FORMAT) return no(`the evidence format is not ${PVM_APP_EVIDENCE_FORMAT}, ${PVM_APP_EVIDENCE_FORMAT_V2}, ${PVM_APP_EVIDENCE_FORMAT_V3} or ${PVM_APP_EVIDENCE_FORMAT_V4}`);
    for (const k of ["allowedRuntimeIds", "allowedCodeHashes", "allowedAuthorityHashes"])
      if (!Array.isArray(expect[k]) || !expect[k].length) return no(`no ${k}: refusing (fail closed)`);
    if (expect.rootPins !== undefined && (!Array.isArray(expect.rootPins) || !expect.rootPins.length)) return no("an empty rootPins: refusing (fail closed)");
    let nonce, appId;
    try { nonce = hex32(expect.nonce, "the caller's nonce"); appId = hex32(expect.appId, "the caller's expected app"); } catch (x) { return no(x.message); }
    if (typeof e.nonce !== "string" || !/^[0-9a-f]{64}$/.test(e.nonce)) return no("the evidence nonce is not 64 lowercase hex");
    if (e.nonce !== nonce.toString("hex")) return no("the evidence answers another nonce (stale or replayed)");
    if (typeof e.app !== "string" || !/^[0-9a-f]{64}$/.test(e.app)) return no("the evidence app is not 64 lowercase hex");
    if (e.app !== appId.toString("hex")) return no("the evidence names another app");
    if (typeof e.spki !== "string" || !/^302a300506032b6570032100[0-9a-f]{64}$/.test(e.spki)) return no("the evidence's transport key is not a 44-byte Ed25519 SPKI");
    if (typeof e.identity !== "string" || e.identity.length > 1024) return no("the evidence identity is not a string of at most 1024 bytes");
    if (typeof e.selftest !== "string" || e.selftest.length > 300) return no("the evidence self-test is not a string of at most 300 bytes");
    if (v2 && (typeof e.appKey !== "string" || !/^[0-9a-f]{64}$/.test(e.appKey))) return no("the evidence appKey is not 64 lowercase hex (an X25519 key)");
    if (v2 && (typeof e.appKeySig !== "string" || !/^[0-9a-f]{128}$/.test(e.appKeySig))) return no("the evidence appKeySig is not 128 lowercase hex (an Ed25519 signature)");
    if (v3 && (typeof e.instanceKey !== "string" || !/^302a300506032b6570032100[0-9a-f]{64}$/.test(e.instanceKey))) return no("the evidence's instance key is not a 44-byte Ed25519 SPKI");
    if (v3 && e.instanceKey === e.spki) return no("the evidence's instance key is its transport key: an instance key is its own, never the boot's");
    if (v3 && (typeof e.instanceSig !== "string" || !/^[0-9a-f]{128}$/.test(e.instanceSig))) return no("the evidence instanceSig is not 128 lowercase hex (an Ed25519 signature)");
    if (v4) {
      if (typeof e.tlsSpki !== "string" || !P256_SPKI_RE.test(e.tlsSpki)) return no("the evidence tlsSpki is not a 91-byte P-256 SPKI (uncompressed point), lowercase hex");
      if (!c.isP256Spki(Buffer.from(e.tlsSpki, "hex"))) return no("the evidence tlsSpki is not a point on P-256");
      if (typeof e.tlsKeySig !== "string" || !/^[0-9a-f]{128}$/.test(e.tlsKeySig)) return no("the evidence tlsKeySig is not 128 lowercase hex (an Ed25519 signature)");
      if (e.appSha256 !== e.app) return no("the evidence's appSha256 is not its app");
      if (e.transportKey !== Buffer.from(e.tlsSpki, "hex").toString("base64")) return no("the evidence's transportKey is not base64 of its tlsSpki");
    }
    if (!Array.isArray(e.chain) || e.chain.length < 2 || e.chain.length > 8) return no("the evidence chain is not 2..8 certificates");
    const chain = [];
    for (const ce of e.chain) {
      if (typeof ce !== "string" || ce.length > 87384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ce) || ce.length % 4) return no("a chain entry is not canonical base64");
      const der = Buffer.from(ce, "base64");
      if (!der.length || der.length > 65536 || der.toString("base64") !== ce) return no("a chain entry is not 1..65536 bytes of canonical base64 DER");
      chain.push(der);
    }
    const spki = Buffer.from(e.spki, "hex");
    const v = verifyPvmAppAbi2({ chain, identity: e.identity, selftest: e.selftest, spki, nonce, appId,
                                 ...(v3 ? { instanceKey: Buffer.from(e.instanceKey, "hex"), instanceSig: Buffer.from(e.instanceSig, "hex") } : {}) },
      { allowedRuntimeIds: expect.allowedRuntimeIds, allowedCodeHashes: expect.allowedCodeHashes, allowedAuthorityHashes: expect.allowedAuthorityHashes,
        ...(expect.rootPins ? { rootPins: expect.rootPins } : {}), ...(expect.now ? { now: expect.now } : {}) });
    if (!v.ok) return { ...base, ok: false, reasons: v.reasons, appId: appId.toString("hex") };
    const reasons = [...v.reasons];
    // v2/v3: the attested transport key vouches for the app key, under THIS nonce and THIS app (v3: and THIS instance)
    let appKey = null;
    if (v2) {
      let ok = false;
      const msg = v3 ? appKeyMessageV3(nonce, appId, v.instanceId, e.appKey) : appKeyMessage(nonce, appId, e.appKey);
      try { ok = c.ed25519Verify(spki, msg, Buffer.from(e.appKeySig, "hex")); }
      catch { ok = false; }
      if (!ok) return no(`the appKey is not signed by the attested transport key for this nonce and app${v3 ? " and instance" : ""}`, reasons);
      appKey = e.appKey;
      reasons.push(`the app key ${appKey.slice(0, 16)}… is signed by the attested transport key for this nonce and app${v3 ? " and instance" : ""}`);
    }
    // v4: the attested transport key vouches for the TLS key, under THIS nonce, app and instance
    let tlsSpki = null, tlsSpkiSha256 = null;
    if (v4) {
      let ok = false;
      try { ok = c.ed25519Verify(spki, tlsKeyMessage(nonce, appId, v.instanceId, e.tlsSpki), Buffer.from(e.tlsKeySig, "hex")); }
      catch { ok = false; }
      if (!ok) return no("the TLS key is not signed by the attested transport key for this nonce, app and instance", reasons);
      tlsSpki = e.tlsSpki; tlsSpkiSha256 = c.sha256(Buffer.from(e.tlsSpki, "hex")).toString("hex");
      reasons.push(`the TLS key (P-256, SPKI sha256 ${tlsSpkiSha256.slice(0, 16)}…) is signed by the attested transport key for this nonce, app and instance`);
    }
    // a bound deployment: the attested instance must be one the signed policy lists for it
    if (bound && !bound.has(v.instanceId))
      return no(`instance ${v.instanceId.slice(0, 16)}… is a genuine instance of this app, but not one bound to the selected deployment: refused`, reasons);
    return { ok: true, reasons, transportSpki: e.spki, runtimeId: v.runtimeId, measurement: v.measurement, freshness: "client-nonce", appId: appId.toString("hex"),
             appKey, sealedWindowSeconds: v2 ? SEALED_WINDOW_SECONDS : null, sealedMaxRequests: v2 ? SEALED_MAX_REQUESTS : null,
             instanceId: v.instanceId, instanceKey: v3 ? e.instanceKey : null, tlsSpki, tlsSpkiSha256 };
  }

  return { runtimeId, bind2, bind3, instanceIdOf, tlsKeyMessage, verifyPvmAppAbi2, verifyPvmAppEvidence };
}
