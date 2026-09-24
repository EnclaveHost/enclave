// The built browser extension (client/dist/pvm-client-ext.zip) in a real headless Chromium that loads unpacked extensions
// (Chrome for Testing; skipped when absent): its anchor installs from its own options page; a SITE cannot open that page to
// plant an anchor; its client page -- code no site served -- refuses a policy signed by a key its anchor does not name,
// and refuses a well-formed VM outside Google's roots before sending anything. The Pixel run is the positive evidence.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { tmpdir, makeCa, haveOpenssl } from "./fixtures/avf-synthetic.mjs";
import { startFakeVm } from "./fixtures/pvm-fake-vm.mjs";
import { createWebCarrier } from "../shielded/anchor/avf/cpu/web-carrier.mjs";

const CFT = process.env.CHROME_FOR_TESTING || path.join(os.homedir(), ".cache/ms-playwright/chromium-1232/chrome-linux64/chrome");
const ZIP = new URL("../shielded/anchor/avf/client/dist/pvm-client-ext.zip", import.meta.url).pathname;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const raw = (k) => k.publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex");
const key = () => { const k = generateKeyPairSync("ed25519"); return { k, pub: raw(k), fp: sha(Buffer.from(raw(k), "hex")) }; };
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const extId = (dir) => [...createHash("sha256").update(dir).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("the extension: anchored from its own page only, refuses a foreign policy and a non-Google VM, sends nothing", { skip: (!fs.existsSync(CFT) && "no Chrome for Testing") || (!haveOpenssl && "no openssl"), timeout: 180000 }, async () => {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-ext-")); execFileSync("unzip", ["-q", ZIP, "-d", ext]);
  const id = extId(ext);
  const P = key(), R = key(), X = key();
  const APP = "1ad17b45e12aabdec8ca08538ce1d3a795a7e68c3b87d534b50305d5654ca339";
  const cadir = tmpdir("pvm-ext-ca-"), ca = makeCa(cadir);
  const vm = await startFakeVm({ dir: cadir, ca, code: Buffer.from("6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990", "hex"), appId: APP });
  const carrier = createWebCarrier({ port: 0, evidencePort: vm.evidencePort, sealedPort: vm.sealedPort });
  await new Promise((r) => carrier.on("listening", r));
  const relay = `http://127.0.0.1:${carrier.address().port}`;
  const results = [];
  let policyDoc = null;
  const PIXEL_RID = sha('{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}');
  const sign = (K, serial, over = {}) => { const now = Date.now(); const t = JSON.stringify({ type: "enclave-pvm-client-policy", key: K.pub, serial, notBefore: iso(now - 3600e3), notAfter: iso(now + 86400e3),
    codeHashes: ["6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990"], authorityHashes: ["cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f"], // gitleaks:allow -- public: sha512 of the TEST signing certificate
    runtimeIds: [PIXEL_RID], appIds: [APP], googleRootPins: ["6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"], formats: ["enclave-pvm-app-evidence/v2"],
    sealedModes: ["chunked"], sealedWindow: { seconds: 600, maxRequests: 256 }, minClientVersion: "0.1.0", nextPolicyKey: null, ...over });
    return { policy: Buffer.from(t).toString("base64"), sig: edSign(null, Buffer.concat([Buffer.from("enclave-pvm-client-policy-v1\n"), Buffer.from(t)]), K.k.privateKey).toString("hex") }; };
  const srv = http.createServer((q, s) => { let b = ""; q.on("data", (d) => { b += d; }); q.on("end", () => {
    if (q.url.split("?")[0] === "/policy") { s.writeHead(200, { "content-type": "application/json" }); return s.end(JSON.stringify(policyDoc)); }
    if (q.url === "/result") { try { results.push(JSON.parse(b)); } catch {} return s.end("ok"); }
    if (q.url === "/evil") {   // a site sends the browser to the extension's options page with the SITE's anchor
      const planted = `chrome-extension://${id}/options.html?install=1&policyKeyFp=${X.fp}&serialFloor=1&releaseKeyFp=${R.fp}&policyUrl=x&relayUrl=x&appId=${APP}&resultUrl=${encodeURIComponent(`http://127.0.0.1:${srv.address().port}/result`)}`;
      s.writeHead(200, { "content-type": "text/html" }); return s.end(`<script>location.href=${JSON.stringify(planted)}</script><a id="a" href="${planted}">x</a><script>setTimeout(()=>document.getElementById("a").click(),500)</script>`);
    }
    s.writeHead(404); s.end(); }); });
  const port = await listen(srv), base = `http://127.0.0.1:${port}`;
  const browse = async (url, ms = 6000, profile) => {
    // a SIGKILLed Chrome restores its tabs on the next launch, re-running earlier pages: clear the session files first
    for (const f of ["Sessions", "Current Session", "Current Tabs", "Last Session", "Last Tabs"]) fs.rmSync(path.join(profile, "Default", f), { recursive: true, force: true });
    const b = spawn(CFT, ["--headless=new", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, url], { detached: true, stdio: "ignore" });
    await wait(ms); try { process.kill(-b.pid, "SIGKILL"); } catch {} await wait(300);
  };
  try {
    // a site trying to plant its own anchor: the extension's pages are not reachable from the web
    const p0 = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-ext-prof-"));
    await browse(`${base}/evil`, 5000, p0);
    assert.equal(results.filter((r) => r.installed).length, 0, "no anchor was installed from a site");
    // and none was planted silently: on that same profile the user's own install still succeeds (an installed anchor is never replaced)
    await browse(`chrome-extension://${id}/options.html?install=1&policyKeyFp=${P.fp}&serialFloor=1&releaseKeyFp=${R.fp}&policyUrl=x&relayUrl=x&appId=${APP}&resultUrl=${encodeURIComponent(base + "/result")}`, 5000, p0);
    assert.deepEqual(results.filter((r) => r.installed).map((r) => r.anchor.policyKeyFp), [P.fp], `the profile the site visited had no anchor: ${JSON.stringify(results)}`);
    results.length = 0;
    // the user installs from the options page
    const prof = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-ext-prof-"));
    await browse(`chrome-extension://${id}/options.html?install=1&policyKeyFp=${P.fp}&serialFloor=1&releaseKeyFp=${R.fp}&policyUrl=${encodeURIComponent(base + "/policy")}&relayUrl=${encodeURIComponent(relay)}&appId=${APP}&resultUrl=${encodeURIComponent(base + "/result")}`, 5000, prof);
    assert.deepEqual(results.find((r) => r.installed)?.anchor, { policyKeyFp: P.fp, serialFloor: 1, releaseKeyFp: R.fp });
    // a policy signed by a key the anchor does not name: refused, nothing sent
    policyDoc = sign(X, 2);
    await browse(`chrome-extension://${id}/client.html?label=ext-foreign-policy&path=%2F`, 6000, prof);
    const outcome = (label) => results.find((r) => r.label === label && !r.event);   // the final result, not the policy-committed event
    const f = outcome("ext-foreign-policy");
    assert.ok(f, "the extension posted its outcome"); assert.equal(f.step, "policy"); assert.equal(f.sent, false); assert.match(f.refused, /anchor does not name/);
    assert.equal(f.extension, id);
    assert.equal(results.filter((r) => r.label === "ext-foreign-policy" && r.event).length, 0, "a refused policy is never committed");
    // the genuine policy, a VM outside Google's roots: refused at verify, nothing sent
    policyDoc = sign(P, 2);
    await browse(`chrome-extension://${id}/client.html?label=ext-non-google&path=%2F`, 6000, prof);
    const g = outcome("ext-non-google");
    // the genuine policy was committed durably BEFORE the evidence fetch (it posts policy-committed first), and verify then refused
    const gi = results.findIndex((r) => r.label === "ext-non-google" && r.event === "policy-committed");
    assert.ok(gi >= 0 && gi < results.indexOf(g), `policy-committed precedes the outcome: ${JSON.stringify(results)}`);
    assert.equal(results[gi].serial, 2); assert.equal(results[gi].gen, 2);
    assert.ok(g, "the extension posted its outcome"); assert.equal(g.step, "verify"); assert.equal(g.sent, false); assert.match(g.refused, /not a pinned Google attestation root/);
    assert.match(g.userAgent, /HeadlessChrome/);
    // deployments (since 0.4.0): the page lists the signed table, and a selection takes its app from it -- the CLI's rules
    const OTHER = "ee".repeat(32), D1 = "0x" + "d1".repeat(32), D2 = "0x" + "d2".repeat(32), D3 = "0x" + "d3".repeat(32);
    policyDoc = sign(P, 3, { appIds: [APP, OTHER], deployments: [{ id: D1, app: APP }, { id: D2, app: OTHER }] });
    const ev0 = vm.log.filter((l) => l.evidence).length;
    await browse(`chrome-extension://${id}/client.html?label=ext-list&deployments=1`, 6000, prof);
    const li = outcome("ext-list");
    assert.equal(li?.step, "list", JSON.stringify(li)); assert.deepEqual(li.deployments, [{ id: D1, app: APP }, { id: D2, app: OTHER }]); assert.equal(li.policySerial, 3);
    await browse(`chrome-extension://${id}/client.html?label=ext-dep&deployment=${D1}&path=%2F`, 6000, prof);
    const dp = outcome("ext-dep");
    assert.equal(dp?.step, "verify", JSON.stringify(dp)); assert.deepEqual(dp.deployment, { id: D1, app: APP, instance: null, bound: false }); assert.match(dp.refused, /not a pinned Google attestation root/);
    assert.equal(vm.log.filter((l) => l.evidence).length, ev0 + 1, "the selection reached the VM's evidence, for the table's app");
    for (const [lab, qs, why] of [["ext-dep-unknown", `deployment=${D3}`, /does not name deployment/], ["ext-dep-mismatch", `deployment=${D1}&app=${OTHER}`, /is not the app the policy expects/],
                                  ["ext-dep-twice", `deployment=${D1}&deployment=${D2}`, /more than once: ambiguous/]]) {
      await browse(`chrome-extension://${id}/client.html?label=${lab}&${qs}&path=%2F`, 6000, prof);
      const o = outcome(lab);
      assert.equal(o?.step, "select", JSON.stringify([lab, o])); assert.match(o.refused, why); assert.equal(o.sent, false);
    }
    assert.equal(vm.log.filter((l) => l.evidence).length, ev0 + 1, "no refused selection asked for evidence");
    const labels = results.filter((r) => r.label && !r.event).map((r) => r.label);
    assert.equal(labels.length, new Set(labels).size, `each page ran exactly once (no restored tab re-ran one): ${labels}`);
    assert.equal(vm.log.filter((l) => l.served).length, 0, "no request reached the VM");
  } finally { srv.close(); carrier.close(); vm.close(); }
});
