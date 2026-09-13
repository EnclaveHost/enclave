// "Add version" must prefill the REAL config, never the routing manifest.
//
// On a catalog rev-7 version the on-chain `config` field is not the config: it
// is the routing manifest ({wasi, threads, set, gpuOptional, volumes, _media},
// a couple of hundred bytes) and the config itself lives at versionConfigCid.
// publishPrefillOf used to read the inline field, so "add version" filled the
// form with the manifest — and the form IS the publish payload, so pressing
// Publish wrote the manifest as the new version's config.
//
// That is not a display bug. eyesoff-ai 1.0.13 shipped that way on 2026-08-11:
// 1.0.12 carried a 6,996-byte config at bafkreiektgu…, 1.0.13 carried 269 bytes
// of manifest, and nothing in the flow said a word. The version is immutable,
// so the only remedy is republishing.
//
// apps.js imports browser modules, so this lifts the function out of the page
// source and runs it against stubs — same approach as publish-cid-verify.
//
//   run: node --test test/publish-prefill-config.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(REPO, "site/js/pages/apps.js"), "utf8");

// The real 269-byte manifest eyesoff-ai 1.0.13 was published with, and the
// shape of the config that should have been carried across instead.
const MANIFEST = JSON.stringify({
  wasi: "0.2", gpuOptional: true, volumes: ["fable-fusion-27b-mtp-q4-gguf"],
  _media: { thumbnail: "bafkreia4w", thumbnailSvg: true, banner: "bafkreib65", bannerSvg: true },
});
const REAL = JSON.stringify({
  vision_service: { endpoint: "https://9f8947ec.app.enclave.host", timeout_s: 120 },
  search: { provider: "exa", max_results: 6, default_on: true },
  models: { primary: "fable-fusion-27b" }, nnCtx: 32768,
  wasi: "0.2", gpuOptional: true, volumes: ["fable-fusion-27b-mtp-q4-gguf"],
});

function loadPrefill(fetchConfigCid) {
  const start = SRC.indexOf("async function publishPrefillOf(");
  assert.ok(start > 0, "apps.js no longer defines publishPrefillOf");
  const end = SRC.indexOf("\n}\n", start) + 3;
  const body = SRC.slice(start, end);
  // everything it closes over, stubbed to identity/known values so the
  // assertions are about the config path and nothing else
  // cpuFallbackOfConfig is the REAL one, lifted out of catalog.js the same way
  // (that module can't be imported here - it touches `document` at load). It
  // reads the same config this test is about, so stubbing it would hide the
  // one thing worth checking: which config the coreless sizing comes from.
  return new Function("fetchConfigCid", "mediaOf", "nextFreeVersion", "prettyConfig", "stripMedia",
    "cpuFallbackOfConfig",
    body + "; return publishPrefillOf;")(
      fetchConfigCid, () => ({}), () => "9.9.9", (s) => s, (s) => s, loadCpuFallbackOfConfig());
}

const CATALOG_SRC = fs.readFileSync(path.join(REPO, "site/js/core/catalog.js"), "utf8");
function loadCpuFallbackOfConfig() {
  const start = CATALOG_SRC.indexOf("export function cpuFallbackOfConfig(");
  assert.ok(start > 0, "catalog.js no longer defines cpuFallbackOfConfig");
  const end = CATALOG_SRC.indexOf("\n}\n", start) + 3;
  return new Function(CATALOG_SRC.slice(start, end).replace("export ", "")
    + "; return cpuFallbackOfConfig;")();
}

const appWith = (v) => ({ slug: "eyesoff-ai", name: "EyesOff AI", description: "", active: true, versions: [v] });

