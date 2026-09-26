// hv-doc-judge.mjs - READ-ONLY: fetch a NucBox partition's attestation document and judge it with a NODE tree's own
// certificate-pass judge (windows/node/hvcert.mjs hvJudge), saving everything it used (CANARY-GO-v44.md A5b and B7;
// the method of REBOOT-GO-v42.md's G2 evidence). Nothing is started, stopped or written anywhere but --out.
//
//   node hv-doc-judge.mjs fetch --view <record.json> --direct <host:port> --out <dir>      (on the box: node builtins only)
//   node hv-doc-judge.mjs fetch --view <record.json> --x --out <dir>                       (ws: through nan's /x splice; `ws` from VIEM_DIR)
//        <record.json> = the manager's /vms record for the partition (saved first; it names the deployment, the runtime,
//        the image, the launcher key and the partition it signs for). --direct = the record's relay port on the box.
//        Writes view.json, nonce.hex, attestation.json (the bytes served), cert.pem, spki.der, fetch.json.
//   node hv-doc-judge.mjs judge --tree <checkout> --in <dir> --pin <64 hex> [--expect-seccomp <64 hex>]
//        judges <dir> with <checkout>/windows/node/hvcert.mjs hvJudge(view, pin) - the tree the node runs - and writes
//        verdict.json. --pin = the node's ENCLAVE_ISOLATION_RUNTIME_ID. Exit 0 ONLY for verdict monitor-signed AND
//        wxCoverage runtime-covered AND (with --expect-seccomp) the self-test's seccomp= being exactly that program
//        sha256, which the judge's wxWhy names (by its first 16 hex). "runtime-unmeasured"
//        (a listed legacy image) exits 1 unless --allow-unmeasured is given.
import crypto from "node:crypto"; import fs from "node:fs"; import http from "node:http"; import path from "node:path"; import tls from "node:tls";
import { createRequire } from "node:module"; import os from "node:os"; import { pathToFileURL } from "node:url";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (k) => { const i = rest.indexOf(`--${k}`); return i < 0 ? undefined : (rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : true); };
const die = (m, code = 2) => { console.log(`ERROR ${m}`); process.exit(code); };
const HEX64 = /^[0-9a-f]{64}$/;

