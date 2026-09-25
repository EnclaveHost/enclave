// attach-cosigner.mjs -- the owner-side ATTACH CO-SIGNER for a pVM runner's tunnel name (RUNNER-AGENT.md "Attach"; reviewed
// design with the verifier session). Once the runner's https://<relay>/t/<name> is registered on chain, the relay's tunnel hub
// takes an attach under <name> only with the registry OPERATOR's personal_sign over "enclave-tunnel-attach:<name>:<nonce b64>"
// (relay/tunnel.js: a quote proves the image, not the box, so a same-build box must not take a seller's name while it is
// down). The operator key never goes to the phone, so this owner-side function signs for it -- and only for the owner's OWN
// VM INSTANCE, never on build eligibility alone:
//   1. the request names THIS co-signer's name (a phone-supplied name is never signed) and its configured relay (a SANITY check
//      only: the requester asserts it and the attach message names no relay; what binds a co-signature to one relay connection
//      is the nonce -- 32 random bytes issued per connection, single-use at the relay that issued it);
//   2. the relay's nonce: exactly 32 bytes, canonical base64, never signed twice (the journal, across restarts; reserved before
//      the signing await, so not under concurrency either);
//   3. the rad is verified with the hub's own code: android-avf-pvm/v2, verifyAvfEvidence over the pad-bind transcript
//      B = "enclave-avf-pad-bind-v1\n" || transport SPKI || pad key || nonce, under the owner's pinned build(s), authority and
//      Google's roots;
//   4. the INSTANCE (after the build pin in 3, which is what separates the pinned build from any other build the same authority
//      signs on the owner's device: the instance secret is stable across same-key APK updates): the payload signs B with its instance key under "enclave-pvm-attach-instance-v1\n" (it signs only its own
//      transcript); sha256(instance SPKI) must be one of the owner's instanceIds -- which come out of band from the owner's
//      own device, never through the relay -- and the signature must verify over this same B, so the instance is paired
//      with this boot's transport key and this nonce (an impostor cannot pair the owner's instance with its own rad);
//   5. only then: personal_sign of exactly "enclave-tunnel-attach:<own name>:<canonical nonce b64>", journaled (fsync) with
//      the name, sha256 of the nonce, sha256 of the transport SPKI, the InstanceID and the time; rate-limited.
// The rate window counts refused requests too, so a local caller can spend the budget: acceptable because the wrapper is
// loopback only, and the budget is all it can spend.
// It is a single-function module: never a general signing endpoint for the chain operator key. serveAttachCosigner() is its
// HTTP wrapper, loopback only.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { verifyAvfEvidence } from "../../../../relay/avf-verify.mjs";
import { AVF_PAD_FORMAT, avfPadBinding } from "../../../../relay/avf-binding.mjs";

export const ATTACH_INSTANCE_DOMAIN = "enclave-pvm-attach-instance-v1\n";
export const attachMessage = (name, nonce) => `enclave-tunnel-attach:${name}:${nonce.toString("base64")}`;   // relay/tunnel.js's own
const NAME = /^[A-Za-z0-9_-]{1,64}$/, HEX64 = /^[0-9a-f]{64}$/, HEX128 = /^[0-9a-f]{128}$/;
const ED25519_SPKI_PREFIX = "302a300506032b6570032100";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const REQ_KEYS = ["instanceKey", "instanceSig", "name", "nonce", "rad", "relay"];

