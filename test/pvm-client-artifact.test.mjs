// The installed pVM client as an ARTIFACT (client/DESIGN.md): reproducibly built, loading no code, trusting only its install
// anchors -- and every malicious delivery a carrier could attempt against it (policy, evidence, update bytes) refused.
// The CLI is exercised as the built file (client/dist/pvm-client.mjs) in a child process, the way it is installed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { CLIENT_VERSION, VERSION_MARKER } from "../shielded/anchor/avf/client/src/trust.js";
import { connect, acceptPolicy } from "../shielded/anchor/avf/client/src/client.js";
import { initialState } from "../shielded/anchor/avf/client/src/trust.js";
import { FileStore } from "../shielded/anchor/avf/client/src/store-file.js";
import { tmpdir, makeCa, haveOpenssl } from "./fixtures/avf-synthetic.mjs";
import { startFakeVm } from "./fixtures/pvm-fake-vm.mjs";
import { createWebCarrier } from "../shielded/anchor/avf/cpu/web-carrier.mjs";

const C = new URL("../shielded/anchor/avf/client/", import.meta.url).pathname;
const DIST = path.join(C, "dist"), CLI = path.join(DIST, "pvm-client.mjs");
const ESBUILD = process.env.ESBUILD || "/home/steven/Projects/enclave/node_modules/.bin/esbuild";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const raw = (k) => k.publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex");
const key = () => { const k = generateKeyPairSync("ed25519"); return { k, pub: raw(k), fp: sha(Buffer.from(raw(k), "hex")) }; };
const esig = (text, domain, k) => edSign(null, Buffer.concat([Buffer.from(domain), Buffer.from(text)]), k.k.privateKey).toString("hex");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const PIXEL_RID = sha('{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}');
const GOOGLE = ["cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc", "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"];
const policy = (P, over = {}, now = Date.now()) => {
  const body = { type: "enclave-pvm-client-policy", key: P.pub, serial: 5, notBefore: iso(now - 3600e3), notAfter: iso(now + 86400e3),
    codeHashes: ["6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990"], authorityHashes: ["cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f"], // gitleaks:allow -- public: sha512 of the TEST signing certificate
    runtimeIds: [PIXEL_RID], appIds: ["1ad17b45e12aabdec8ca08538ce1d3a795a7e68c3b87d534b50305d5654ca339"], googleRootPins: GOOGLE,
    formats: ["enclave-pvm-app-evidence/v2"], sealedModes: ["chunked", "whole"], sealedWindow: { seconds: 600, maxRequests: 256 },
    minClientVersion: "0.1.0", nextPolicyKey: null, ...over };
  const text = JSON.stringify(body);
  return { policy: Buffer.from(text).toString("base64"), sig: esig(text, "enclave-pvm-client-policy-v1\n", P) };
};
// the CLI in a child process, asynchronously (the fake VM and carrier run in THIS process and must keep answering)
const cli = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
  let out = "", err = ""; c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { err += d; });
  const t = setTimeout(() => c.kill("SIGKILL"), 60000);
  c.on("close", (rc) => { clearTimeout(t); resolve({ rc, lines: out.split("\n").filter(Boolean).map((l) => JSON.parse(l)), stderr: err }); });
});