if (cmd === "fetch") {
  const out = opt("out"), viewPath = opt("view");
  if (typeof out !== "string" || typeof viewPath !== "string") die("fetch needs --view <record.json> and --out <dir>");
  const view = JSON.parse(fs.readFileSync(viewPath, "utf8").replace(/^\uFEFF/, ""));   // PowerShell 5.1 files carry a BOM
  const id = String(view.name || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(id)) die(`the record names no deployment id (name ${JSON.stringify(view.name)})`);
  const host = `${id.slice(2, 10)}.app.enclave.host`;
  fs.mkdirSync(out, { recursive: true });
  const put = (f, b) => fs.writeFileSync(path.join(out, f), b);
  const nonce = crypto.randomBytes(32);
  put("view.json", JSON.stringify(view, null, 1) + "\n"); put("nonce.hex", nonce.toString("hex") + "\n");
  let socket, via;
  if (typeof opt("direct") === "string") {
    const [h, p] = opt("direct").split(":");
    if (!h || !/^\d+$/.test(p || "")) die("--direct wants host:port (the record's relay port)");
    via = `direct ${h}:${p}`;
    socket = tls.connect({ host: h, port: Number(p), servername: host, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] });
  } else if (opt("x") === true) {
    const req = createRequire(path.join(process.env.VIEM_DIR || path.join(os.homedir(), "Projects/enclave"), "package.json"));
    const WebSocket = req("ws"), { createWebSocketStream } = WebSocket;   // ws's CommonJS entry: the class, with the helper on it
    const url = `wss://api.enclave.host/t/nucbox-k11/x/${id}/https`;
    via = url;
    const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 15000 });
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); ws.on("unexpected-response", (_q, r) => rej(new Error(`splice refused ${r.statusCode}`))); })
      .catch((e) => die(e.message, 1));
    socket = tls.connect({ socket: createWebSocketStream(ws), servername: host, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] });
    socket.on("close", () => ws.terminate());
  } else die("fetch needs --direct <host:port> or --x");
  const started = new Date().toISOString();
  setTimeout(() => die("timeout", 1), 30000).unref();
  socket.on("error", (e) => die(`tls ${e.message}`, 1));
  socket.on("secureConnect", () => {
    const peer = socket.getPeerCertificate(true);
    const cert = new crypto.X509Certificate(peer.raw);
    const chain = [cert.toString()];
    for (let c = peer.issuerCertificate; c && c !== c.issuerCertificate && chain.length < 5; c = c.issuerCertificate) chain.push(new crypto.X509Certificate(c.raw).toString());
    put("cert.pem", chain.join(""));
    const spki = cert.publicKey.export({ type: "spki", format: "der" }); put("spki.der", spki);
    const r = http.request({ createConnection: () => socket, host, path: `/.well-known/enclave-attestation?nonce=${nonce.toString("hex")}`, headers: { connection: "close" } }, (res) => {
      const parts = []; res.on("data", (d) => parts.push(d)); res.on("end", () => {
        const body = Buffer.concat(parts); put("attestation.json", body);
        const spkiSha = crypto.createHash("sha256").update(spki).digest("hex");
        const f = { started, done: new Date().toISOString(), via, sni: host, status: res.statusCode, handshakeSpkiSha256: spkiSha,
          recordTransportKeySha256: view.transportKeySha256 ?? null, issuer: cert.issuer, subject: cert.subject, tlsChainVerifiedByNode: socket.authorized };
        put("fetch.json", JSON.stringify(f, null, 1) + "\n");
        let doc = {}; try { doc = JSON.parse(body.toString("utf8")); } catch {}
        console.log(`fetched ${f.done} via ${via} HTTP ${res.statusCode}; spki ${spkiSha} ${spkiSha === view.transportKeySha256 ? "= the record's transportKeySha256" : "DIFFERS from the record's transportKeySha256"}`);
        console.log(`runtimeSelfTest ${JSON.stringify(doc.runtimeSelfTest ?? null)} abi ${doc.abi ?? "-"} nonce-echo ${doc.nonce === nonce.toString("hex")}`);
        socket.end(); process.exit(res.statusCode === 200 ? 0 : 1);
      });
    });
    r.on("error", (e) => die(e.message, 1)); r.end();
  });
} else if (cmd === "judge") {
  const tree = opt("tree"), dir = opt("in"), pin = String(opt("pin") || "").toLowerCase(), sc = opt("expect-seccomp");
  if (typeof tree !== "string" || typeof dir !== "string") die("judge needs --tree <checkout> and --in <dir>");
  if (!HEX64.test(pin)) die("judge needs --pin <64 hex>: the node's ENCLAVE_ISOLATION_RUNTIME_ID (never taken from the record)");
  if (sc !== undefined && !(typeof sc === "string" && HEX64.test(sc))) die("--expect-seccomp wants a 64-hex program sha256");
  const hvcert = path.resolve(tree, "windows/node/hvcert.mjs");
  const { hvJudge } = await import(pathToFileURL(hvcert).href);
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f)); } catch (e) { return die(`${dir} has no ${f} (did the fetch finish?): ${e.code || e.message}`); } };
  const view = JSON.parse(read("view.json").toString("utf8").replace(/^\uFEFF/, "")), doc = JSON.parse(read("attestation.json").toString("utf8"));
  const spki = read("spki.der"), nonce = Buffer.from(read("nonce.hex").toString().trim(), "hex");
  const v = await hvJudge(view, pin)(doc, spki, nonce, { appSha: view.appId });
  const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  const judgeHv = path.resolve(tree, "windows/vbslike/verify/judge-hv.mjs"), judgeMjs = path.resolve(tree, "isolation/m2/judge.mjs");
  const out = { time: new Date().toISOString(), judge: `${hvcert} hvJudge(view, --pin)`, pin,
    files: { hvcert: sha(hvcert), judgeHv: sha(judgeHv), judgeMjs: sha(judgeMjs) },
    image: view.image ?? null, runtimeSelfTest: doc.runtimeSelfTest ?? null, verdict: v };
  fs.writeFileSync(path.join(dir, "verdict.json"), JSON.stringify(out, null, 1) + "\n");
  const unmeasuredOk = opt("allow-unmeasured") === true;
  // the FULL hash from the self-test the judge accepted (judge-hv's wxWhy names only its first 16 hex), and the judge's
  // own words naming it
  const stated = (String(doc.runtimeSelfTest || "").match(/(?:^| )seccomp=([0-9a-f]{64})(?: |$)/) || [])[1];
  const scOk = sc === undefined || (stated === sc && typeof v.wxWhy === "string" && v.wxWhy.includes(`program sha256 ${sc.slice(0, 16)}`));
  const covOk = v.wxCoverage === "runtime-covered" || (unmeasuredOk && v.wxCoverage === "runtime-unmeasured");
  const ok = v.verdict === "monitor-signed" && covOk && scOk;
  console.log(`judge ${hvcert} (sha256 ${out.files.hvcert}); judge-hv ${out.files.judgeHv}; judge.mjs ${out.files.judgeMjs}`);
  console.log(`image ${out.image}; runtimeSelfTest ${JSON.stringify(out.runtimeSelfTest)}`);
  console.log(`VERDICT ${v.verdict} wxCoverage=${v.wxCoverage || "-"}`);
  console.log(`wxWhy ${v.wxWhy || "-"}`);
  if (v.reasons?.length) console.log(`reasons ${v.reasons.join(" | ").slice(0, 600)}`);
  console.log(`${ok ? "PASS" : "FAIL"} monitor-signed=${v.verdict === "monitor-signed"} coverage=${v.wxCoverage || "-"}${sc === undefined ? "" : ` seccomp ${sc.slice(0, 8)}… named=${scOk}`}`);
  process.exit(ok ? 0 : 1);
} else die("usage: hv-doc-judge.mjs fetch --view <record.json> (--direct <host:port> | --x) --out <dir> | judge --tree <checkout> --in <dir> --pin <64 hex> [--expect-seccomp <64 hex>] [--allow-unmeasured]");
