// hvlab-check.mjs - functional checks of the in-partition guest runtime, from OUTSIDE the guest, over the same
// channel a NucBox client has: host TCP -> the partition's domain port -> TLS that ends in the domain's front.
//
// Every verdict is judged by windows/vbslike/verify/judge-hv.mjs (the Windows owner's judge), against the client's
// OWN handshake key and nonce. On this path the best verdict is "monitor-signed" (T0-hv: a launcher in the root
// partition signs; the host is NOT excluded). Nothing here says "attested".
//
//   usage: node hvlab-check.mjs <launcher pubkey b64> <A port> <A appId> <B port> <B appId>
//          A = a wasi:http app (enclave-catalog-bundle/1), B = hookbin, a wasi:cli command (/2)
// prints one line per check (PASS/FAIL) and exits non-zero if any failed.
import tls from "node:tls";
import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The judge is the Windows owner's (windows/vbslike/verify/judge-hv.mjs), loaded by path so this runs against the
// version they ship: HVLAB_JUDGE=<path>. HVLAB_RUNTIME=<runtime.json> pins the runtime identity (ABI/2): a document
// stating another identity, or ABI/1, is then refused rather than downgraded.
const { judge: judgeHv } = await import(pathToFileURL(process.env.HVLAB_JUDGE ||
  new URL("../../windows/vbslike/verify/judge-hv.mjs", import.meta.url).pathname).href);
const expectRuntime = process.env.HVLAB_RUNTIME ? JSON.parse(readFileSync(process.env.HVLAB_RUNTIME, "utf8")) : undefined;
const judge = (a) => judgeHv({ ...a, ...(expectRuntime ? { expectRuntime } : {}) });

const [launcherKey, portA, appA, portB, appB] = process.argv.slice(2);
if (!appB) { console.error("usage: node hvlab-check.mjs <launcher key> <A port> <A appId> <B port> <B appId>"); process.exit(2); }
let failed = 0;
const record = (name, ok, detail) => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); };

// One TLS session; every request on it is answered by the key this handshake saw.
function session(port) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: "127.0.0.1", port: Number(port), servername: "hvlab.test", rejectUnauthorized: false });
    s.once("error", reject);
    s.once("secureConnect", () => {
      const spki = s.getPeerX509Certificate().publicKey.export({ type: "spki", format: "der" });
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      agent.createConnection = () => s;
      const req = (method, path, body, headers = {}) => new Promise((res, rej) => {
        const r = http.request({ agent, method, path, headers: { host: "hvlab.test", ...headers,
          ...(body ? { "content-length": Buffer.byteLength(body) } : {}) } }, (a) => {
          const c = []; a.on("data", (x) => c.push(x)); a.on("end", () => res({ status: a.statusCode, body: Buffer.concat(c).toString() }));
        });
        r.on("error", rej); r.end(body);
      });
      resolve({ spki, req, close: () => s.destroy() });
    });
  });
}

async function attest(sess, expectApp) {
  const nonce = randomBytes(32);
  const r = await sess.req("GET", `/.well-known/enclave-attestation?nonce=${nonce.toString("hex")}`);
  const doc = JSON.parse(r.body);
  return { doc, v: judge({ doc, spki: sess.spki, nonce, expectedAppSha256: expectApp, launcherKey }) };
}

const sha = (b) => createHash("sha256").update(b).digest("hex");
for (const [label, port, app] of [["A (wasi:http, /1)", portA, appA], ["B (wasi:cli socket server, /2)", portB, appB]]) {
  const s = await session(port);
  const { doc, v } = await attest(s, app);
  record(`${label}: judged on this handshake's key and a fresh nonce`, v.verdict === "monitor-signed",
    `verdict ${v.verdict}${v.reasons.length ? " (" + v.reasons.join("; ") + ")" : ""}, tier ${doc.tier}, key ${sha(s.spki).slice(0, 16)}...`);
  record(`${label}: the document never claims host exclusion or hardware attestation`,
    doc.tier === "T0-hv" && !/attested/i.test(JSON.stringify(doc.tier)) && v.checks["platform states host_excluded=false"] === true,
    `tier ${doc.tier}, format ${doc.format}`);
  const ready = await s.req("GET", "/.well-known/enclave-ready");
  let rj = {}; try { rj = JSON.parse(ready.body); } catch {}
  record(`${label}: enclave-ready on the SAME session`, ready.status === 200 && rj.ready === true && rj.appId === app,
    `${ready.status} ${ready.body.trim()}`);
  s.close();
}

