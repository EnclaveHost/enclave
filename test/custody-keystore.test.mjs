// A custodian's durable state is ONE passphrase-encrypted file (custody/keystore.mjs). These pin its recovery story:
// the file is the backup, it opens only with its passphrase, any tampering is refused, a key file anyone else can read is
// refused, and a custodian restored from a backup copy on another machine serves the shares it held (test/custody-e2e.test.mjs
// covers serving; here, that the restored keys are the same keys). Plus a smoke test of the daemon itself on anvil.
//   run: node --test test/custody-keystore.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateKeys, sealKeyFile, openKeyFile, writeKeyFile, readKeyFile } from "../custody/keystore.mjs";
import * as hpke from "../custody/hpke.mjs";

const FAST = { name: "scrypt", N: 2 ** 12, r: 8, p: 1 };   // the production default is N = 2^17; tests need no slow KDF
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-custodian-keys-"));

test("the key file is the backup: a copy opens elsewhere to the SAME keys, only with its passphrase", () => {
  const k = generateKeys();
  const text = sealKeyFile({ ...k, passphrase: "correct horse battery staple", kdf: FAST });
  assert.ok(!text.includes(Buffer.from(k.encPrivateKey).toString("hex")) && !text.includes(k.operatorPrivateKey.slice(2)), "no private key in the clear");
  const restored = openKeyFile(text, "correct horse battery staple");
  assert.deepEqual(Buffer.from(restored.encPrivateKey), Buffer.from(k.encPrivateKey));
  assert.equal(restored.operatorPrivateKey, k.operatorPrivateKey);
  assert.equal(restored.encKey, Buffer.from(hpke.publicKeyOf(k.encPrivateKey)).toString("hex"));
  assert.throws(() => openKeyFile(text, "wrong passphrase!!"), /wrong passphrase/);
  const f = JSON.parse(text);
  for (const bend of [{ ...f, encKey: "00".repeat(32) }, { ...f, operator: "0x" + "11".repeat(20) },
                      { ...f, ct: Buffer.from(Buffer.from(f.ct, "base64").map((b, i) => (i === 3 ? b ^ 1 : b))).toString("base64") }])
    assert.throws(() => openKeyFile(JSON.stringify(bend), "correct horse battery staple"));
  assert.throws(() => sealKeyFile({ ...k, passphrase: "short" }), /12 characters/);
});

test("a key file is written owner-only, never overwritten, and refused when others can read it", () => {
  const k = generateKeys();
  const p = path.join(dir, "c.key");
  writeKeyFile(p, sealKeyFile({ ...k, passphrase: "correct horse battery staple", kdf: FAST }));
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  assert.throws(() => writeKeyFile(p, "x"), /EEXIST/);
  fs.chmodSync(p, 0o640);
  assert.throws(() => readKeyFile(p), /0600/);
});

const { anvilAvailable, custodyRig } = await import("./helpers/custody-rig.mjs");
test("the daemon starts from its key file with production verifiers: info and challenge answer, and no private key is printed (synthetic evidence under the production table: test/custody-hardware.test.mjs)", { skip: anvilAvailable() ? false : "anvil not installed" }, async () => {
  const R = await custodyRig({ n: 3, t: 2 });
  const S = path.join(dir, "daemon");
  fs.mkdirSync(S);
  fs.writeFileSync(path.join(S, "pass"), "a-long-test-passphrase\n", { mode: 0o600 });
  const k = { encPrivateKey: R.members[0].encPrivateKey, operatorPrivateKey: "0x" + "42".repeat(32) };
  writeKeyFile(path.join(S, "c.key"), sealKeyFile({ ...k, passphrase: "a-long-test-passphrase" }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, CUSTODY_KEYFILE: path.join(S, "c.key"), CUSTODY_PASSPHRASE_FILE: path.join(S, "pass"), CUSTODY_VAULT: R.vault,
                CUSTODY_CHAIN_ID: String(R.chainId), CUSTODY_RPCS: R.anvil.url, CUSTODY_MIN_AGREE: "1", CUSTODY_LISTEN: `127.0.0.1:${port}`, CUSTODY_STATE_DIR: path.join(S, "state") };
  const daemon = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "custody", "custodian-daemon.mjs"), "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  daemon.stdout.on("data", (d) => (out += d)); daemon.stderr.on("data", (d) => (out += d));
  try {
    for (let i = 0; i < 100 && !/listening/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /listening/);
    const info = await (await fetch(`http://127.0.0.1:${port}/v1/custody/info`)).json();
    assert.equal(info.encKey, Buffer.from(R.members[0].encKey).toString("hex"));
    assert.equal(info.vault, R.vault);
    const ch = await R.post(`http://127.0.0.1:${port}/v1/custody/challenge`, {});
    assert.match(ch.nonce, /^[0-9a-f]{64}$/);
    // nothing the daemon prints carries a private key
    assert.ok(!out.includes(Buffer.from(R.members[0].encPrivateKey).toString("hex")) && !out.includes("42".repeat(32)));
  } finally { daemon.kill(); await R.stop(); }
});
