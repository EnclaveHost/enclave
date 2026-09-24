// The LAB browser channel in a REAL browser (headless Chromium, when installed): the site serves the page and its pins
// (web/lab-site.mjs), the page fetches evidence and sends a sealed request through the relay's carrier
// (cpu/web-carrier.mjs) to a FAKE VM (test/fixtures/pvm-fake-vm.mjs: the real wire protocol over a synthetic chain).
// What this shows: WebCrypto X25519/Ed25519/ECDSA/HKDF/AES-GCM, CORS and the site's CSP all work in the browser, the page
// refuses a VM running another app, and nothing is sent to it. The phone run is the evidence for the real VM.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { haveOpenssl, tmpdir, makeCa, AUTH } from "./fixtures/avf-synthetic.mjs";
import { startFakeVm } from "./fixtures/pvm-fake-vm.mjs";
import { createWebCarrier } from "../shielded/anchor/avf/cpu/web-carrier.mjs";

const chromium = (() => { for (const b of ["chromium", "chromium-browser", "google-chrome"]) { try { execFileSync("which", [b], { stdio: "pipe" }); return b; } catch {} } return null; })();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const up = (srv) => new Promise((r) => (srv.listening ? r(srv.address().port) : srv.on("listening", () => r(srv.address().port))));

test("a real browser verifies the (fake) VM, seals its request, and refuses another app", { skip: (!chromium && "no chromium") || (!haveOpenssl && "no openssl"), timeout: 120000 }, async () => {
  const dir = tmpdir("pvm-browser-");
  const ca = makeCa(dir);
  const CODE = createHash("sha256").update("pvm-cpu protected build").digest();
  const APP = createHash("sha256").update("ggml-probe").digest("hex");
  const vm = await startFakeVm({ dir, ca, code: CODE, appId: APP });
  const results = path.join(dir, "results.jsonl");
  // the site: a separate origin from the relay's carrier
  const site = spawn(process.execPath, [new URL("../shielded/anchor/avf/web/lab-site.mjs", import.meta.url).pathname, "--port", "0", "--results", results,
    "--app", APP, "--code-hash", CODE.toString("hex"), "--authority", AUTH.toString("hex"), "--root-pin", ca.rootPin, "--connect", "http://127.0.0.1:*"], { stdio: ["ignore", "pipe", "inherit"] });
  const siteUrl = await new Promise((r) => site.stdout.on("data", (d) => { const m = /"site":"([^"]+)"/.exec(String(d)); if (m) r(m[1]); }));
  const siteOrigin = new URL(siteUrl).origin;
  const carrier = createWebCarrier({ port: 0, origin: siteOrigin, evidencePort: vm.evidencePort, sealedPort: vm.sealedPort });
  const relay = `http://127.0.0.1:${await up(carrier)}`;
  const run = async (label, extra = "") => {
    const prof = fs.mkdtempSync(path.join(dir, "prof-"));
    const b = spawn(chromium, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions", `--user-data-dir=${prof}`,
      `${siteUrl}?relay=${encodeURIComponent(relay)}&label=${label}&path=${encodeURIComponent("/?graph=g&steps=3")}${extra}`], { detached: true, stdio: "ignore" });
    try {
      for (let i = 0; i < 300; i++) {
        const got = fs.existsSync(results) && fs.readFileSync(results, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.label === label);
        if (got) return got;
        await wait(100);
      }
      throw new Error(`no result for ${label}`);
    } finally { try { process.kill(-b.pid, "SIGKILL"); } catch {} }
  };
  try {
    const ok = await run("honest");
    assert.equal(ok.status, 200, JSON.stringify(ok));
    assert.equal(ok.body, '{"tokens":[1,2,3],"fake":true}');
    assert.equal(ok.verified.format, "enclave-pvm-app-evidence/v2");
    assert.match(ok.userAgent, /Chrome\//);
    assert.ok(vm.log.some((l) => l.served === "GET /?graph=g&steps=3 HTTP/1.1"), "the fake VM opened the page's request");
    const st = await run("stream-honest", "&mode=stream&trace=1");
    assert.equal(st.complete, true, JSON.stringify(st)); assert.equal(st.status, 200);
    assert.equal(st.tokens, 3); assert.deepEqual(st.lines.map((l) => JSON.parse(l).token), [7, 8, 9]);
    assert.match(st.trace.exported, /^[0-9a-f]{32}$/, "a lab trace carries the context to re-open the stream offline");
    assert.ok(vm.log.some((l) => l.served && l.chunked), "the fake VM answered a chunked request");
    const n = vm.log.filter((l) => l.served).length;
    const wrong = await run("wrong-app", `&app=${"e".repeat(64)}`);
    assert.equal(wrong.sent, false); assert.equal(wrong.step, "verify"); assert.match(wrong.refused, /another app/);
    assert.equal(vm.log.filter((l) => l.served).length, n, "nothing reached the VM from a refusing page");
  } finally { site.kill(); carrier.close(); vm.close(); }
});
