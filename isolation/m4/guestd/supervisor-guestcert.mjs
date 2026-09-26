// supervisor-guestcert.mjs - a WebPKI certificate for a per-app guest's OWN key (finding F2), so a browser can use a
// tier app without a warning while its TLS still ends in its guest and its private key never leaves it.
//
// The supervisor is the only party that may ask the platform certificate service for a deployment's name (it holds
// the lease and the operator key the service checks), and the guest is the only party that holds the key. So the
// supervisor relays: it obtains the GUEST's CSR, has it issued, and installs the certificate in the guest. It sees a
// CSR and a certificate, both public; nothing here could create, read or replace the key.
//
// What is checked before anything is issued (each check is on bytes this process observed itself):
//   1. the route: guestd, over the authenticated channel, names the instance, its verified transport key, its
//      measurement, and that it is the app this supervisor launched (supervisor-splice.mjs routeFor);
//   2. every TLS session to the guest (through guestd's data plane, like any client's) presents exactly that key;
//   3. the guest's attestation, fetched over such a session with a fresh nonce, is judged by the same judge a client
//      uses (isolation/m2/judge.mjs): AMD chain, report binding of THIS handshake's key and nonce, the AppID, and
//      HOST_DATA = this deployment, and - when the node image carries one (ISOLATION_MIN_TCB, a file measured into the
//      node's own image) - a firmware TCB floor, below which nothing is issued;
//   4. for an SEV-SNP guest, the relay's PREDICTION (holdToPrediction): guestd's AppID and the measurement the guest is
//      judged against were the host's word, so a host running a modified image with the right HOST_DATA could have had
//      it certified for the deployment's name. They must now be what the relay predicts for this deployment from the
//      chain and its installed domain releases (GET /v1/expected-guest, the predictor the attested release admits
//      against: no list of its own here), and the runtime the report binds must be the predicted image's;
//   5. the CSR's public key is exactly that key, and the issued leaf is for that key and the deployment's name.
// Any failure issues nothing and installs nothing. Whether a guest must meet the prediction is the BOX's decision
// (requirePrediction: the node's measured backend), never the route's shape: guestd states the tier, so on an SEV-SNP
// box a route that claims to be a T0-hv partition (no measurement) is refused, not waved through (enclave-5d). A NucBox
// box (tier T0-hv) has no measurement and no relay prediction; its routes are judged as before.
//
// A certificate says only "this key answers for this name", which a browser trusts on the platform's word. What a
// VERIFYING client relies on is unchanged: the attestation over the same key.
import tls from "node:tls";
import http from "node:http";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { routeFor, openSplice } from "./supervisor-splice.mjs";
import { ABI2, runtimeId } from "../../contract/runtime.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");

// ---- the public key out of a PKCS#10 request (DER walk; Node has no CSR parser) ----------------------------------
function tlv(buf, o) {
  const tag = buf[o];
  let len = buf[o + 1], hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 3) throw new Error("unsupported DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[o + 2 + i];
    hdr = 2 + n;
  }
  if (o + hdr + len > buf.length) throw new Error("DER overruns its buffer");
  return { tag, start: o, body: o + hdr, end: o + hdr + len };
}
// CertificationRequest ::= SEQ { CertificationRequestInfo ::= SEQ { version INTEGER, subject Name, subjectPKInfo SPKI,
// attributes [0] }, signatureAlgorithm, signature }
export function csrSpki(pem) {
  const m = /-----BEGIN CERTIFICATE REQUEST-----([\s\S]+?)-----END CERTIFICATE REQUEST-----/.exec(String(pem || ""));
  if (!m) throw new Error("not a PEM certificate request");
  const der = Buffer.from(m[1].replace(/\s+/g, ""), "base64");
  const outer = tlv(der, 0);
  if (outer.tag !== 0x30) throw new Error("the request is not a SEQUENCE");
  const info = tlv(der, outer.body);
  if (info.tag !== 0x30) throw new Error("the request info is not a SEQUENCE");
  const version = tlv(der, info.body);
  const subject = tlv(der, version.end);
  const spki = tlv(der, subject.end);
  if (version.tag !== 0x02 || subject.tag !== 0x30 || spki.tag !== 0x30) throw new Error("unexpected request structure");
  return der.subarray(spki.start, spki.end);
}