test("a rev-7 version prefills from its configCid, not from the inline manifest", async () => {
  let asked = null;
  const prefill = loadPrefill(async (cid) => { asked = cid; return REAL; });
  const s = await prefill(appWith({ version: "1.0.12", cid: "ipfs://x",
    config: MANIFEST, configCid: "bafkreiektgu" }), 0);

  assert.equal(asked, "bafkreiektgu", "the version's configCid must actually be fetched");
  assert.equal(s.config, REAL, "the form must carry the real config");
  assert.notEqual(s.config, MANIFEST, "prefilling the routing manifest is the bug this file exists to catch");
  assert.ok(s.config.includes("vision_service"),
    "the keys that only exist in the off-chain config must survive into the form");
});

test("an unreadable configCid empties the box loudly - it never degrades to the manifest", async () => {
  const prefill = loadPrefill(async () => null);          // gateway down / not pinned
  const s = await prefill(appWith({ version: "1.0.12", cid: "ipfs://x",
    config: MANIFEST, configCid: "bafkreiektgu" }), 0);

  assert.equal(s.config, "", "a failed fetch must leave the box EMPTY");
  assert.notEqual(s.config, MANIFEST,
    "falling back to the inline field is exactly how a 6,996-byte config became 269 bytes");
  assert.match(s.note, /bafkreiektgu/, "the note must name the CID that could not be loaded");
  assert.match(s.note, /publish/i, "the note must warn that publishing now drops the config");
});

test("a pre-rev-7 version still prefills from its inline config, unchanged", async () => {
  let called = false;
  const prefill = loadPrefill(async () => { called = true; return null; });
  const inline = JSON.stringify({ backend: "ggml", model_volume: "qwen2.5-0.5b" });
  const s = await prefill(appWith({ version: "1.0.9", cid: "ipfs://x", config: inline }), 0);

  assert.equal(s.config, inline, "without a configCid the inline field IS the config");
  assert.equal(called, false, "no CID means no fetch");
  assert.doesNotMatch(s.note, /could not load/, "nothing failed, so nothing to warn about");
});

test("gpuOptional is read from the resolved config, not the stale inline field", async () => {
  // the manifest carries gpuOptional too, so a wrong read is invisible until
  // the two disagree - which they do the moment a publisher flips the switch
  const prefill = loadPrefill(async () => JSON.stringify({ tools: {}, gpuOptional: false }));
  const s = await prefill(appWith({ version: "1.0.12", cid: "ipfs://x",
    config: MANIFEST, configCid: "bafkreiektgu" }), 0);
  assert.equal(s.gpuOptional, false,
    "the switch must reflect the config the publisher will actually ship");
});

test("cpuFallback comes from the resolved config too, and survives an add-version", async () => {
  // The coreless sizing has the same hazard as gpuOptional one key over: it is
  // a ROUTING key, so it lives in the on-chain manifest AND in the real config,
  // and the two disagree the moment a publisher edits one. Reading the stale
  // manifest would re-publish a node floor the publisher had already changed —
  // and silently, since nothing downstream can tell the figures apart.
  const prefill = loadPrefill(async () => JSON.stringify({
    tools: {}, gpuOptional: true, cpuFallback: { memMb: 40960, cpuGflops: 400 } }));
  const s = await prefill(appWith({ version: "1.0.12", cid: "ipfs://x",
    config: JSON.stringify({ wasi: "0.2", gpuOptional: true, cpuFallback: { memMb: 8192 } }),
    configCid: "bafkreiektgu" }), 0);
  assert.deepEqual(s.cpuFallback, { memMb: 40960, cpuGflops: 400 },
    "the figures the publisher will actually ship, not the manifest's stale copy");

  // a version that declares none prefills none — the fields come up at 0 and
  // the next publish carries no key, exactly like every version before this
  const bare = loadPrefill(async () => JSON.stringify({ tools: {}, gpuOptional: true }));
  const b = await bare(appWith({ version: "1.0.12", cid: "ipfs://x",
    config: MANIFEST, configCid: "bafkreiektgu" }), 0);
  assert.equal(b.cpuFallback, null);
});
