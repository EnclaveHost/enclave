// hvnode-evidence.test.mjs - the node's windows-hv-node/v1 evidence builder. Every check has a test that fails if
// the check is removed (enclave-d1's condition 3). Run: node --test windows/node/hvnode-evidence.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, verify as edVerify, createPublicKey } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  HV_NODE_FORMAT, HV_NODE_BIND_DOMAIN, HV_NODE_PROVES, HV_NODE_REQUIRED_PCR12,
  hvNodeBinding, hvNodeChallenge, refusalsFromFacts, bootStateRefusals, loadOrCreateNodeKey,
  isolationStatementBytes, buildHvNodeFrame,
} from "./hvnode-evidence.mjs";
import { vbsBinding, VBS_REQUIRED_PCR12 } from "../../relay/vbs-verify.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (b) => createHash("sha256").update(b).digest();
const edKey = () => { const { privateKey } = generateKeyPairSync("ed25519"); return { privateKey, spki: createPublicKey(privateKey).export({ type: "spki", format: "der" }) }; };
const NONCE = Buffer.alloc(32, 7);
const STMT = Buffer.from('{"stated":true}');
// the real boot-64 log: Secure Boot OFF and TESTSIGNING on (relay's own fixture)
const boot64 = JSON.parse(fs.readFileSync(path.join(HERE, "../../test/fixtures/vbs/boot64-evidence.json"), "utf8"));
const BOOT64_LOG = Buffer.from(boot64.body.log, "base64");

test("binding: exact fixed-width layout domain || spki || nonce || sha256(statement)", () => {
  const { spki } = edKey();
  const b = hvNodeBinding(spki, NONCE, STMT);
  assert.equal(b.length, HV_NODE_BIND_DOMAIN.length + 44 + 32 + 32);
  assert.deepEqual(b, Buffer.concat([Buffer.from(HV_NODE_BIND_DOMAIN), spki, NONCE, sha256(STMT)]));
  assert.deepEqual(hvNodeChallenge(b), sha256(b));
  // the statement is bound: other statement bytes give another binding
  assert.notDeepEqual(hvNodeBinding(spki, NONCE, Buffer.from('{"stated":false}')), b);
});

test("binding: refuses a non-Ed25519 key, a short nonce, and a statement that is not bytes", () => {
  const { spki } = edKey();
  const p256 = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "der" });
  assert.throws(() => hvNodeBinding(p256, NONCE, STMT), /Ed25519/);
  assert.throws(() => hvNodeBinding(spki, Buffer.alloc(31), STMT), /32 bytes/);
  assert.throws(() => hvNodeBinding(spki, NONCE, "{}"), /exact bytes/);
});

test("binding: domain-separated from the legacy enclave binding", () => {
  const { spki } = edKey();
  const legacy = vbsBinding(spki, "00".repeat(32), NONCE);
  assert.notDeepEqual(hvNodeChallenge(hvNodeBinding(spki, NONCE, STMT)), sha256(legacy));
  assert.ok(!hvNodeBinding(spki, NONCE, STMT).subarray(0, 24).equals(legacy.subarray(0, 24)));
});

const goodFacts = () => ({ secureBoot: 1, fields: new Map(Object.entries(HV_NODE_REQUIRED_PCR12).map(([k, v]) => [k, [v, v]])) });

test("policy: the required set is the relay's production set plus TESTSIGNING 0", () => {
  for (const [k, v] of Object.entries(VBS_REQUIRED_PCR12)) assert.equal(HV_NODE_REQUIRED_PCR12[k], v, k);
  assert.equal(HV_NODE_REQUIRED_PCR12.TESTSIGNING, 0);
});

test("policy: good facts are not refused", () => {
  assert.deepEqual(refusalsFromFacts(goodFacts()), []);
});

test("policy: Secure Boot off or absent is refused", () => {
  for (const sb of [0, null, 2]) {
    const f = goodFacts(); f.secureBoot = sb;
    const r = refusalsFromFacts(f);
    assert.equal(r.length, 1); assert.match(r[0], /Secure Boot is not on/);
  }
});

test("policy: every required field, wrong in ONE occurrence or absent, is refused by name", () => {
  for (const [name, want] of Object.entries(HV_NODE_REQUIRED_PCR12)) {
    const wrong = goodFacts(); wrong.fields.set(name, [want, want === 0 ? 1 : 0]);
    const r = refusalsFromFacts(wrong);
    assert.equal(r.length, 1, name); assert.match(r[0], new RegExp(`^${name} is not ${want}`));
    const absent = goodFacts(); absent.fields.delete(name);
    const a = refusalsFromFacts(absent);
    assert.equal(a.length, 1, name); assert.match(a[0], new RegExp(`^${name} is absent`));
  }
});

test("log: the REAL boot-64 log (Secure Boot off, test signing on) is refused on both", () => {
  const r = bootStateRefusals(BOOT64_LOG);
  assert.ok(r.some((x) => /Secure Boot is not on/.test(x)), r.join(" | "));
  assert.ok(r.some((x) => /^TESTSIGNING is not 0/.test(x)), r.join(" | "));
});

test("log: an unreadable log is a refusal, not a pass", () => {
  const r = bootStateRefusals(Buffer.from("not a tcg log"));
  assert.equal(r.length, 1); assert.match(r[0], /does not parse|do not decode/);
});

test("key: created once, reused, owner-only, Ed25519", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hvnode-key-"));
  const a = loadOrCreateNodeKey(dir), b = loadOrCreateNodeKey(dir);
  assert.equal(a.spki.length, 44); assert.deepEqual(a.spki, b.spki);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, "node-transport.key")).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("statement: never raises host exclusion", () => {
  assert.equal(isolationStatementBytes(null).toString(), "null");
  const s = JSON.parse(isolationStatementBytes({ backend: "hyperv-partition-per-app", boundary: { tier: "t0-hv" }, catalog: { derivations: ["enclave-catalog-bundle/1"] } }));
  assert.equal(s.hostExcluded, false); assert.equal(s.stated, true); assert.equal(s.tier, "t0-hv");
  assert.throws(() => isolationStatementBytes({ boundary: { hostExcluded: true } }), /never claims/);
});

test("frame: a refused boot state asks the TPM for NOTHING beyond the log (no activation, no quote)", async () => {
  const { spki, privateKey } = edKey();
  const asked = [];
  const tpm = async (cmd) => { asked.push(cmd.split(" ")[0]); return cmd === "log" ? { log: "boot.log" } : {}; };
  await assert.rejects(buildHvNodeFrame({ nonce: NONCE, credentialBlob: Buffer.alloc(8), secret: Buffer.alloc(8), spki, privateKey,
                                          tpm, readLog: () => BOOT64_LOG }), /refusing to attest this node/);
  assert.deepEqual(asked, ["log"]);
});

test("frame: the format is windows-hv-node/v1 and says what it proves", () => {
  assert.equal(HV_NODE_FORMAT, "windows-hv-node/v1");
  assert.match(HV_NODE_PROVES, /proves nothing about isolation or host exclusion/);
});
