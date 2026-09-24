// hcs-window.mjs: drive the manager's HCS development backend against the REAL `vbslike-host lab` on the box, once,
// inside a window the Windows owner granted. It loads the pinned hello-world bundle, checks hash agreement (the
// monitor's appSha256 == the derived AppID), then judges the partition from the outside as a client would: one TLS
// session to the relay port, the attestation document judged by judge-hv on THIS handshake's key and a fresh nonce
// against the launcher key the lab's ready line announced, enclave-ready (404 on the old initrd, 200/503 on 63b2b276's),
// the app's own answer, and then stop and teardown, checking the launcher's own view. Everything it did is printed as
// JSON. Nothing under C:\Users\claude\vbs is touched; partitions it creates are destroyed before exit.
//   node hcs-window.mjs <vbslike-host.exe> <kernel> <initrd> <outDir> <hello.bundle> [judge-hv.mjs]
import fs from "node:fs";
import tls from "node:tls";
import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { HcsPartitionBackend } from "./manager-backend-hcs.mjs";
const [exe, kernel, initrd, out, bundlePath, judgePath] = process.argv.slice(2);
const APP = "9c3d10f1450e17bc6a21478723193ef7e3da409afe353e264714cb801d180d45";
const RUNTIME = { name: "wasmtime", version: "48.0.1", execution: "jit", targetIsa: "x86_64", hostIsa: "x86_64", cpuFeatures: "host-detected", wx: "enforced", cache: "none" };
const R = { at: new Date().toISOString(), steps: [] };
const step = (name, data) => { R.steps.push({ name, at: new Date().toISOString(), ...data }); console.error(`[${name}] ${JSON.stringify(data).slice(0, 300)}`); };
const sha = (b) => createHash("sha256").update(b).digest("hex");
function session(port) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: "127.0.0.1", port, servername: "hvlab.test", rejectUnauthorized: false });
    s.once("error", reject);
    s.once("secureConnect", () => {
      const spki = s.getPeerX509Certificate().publicKey.export({ type: "spki", format: "der" });
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); agent.createConnection = () => s;
      const req = (method, path, headers = {}) => new Promise((res, rej) => {
        const r = http.request({ agent, method, path, headers: { host: "hvlab.test", ...headers } }, (a) => { const c = []; a.on("data", (x) => c.push(x)); a.on("end", () => res({ status: a.statusCode, body: Buffer.concat(c).toString() })); });
        r.on("error", rej); r.end();
      });
      resolve({ spki, req, close: () => s.destroy() });
    });
  });
}
const bundle = fs.readFileSync(bundlePath);
step("bundle", { bytes: bundle.length, sha256: sha(bundle), expectAppId: APP });
const b = new HcsPartitionBackend({ exe, kernel, initrd, out, tcpBase: 19100, memMiB: 512, vcpus: 1 });
let handle = null;
try {
  step("preflight", await b.preflight());
  const hello = await b.open();
  step("launcher-ready", { launcherKey: hello.launcherKey, boundary: hello.boundary, initrdSha256: hello.initrdSha256, kernelSha256: hello.kernelSha256 });
  const t0 = Date.now();
  handle = await b.start({ appId: APP, bundle, record: { policy: { cpuPercent: 100, memMiB: 512, vcpus: 1 } } }, { instanceId: "review99-hello" });
  step("started", { ms: Date.now() - t0, domainId: handle.domainId, tcpPort: handle.tcpPort, guestPort: handle.guestPort, appReady: handle.appReady, boundary: handle.boundary });
  // the client's view, on the relay port. Immediately after `load` the domain's front may not be listening yet (the first
  // run saw ECONNRESET 7 ms after start): connect with retries and record when the TLS first accepted.
  let s = null; const tc = Date.now(); let attempts = 0, lastErr = null;
  while (Date.now() - tc < 60_000) { attempts++; try { s = await session(handle.tcpPort); break; } catch (e) { lastErr = e.message; await new Promise((r) => setTimeout(r, 500)); } }
  step("tls-connect", { ok: !!s, attempts, ms: Date.now() - tc, lastErr });
  if (!s) throw new Error(`no TLS session on the relay port within 60 s: ${lastErr}`);
  const nonce = randomBytes(32);
  const a = await s.req("GET", `/.well-known/enclave-attestation?nonce=${nonce.toString("hex")}`);
  let doc = null; try { doc = JSON.parse(a.body); } catch {}
  step("attestation", { status: a.status, tier: doc && doc.tier, format: doc && doc.format, abi: doc && doc.abi, nonceEchoed: doc && doc.nonce === nonce.toString("hex"), transportKeyIsHandshake: doc && Buffer.from(String(doc.transportKey || ""), "base64").equals(s.spki), appSha256: doc && doc.appSha256 });
  if (judgePath && doc) {
    const { judge } = await import(pathToFileURL(judgePath).href);
    const v = judge({ doc, spki: s.spki, nonce, expectedAppSha256: APP, launcherKey: hello.launcherKey, expectRuntime: RUNTIME });
    step("judge-hv", { verdict: v.verdict, reasons: v.reasons, hostExcludedFalse: v.checks["platform states host_excluded=false"] });
    const v2 = judge({ doc, spki: s.spki, nonce: randomBytes(32), expectedAppSha256: APP, launcherKey: hello.launcherKey, expectRuntime: RUNTIME });
    step("judge-hv-replayed-nonce", { verdict: v2.verdict });
  }
  // readiness: poll enclave-ready up to 20 s (404 on the 44abb52b initrd, which predates the route; 200/503 on 63b2b276+)
  let ready = null; const tr = Date.now();
  for (let i = 0; i < 20; i++) { ready = await s.req("GET", "/.well-known/enclave-ready"); if (ready.status === 200 || ready.status === 404) break; await new Promise((r) => setTimeout(r, 1000)); }
  step("enclave-ready", { status: ready.status, body: ready.body.slice(0, 200), polledMs: Date.now() - tr });
  // the app: hello-world 1.0.4 answers exactly "Hello World!\n" (13 bytes; enclave-53 retracted the trimmed string)
  let app = null; const ta = Date.now();
  for (let i = 0; i < 20; i++) { app = await s.req("GET", "/", { "x-forwarded-for": "203.0.113.9" }); if (app.status === 200) break; await new Promise((r) => setTimeout(r, 1000)); }
  step("app", { status: app.status, bytes: Buffer.byteLength(app.body), body: JSON.stringify(app.body.slice(0, 80)), exact13: app.body === "Hello World!\n", sha256: sha(Buffer.from(app.body)), polledMs: Date.now() - ta });
  s.close();
} catch (e) {
  step("error", { message: e.message, code: e.code, cleanup: e.cleanup });
} finally {
  try { if (handle) step("stop", await b.stop(handle)); } catch (e) { step("stop-error", { message: e.message }); }
  try { step("teardown", await b.teardown()); } catch (e) { step("teardown-error", { message: e.message, failed: e.failed }); }
  await b.close();
}
process.stdout.write(JSON.stringify(R, null, 1) + "\n");
