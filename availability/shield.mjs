// Enclave Shield (isolation backend "hyperv-partition-per-app") pieces of the paid capacity audit
// (docs/design/paid-capacity-verification.md). scripts/availability/service.mjs composes them for a config whose hosts say
// kind "shield"; every piece here takes its I/O as arguments, so the tests drive it with stand-ins.
//
//   - createShieldHostChecker: a FRESH windows-hv-node/v1 TPM session of one box over OUR nonce and OUR credential, through
//     the relay's two-step route (POST /v1/enclaves/<name>/attestation {nonce} -> the TPM keys; we compute the AIK name
//     ourselves and MakeCredential for the EK; POST .../attestation/credential -> the box's document), verified with
//     relay/hvnode-verify.mjs. What it proves is the HOST's boot state (genuine on-die TPM, Secure Boot, no test signing,
//     VBS/HVCI) in this boot, for this nonce: the host is not excluded, and nothing here is a TEE claim. Each check costs
//     the box a TPM quote (~4 s); the relay allows one check per box per 20 s, one at a time, and refuses while the box is
//     re-attaching. So checks of one box are serialized here, spaced >= 20 s, and a busy answer (503, 429, a re-attach
//     refusal, a box momentarily absent) is retried after a jittered backoff of at least 20 s, a bounded number of times.
//   - shieldWitnessVerifier: the witness's verify hook for such a session (the EK certificate's sha256 is the allowlisted
//     identity and the hardware id basis).
//   - shieldAvailability: a Shield box's /availability states nodeGflops and shares, not cpuGflopsFree.
//   - createShieldExpectations: the per-job expectation for verified-http's Shield branch, derived independently (our
//     ledger read, the catalog, the CID-verified component, our pinned policy), the host session LAST.
//   - rawCidFetcher: a raw-codec CID's bytes from an untrusted gateway, accepted only when sha256 == the CID's digest.
//
// Failure messages are prefixed so the service can tell the verifier's own faults (INCONCLUSIVE: "Shield host session
// unavailable", "Shield expectation unavailable", "Shield app policy ...") from the host's ("Shield host session refused").
import fs from "node:fs";
import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import { makeCredential, ekPublicFrom } from "../relay/vbs-credential.mjs";
import { verifyHvNodeEvidence, HVNODE_FORMAT } from "../relay/hvnode-verify.mjs";
import { parseTpmtPublic, tpmNameOf, AIK_REQUIRED_ATTRIBUTES, TPMA_DECRYPT, TPM_ALG_SHA256, TPM_ALG_RSASSA, VBS_MAX_CERT_BYTES,
         VBS_MAX_TPMT_PUBLIC_BYTES } from "../relay/vbs-verify.mjs";
import { expectedShieldApp } from "../relay/shield-app-verifier.mjs";
import { rawCidDigest } from "../relay/measurement-predict.mjs";

const sha256 = (b) => createHash("sha256").update(b).digest();
const lc = (s) => String(s || "").toLowerCase();
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_KEYS_ANSWER = 256 * 1024, MAX_DOCUMENT_ANSWER = 16 * 1024 * 1024;
export const SHIELD_EVIDENCE = "fresh windows-hv-node/v1 TPM session over our nonce and credential (host boot state only; host not excluded) + /availability";
export const unavailable = (why) => new Error(`Shield host session unavailable: ${why}`);
export const refused = (why) => new Error(`Shield host session refused: ${why}`);
const b64 = (v, cap, what) => {
  if (typeof v !== "string" || !v.length || v.length > 4 * Math.ceil(cap / 3) + 4 || !/^[A-Za-z0-9+/]+=*$/.test(v)) throw refused(`${what} missing or malformed`);
  const b = Buffer.from(v, "base64"); if (!b.length || b.length > cap) throw refused(`${what} missing or oversized`); return b;
};

// the box name the relay routes by: h.name, else the registry endpoint's /t/<name>
export function shieldBoxName(h) {
  const name = h.name || (String(h.endpoint || "").match(/\/t\/([A-Za-z0-9_-]{1,64})\/?$/) || [])[1];
  if (!NAME.test(String(name || ""))) throw new Error(`${h.endpoint}: no Enclave Shield box name`);
  return name;
}

// The relay answered "not now": busy (503: one check in flight, the 20 s gap, a re-attach), rate limited (429), or no box
// attached at this instant (404 no_box: a re-attach drops the old tunnel before the new one binds). None of these started
// a quote, so waiting costs the box nothing.
export const relayBusy = (status, body) => status === 503 || status === 429 || (status === 404 && body?.error === "no_box");
// at least minBackoffMs, at least the relay's retryAfter, plus up to jitterMs
export const backoffMs = ({ retryAfter, minBackoffMs, jitterMs, random = Math.random }) =>
  Math.max(minBackoffMs, Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : 0) + Math.floor(random() * jitterMs);

