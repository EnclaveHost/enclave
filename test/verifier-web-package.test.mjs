// The browser artifact's packaging (verifier/web/build.mjs, reproduce.mjs, notices.mjs): the committed bundle rebuilds byte
// for byte from the tree with the pinned esbuild; its manifest names every bundled input with its hash and the build options;
// the notices are generated from those exact inputs (transitive packages and the Buffer stand-in included) with each LICENSE
// file's text; and each of these fails closed when tampered with, so a stale artifact, an edited manifest or a hand-edited
// notice can never pass the strict command.
//   run: node --test test/verifier-web-package.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildWeb, manifestFor, noticesOf, DIST, ARTIFACT, MANIFEST, NOTICES, OPTIONS } from "../verifier/web/build.mjs";
import { reproduceWeb } from "../verifier/web/reproduce.mjs";
import { noticesFor, packagesOf } from "../verifier/web/notices.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const manifest = JSON.parse(fs.readFileSync(path.join(DIST, MANIFEST), "utf8"));

test("the committed artifact reproduces from the tree: bytes, manifest, every input hash, build options and notices", async () => {
  const r = await reproduceWeb();
  assert.deepEqual(r.problems, []); assert.equal(r.ok, true);
  assert.equal(sha(fs.readFileSync(path.join(DIST, ARTIFACT))), manifest.artifact.sha256);
  const b = await buildWeb({ outfile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "web-pkg-")), ARTIFACT) });
  assert.deepEqual(manifestFor(b), manifest, "a fresh build's manifest is the committed one");
  assert.equal(manifest.build.tool, "esbuild"); assert.equal(manifest.build.version, JSON.parse(fs.readFileSync(path.join(REPO, "node_modules/esbuild/package.json"), "utf8")).version, "the pinned esbuild");
  assert.deepEqual({ ...manifest.build, version: undefined, tool: undefined }, { ...OPTIONS, version: undefined, tool: undefined });
  assert.ok(manifest.inputs.length >= 60 && manifest.inputs.every((i) => /^[0-9a-f]{64}$/.test(i.sha256) && !path.isAbsolute(i.path)), "every input hashed, relative paths only");
  for (const p of ["verifier/snp.mjs", "relay/snp-verify.mjs", "verifier/web/x509.mjs", "verifier/web/shims/node-crypto.mjs", "verifier/web/shims/buffer-global.mjs"]) assert.ok(manifest.inputs.some((i) => i.path === p), p);
  const cli = spawnSync(process.execPath, [path.join(REPO, "verifier/web/reproduce.mjs")], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /REPRODUCED with esbuild/);
});

test("tampering fails closed: a changed artifact byte, an edited input record, other build options, a stale notice and a missing notice each refuse reproduction by name", async () => {
  const copy = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "web-tamper-")); for (const f of [ARTIFACT, MANIFEST, NOTICES]) fs.copyFileSync(path.join(DIST, f), path.join(d, f)); return d; };
  const run = (d) => { const r = spawnSync(process.execPath, [path.join(REPO, "verifier/web/reproduce.mjs"), "--dist", d], { encoding: "utf8" }); return { status: r.status, err: r.stderr }; };
  let d = copy(); { const b = fs.readFileSync(path.join(d, ARTIFACT)); b[100] ^= 1; fs.writeFileSync(path.join(d, ARTIFACT), b); }
  let r = run(d); assert.equal(r.status, 1); assert.match(r.err, /artifact on disk .* is not what the manifest records/);
  d = copy(); { const m = JSON.parse(fs.readFileSync(path.join(d, MANIFEST), "utf8")); m.inputs[0].sha256 = "0".repeat(64); fs.writeFileSync(path.join(d, MANIFEST), JSON.stringify(m)); }
  r = run(d); assert.equal(r.status, 1); assert.match(r.err, /input .* differs from its manifest record/);
  d = copy(); { const m = JSON.parse(fs.readFileSync(path.join(d, MANIFEST), "utf8")); m.build.minify = false; fs.writeFileSync(path.join(d, MANIFEST), JSON.stringify(m)); }
  r = run(d); assert.equal(r.status, 1); assert.match(r.err, /build tool or options differ/);
  d = copy(); { const m = JSON.parse(fs.readFileSync(path.join(d, MANIFEST), "utf8")); m.inputs.push({ path: "verifier/web/nothing.mjs", bytes: 1, sha256: "1".repeat(64) }); fs.writeFileSync(path.join(d, MANIFEST), JSON.stringify(m)); }
  r = run(d); assert.equal(r.status, 1); assert.match(r.err, /manifest input verifier\/web\/nothing.mjs is no longer bundled/);
  d = copy(); fs.appendFileSync(path.join(d, NOTICES), "\nedited by hand\n");
  r = run(d); assert.equal(r.status, 1); assert.match(r.err, /notices differ from a fresh generation/);
  d = copy(); fs.rmSync(path.join(d, NOTICES));
  r = run(d); assert.equal(r.status, 1); assert.match(r.err, /notices file missing/);
  d = copy(); fs.rmSync(path.join(d, MANIFEST));
  r = run(d); assert.equal(r.status, 1); assert.match(r.err, /manifest unreadable/);
});

