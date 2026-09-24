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
//      node's own image) - a firmware TCB floor, below which nothing is issued. The measurement it is held to is
//      guestd's (host) word - the supervisor has no independent expected measurement - and this file says so rather
//      than implying more;
//   4. the CSR's public key is exactly that key, and the issued leaf is for that key and the deployment's name.
// Any failure issues nothing and installs nothing.
//
// A certificate says only "this key answers for this name", which a browser trusts on the platform's word. What a
// VERIFYING client relies on is unchanged: the attestation over the same key.
import tls from "node:tls";
import http from "node:http";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { routeFor, openSplice } from "./supervisor-splice.mjs";

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

// ensureGuestCert runs the whole relay once. Returns what was installed, or throws with why nothing was.
//   judge(doc, spki, nonce, want)  isolation/m2/judge.mjs's judge; judgeOk: the verdicts that allow issuance
//   issue(name, csrPem, spkiHash)  the platform certificate service; resolves to the PEM chain
export async function ensureGuestCert({ transport, dataAddr, instanceId, expectAppId, deploymentId, name, judge,
                                        judgeOk = ["attested", "no-tcb-policy"], judgeMode = "trusted", issue,
                                        minTcb, timeoutMs = 20_000 }) {
  const route = await routeFor(transport, instanceId, expectAppId, { timeoutMs });
  // 3. the guest's attestation, over a session with the verified key
  const nonce = randomBytes(32);
  const a = await exchange(dataAddr, route, name, "GET", `/.well-known/enclave-attestation?nonce=${nonce.toString("hex")}`, null, timeoutMs);
  if (a.status !== 200) throw new Error(`the guest's attestation answered HTTP ${a.status}`);
  let doc;
  try { doc = JSON.parse(a.body.toString()); } catch { throw new Error("the guest's attestation is not JSON"); }
  const v = await judge(doc, a.spki, nonce, { measurement: route.measurement, appSha: expectAppId, mode: judgeMode,
    hostData: deploymentId, ...(minTcb !== undefined ? { minTcb } : {}) });
  if (!judgeOk.includes(v.verdict))
    throw new Error(`the guest did not verify (${v.verdict}: ${String(v.reasons?.at(-1) || "").slice(0, 160)}); nothing issued`);
  // 4. its CSR, for exactly its key
  const c = await exchange(dataAddr, route, name, "GET", "/.well-known/enclave-csr", null, timeoutMs);
  if (c.status !== 200) throw new Error(`the guest produced no CSR (HTTP ${c.status}: ${c.body.toString().slice(0, 120)})`);
  const csrPem = c.body.toString();
  if (sha(csrSpki(csrPem)) !== route.key) throw new Error("the CSR is not for the guest's verified key; nothing issued");
  const chain = String(await issue(name, csrPem, route.key));
  const leaf = new X509Certificate(chain);
  if (sha(leaf.publicKey.export({ type: "spki", format: "der" })) !== route.key)
    throw new Error("the issued certificate is not for the guest's key; not installed");
  if (!leaf.checkHost(name)) throw new Error(`the issued certificate is not for ${name}; not installed`);
  const i = await exchange(dataAddr, route, name, "POST", "/.well-known/enclave-cert", chain, timeoutMs);
  if (i.status !== 200) throw new Error(`the guest refused the certificate (HTTP ${i.status}: ${i.body.toString().slice(0, 160)})`);
  const nb = new Date(leaf.validFrom).getTime(), na = new Date(leaf.validTo).getTime();
  return { instanceId: route.id, key: route.key, name, serial: leaf.serialNumber, issuer: leaf.issuer.replace(/\n/g, ", "),
           notAfter: na, renewAt: nb + Math.round((na - nb) * 2 / 3), verdict: v.verdict };
}
