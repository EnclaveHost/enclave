// The payload's in-place RE-ATTACH (shielded/anchor/avf/payload/anchor_reattach.h; RUNNER-AGENT.md "Reconnect in place",
// reviewed with the verifier session), held to what the design rests on:
//   1. natively, under ASan/UBSan: the relay's nonce is the ONLY input (exactly 64 lowercase hex; every malformed form gets
//      nothing), B is built from the keys armed at boot, a second re-attach inside 5 s, a backwards clock, a key change and an
//      unarmed session get nothing; and the B it builds is byte-equal to relay/avf-binding.mjs's, its instance proof verifying
//      exactly as the owner's co-signer verifies it;
//   2. in the payload source: reattach() never touches the tier's caps state (the attach time, the caps nonce), never assigns
//      a key, and requests its attestation through the one locked call site; the serving loop hands it the WHOLE line.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { ATTACH_INSTANCE_DOMAIN } from "../shielded/anchor/avf/runner/attach-cosigner.mjs";
import { avfPadBinding } from "../relay/avf-binding.mjs";
const here = dirname(fileURLToPath(import.meta.url)), root = join(here, "..");
const payload = join(root, "shielded", "anchor", "avf", "payload"), vendor = join(root, "wasm", "ggml-shielded");
const SPKI = (pk) => Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pk, "hex")]);

test("anchor_reattach.h, natively: the nonce is the only input; B from the boot keys, equal to the relay's; malformed, too soon, backwards, changed keys and unarmed each get nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "anchor-reattach-"));
  try {
    const bin = join(dir, "t");
    const cc = spawnSync("cc", ["-O1", "-g", "-fsanitize=address,undefined", "-fno-sanitize-recover=all", "-Wall", "-Wextra", "-I", vendor, "-I", payload,
      join(here, "fixtures", "anchor-reattach.c"), join(vendor, "tweetnacl.c"), "-o", bin], { encoding: "utf8" });
    assert.equal(cc.status, 0, cc.stderr);
    assert.doesNotMatch(cc.stderr.split("\n").filter((l) => /anchor_reattach\.h|anchor-reattach\.c|anchor_attach_instance\.h/.test(l)).join("\n"), /warning/, cc.stderr);   // ours; the vendored tweetnacl.c has its own
    const run = spawnSync(bin, [], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.match(run.stdout, /anchor-reattach: ok\n/);
    const f = Object.fromEntries(run.stdout.split("\n").filter((l) => /^(ipk|tpk|ppk|nonce|B|sig)=/.test(l)).map((l) => l.split("=")));
    assert.equal(f.B, avfPadBinding(SPKI(f.tpk), f.ppk, Buffer.from(f.nonce, "hex")).toString("hex"), "the relay rebuilds the same B from the transport SPKI, the pad key and ITS nonce");
    assert.equal(cryptoVerify(null, Buffer.concat([Buffer.from(ATTACH_INSTANCE_DOMAIN), Buffer.from(f.B, "hex")]), createPublicKey({ key: SPKI(f.ipk), format: "der", type: "spki" }), Buffer.from(f.sig, "hex")), true,
                 "the instance proof over B verifies as the co-signer verifies it");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the payload source: reattach() touches no caps state and assigns no key; attestation only through the locked call; the serving loop takes STOP or REATTACH as whole lines", () => {
  const src = fs.readFileSync(join(payload, "anchor_payload.c"), "utf8");
  const body = (name) => { const i = src.indexOf(`static void ${name}(`); assert.ok(i >= 0, name); const j = src.indexOf("\n}\n", i); return src.slice(i, j + 2); };
  const r = body("reattach");
  assert.doesNotMatch(r, /g_caps_|g_app_nonce|g_abi2/, "the tier's caps state and the app's ABI/2 state are not the re-attach's");
  assert.doesNotMatch(r, /\bg_(tpk|tsk|ppk|psk|ipk|isk)\b/, "reattach() never names a key: it gets them from the context armed at boot");
  assert.match(r, /anchor_reattach_prepare\(&g_reattach, arg, len, boot_ms\(\), B, isig, &has_isig\)/);
  assert.match(r, /attest_certify\(ch, B, sizeof B, 1\)/);
  // one attestation call site, under the lock; the lock covers the request alone
  assert.equal((src.match(/AVmPayload_requestAttestation\(/g) || []).length, 1, "every attestation goes through request_attestation()");
  assert.match(body("attest_certify"), /request_attestation\(ch, 32, &res\)/);
  assert.match(src, /pthread_mutex_lock\(&g_att_mu\);\n\s+const AVmAttestationStatus st = AVmPayload_requestAttestation\(ch, n, res\);\n\s+pthread_mutex_unlock\(&g_att_mu\);/);
  // armed once, after the keys exist; no key is assigned after that line
  const arm = src.indexOf("anchor_reattach_arm(&g_reattach, g_tpk, g_ppk, g_isk, g_inst);");
  assert.ok(arm > src.indexOf("crypto_sign_keypair(g_tpk, g_tsk);") && arm > src.indexOf("crypto_box_keypair(g_ppk, g_psk);") && arm > src.indexOf("crypto_sign_ed25519_tweet_seed_keypair(g_ipk, g_isk, seed)"), "armed after the three keys");
  assert.equal((src.match(/anchor_reattach_arm\(/g) || []).length, 1);
  const after = src.slice(arm);
  assert.doesNotMatch(after, /crypto_sign_keypair\(g_tpk|crypto_box_keypair\(g_ppk|seed_keypair\(g_ipk|memcpy\(g_(tpk|ppk|isk)\b|g_(tpk|ppk)\[[^\]]*\]\s*=[^=]/, "no key is (re)assigned after arming");
  // the serving loop: a whole line (read_ctl_line), REATTACH dispatched with the kept length, an over-long line refused whole
  assert.match(src, /const int ln = read_ctl_line\(g_ctl, l, sizeof l, &over\);/);
  assert.match(src, /if \(ln >= 9 && !memcmp\(l, ANCHOR_REATTACH_CMD, 9\)\) \{ reattach\(l \+ 9, over \? \(size_t\)-1 : \(size_t\)ln - 9\); continue; \}/);
  const h = fs.readFileSync(join(payload, "anchor_reattach.h"), "utf8");
  assert.doesNotMatch(h, /printf|OUT\(|fprintf|write\(|memcpy\([^,]+, (c->)?isk/, "the header never prints or copies the instance secret");
});