// app traffic through the guest's TLS
{
  const s = await session(portA);
  const r = await s.req("GET", "/");
  record("A: the app answers through the domain's TLS", r.status === 200 && r.body.length > 0, `${r.status} ${JSON.stringify(r.body.slice(0, 40))}`);
  s.close();
}
{
  const s = await session(portB);
  const bin = "hv" + randomBytes(4).toString("hex"), nonce = randomBytes(8).toString("hex");
  const mk = await s.req("POST", "/api/bins", null, { "x-bin-id": bin });
  const post = await s.req("POST", `/b/${bin}`, JSON.stringify({ nonce }), { "content-type": "application/json",
    "x-forwarded-for": "203.0.113.9" });
  const got = await s.req("GET", `/api/bins/${bin}/requests`, null, { "x-bin-id": bin });
  let reqs = []; try { reqs = JSON.parse(got.body); } catch {}
  const body = reqs[0] ? Buffer.from(reqs[0].body_b64, "base64").toString() : "";
  record("B: webhook captured inside the guest and read back", mk.status === 200 && post.status === 200 && body.includes(nonce),
    `create ${mk.status}, post ${post.status}, read ${got.status}, body ${JSON.stringify(body)}`);
  const hdrs = reqs[0] ? reqs[0].headers.map(([k]) => k.toLowerCase()) : [];
  record("B: the app is told no X-Forwarded-For (not the host's CID, not the client's claim)", reqs[0] && !hdrs.includes("x-forwarded-for"),
    `headers the app saw: ${hdrs.join(",")}`);
  s.close();
}

// the certificate name: A was loaded with one (the launcher's word, T0-hv), B without. A's CSR is exactly that name on
// the handshake key; B has no name to certify.
if (process.env.HVLAB_NAME_A) {
  const s = await session(portA);
  const r = await s.req("GET", "/.well-known/enclave-csr");
  const pem = r.body;
  // node has no CSR parser: the subject/SAN name is checked as text and the key by re-exporting it from the CSR's DER
  const der = Buffer.from((/-----BEGIN CERTIFICATE REQUEST-----([\s\S]+?)-----END/.exec(pem) || [, ""])[1].replace(/\s+/g, ""), "base64");
  const { csrSpki } = await import("../m4/guestd/supervisor-guestcert.mjs");
  let spkiOk = false;
  try { spkiOk = Buffer.compare(csrSpki(pem), s.spki) === 0; } catch {}
  record("A: a CSR for exactly the launcher's name, on the handshake key", r.status === 200 && der.includes(Buffer.from(process.env.HVLAB_NAME_A)) && spkiOk,
    `${r.status}, name in CSR ${der.includes(Buffer.from(process.env.HVLAB_NAME_A))}, key matches ${spkiOk}`);
  s.close();
  const t = await session(portB);
  const rb = await t.req("GET", "/.well-known/enclave-csr");
  record("B (loaded with no name): no CSR", rb.status === 404, `${rb.status} ${rb.body.trim().slice(0, 80)}`);
  t.close();
}

// crossed identities: each refused by the judge, never served as the other
{
  const s = await session(portB);
  const { v } = await attest(s, appA);
  record("B's domain judged as A's app: refused", v.verdict === "reject" && v.reasons.some((x) => /different app/.test(x)), `${v.verdict}: ${v.reasons.join("; ")}`);
  s.close();
}
{
  const s = await session(portA), t = await session(portB);
  const nonce = randomBytes(32);
  const r = await s.req("GET", `/.well-known/enclave-attestation?nonce=${nonce.toString("hex")}`);
  const v = judge({ doc: JSON.parse(r.body), spki: t.spki, nonce, expectedAppSha256: appA, launcherKey });
  record("A's document presented on B's key: refused", v.verdict === "reject", `${v.verdict}: ${v.reasons.join("; ")}`);
  const v2 = judge({ doc: JSON.parse(r.body), spki: s.spki, nonce: randomBytes(32), expectedAppSha256: appA, launcherKey });
  record("A's document replayed for another nonce: refused", v2.verdict === "reject", `${v2.verdict}`);
  const other = randomBytes(32).toString("base64");
  const v3 = judge({ doc: JSON.parse(r.body), spki: s.spki, nonce, expectedAppSha256: appA, launcherKey: other });
  record("A's document under an untrusted launcher key: not monitor-signed", v3.verdict !== "monitor-signed", `${v3.verdict}`);
  s.close(); t.close();
}
console.log(failed ? `HVLAB-CHECK ${failed} FAILED` : "HVLAB-CHECK ALL PASS");
process.exit(failed ? 1 : 0);
