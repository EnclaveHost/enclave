// ABI/2 evidence from an app run in a Pixel pVM (shielded/anchor/avf/PVM-CPU.md, "The app runtime", milestone 5).
//
// The pVM CPU payload runs one portable WebAssembly component in its protected VM, compiled there to Pulley and
// interpreted (runtime/pvm-rt). Before the component runs, the payload asks the VM for a second AVF certificate whose
// 64-byte challenge is
//     Bind2(transport SPKI, attach nonce, RuntimeID(identity))  ||  AppID (the component's SHA-256)
// and prints the identity and the runtime self-test tuple beside it (payload/anchor_payload.c, app_attest_abi2). This file
// is the verifier: the chain to a pinned Google root, a secure VM, the published APK (relay/avf-verify.mjs), and a
// challenge that equals what the verifier recomputes from the stated identity, its own nonce, the transport key it
// holds, and the app it expects. A restated identity, another nonce, another key or another app changes the challenge.
//
// RuntimeID, Bind2 and the identity rules are the isolation contract's (isolation/contract/runtime.go and runtime.mjs,
// RUNTIME.md; the same judge rules as isolation/m2/judge.mjs checkRuntimeSelfTest). The contract is not on main yet, so
// they are restated here and pinned to the contract's vectors (test/pvm-app-attest.test.mjs, vectors from
// isolation/contract/vectors.json at fb5e466c). When the contract lands on main, import runtime.mjs instead.
import { createHash } from "node:crypto";
import { verifyAvfEvidence } from "./avf-verify.mjs";

export const BIND2_DOMAIN = "enclave-bind-v2\n";
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

/** SHA-256 of the identity's canonical JSON; an inadmissible identity has no ID. */
export function runtimeId(r) {
  const why = validateRuntimeIdentity(r);
  if (why) throw new Error(`inadmissible runtime identity: ${why}`);
  return createHash("sha256").update(canonical(Object.fromEntries(FIELDS.map((k) => [k, r[k]])))).digest();
}

/** report_data[0:32] under ABI/2: SHA-256(domain || spki || nonce || runtime id). */
export function bind2(spki, nonce, rid) {
  if (nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  if (rid.length !== 32) throw new Error("runtime id must be 32 bytes");
  return createHash("sha256").update(Buffer.concat([Buffer.from(BIND2_DOMAIN), Buffer.from(spki), Buffer.from(nonce), Buffer.from(rid)])).digest();
}

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

const hex32 = (v, what) => {
  const b = Buffer.isBuffer(v) ? v : typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? Buffer.from(v, "hex") : null;
  if (!b || b.length !== 32) throw new Error(`${what} must be 32 bytes`);
  return b;
};

/**
 * Verify a pVM app's ABI/2 evidence.
 *   evidence: { chain: [DER...], identity: "<the ABI2 runtime line's JSON, verbatim>", selftest: "<the tuple>",
 *               spki: Buffer (the transport key the verifier holds for this session), nonce: 32 bytes (the verifier's
 *               own), appId: 32 bytes (the component the verifier expects) }
 *   opts: relay/avf-verify.mjs options (allowedCodeHashes, allowedAuthorityHashes, rootPins, now), plus
 *         allowedRuntimeIds: hex runtime IDs this verifier admits (fail closed when empty), and verifyAvf (tests only).
 * Returns { ok, reasons, runtimeId, bind2, measurement }.
 */
export function verifyPvmAppAbi2(evidence = {}, opts = {}) {
  const reasons = [];
  const fail = (m) => ({ ok: false, reasons: [...reasons, m], runtimeId: null, bind2: null, measurement: null });
  const { chain, identity, selftest, spki } = evidence;
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
  const b = bind2(spki, nonce, rid);
  const challenge = Buffer.concat([b, appId]);
  const avf = (opts.verifyAvf || verifyAvfEvidence)({ chain, challenge }, opts);
  if (!avf.ok) return fail(`attestation: ${avf.reasons.join("; ")}`);
  reasons.push(`the AVF certificate's challenge is Bind2(transport key, nonce, runtime) || app ${appId.toString("hex").slice(0, 16)}…`);
  return { ok: true, reasons, runtimeId: rid.toString("hex"), bind2: b.toString("hex"), measurement: avf.measurement };
}

/** The app attestation's pieces from a captured pVM log (ABI2_LINK<i>[k], ABI2 runtime, ABI2 selftest, ABI2 binding). */
export function abi2FromLog(text) {
  const certs = new Map();
  let identity = null, selftest = null, binding = null;
  for (const line of text.split("\n")) {
    let m;
    if ((m = /ABI2_LINK(\d+)\[(\d+)\] ([0-9a-f]+)/.exec(line))) { const i = +m[1]; if (!certs.has(i)) certs.set(i, []); certs.get(i)[+m[2]] = m[3]; }
    else if ((m = /ABI2 runtime (\{.*\})\s*$/.exec(line))) identity = m[1];
    else if ((m = /ABI2 selftest (.*?)\s*$/.exec(line))) selftest = m[1];
    else if ((m = /ABI2 binding nonce=([0-9a-f]{64}) .* runtime_id=([0-9a-f]{64}) bind2=([0-9a-f]{64}) app=([0-9a-f]{64})/.exec(line)))
      binding = { nonce: m[1], runtimeId: m[2], bind2: m[3], app: m[4] };
  }
  const chain = [...certs.keys()].sort((a, b) => a - b).map((i) => Buffer.from(certs.get(i).join(""), "hex"));
  return { chain, identity, selftest, binding };
}