test("the artifact: reproducible, versioned in its own bytes, loading no code, the extension a site cannot script", { skip: !fs.existsSync(ESBUILD) && "no esbuild" }, () => {
  const out = execFileSync(path.join(C, "build.sh"), ["--check"], { encoding: "utf8", env: { ...process.env, ESBUILD } });
  assert.match(out, /reproduced: dist\/ matches a fresh build byte for byte/);
  const b = JSON.parse(fs.readFileSync(path.join(DIST, "BUILD.json"), "utf8"));
  for (const [n, o] of Object.entries(b.outputs)) { const bytes = fs.readFileSync(path.join(DIST, n)); assert.equal(sha(bytes), o.sha256, n); assert.equal(bytes.length, o.size); }
  for (const [p, h] of Object.entries(b.inputs)) assert.equal(sha(fs.readFileSync(path.join(C, p))), h, `input ${p}`);
  const cliText = fs.readFileSync(CLI, "utf8");
  assert.ok(cliText.split("\n")[0].startsWith(`${VERSION_MARKER}${CLIENT_VERSION} `), "the version is inside the artifact's bytes");
  assert.equal(b.version, CLIENT_VERSION);
  // no code from anywhere but the artifact: the one import() is @hpke/common's fixed fallback to the Node builtin
  const unzip = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-ext-")); execFileSync("unzip", ["-q", path.join(DIST, "pvm-client-ext.zip"), "-d", unzip]);
  for (const f of [CLI, path.join(unzip, "client.js"), path.join(unzip, "options.js")]) {
    const t = fs.readFileSync(f, "utf8");
    assert.deepEqual([...t.matchAll(/import\(([^)]*)\)/g)].map((m) => m[1]).filter((a) => a !== '"crypto"'), [], `${f}: a dynamic import`);
    assert.ok(!/\beval\(|new Function\(|importScripts\(/.test(t), `${f}: dynamic code`);
  }
  const m = JSON.parse(fs.readFileSync(path.join(unzip, "manifest.json"), "utf8"));
  assert.equal(m.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
  assert.equal(m.web_accessible_resources, undefined, "no page of the extension is reachable from a site");
  assert.equal(m.externally_connectable, undefined);
  for (const h of ["client.html", "options.html"]) assert.deepEqual([...fs.readFileSync(path.join(unzip, h), "utf8").matchAll(/src="([^"]+)"/g)].map((x) => x[1]).filter((s) => /:\/\//.test(s)), [], `${h}: a remote script`);
});

test("the CLI: installs its anchors once; refuses unsigned, foreign, rolled-back and expired policies across runs; refuses a VM outside Google's roots", { skip: !haveOpenssl && "no openssl", timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-cli-")), state = path.join(dir, "state.json");
  const P = key(), R = key(), X = key();
  const cadir = tmpdir("pvm-cli-ca-"), ca = makeCa(cadir);   // the fake VM issues its leaves under this CA, in its directory
  const APP = "1ad17b45e12aabdec8ca08538ce1d3a795a7e68c3b87d534b50305d5654ca339";
  const vm = await startFakeVm({ dir: cadir, ca, code: Buffer.from("6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990", "hex"), appId: APP });
  const carrier = createWebCarrier({ port: 0, evidencePort: vm.evidencePort, sealedPort: vm.sealedPort });
  await new Promise((r) => carrier.on("listening", r));
  const relay = `http://127.0.0.1:${carrier.address().port}`;
  const write = (n, o) => { const f = path.join(dir, n); fs.writeFileSync(f, JSON.stringify(o)); return f; };
  try {
    assert.equal((await cli(["run", "--state", state, "--policy", "x", "--relay", relay, "--app", APP])).rc, 2, "no anchor, nothing runs");
    const inst = await cli(["install", "--state", state, "--policy-key-fp", P.fp, "--serial-floor", "5", "--release-key-fp", R.fp]);
    assert.equal(inst.rc, 0, JSON.stringify(inst.lines));
    assert.match((await cli(["install", "--state", state, "--policy-key-fp", X.fp, "--serial-floor", "1", "--release-key-fp", R.fp])).lines[0].refused, /already installed/);
    const run = async (pol) => (await cli(["run", "--state", state, "--policy", write(`p${Math.random()}.json`, pol), "--relay", relay, "--app", APP])).lines.at(-1).result;
    assert.match((await run(policy(X))).refused, /anchor does not name/);
    assert.match((await run({ ...policy(P), sig: "00".repeat(64) })).refused, /does not verify/);
    assert.match((await run(policy(P, { serial: 4 }))).refused, /rollback/, "below the install floor");
    assert.match((await run(policy(P, { appIds: ["ee".repeat(32)] }))).refused, /does not admit this app/);
    // a well-formed VM whose chain is not Google's: the installed client refuses it at verify, and sends nothing
    const r7 = await run(policy(P, { serial: 7 }));
    assert.equal(r7.step, "verify"); assert.equal(r7.sent, false); assert.match(r7.refused, /not a pinned Google attestation root/);
    assert.equal((await cli(["state", "--state", state])).lines[0].state.serial, 7, "the client remembers the newest policy");
    assert.match((await run(policy(P, { serial: 6 }))).refused, /rollback/, "an older signed policy after a newer one, in a later run");
    assert.match((await run(policy(P, { serial: 7, formats: ["enclave-pvm-app-evidence/v1", "enclave-pvm-app-evidence/v2"] }))).refused, /equivocation/);
    assert.match((await run(policy(P, { serial: 8, notBefore: iso(Date.now() - 7200e3), notAfter: iso(Date.now() - 3600e3) }))).refused, /expired/);
    assert.equal(vm.log.filter((l) => l.served).length, 0, "no request ever reached the VM");
  } finally { carrier.close(); vm.close(); }
});

test("the CLI's updates: staged beside it only when release-signed, policy-countersigned and exact; never run by it; every malicious delivery refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-upd-")), state = path.join(dir, "state.json");
  const P = key(), R = key(), X = key();
  await cli(["install", "--state", state, "--policy-key-fp", P.fp, "--serial-floor", "1", "--release-key-fp", R.fp]);
  const cur = fs.readFileSync(CLI);
  const NEXT = "9.1.0";   // newer than the running client, whatever its version
  const next = Buffer.from(cur.toString("utf8").replace(`${VERSION_MARKER}${CLIENT_VERSION} `, `${VERSION_MARKER}${NEXT} `));
  const man = (b, over = {}, r = R, p = P) => {
    const body = { type: "enclave-pvm-client-update", artifact: "pvm-client.mjs", version: NEXT, artifactSha256: sha(b), size: b.length, sourceCommit: "ab".repeat(20),
                   notAfter: iso(Date.now() + 86400e3), releaseKey: r.pub, policyKey: p.pub, nextReleaseKey: null, ...over };
    const t = JSON.stringify(body);
    return { manifest: Buffer.from(t).toString("base64"), releaseSig: esig(t, "enclave-pvm-client-update-v1\n", r), policySig: esig(t, "enclave-pvm-client-update-countersign-v1\n", p) };
  };
  const published = () => fs.readdirSync(dir).filter((n) => /^\.?pvm-client-/.test(n)).sort();
  const upd = async (m, b) => {   // the install directory is never cleaned between attempts: what an attempt leaves, the next one sees
    const mf = path.join(dir, "m.json"), af = path.join(dir, "a.mjs"); fs.writeFileSync(mf, JSON.stringify(m)); fs.writeFileSync(af, b);
    const before = published();
    const r = (await cli(["update", "--state", state, "--manifest", mf, "--artifact", af, "--install-dir", dir])).lines.at(-1).update;
    const st = (await cli(["state", "--state", state])).lines[0];
    return { ...r, staged: !!st.state.staged && fs.existsSync(path.join(dir, st.state.staged.file)), gen: st.gen, before, after: published() };
  };
  const bad = (r, re) => { assert.equal(r.ok, false); assert.match(r.reasons[0], re); assert.equal(r.staged, false, "nothing staged"); assert.deepEqual(r.after, r.before, "nothing published"); };
  bad(await upd(man(next), Buffer.concat([next, Buffer.from("\nevil();")])), /bytes; the signed manifest says|not the signed artifact/);
  const t = Buffer.from(next); t[t.length - 5] ^= 1; bad(await upd(man(next), t), /not the signed artifact/);
  bad(await upd(man(next, {}, X, P), next), /release key this client's anchor does not name/);
  bad(await upd({ ...man(next), policySig: man(next, {}, R, X).policySig }, next), /countersignature does not verify/);
  bad(await upd(man(cur, { version: CLIENT_VERSION }), cur), /downgrade or a replay/);
  bad(await upd(man(cur, { version: NEXT }), cur), /own version line is not 9\.1\.0/);
  bad(await upd(man(next, { notAfter: iso(Date.now() - 1000e3) }), next), /expired/);
  const ok = await upd(man(next), next);
  assert.equal(ok.ok, true, JSON.stringify(ok)); assert.equal(ok.staged, true); assert.equal(ok.version, NEXT);
  const NAME = `pvm-client-${NEXT}-${sha(next)}.mjs`;   // content-addressed: other bytes never take this name
  assert.deepEqual(ok.after, [NAME]); assert.deepEqual(fs.readFileSync(path.join(dir, NAME)), next);
  const id = () => { const st = fs.statSync(path.join(dir, NAME)); return [sha(fs.readFileSync(path.join(dir, NAME))), st.ino, st.mtimeMs, st.mode & 0o777]; };
  const id0 = id(); assert.equal(id0[3], 0o444, "published read-only");
  const staged = (await cli(["staged", "--state", state, "--install-dir", dir])).lines[0].staged;
  assert.equal(staged.version, NEXT); assert.equal(staged.bytesMatch, true); assert.equal(staged.file, NAME);
  const again = await upd(man(next), next);   // the same artifact again: idempotent -- success, nothing recorded, nothing rewritten
  assert.equal(again.ok, true, JSON.stringify(again)); assert.equal(again.already, true); assert.equal(again.gen, ok.gen); assert.deepEqual(id(), id0);
  // a second, validly signed artifact under the SAME version (a re-signed build): refused, and the staged bytes untouched
  const other = Buffer.concat([next, Buffer.from("\n// another build of the same version\n")]);
  const eq = await upd(man(other), other);
  assert.equal(eq.ok, false); assert.match(eq.reasons[0], /already staged: 9\.1\.0 cannot replace it/);
  assert.deepEqual(id(), id0, "the refused stager did not touch the staged file"); assert.deepEqual(eq.after, [NAME], "refused before publishing anything");
  assert.equal(eq.gen, ok.gen);
  assert.equal((await cli(["staged", "--state", state, "--install-dir", dir])).lines[0].staged.bytesMatch, true);
  assert.equal((await cli(["version"])).lines[0].version, CLIENT_VERSION, "the running client did not load what it staged");
});

test("in process, on the Pixel's real v2 evidence: policy, verification and the release rule pass, the request is sealed and sent once; a replay is held", async () => {
  const env = JSON.parse(fs.readFileSync(new URL("../shielded/anchor/avf/results/pvm-cpu-browser-channel/l1-evidence.json", import.meta.url)));
  const at = Date.parse("2026-09-24T07:26:36Z");
  const P = key(), R = key();
  const store = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), "pvm-inproc-")));
  store.init({ ...initialState({ policyKeyFp: P.fp, serialFloor: 1, releaseKeyFp: R.fp }), staged: null });
  const pol = policy(P, { serial: 1, codeHashes: ["6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990"] }, at);
  let evidenceOut = JSON.stringify(env), sealedSeen = 0, holdEvidence = null, evidenceHeld = null;
  const srv = http.createServer((q, s) => { let b = ""; q.on("data", (d) => { b += d; }); q.on("end", async () => {
    if (q.url === "/evidence") { if (holdEvidence) { const h = holdEvidence; holdEvidence = null; evidenceHeld(); await h; } s.end(evidenceOut + "\n"); return; }
    sealedSeen++; s.writeHead(502); s.end(); }); }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.on("listening", r));
  const relay = `http://127.0.0.1:${srv.address().port}`;
  const orig = crypto.getRandomValues.bind(crypto);
  crypto.getRandomValues = (a) => { if (a.length === 32) { a.set(Buffer.from(env.nonce, "hex")); return a; } return orig(a); };   // the page's nonce is the one the Pixel answered
  try {
    const used = new Set();
    const r1 = await connect({ relay, policyEnv: pol, store, appId: env.app, path: "/?graph=g&steps=3", usedNonces: used, now: at });
    assert.equal(r1.result.step, "sealed", JSON.stringify(r1.result)); assert.equal(r1.result.sent, true); assert.equal(sealedSeen, 1, "released: sealed and sent");
    assert.ok(used.has(env.nonce), "the nonce is spent");
    const r2 = await connect({ relay, policyEnv: pol, store, appId: env.app, path: "/", usedNonces: used, now: at });
    assert.equal(r2.result.step, "gate"); assert.match(r2.result.refused, /used before/); assert.equal(sealedSeen, 1, "a replayed exchange sends nothing");
    evidenceOut = JSON.stringify({ ...env, appKey: "11".repeat(32) });
    const r3 = await connect({ relay, policyEnv: pol, store, appId: env.app, path: "/", usedNonces: new Set(), now: at });
    assert.equal(r3.result.step, "verify"); assert.equal(sealedSeen, 1, "a relay's app key: nothing sent");
    const narrow = policy(P, { serial: 2, googleRootPins: [GOOGLE[0]] }, at);
    evidenceOut = JSON.stringify(env);
    const r4 = await connect({ relay, policyEnv: narrow, store, appId: env.app, path: "/", usedNonces: new Set(), now: at });
    assert.equal(r4.result.step, "verify"); assert.match(r4.result.refused, /not a pinned Google attestation root/); assert.equal(sealedSeen, 1);
    // superseded while it waited: this run commits serial 3, its evidence is held; meanwhile serial 4 is committed (another
    // tab or process); on release, the evidence verifies and the release rule passes -- and it is still refused, nothing sent
    let release; holdEvidence = new Promise((r) => { release = r; });
    const held = new Promise((r) => { evidenceHeld = r; });
    const pending = connect({ relay, policyEnv: policy(P, { serial: 3, codeHashes: ["6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990"] }, at), store, appId: env.app, path: "/", usedNonces: new Set(), now: at });
    await held;
    assert.equal(store.latest().state.serial, 3, "committed before the evidence request");
    assert.equal((await acceptPolicy(store, policy(P, { serial: 4, codeHashes: ["6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990"] }, at), { now: at })).serial, 4);
    release();
    const r5 = (await pending).result;
    assert.equal(r5.step, "gate"); assert.match(r5.refused, /serial 3 was superseded by serial 4/); assert.equal(sealedSeen, 1, "a superseded policy sends nothing");
    const r6 = await connect({ relay, policyEnv: policy(P, { serial: 4, codeHashes: ["6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990"] }, at), store, appId: env.app, path: "/", usedNonces: new Set(), now: at });
    assert.equal(r6.result.step, "sealed", JSON.stringify(r6.result)); assert.equal(sealedSeen, 2, "the newest policy still releases");
  } finally { crypto.getRandomValues = orig; srv.close(); }
});
