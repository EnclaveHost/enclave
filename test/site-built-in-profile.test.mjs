// The site build's optional built-in network profile (scripts/site-built-in-profile.mjs, used by scripts/build-site.mjs):
// only an exact, reviewed, parser-valid profile file is accepted, and the bundled independent.js then carries exactly
// that text as BUILT_IN_PROFILE_TEXT - which a browser with empty storage loads as its built-in profile.
//   run: node --test test/site-built-in-profile.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parseBuildArgs, readBuiltInProfile, builtInProfilePlugin, BUILT_IN_DECLARATION } from "../scripts/site-built-in-profile.mjs";
import { loadProfileState, BUILT_IN_PROFILE_TEXT, PROFILE_KEY } from "../site/js/core/independent.js";

const a = (b) => "0x" + b.repeat(20);
// a synthetic profile in the shape of test/site-independent-profile.test.mjs's sample (not imported: that would re-run its tests)
const sampleProfile = (over = {}) => ({
  format: "enclave-browser-profile", version: 1, name: "test network", chainId: 8453,
  rpcs: ["https://rpc-a.example", "https://rpc-b.example", "https://rpc-c.example"], quorum: 2, confirmations: 2,
  contractPins: { version: 1, chainId: 8453, contracts: { registry: a("11"), deployments: a("22"), appCatalog: a("33"), proofOfTime: a("44"),
    enclavePay: a("00"), verificationFees: a("00"), sessionVaultFactory: a("55"), secretVaultV2: a("00") } },
  usdc: a("66"),
  storage: { version: 1, minimumCopies: 2, replicas: [
    { upload: "https://s1.example/add-json", audience: "0x" + "01".repeat(32), gateway: "https://s1.example/ipfs" },
    { upload: "https://s2.example/add-json", audience: "0x" + "02".repeat(32), gateway: "https://s2.example/ipfs" }] },
  directories: ["https://dir-a.example"],
  ...over,
});

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(REPO, "site");
const sha = (b) => "sha256:" + createHash("sha256").update(b).digest("hex");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "built-in-profile-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const file = (name, bytes) => { const f = path.join(tmp, name); fs.writeFileSync(f, bytes); return f; };
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
// a profile text with characters a careless embedding would break: quotes, backslashes, U+2028, "</script>", "${"
const TRICKY = JSON.stringify(sampleProfile({ name: "réseau \"test\" \\   </script> ${x} `" , addressBook: "0x" + "ab".repeat(20) }), null, 2) + "\n";

test("build arguments: none (unchanged build), both flags, or a refusal", () => {
  assert.deepEqual(parseBuildArgs([]), { file: null, digest: null });
  assert.deepEqual(parseBuildArgs(["--built-in-profile", "p.json", "--built-in-profile-digest", "sha256:" + "0".repeat(64)]), { file: "p.json", digest: "sha256:" + "0".repeat(64) });
  for (const [argv, re] of [
    [["--built-in-profile", "p.json"], /go together/],
    [["--built-in-profile-digest", "sha256:" + "0".repeat(64)], /go together/],
    [["--built-in-profile"], /needs a value/],
    [["--built-in-profile", "--built-in-profile-digest", "x"], /needs a value/],
    [["--built-in-profile", "a", "--built-in-profile", "b"], /given twice/],
    [["--profile", "p.json"], /unknown build argument/],
    [["p.json"], /unknown build argument/],
  ]) assert.throws(() => parseBuildArgs(argv), re, JSON.stringify(argv));
});