// One TLS session to the guest through guestd's data plane, and one HTTP exchange on it. The handshake key must be
// the route's verified key, or the exchange never starts.
function exchange(dataAddr, route, servername, method, path, body, timeoutMs) {
  return openSplice(dataAddr, route, { timeoutMs }).then((sock) => new Promise((resolve, reject) => {
    const s = tls.connect({ socket: sock, servername, rejectUnauthorized: false });
    const t = setTimeout(() => { s.destroy(); reject(new Error(`the guest did not answer ${path} within ${timeoutMs} ms`)); }, timeoutMs);
    const done = (err, v) => { clearTimeout(t); s.destroy(); err ? reject(err) : resolve(v); };
    s.once("error", (e) => done(e));
    s.once("secureConnect", () => {
      const spki = s.getPeerX509Certificate()?.publicKey.export({ type: "spki", format: "der" });
      if (!spki || sha(spki) !== route.key) return done(new Error("the guest's handshake key is not the key guestd verified"));
      const req = http.request({ createConnection: () => s, method, path, headers: {
        host: servername, ...(body ? { "content-type": "application/x-pem-file", "content-length": Buffer.byteLength(body) } : {}) } },
      (res) => {
        const chunks = []; let n = 0;
        res.on("data", (c) => { n += c.length; if (n > 256 << 10) { res.destroy(); return done(new Error("answer too large")); } chunks.push(c); });
        res.on("end", () => done(null, { status: res.statusCode, body: Buffer.concat(chunks), spki }));
        res.on("error", (e) => done(e));
      });
      req.on("error", (e) => done(e));
      req.end(body);
    });
  }));
}

const renewAtOf = (leaf) => {
  const nb = new Date(leaf.validFrom).getTime(), na = new Date(leaf.validTo).getTime();
  return { notAfter: na, renewAt: nb + Math.round((na - nb) * 2 / 3) };
};

// What the guest ALREADY serves for the name, if it needs no new certificate: a chain that verifies against this
// process's WebPKI roots (Node's store, plus NODE_EXTRA_CA_CERTS), for the name, on exactly the route's verified key,
// and not yet at its renewal point. Found on a handshake the guest completed, so the guest proved it holds that key;
// the host in between cannot present a CA leaf for a key it does not hold. Anything else (none installed, a
// self-signed carrier, another key, due for renewal) is null, and the relay issues as before. A node restart used to
// ask the CA for a new certificate for every guest, each time.
export function servedReusable(dataAddr, route, name, { timeoutMs = 20_000, now = Date.now() } = {}) {
  return openSplice(dataAddr, route, { timeoutMs }).then((sock) => new Promise((resolve) => {
    const s = tls.connect({ socket: sock, servername: name, rejectUnauthorized: false });
    const t = setTimeout(() => { s.destroy(); resolve(null); }, timeoutMs);
    const done = (v) => { clearTimeout(t); s.destroy(); resolve(v); };
    s.once("error", () => done(null));
    s.once("secureConnect", () => {
      const leaf = s.getPeerX509Certificate();
      if (!s.authorized || !leaf) return done(null);
      if (sha(leaf.publicKey.export({ type: "spki", format: "der" })) !== route.key || !leaf.checkHost(name)) return done(null);
      const { notAfter, renewAt } = renewAtOf(leaf);
      if (!(now < renewAt)) return done(null);
      done({ serial: leaf.serialNumber, issuer: leaf.issuer.replace(/\n/g, ", "), notAfter, renewAt });
    });
  }), () => null);
}

// ---- the independent expectation: the relay's prediction (GUEST-POOL-ROLLOUT section 9, row 6) ---------------------
const HEXL = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const short = (h) => `${String(h || "").slice(0, 16)}…`;

