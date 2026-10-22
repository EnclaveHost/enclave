// extract-site-blocks.mjs against the REAL published site CAR (the IPNS target, bafybeieuxt6…; byte-identical to what the
// fronts serve: 35,127,042 bytes) and tampered copies of it. Run by serving-job.sh with PKG=<package dir>.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { extract, blocksOf, cidString, cidBytes } from "../extract-site-blocks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = process.env.PKG;
const ROOT = path.basename(PKG);
const tmp = (n) => { const d = path.join(here, "..", "run-unit", n); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };
const sitesWith = (name, car) => { const s = tmp(name), d = path.join(s, "sites", ROOT); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "site.car"), car); return path.join(s, "sites"); };
const CAR = fs.readFileSync(path.join(PKG, "site.car"));

test("the real site CAR: every block written once as <out>/ipfs/<cid>, hash-verified, root included; a re-run writes nothing", () => {
  const out = path.join(tmp("happy"), "blocks");
  const a = extract({ sites: path.dirname(PKG), out, cids: [ROOT] });
  const files = fs.readdirSync(path.join(out, "ipfs"));
  assert.equal(a.written, files.length); assert.ok(files.includes(ROOT)); assert.ok(files.length > 100);
  for (const f of files) {
    const b = cidBytes(f), data = fs.readFileSync(path.join(out, "ipfs", f));
    assert.equal(cidString(b), f, "base32 round trip");
    assert.ok(createHash("sha256").update(data).digest().equals(b.subarray(4)), f + " hashes to its CID");
  }
  assert.ok(fs.readFileSync(path.join(out, "ipfs", ROOT)).equals(fs.readFileSync(path.join(PKG, "site-root.block"))), "root block = the front's site-root.block");
  const b = extract({ sites: path.dirname(PKG), out, cids: [ROOT] });
  assert.equal(b.written, 0); assert.equal(b.present, files.length);
  assert.equal(fs.readdirSync(path.join(out, "ipfs")).filter((f) => f.endsWith(".tmp")).length, 0, "no temporary file left");
});

test("a tampered block refuses the whole CAR and writes nothing", () => {
  const bad = Buffer.from(CAR); bad[bad.length - 100] ^= 1;
  const sites = sitesWith("tamper", bad), out = path.join(path.dirname(sites), "blocks");
  assert.throws(() => extract({ sites, out, cids: [ROOT] }), /does not hash to its CID/);
  assert.equal(fs.existsSync(path.join(out, "ipfs")) ? fs.readdirSync(path.join(out, "ipfs")).length : 0, 0);
});

test("a CAR filed under another root, a non-canonical header, or a truncated CAR is refused", () => {
  const other = "bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y";
  assert.throws(() => blocksOf(CAR, other), /CAR header is not exactly/);
  const v2 = Buffer.from(CAR); v2[v2.indexOf(Buffer.from("version")) + 7] = 2;
  assert.throws(() => blocksOf(v2, ROOT), /CAR header is not exactly/);
  assert.throws(() => blocksOf(CAR.subarray(0, CAR.length - 7), ROOT), /truncated CAR block/);
  assert.throws(() => extract({ sites: path.dirname(PKG), out: tmp("bad-root"), cids: ["not-a-cid"] }), /not a site root CID/);
});

test("an existing block file with other bytes is refused; --check writes nothing", () => {
  const out = path.join(tmp("conflict"), "blocks"); fs.mkdirSync(path.join(out, "ipfs"), { recursive: true });
  const [first] = blocksOf(CAR, ROOT);
  fs.writeFileSync(path.join(out, "ipfs", first.cid), "not the block");
  assert.throws(() => extract({ sites: path.dirname(PKG), out, cids: [ROOT] }), /exists with other bytes/);
  const dry = path.join(tmp("check"), "blocks");
  const s = extract({ sites: path.dirname(PKG), out: dry, cids: [ROOT], check: true });
  assert.ok(s.written > 100); assert.equal(fs.existsSync(dry), false);
});