test("a profile file is accepted only with its reviewed digest, as UTF-8, and when the dashboard's parser accepts it", () => {
  const good = file("good.json", TRICKY);
  const r = readBuiltInProfile(good, sha(TRICKY));
  assert.equal(r.text, TRICKY, "the exact text, not a re-serialization");
  assert.equal("sha256:" + r.fingerprint, sha(TRICKY));
  assert.equal(r.profile.addressBook, "0x" + "ab".repeat(20));
  const bad = (name, bytes, re, digest = sha(bytes)) => assert.throws(() => readBuiltInProfile(file(name, bytes), digest), re, name);
  assert.throws(() => readBuiltInProfile(good, sha(TRICKY + " ")), /not the reviewed/);
  assert.throws(() => readBuiltInProfile(good, sha(TRICKY).toUpperCase()), /64 lower-case hex/);
  assert.throws(() => readBuiltInProfile(good, "sha256:abc"), /64 lower-case hex/);
  assert.throws(() => readBuiltInProfile(tmp, sha("")), /not a file/);
  bad("not-json.json", "{ not json", /not a usable browser profile/);
  bad("dup.json", TRICKY.replace('"format"', '"version": 1, "format"'), /duplicate key/);
  bad("one-rpc.json", JSON.stringify(sampleProfile({ rpcs: ["https://rpc-a.example"] })), /2–8 RPC origins/);
  bad("unknown.json", JSON.stringify({ ...sampleProfile(), extra: 1 }), /unknown field/);
  bad("http-rpc.json", JSON.stringify(sampleProfile({ rpcs: ["http://rpc-a.example", "https://rpc-b.example"] })), /HTTPS/);
  bad("latin1.json", Buffer.concat([Buffer.from(TRICKY.slice(0, 40)), Buffer.from([0xe9]), Buffer.from(TRICKY.slice(40))]), /not UTF-8/);
  bad("bom.json", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TRICKY)]), /not a usable browser profile/);
  bad("huge.json", JSON.stringify(sampleProfile({ name: "x" })) + " ".repeat(33000), /larger than/);
});

test("the bundled independent.js carries exactly the reviewed text, and an empty browser loads it as its built-in profile", async () => {
  assert.equal(BUILT_IN_PROFILE_TEXT, null, "the source tree keeps no built-in profile");
  assert.equal(fs.readFileSync(path.join(SITE, "js/core/independent.js"), "utf8").split(BUILT_IN_DECLARATION).length, 2);
  const bundle = async (plugins, name) => {
    const out = path.join(tmp, name);
    await build({ entryPoints: [path.join(SITE, "js/core/independent.js")], bundle: true, format: "esm", target: ["es2022"], minify: true,
      platform: "browser", outfile: out, plugins, logLevel: "silent" });
    return import(pathToFileURL(out).href);
  };
  const M = await bundle([builtInProfilePlugin(TRICKY, SITE)], "with.mjs");
  assert.equal(M.BUILT_IN_PROFILE_TEXT, TRICKY);
  const st = M.loadProfileState(mem(), undefined, mem());
  assert.equal(st.state, "on"); assert.equal(st.source, "built-in"); assert.equal(st.text, TRICKY);
  assert.equal(st.profile.addressBook, "0x" + "ab".repeat(20), "an address-book profile keeps following its book");
  assert.equal("sha256:" + (await M.profileFingerprint(st.text)), sha(TRICKY), "the dashboard shows the reviewed digest");
  // a profile the user saved still takes precedence (and still needs this tab's confirmation)
  const saved = mem(); saved.setItem(PROFILE_KEY, JSON.stringify(sampleProfile({ name: "mine" })));
  const st2 = M.loadProfileState(saved, undefined, mem());
  assert.equal(st2.source, "saved"); assert.equal(st2.state, "unconfirmed");
  // without the plugin the bundle is today's: no built-in profile, the hosted defaults
  const N = await bundle([], "without.mjs");
  assert.equal(N.BUILT_IN_PROFILE_TEXT, null);
  assert.equal(loadProfileState(mem(), N.BUILT_IN_PROFILE_TEXT, mem()).state, "off");
});

test("the embedding refuses a module whose declaration is missing or repeated", async () => {
  for (const [name, src] of [["missing", "export const BUILT_IN_PROFILE_TEXT = undefined;\n"], ["twice", BUILT_IN_DECLARATION + "\n// " + BUILT_IN_DECLARATION + "\n"]]) {
    const site = path.join(tmp, "site-" + name), f = path.join(site, "js/core/independent.js");
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, src);
    await assert.rejects(build({ entryPoints: [f], bundle: true, write: false, format: "esm", plugins: [builtInProfilePlugin(TRICKY, site)], logLevel: "silent" }),
      /expected exactly one/, name);
  }
});