export function createAttachCosigner({ account, name, relay, codeHashes, authorityHashes, rootPins, instanceIds, journalFile,
                                        rate = { max: 6, ms: 60000 }, now = Date.now }) {
  const bad = (m) => { throw new Error(`attach-cosigner: ${m}`); };
  if (!account || typeof account.signMessage !== "function") bad("an operator account that can personal_sign is required");
  if (!NAME.test(name || "")) bad("name must be a tunnel name ([A-Za-z0-9_-]{1,64})");
  if (!/^https?:\/\/[^\s/]+$/.test(relay || "")) bad("relay must be the relay's origin (scheme://host[:port])");
  for (const [k, v] of Object.entries({ codeHashes, instanceIds })) if (!Array.isArray(v) || !v.length || !v.every((h) => HEX64.test(h))) bad(`${k} must be a non-empty list of 64 lowercase hex`);
  if (!Array.isArray(authorityHashes) || !authorityHashes.length || !authorityHashes.every((h) => HEX128.test(h))) bad("authorityHashes must be a non-empty list of 128 lowercase hex");
  if (!journalFile) bad("a journal file is required (every signature is recorded, and no nonce is ever signed twice)");
  fs.mkdirSync(path.dirname(journalFile), { recursive: true, mode: 0o700 });
  const signed = new Set(fs.existsSync(journalFile) ? fs.readFileSync(journalFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).nonceSha256) : []);
  const fd = fs.openSync(journalFile, "a", 0o600);
  let window = { start: 0, n: 0 };

  async function sign(req) {
    const no = (reason) => ({ ok: false, reason });
    const t = now();
    if (t - window.start >= rate.ms) window = { start: t, n: 0 };
    if (++window.n > rate.max) return no(`rate: at most ${rate.max} attach signatures per ${rate.ms / 1000} s`);
    if (!req || typeof req !== "object" || Array.isArray(req) || Object.keys(req).sort().join() !== REQ_KEYS.join()) return no(`the request must be exactly { ${REQ_KEYS.join(", ")} }`);
    if (req.relay !== relay) return no(`this co-signer signs for ${relay} only`);
    if (req.name !== name) return no(`this co-signer signs for its own name ${name} only, never a requested one`);
    let nonce;
    try { nonce = Buffer.from(String(req.nonce), "base64"); } catch { return no("the nonce is not base64"); }
    if (nonce.length !== 32 || nonce.toString("base64") !== req.nonce) return no("the nonce must be exactly 32 bytes in canonical base64");
    const nonceSha256 = sha(nonce);
    if (signed.has(nonceSha256)) return no("this nonce was already signed once: never twice");
    const rad = req.rad;
    if (!rad || typeof rad !== "object" || rad.format !== AVF_PAD_FORMAT) return no(`the rad must be ${AVF_PAD_FORMAT} (the pad-bind transcript)`);
    let spki, B;
    try { spki = Buffer.from(String(rad.transportKey), "base64"); B = avfPadBinding(spki, rad.padKey, nonce); } catch (e) { return no(`the rad's transcript: ${e.message}`); }
    let ev; try { ev = JSON.parse(Buffer.from(String(rad.body), "base64").toString("utf8")); } catch { return no("the rad's body is not JSON"); }
    if (!ev || !Array.isArray(ev.chain) || !ev.signature) return no("the rad's body needs chain[] and the attested key's signature over the transcript");
    const v = verifyAvfEvidence({ chain: ev.chain.map((c) => Buffer.from(c, "base64")), challenge: createHash("sha256").update(B).digest(),
                                  signature: Buffer.from(ev.signature, "base64"), signedMessage: B },
                                { allowedCodeHashes: codeHashes, allowedAuthorityHashes: authorityHashes, ...(rootPins ? { rootPins } : {}) });
    if (!v.ok) return no(`the rad: ${v.reasons.at(-1)}`);
    if (typeof req.instanceKey !== "string" || !new RegExp(`^${ED25519_SPKI_PREFIX}[0-9a-f]{64}$`).test(req.instanceKey)) return no("the instance key must be an Ed25519 SPKI in lowercase hex");
    const instanceId = sha(Buffer.from(req.instanceKey, "hex"));
    if (!instanceIds.includes(instanceId)) return no(`instance ${instanceId.slice(0, 16)}… is not one of the owner's`);
    if (!HEX128.test(req.instanceSig || "")) return no("the instance signature must be 128 lowercase hex");
    let iok = false;
    try { iok = cryptoVerify(null, Buffer.concat([Buffer.from(ATTACH_INSTANCE_DOMAIN), B]), createPublicKey({ key: Buffer.from(req.instanceKey, "hex"), format: "der", type: "spki" }), Buffer.from(req.instanceSig, "hex")); } catch { iok = false; }
    if (!iok) return no("the instance signature does not verify over THIS transcript (this boot's transport key and this nonce)");
    const message = attachMessage(name, nonce);
    // RESERVE the nonce before the first await: every check above is synchronous, so two concurrent requests for one nonce
    // cannot both get here (enclave-99's review of e47314d9). A signing failure keeps it reserved: fail closed -- that
    // nonce's connection is dead anyway.
    signed.add(nonceSha256);
    const operatorSig = await account.signMessage({ message });
    fs.writeSync(fd, JSON.stringify({ at: new Date(t).toISOString(), name, relay, nonceSha256, spkiSha256: sha(spki), instanceId, build: v.measurement }) + "\n"); fs.fsyncSync(fd);
    return { ok: true, operatorSig, message };
  }
  return { sign, close: () => { try { fs.closeSync(fd); } catch {} } };
}

/** The HTTP wrapper: POST /attach-sign with the JSON request -> 200 { operatorSig } or 403 { error }. Loopback only. */
export async function serveAttachCosigner(cosigner, { host = "127.0.0.1", port = 0, maxBody = 256 << 10 } = {}) {
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("attach-cosigner: listen on loopback only");
  const srv = http.createServer((req, res) => {
    const send = (s, o) => { res.writeHead(s, { "content-type": "application/json", "cache-control": "no-store", connection: "close" }); res.end(JSON.stringify(o)); };
    if (req.method !== "POST" || req.url !== "/attach-sign") return send(404, { error: "not found" });
    const parts = []; let n = 0, over = false;
    req.on("data", (d) => { n += d.length; if (n > maxBody) over = true; else parts.push(d); });
    req.on("end", async () => {
      if (over) return send(413, { error: "too large" });
      let body; try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { return send(400, { error: "not JSON" }); }
      try { const r = await cosigner.sign(body); return r.ok ? send(200, { operatorSig: r.operatorSig }) : send(403, { error: r.reason }); }
      catch (e) { return send(500, { error: e.message }); }
    });
  });
  return await new Promise((resolve) => srv.listen(port, host, () => resolve({ port: srv.address().port, close: () => srv.close() })));
}