// holdToPrediction: guestd's AppID must be the relay's predicted AppID, and the measurement the guest will be judged
// against must be one predicted image's. Returns { ok, image } or { ok: false, why }.
export function holdToPrediction(exp, { deploymentId, appId, measurement }) {
  if (!exp || typeof exp !== "object") return { ok: false, why: "the relay gave no expected guest" };
  if (String(exp.id || "").toLowerCase() !== String(deploymentId || "").toLowerCase())
    return { ok: false, why: "the relay's expected guest names another deployment" };
  if (!HEXL(64).test(String(exp.appId || ""))) return { ok: false, why: "the relay's predicted AppID is malformed" };
  if (exp.appId !== String(appId || "").toLowerCase())
    return { ok: false, why: `guestd's AppID ${short(appId)} is not the relay's predicted ${short(exp.appId)}` };
  const images = (Array.isArray(exp.images) ? exp.images : [])
    .filter((m) => m && HEXL(96).test(String(m.measurement || "")) && HEXL(64).test(String(m.runtimeId || "")));
  if (!images.length) return { ok: false, why: "the relay predicted no image for this deployment" };
  const image = images.find((m) => m.measurement === String(measurement || "").toLowerCase());
  if (!image) return { ok: false, why: `the guest's measurement ${short(measurement)} is no predicted image's` };
  return { ok: true, image };
}

// runtimePairs: after the judge, the runtime the report binds (ABI/2 binds its id into report_data) must be the runtime
// of the predicted image the measurement matched - the (measurement, runtime) pair, as the attested release admits it.
export function runtimePairs(doc, image) {
  if (!doc || doc.abi !== ABI2 || !doc.runtime) return { ok: false, why: "the guest's report binds no runtime (not enclave-domain-abi/2)" };
  let rid;
  try { rid = runtimeId(doc.runtime).toString("hex"); } catch (e) { return { ok: false, why: e.message }; }
  if (rid !== image.runtimeId) return { ok: false, why: `the report binds runtime ${short(rid)}, not the predicted image's ${short(image.runtimeId)}` };
  return { ok: true };
}

