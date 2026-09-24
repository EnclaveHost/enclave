// test/helpers/pvm-lab.mjs: the LAB side of black-box tests against the installed pVM client: keys made per test run,
// policies and update manifests signed the way the client's design text defines them, a fake carrier and relay whose
// endpoints hold each client's request as a deterministic barrier, and the client's state read through its own `state`
// command. Nothing here is the owner's code and nothing here is a production key.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

export const APP = "29e8942369846359b5936dbef1268c28f7097cccb3101b86345dc4dd8f4c1373", RID = "d3370878afa9d5ee064cdcd9c50572a6baa8e23de35f5f4a0c41b7ec8f80acba";
export const ROOTS = ["cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc", "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"];
export const rawPub = (pair) => pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
export const fpOf = (pair) => createHash("sha256").update(rawPub(pair)).digest("hex");
export const sha256 = (b) => createHash("sha256").update(b).digest("hex");
export const keys = () => ({ policy: generateKeyPairSync("ed25519"), policy2: generateKeyPairSync("ed25519"), release: generateKeyPairSync("ed25519"), release2: generateKeyPairSync("ed25519"), other: generateKeyPairSync("ed25519"), x25519: generateKeyPairSync("x25519") });
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");

// { policy: base64(exact bytes), sig: hex(Ed25519("enclave-pvm-client-policy-v1\n" || bytes)) }
export function signedPolicy(K, serial, { key = K.policy, appIds = [APP], codeHash = "43".repeat(32), minClientVersion = "0.1.0", nextPolicyKey = null, tag = "", runtimeIds = [RID] } = {}) {
  const now = Date.now();
  const body = { type: "enclave-pvm-client-policy", key: rawPub(key).toString("hex"), serial, notBefore: iso(now - 3600e3), notAfter: iso(now + 6 * 3600e3),
    codeHashes: [tag ? sha256(tag) : codeHash], authorityHashes: ["cd".repeat(64)], runtimeIds, appIds, googleRootPins: ROOTS, formats: ["enclave-pvm-app-evidence/v2"], sealedModes: ["chunked", "whole"], sealedWindow: { seconds: 600, maxRequests: 256 }, minClientVersion, nextPolicyKey };
  const bytes = Buffer.from(JSON.stringify(body));
  return { policy: bytes.toString("base64"), sig: edSign(null, Buffer.concat([Buffer.from("enclave-pvm-client-policy-v1\n"), bytes]), key.privateKey).toString("hex"), digest: sha256(bytes), serial };
}
// an artifact whose first line carries the version marker, and its manifest { manifest, releaseSig, policySig }
export function fakeArtifact(version) { return Buffer.from(`/*! enclave-pvm-client ${version} (LAB TEST BYTES, not a client) */\nexport const CLIENT_VERSION = ${JSON.stringify(version)};\n`); }
export function signedManifest(K, version, bytes, { releaseKey = K.release, policyKey = K.policy, nextReleaseKey = null, notAfterMs = 6 * 3600e3, sourceCommit = "0".repeat(40) } = {}) {
  const body = { type: "enclave-pvm-client-update", artifact: "pvm-client.mjs", version, artifactSha256: sha256(bytes), size: bytes.length, sourceCommit, notAfter: iso(Date.now() + notAfterMs),
    releaseKey: rawPub(releaseKey).toString("hex"), policyKey: rawPub(policyKey).toString("hex"), nextReleaseKey };
  const mb = Buffer.from(JSON.stringify(body));
  return { manifest: mb.toString("base64"), releaseSig: edSign(null, Buffer.concat([Buffer.from("enclave-pvm-client-update-v1\n"), mb]), releaseKey.privateKey).toString("hex"),
           policySig: edSign(null, Buffer.concat([Buffer.from("enclave-pvm-client-update-countersign-v1\n"), mb]), policyKey.privateKey).toString("hex") };
}