// createShieldHostChecker(o).session(name) -> { session, atMs, ekCertSha256, verdict }. session is exactly what
// relay/vbs-app-verify.mjs needs as hostSession ({ evidence, nonce, transportKeySpki, expectedCredential, mintedFor });
// verdict is relay/hvnode-verify.mjs's (ok and admissible, else this throws "refused"). ekRoots: a PEM bundle or a function
// returning one (our pinned policy's ekRoots).
export function createShieldHostChecker({ relay, ekRoots, fetchImpl = (...a) => fetch(...a), randomBytes = cryptoRandomBytes, now = Date.now,
                                          sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random, attempts = 4,
                                          minBackoffMs = 20_000, jitterMs = 10_000, minGapMs = 20_000, timeoutMs = 45_000, log = () => {} }) {
  if (!/^https:\/\//.test(String(relay || ""))) throw new Error("Shield host checks need the relay's https base");
  const boxes = new Map();   // name -> { tail: Promise, lastAt }
  const post = async (url, payload, cap) => {
    let r;
    try { r = await fetchImpl(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", accept: "application/json" },
                                    body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw unavailable(`${url}: ${e.name === "TimeoutError" || e.name === "AbortError" ? `no answer within ${timeoutMs} ms` : e.message}`); }
    const text = await r.text();
    if (text.length > cap) throw unavailable(`${url}: the answer exceeds ${cap} bytes`);
    let body = null; try { body = JSON.parse(text); } catch { body = null; }
    return { status: r.status, body };
  };
  const fail = (step, r) => Object.assign(unavailable(`${step}: HTTP ${r.status}${r.body?.message ? ` ${String(r.body.message).slice(0, 200)}` : r.body?.error ? ` ${r.body.error}` : ""}`),
                                          { busy: relayBusy(r.status, r.body), retryAfter: r.body?.retryAfter });
  async function once(name) {
    const base = `${relay.replace(/\/+$/, "")}/v1/enclaves/${name}/attestation`;
    // our pinned roots first: a check we could not verify is never started (each one is a quote on the box)
    const roots = typeof ekRoots === "function" ? await ekRoots() : ekRoots;
    if (!roots) throw new Error("Shield app policy has no ekRoots");
    const nonce = Buffer.from(randomBytes(32)), nonceHex = nonce.toString("hex");
    const one = await post(base, { nonce: nonceHex }, MAX_KEYS_ANSWER);
    if (one.status !== 200 || !one.body) throw fail("TPM keys", one);
    if (one.body.mode !== "hv-node") throw refused(`${name} is not an Enclave Shield host (mode ${JSON.stringify(one.body.mode ?? null)})`);
    if (one.body.nonce !== nonceHex) throw refused("the relay answered for another nonce");
    if (typeof one.body.session !== "string" || !/^[0-9a-f]{48}$/.test(one.body.session)) throw unavailable("the relay's answer carries no usable session");
    const keys = one.body.keys && typeof one.body.keys === "object" ? one.body.keys : {};
    // the keys, checked before anything is minted for them; the AIK name is OURS (0x000B || sha256(aikPub)), not the relay's
    const ekDer = b64(keys.ek, VBS_MAX_CERT_BYTES, "keys.ek");
    const aikPub = b64(keys.aikPub, VBS_MAX_TPMT_PUBLIC_BYTES, "keys.aikPub");
    let aik; try { aik = parseTpmtPublic(aikPub); } catch (e) { throw refused(`the quoting key: ${e.message}`); }
    if (aik.nameAlg !== TPM_ALG_SHA256 || aik.scheme.alg !== TPM_ALG_RSASSA || aik.scheme.hash !== TPM_ALG_SHA256) throw refused("the quoting key is not an RSASSA/SHA-256 key with a SHA-256 name");
    if ((aik.attributes & AIK_REQUIRED_ATTRIBUTES) !== AIK_REQUIRED_ATTRIBUTES || (aik.attributes & TPMA_DECRYPT)) throw refused("the quoting key is not a restricted, TPM-fixed signing key");
    const aikName = tpmNameOf(aikPub);
    if (keys.aikName !== undefined && !Buffer.from(String(keys.aikName), "base64").equals(aikName)) throw refused("the relay's aikName is not 0x000B || sha256(aikPub)");
    let ek; try { ek = ekPublicFrom(ekDer); } catch (e) { throw refused(`the EK certificate: ${e.message}`); }
    const credential = Buffer.from(randomBytes(32)), seed = Buffer.from(randomBytes(32));
    const blob = makeCredential(ek, aikName, credential, { seed });
    const two = await post(`${base}/credential`, { session: one.body.session, credentialBlob: blob.credentialBlob.toString("base64"), secret: blob.secret.toString("base64") }, MAX_DOCUMENT_ANSWER);
    if (two.status !== 200 || !two.body) throw fail("TPM document", two);
    const doc = two.body.document;
    if (!doc || typeof doc !== "object") throw unavailable(`${name} returned no document`);
    if (doc.format !== HVNODE_FORMAT) throw refused(`the document is ${JSON.stringify(doc.format ?? null)}, not ${HVNODE_FORMAT}`);
    let evidence, spki;
    try {
      if (typeof doc.body !== "string" || doc.body.length > MAX_DOCUMENT_ANSWER) throw new Error("document.body missing or oversized");
      evidence = JSON.parse(Buffer.from(doc.body, "base64").toString("utf8"));
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("the evidence is not a JSON object");
      if (typeof doc.transportKey !== "string" || doc.transportKey.length > 128) throw new Error("document.transportKey missing or oversized");
      spki = Buffer.from(doc.transportKey, "base64");
    } catch (e) { throw refused(`the document: ${e.message}`); }
    const atMs = now();
    const session = { evidence, nonce, transportKeySpki: spki, expectedCredential: credential, mintedFor: { ekCert: ekDer, aikName } };
    const verdict = verifyHvNodeEvidence(session, { ekRoots: roots });
    if (!verdict.ok || !verdict.admissible) throw refused((verdict.reasons || []).slice(0, 3).join("; ").slice(0, 400) || "not admissible");
    const ekCertSha256 = sha256(ekDer).toString("hex");
    if (verdict.boot?.ekCertSha256 !== ekCertSha256) throw refused("the verified EK certificate is not the one the credential was minted for");
    return { session, atMs, ekCertSha256, verdict };
  }
  async function guarded(name) {
    const box = boxes.get(name) || { tail: Promise.resolve(), lastAt: 0 };
    boxes.set(name, box);
    const run = box.tail.then(async () => {
      for (let attempt = 1; ; attempt++) {
        const gap = box.lastAt + minGapMs - now();
        if (gap > 0) await sleep(gap + Math.floor(random() * 1000));
        box.lastAt = now();
        try { return await once(name); }
        catch (e) {
          if (!e.busy || attempt >= attempts) throw e;
          const ms = backoffMs({ retryAfter: e.retryAfter, minBackoffMs, jitterMs, random });
          log(`[shield] ${name} busy (${e.message}); retry ${attempt + 1}/${attempts} in ${Math.round(ms / 1000)} s`);
          await sleep(ms);
        }
      }
    });
    box.tail = run.catch(() => {});
    return run;
  }
  return { session: (name) => { if (!NAME.test(String(name || ""))) throw new Error("no Enclave Shield box name"); return guarded(name); } };
}

// The witness's verify hook for a Shield host: q.check is a session from the checker (attest ran it); the identity the
// allowlist pins is the EK certificate's sha256, and it is the hardware id basis (witness: hardwareId = sha256(chipId)).
export function shieldWitnessVerifier(q, { allowedMeasurements }) {
  const c = q && q.check;
  if (!c || !c.verdict?.ok || !c.verdict?.admissible) return { ok: false, reason: "no verified Shield host session" };
  const ek = lc(c.ekCertSha256);
  if (!/^[0-9a-f]{64}$/.test(ek)) return { ok: false, reason: "no EK certificate identity" };
  if (!(allowedMeasurements || []).map(lc).includes(ek)) return { ok: false, reason: `EK certificate ${ek.slice(0, 16)}… is not on the allowlist` };
  return { ok: true, measurement: ek, chipId: ek };
}
export const shieldHardwareId = (ekCertSha256) => "0x" + sha256(Buffer.from(lc(ekCertSha256), "hex")).toString("hex");

// A Shield box's /availability: nodeGflops (measured) and the free CPU share, capped by the per-app maximum share; it states
// no cpuGflopsFree. spare = floor(nodeGflops * min(cpuShareFree, maxShare)).
export function shieldAvailability(a) {
  const g = Number(a?.nodeGflops), free = Number(a?.cpuShareFree), max = Number(a?.maxShare);
  if (!Number.isFinite(g) || !Number.isFinite(free) || !Number.isFinite(max)) throw new Error("Shield /availability lacks nodeGflops, cpuShareFree or maxShare");
  const share = Math.min(Math.max(0, free), Math.max(0, max), 1);
  return { nodeGflops: g, cpuGflopsFree: Math.max(0, Math.floor(g * share)) };
}

// our own pinned copy of the Shield app policy (seeded from windows/installer/admitted-shield-policy.json); read on every use
// so a replaced file takes effect, refused when absent, malformed or (with sha256 set) not the pinned bytes
export function shieldPolicyLoader({ file, sha256: pin = null, readFile = (f) => fs.readFileSync(f) }) {
  return () => {
    let bytes; try { bytes = readFile(file); } catch { throw new Error(`Shield app policy file missing: ${file}`); }
    if (pin && sha256(bytes).toString("hex") !== lc(pin)) throw new Error("Shield app policy file is not the pinned sha256");
    let p; try { p = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new Error("Shield app policy file is not JSON"); }
    if (p.schema !== "enclave-shield-app-policy/1" || !p.ekRoots || !/^[0-9a-f]{64}$/.test(p.cpu?.runtimeId || "")) throw new Error("Shield app policy file is not an enclave-shield-app-policy/1 with ekRoots and a CPU runtime");
    return p;
  };
}

// readRow(id) -> the ledger's record ({ id, active, isPublic, runner, appRef, configCid, cpuMilli, gpuMilli }), read by us.
// hostSession(job) -> { session, atMs, ekCertSha256 } (the checker), run LAST: verified-http wants it within 30 s of the
// capture. Derivations are cached per job (forget(id) drops one).
export function createShieldExpectations({ readRow, readCatalog, readConfig, fetchVerified, policy, hostSession, appRef, secretsRequired = true,
                                           expect = expectedShieldApp }) {
  const cache = new Map();
  const no = (why) => new Error(`Shield expectation unavailable: ${why}`);
  const load = async (job) => {
    const id = lc(job.deployment.id), hostId = lc(job.offer.hostId);
    const pol = typeof policy === "function" ? policy() : policy;
    let d = cache.get(id);
    if (!d) {
      let row; try { row = await readRow(id); } catch (e) { throw no(`the ledger record: ${e.shortMessage || e.message}`); }
      if (!row || lc(row.id) !== id) throw no("the ledger holds no such deployment");
      if (row.active !== true || row.isPublic !== true) throw no("the deployment is not active and public");
      if (lc(row.runner) !== hostId) throw no("the deployment is not leased to the offered host");
      if (row.appRef !== appRef) throw no("the deployment is not the reviewed audit app");
      try { d = await expect({ ...row, id }, { policy: pol, readCatalog, readConfig, fetchVerified, secretsRequired }); }
      catch (e) { throw no(e.message); }
      if (d.runtimeId !== pol.cpu.runtimeId || !/^[0-9a-f]{64}$/.test(d.appSha256 || "")) throw no("no admitted CPU runtime for the app");
      cache.set(id, d);
    }
    const hs = await hostSession(job);
    if (job.offer.hardwareId && lc(job.offer.hardwareId) !== shieldHardwareId(hs.ekCertSha256)) throw refused("the TPM is not the hardware the job was offered for");
    return { kind: "shield", deploymentId: job.deployment.id, hostId: job.offer.hostId, appId: d.appSha256, runtimeId: pol.cpu.runtimeId,
             origin: `https://${id.slice(2, 10)}.app.enclave.host/`, hostSession: hs.session, hostSessionAtMs: hs.atMs, policy: pol,
             requiresConfigBundleV5: !!d.requiresConfigBundleV5, requiresSecretsV1: !!d.requiresSecretsV1, requiresConfigSocketServer: !!d.requiresConfigSocketServer };
  };
  load.forget = (id) => cache.delete(lc(id));
  return load;
}

// fetchVerified(cid, maxBytes) for raw-codec CIDs only (bafkrei…): the bytes are accepted when sha256 equals the CID's digest,
// so the gateways are not trusted. Any other CID is refused (fail closed).
export function rawCidFetcher({ gateways, fetchImpl = (...a) => fetch(...a), timeoutMs = 60_000 }) {
  const list = (Array.isArray(gateways) ? gateways : [gateways]).filter((g) => /^https:\/\//.test(String(g || "")));
  return async (cid, maxBytes = 1 << 20) => {
    const digest = rawCidDigest(cid);
    if (!digest) return { ok: false, reason: `${cid} is not a raw sha2-256 CID` };
    let reason = "no https gateway configured";
    for (const g of list) {
      try {
        const r = await fetchImpl(`${g.replace(/\/+$/, "")}/ipfs/${cid}`, { headers: { accept: "application/vnd.ipld.raw" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
        if (r.status !== 200) { reason = `${g}: HTTP ${r.status}`; continue; }
        const chunks = []; let size = 0;
        for await (const c of r.body) { size += c.length; if (size > maxBytes) throw new Error("larger than allowed"); chunks.push(Buffer.from(c)); }
        const bytes = Buffer.concat(chunks);
        if (sha256(bytes).toString("hex") !== digest) { reason = `${g}: bytes do not match the CID`; continue; }
        return { ok: true, bytes };
      } catch (e) { reason = `${g}: ${e.message}`; }
    }
    return { ok: false, reason };
  };
}