// expectedGuestFetcher: the relay's answer for one deployment, over WebPKI TLS (the global fetch: Node's CA store plus
// the node image's own bundle, certificate checks on, no redirect followed) to an https origin fixed in the measured
// image (supervisor.js passes SECRETS_API, whose default the host does not override). Anything but a well-formed 200
// throws, with a bounded retry hint, so the caller issues nothing and backs off. Kept per deployment for cacheMs: a
// prediction changes only with the catalog version or the relay's installed releases.
export function expectedGuestFetcher({ base, fetchImpl = globalThis.fetch, timeoutMs = 10_000, cacheMs = 10 * 60_000,
                                       now = Date.now } = {}) {
  const origin = String(base || "").replace(/\/+$/, "");
  const cache = new Map();
  return async (deploymentId) => {
    if (!/^https:\/\/[^/]+$/.test(origin)) throw new Error("no https relay origin for the expected guest; nothing issued");
    const id = String(deploymentId || "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(id)) throw new Error("not a deployment id");
    const hit = cache.get(id);
    if (hit && now() - hit.at < cacheMs) return hit.value;
    const r = await fetchImpl(`${origin}/v1/expected-guest?id=${id}`, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    let b = null;
    try { b = await r.json(); } catch { b = null; }
    if (r.status !== 200 || !b || typeof b !== "object") {
      const e = new Error(`the relay's expected guest answered HTTP ${r.status}${b && typeof b.error === "string" ? " " + b.error.slice(0, 40) : ""}; nothing issued`);
      const after = Number(b && b.retryAfterSec);
      if (after > 0) e.retryMs = Math.min(3600_000, Math.max(60_000, after * 1000));   // never faster than the loop
      throw e;
    }
    cache.set(id, { at: now(), value: b });
    while (cache.size > 256) cache.delete(cache.keys().next().value);
    return b;
  };
}

// ensureGuestCert runs the whole relay once. Returns what was installed (or, with reuse, what the guest already
// serves: reused true, nothing issued), or throws with why nothing was.
//   judge(doc, spki, nonce, want)  isolation/m2/judge.mjs's judge; judgeOk: the verdicts that allow issuance
//   issue(name, csrPem, spkiHash)  the platform certificate service; resolves to the PEM chain
//   expected(deploymentId)         the relay's expected guest (expectedGuestFetcher)
//   requirePrediction              this box is an SEV-SNP box (its measured backend): EVERY route must state a measurement
//                                  and meet the prediction. Default true; only a NucBox (T0-hv) box passes false.
export async function ensureGuestCert({ transport, dataAddr, instanceId, expectAppId, deploymentId, name, judge,
                                        judgeOk = ["attested", "no-tcb-policy"], judgeMode = "trusted", issue, expected,
                                        requirePrediction = true,
                                        minTcb, reuse = true, timeoutMs = 20_000,
                                        _deps: { routeFor: rf = routeFor, servedReusable: sr = servedReusable, exchange: ex = exchange } = {} }) {
  const route = await rf(transport, instanceId, expectAppId, { timeoutMs });
  if (reuse) {
    const have = await sr(dataAddr, route, name, { timeoutMs });
    if (have) return { instanceId: route.id, key: route.key, name, ...have, reused: true, verdict: "not judged: nothing issued" };
  }
  // 4 (before any exchange that could lead to issuing). On an SEV-SNP box every route must carry a measurement: guestd
  // chooses the route's shape, so a missing one is the host's claim, not a partition.
  let image = null;
  if (requirePrediction && route.measurement === undefined)
    throw new Error("this SEV-SNP box's route for the guest states no measurement; nothing issued");
  if (route.measurement !== undefined) {
    if (typeof expected !== "function") throw new Error("no source for the relay's expected guest; nothing issued");
    const held = holdToPrediction(await expected(deploymentId), { deploymentId, appId: expectAppId, measurement: route.measurement });
    if (!held.ok) throw new Error(`${held.why}; nothing issued`);
    image = held.image;
  }
  // 3. the guest's attestation, over a session with the verified key
  const nonce = randomBytes(32);
  const a = await ex(dataAddr, route, name, "GET", `/.well-known/enclave-attestation?nonce=${nonce.toString("hex")}`, null, timeoutMs);
  if (a.status !== 200) throw new Error(`the guest's attestation answered HTTP ${a.status}`);
  let doc;
  try { doc = JSON.parse(a.body.toString()); } catch { throw new Error("the guest's attestation is not JSON"); }
  // the release is the prediction's for the measurement it matched (the relay's word, over WebPKI), never the guest's:
  // it decides whether a pre-chain guest's LEGACY runtime self-test is accepted (judge.mjs LEGACY_WX_RELEASES)
  const v = await judge(doc, a.spki, nonce, { measurement: image ? image.measurement : route.measurement, appSha: expectAppId,
    mode: judgeMode, hostData: deploymentId, ...(minTcb !== undefined ? { minTcb } : {}),
    ...(image && image.release !== undefined ? { release: image.release } : {}) });
  if (!judgeOk.includes(v.verdict))
    throw new Error(`the guest did not verify (${v.verdict}: ${String(v.reasons?.at(-1) || "").slice(0, 160)}); nothing issued`);
  if (image) {
    const paired = runtimePairs(doc, image);
    if (!paired.ok) throw new Error(`${paired.why}; nothing issued`);
  }
  // 4. its CSR, for exactly its key
  const c = await ex(dataAddr, route, name, "GET", "/.well-known/enclave-csr", null, timeoutMs);
  if (c.status !== 200) throw new Error(`the guest produced no CSR (HTTP ${c.status}: ${c.body.toString().slice(0, 120)})`);
  const csrPem = c.body.toString();
  if (sha(csrSpki(csrPem)) !== route.key) throw new Error("the CSR is not for the guest's verified key; nothing issued");
  const chain = String(await issue(name, csrPem, route.key));
  const leaf = new X509Certificate(chain);
  if (sha(leaf.publicKey.export({ type: "spki", format: "der" })) !== route.key)
    throw new Error("the issued certificate is not for the guest's key; not installed");
  if (!leaf.checkHost(name)) throw new Error(`the issued certificate is not for ${name}; not installed`);
  const i = await ex(dataAddr, route, name, "POST", "/.well-known/enclave-cert", chain, timeoutMs);
  if (i.status !== 200) throw new Error(`the guest refused the certificate (HTTP ${i.status}: ${i.body.toString().slice(0, 160)})`);
  return { instanceId: route.id, key: route.key, name, serial: leaf.serialNumber, issuer: leaf.issuer.replace(/\n/g, ", "),
           ...renewAtOf(leaf), verdict: v.verdict, ...(image ? { release: image.release ?? null } : {}),
           ...(v.wxCoverage !== undefined ? { wxCoverage: v.wxCoverage } : {}) };
}
