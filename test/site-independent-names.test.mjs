// Owner-committed names in the browser (site/js/core/startup-package.js) against the SHARED vectors the measured guest's
// Go check and the SDK read (isolation/m2/bootstrap/testdata/names-vectors.json): the browser must accept and refuse
// exactly the same packages, derive the same challenge aliases, and build - from explicit form input only - the very
// bytes the SDK/CLI prepare. No CA, responder or zone is ever filled in for the owner.
//   run: node --test test/site-independent-names.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as SDK from "../sdk/bootstrap/package.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nv = JSON.parse(fs.readFileSync(path.join(REPO, "isolation/m2/bootstrap/testdata/names-vectors.json"), "utf8"));
const intentOf = (s) => ({ version: 1, sha256: createHash("sha256").update(s).digest("hex") });
let SP;
test.before(async () => {
  globalThis.localStorage ??= { getItem: () => null, setItem(){}, removeItem(){} };
  globalThis.sessionStorage ??= globalThis.localStorage;
  globalThis.location ??= { hostname: "localhost" };
  SP = await import(pathToFileURL(path.join(REPO, "site/js/core/startup-package.js")).href);
});

test("the browser accepts and refuses exactly the shared Go/JS name vectors, as the SDK does", async () => {
  assert.ok(nv.cases.length >= 30 && nv.cases.some((c) => c.valid) && nv.cases.some((c) => !c.valid));
  for (const c of nv.cases){
    let browser = null, sdk = null;
    try { await SP.verifyPackage(new TextEncoder().encode(c.manifest), intentOf(c.manifest)); } catch (e){ browser = e; }
    try { SDK.verifyPackage(Buffer.from(c.manifest), intentOf(c.manifest)); } catch (e){ sdk = e; }
    assert.equal(browser === null, c.valid, `${c.name}: browser ${browser ? browser.message : "accepted"}`);
    assert.equal(browser === null, sdk === null, `${c.name}: browser and SDK agree`);
  }
});

test("the browser derives the shared challenge aliases (owner-bound, case-insensitive owner)", async () => {
  for (const a of nv.aliases){
    assert.equal(await SP.challengeLabel(a.deployment, a.owner), a.label);
    assert.equal(await SP.challengeAlias(a.deployment, a.owner, a.zone), a.alias);
  }
  assert.notEqual(nv.aliases[0].label, nv.aliases[1].label);
});

test("every valid vector's name set round-trips through the Startup form into the SDK's exact package bytes", async () => {
  let checked = 0;
  for (const c of nv.cases.filter((x) => x.valid)){
    const m = JSON.parse(c.manifest);
    if (!m.names) continue;
    const a = m.names.acme || {};
    // what an owner types: names in any order and case, and the CA selection field by field
    const form = { hostsText: [...m.names.hosts].reverse().map((h, i) => (i % 2 ? h.toUpperCase() : h)).join("\n"),
      directory: a.directory || "", challenge: a.challenge || "", zone: a.zone || "", eabKid: a.eab ? a.eab.kid : "", eabHmac: a.eab ? a.eab.hmac : "" };
    const names = SP.namesFromForm(form, m.secretsMode);
    assert.equal(JSON.stringify(names), JSON.stringify(m.names), c.name + ": the same member, in the same key order");
    const scope = { chainId: m.chainId, ledger: m.ledger, deployment: m.deployment, owner: m.owner, appRef: m.appRef };
    const pkg = await SP.preparePackage(scope, { appId: m.appId, runtimeId: m.runtimeId, configText: m.configText, custody: m.custody || null, names });
    assert.equal(Buffer.from(pkg.bytes).toString(), SDK.preparePackage(m).bytes.toString(), c.name + ": byte-identical to the SDK/CLI");
    checked++;
  }
  assert.ok(checked >= 3, "several named vectors were round-tripped (" + checked + ")");
});

test("explicit choices only: no default CA, responder or zone; a partial selection is refused; Enclave-run choices are named", () => {
  const only = SP.namesFromForm({ hostsText: "shop.example.com" }, "public");
  assert.deepEqual(only, { hosts: ["shop.example.com"] }, "names without a CA selection carry no acme member at all");
  for (const partial of [{ directory: "https://ca.example.org/dir" }, { challenge: "https://r.example.net" }, { zone: "acme.example.net" },
                         { directory: "https://ca.example.org/dir", challenge: "https://r.example.net" }])
    assert.throws(() => SP.namesFromForm({ hostsText: "shop.example.com", ...partial }, "public"), /owner ACME selection needs/, JSON.stringify(partial));
  assert.throws(() => SP.namesFromForm({ hostsText: "", directory: "https://ca.example.org/dir" }, "public"), /ACME settings need at least one name/);
  assert.throws(() => SP.namesFromForm({ hostsText: "app.enclave.host" }, "public"), /outside enclave.host/);
  const sel = (d, c, z) => SP.namesFromForm({ hostsText: "shop.example.com", directory: d, challenge: c, zone: z }, "public");
  assert.deepEqual(SP.enclaveOperatedSelection(sel("https://ca.example.org/dir", "https://r.example.net", "acme.example.net")), []);
  assert.deepEqual(SP.enclaveOperatedSelection(sel("https://acme.enclave.host/dir", "https://challenge.enclave.host", "acme.enclave.host")), ["directory", "challenge", "zone"]);
  assert.deepEqual(SP.enclaveOperatedSelection(sel("https://ca.example.org/dir", "https://r.example.net", "acme.enclave.host")), ["zone"],
    "an Enclave zone is accepted by the schema, and named to the owner");
  assert.deepEqual(SP.enclaveOperatedSelection(only), []);
});