// The lab server. Carrier: /policy/<name> serves the policy so named; with ?for=<label> (the 0.2.0 extension appends its
// tab's label) the policy named <label> if one exists; /policy/current serves L.defaultPolicy (the 0.1.0 extension sends no
// label). /manifest/<n> and /artifact/<n> serve an update; an artifact marked hold is HELD until released. Relay:
// /r/<label>/evidence is HELD until released, then answered by evidenceAnswer(nonce) or 503; /r/<label>/sealed is recorded
// and answered 503 (a private request never gets an answer here). /result collects whatever a client posts. Arrivals are
// COUNTED per key, so several tabs of one install (which share one relay URL) are told apart by arrival order, which the
// tests make deterministic by waiting for each arrival before opening the next tab.
export async function labServer() {
  const policies = new Map(), artifacts = new Map(), manifests = new Map(), posts = [], held = new Map(), counts = new Map(), waiters = [];
  const L = { policies, artifacts, manifests, posts, defaultPolicy: null, evidenceAnswer: null };
  const poke = () => { for (const w of [...waiters]) if (w.pred()) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); } };
  const arrive = (key, h) => { counts.set(key, (counts.get(key) || 0) + 1); if (h) { if (!held.has(key)) held.set(key, []); held.get(key).push(h); } poke(); };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"); let body = "";
    req.on("data", (c) => (body += c)); req.on("end", () => {
      let m;
      if ((m = /^\/policy\/([^/]+)$/.exec(u.pathname))) {
        const f = u.searchParams.get("for"); const name = f && policies.has(f) ? f : m[1] === "current" ? L.defaultPolicy : m[1]; const p = policies.get(name);
        if (!p) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ policy: p.policy, sig: p.sig }));
      }
      if ((m = /^\/manifest\/([^/]+)$/.exec(u.pathname))) { const x = manifests.get(m[1]); if (!x) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(x)); }
      if ((m = /^\/artifact\/([^/]+)$/.exec(u.pathname))) {
        const x = artifacts.get(m[1]); if (!x) { res.writeHead(404); return res.end(); }
        const answer = () => { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(x.bytes); };
        if (x.hold) return arrive(`artifact:${m[1]}`, { res, answer }); return answer();
      }
      if (u.pathname === "/result") { try { posts.push(JSON.parse(body)); } catch { posts.push({ raw: body }); } poke(); res.writeHead(204); return res.end(); }
      if ((m = /^\/r\/([^/]+)\/(evidence|sealed)$/.exec(u.pathname))) {
        const [, label, ep] = m;
        if (ep === "sealed") { arrive(`${label}:sealed`, null); res.writeHead(503); return res.end(); }
        const nonce = (/EVIDENCE ([0-9a-f]{64})/.exec(body) || [])[1] || null;
        return arrive(label, { res, nonce, answer: () => { if (L.evidenceAnswer) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(L.evidenceAnswer(nonce, label)) + "\n"); } else { res.writeHead(503); res.end(); } } });
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  L.base = `http://127.0.0.1:${server.address().port}`;
  L.count = (key) => counts.get(key) || 0;
  // every wait has a deadline: a hung client is a FAILURE here, never a silent stall
  L.when = (pred, what, ms = 30000) => pred() ? Promise.resolve() : new Promise((resolve, reject) => { const w = { pred, resolve }; waiters.push(w); setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`timeout (${ms} ms) waiting for ${what}`)); } }, ms).unref(); });
  L.evidenceRequested = (label, n = 1) => L.when(() => L.count(label) >= n, `evidence request #${n} of ${label}`);
  L.sealedRequested = (label, n = 1) => L.when(() => L.count(`${label}:sealed`) >= n, `sealed request #${n} of ${label}`);
  L.artifactRequested = (name, n = 1) => L.when(() => L.count(`artifact:${name}`) >= n, `artifact download #${n} of ${name}`);
  L.waitPost = async (pred, what, ms) => { await L.when(() => posts.some(pred), what, ms); return posts.find(pred); };
  L.release = (key, nth = 1) => { const h = (held.get(key) || [])[nth - 1]; if (!h) throw new Error(`nothing held as ${key} #${nth}`); if (!h.released) { h.released = true; h.answer(); } };
  L.close = () => { for (const q of held.values()) for (const h of q) if (!h.released) { h.released = true; try { h.res.writeHead(503); h.res.end(); } catch {} } server.close(); };
  return L;
}

// the CLI under test
export function cliEnv(tmp) { const e = { ...process.env, XDG_CONFIG_HOME: path.join(tmp, "xdg-unused") }; delete e.NODE_TEST_CONTEXT; return e; }
const parseLines = (out) => out.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
export function cliRun(CLI, tmp, args, { nodeArgs = [] } = {}) {
  const child = spawn(process.execPath, [...nodeArgs, CLI, ...args], { env: cliEnv(tmp), stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (c) => (out += c)); child.stderr.on("data", (c) => (err += c));
  const done = new Promise((resolve) => child.on("exit", (status, signal) => { const lines = parseLines(out); resolve({ exited: true, status, signal, out, err, lines, result: lines.find((l) => l.result)?.result ?? null, committed: lines.find((l) => l.committed)?.committed ?? null, update: lines.find((l) => l.update)?.update ?? null }); }));
  return { child, done, out: () => out };
}
export const cliSync = (CLI, tmp, args, opts = {}) => { const r = spawnSync(process.execPath, [...(opts.nodeArgs || []), CLI, ...args], { encoding: "utf8", env: cliEnv(tmp) }); const lines = parseLines(r.stdout); return { ...r, lines, last: lines.at(-1) || null }; };
export function committedState(CLI, tmp, stateDir) { const r = cliSync(CLI, tmp, ["state", "--state", stateDir]); const j = r.lines.find((l) => l.state || l.error); return j ? (j.state ? { ...j.state, gen: j.gen, dir: j.dir } : { error: j.error }) : null; }
export function install(CLI, tmp, stateDir, K, { serialFloor = 1 } = {}) { const r = cliSync(CLI, tmp, ["install", "--policy-key-fp", fpOf(K.policy), "--serial-floor", String(serialFloor), "--release-key-fp", fpOf(K.release), "--state", stateDir]); if (r.status !== 0) throw new Error(`install failed: ${r.stdout} ${r.stderr}`); return r; }
export const unzipTo = (zip, dir) => { fs.mkdirSync(dir, { recursive: true }); const r = spawnSync("unzip", ["-q", "-o", zip, "-d", dir], { encoding: "utf8" }); if (r.status !== 0) throw new Error(`unzip failed: ${r.stderr}`); return dir; };