test("the notices name every third-party package in the bundle with its exact version, LICENSE file text and bundled files, transitive ones included, and state the sigstore-browser license discrepancy", () => {
  const notices = fs.readFileSync(path.join(DIST, NOTICES), "utf8");
  const { third, first } = packagesOf(manifest.inputs.map((i) => i.path), { repo: REPO });
  assert.ok(third.length >= 8, `${third.length} third-party packages`);
  for (const p of third) {
    assert.ok(notices.includes(`### ${p.name}@${p.version}`), `${p.name}@${p.version} has a heading`);
    assert.ok(notices.includes(p.licenseText.replace(/\s+$/, "")), `${p.name}: its LICENSE text is reproduced`);
    for (const f of p.files) assert.ok(notices.includes(`\`${f.slice(p.dir.length + 1)}\``), `${p.name}: bundled file ${f} listed`);
  }
  for (const name of ["buffer", "base64-js", "ieee754", "@freedomofpress/sigstore-browser", "@freedomofpress/crypto-browser", "@noble/curves", "@noble/hashes"]) assert.ok(third.some((p) => p.name === name), `${name} is a bundled package`);
  const sb = third.find((p) => p.name === "@freedomofpress/sigstore-browser");
  assert.equal(sb.declared, "MIT"); assert.equal(sb.fileKind, "Apache-2.0");
  assert.match(notices, /### @freedomofpress\/sigstore-browser@[^\n]+\n\n- package.json license: MIT; LICENSE file: `LICENSE` \(Apache-2.0 text\)\n- NOTE: package.json declares MIT but the LICENSE file is the Apache-2.0 text; the file governs/);
  for (const f of first) assert.ok(notices.includes(`- \`${f}\``), `first-party ${f} listed`);
  assert.ok(!/\/home\/|\/tmp\//.test(notices), "no absolute paths");
  assert.equal(noticesOf({ inputs: manifest.inputs, esbuild: manifest.build.version }), notices, "regenerates identically from the manifest's inputs");
  // every bundled node_modules input is accounted to exactly one package
  const accounted = new Set(third.flatMap((p) => p.files));
  for (const i of manifest.inputs) if (i.path.includes("node_modules/")) assert.ok(accounted.has(i.path), `${i.path} accounted`);
});

test("a package without a LICENSE file cannot be noticed: generation throws, so such a bundle is never packaged (fail closed)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "web-nolic-"));
  fs.mkdirSync(path.join(repo, "node_modules/nolic"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules/nolic/package.json"), JSON.stringify({ name: "nolic", version: "1.0.0", license: "MIT" }));
  fs.writeFileSync(path.join(repo, "node_modules/nolic/index.js"), "export default 1;\n");
  assert.throws(() => noticesFor(["node_modules/nolic/index.js"], { repo }), /nolic@1.0.0 .* has no LICENSE file/);
  fs.writeFileSync(path.join(repo, "node_modules/nolic/LICENSE"), "MIT License\n\nPermission is hereby granted, free of charge, to any person\n");
  const n = noticesFor(["node_modules/nolic/index.js", "verifier/x.mjs"], { repo });
  assert.match(n, /### nolic@1.0.0\n\n- package.json license: MIT; LICENSE file: `LICENSE` \(MIT text\)\n- bundled files \(1\): `index.js`/);
  assert.ok(n.includes("- `verifier/x.mjs`"));
  // a nested copy is its own package, keyed by its own package.json
  fs.mkdirSync(path.join(repo, "node_modules/outer/node_modules/@sc/inner"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules/outer/package.json"), JSON.stringify({ name: "outer", version: "2.0.0", license: "MIT" })); fs.writeFileSync(path.join(repo, "node_modules/outer/LICENSE"), "MIT License\nPermission is hereby granted, free of charge\n");
  fs.writeFileSync(path.join(repo, "node_modules/outer/node_modules/@sc/inner/package.json"), JSON.stringify({ name: "@sc/inner", version: "3.1.4", license: "BSD-3-Clause" })); fs.writeFileSync(path.join(repo, "node_modules/outer/node_modules/@sc/inner/LICENSE"), "Redistribution and use in source and binary forms\n");
  const { third } = packagesOf(["node_modules/outer/node_modules/@sc/inner/lib/a.js", "node_modules/outer/x.js"], { repo });
  assert.deepEqual(third.map((p) => `${p.name}@${p.version}:${p.dir}`), ["@sc/inner@3.1.4:node_modules/outer/node_modules/@sc/inner", "outer@2.0.0:node_modules/outer"]);
});
