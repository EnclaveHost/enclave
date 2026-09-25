// The payload's boot-time INSTANCE proof for a relay attach (shielded/anchor/avf/payload/anchor_attach_instance.h), held to the
// two properties the attach co-signer's soundness rests on (reviewed with the verifier session):
//   1. it signs ONLY this pVM's own pad-bind transcript -- a foreign or malformed one gets nothing (natively, below), and the
//      payload prints INSTANCEATTACH only from that function's success;
//   2. the instance SECRET never leaves the payload: every use of g_isk in anchor_payload.c is one of the four allowed ones
//      (its declaration, its derivation, the v3 evidence signature, this signature), and INSTANCEATTACH prints only the
//      instance SPKI and the signature.
// The signature it makes verifies, in node, exactly as runner/attach-cosigner.mjs verifies it.
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
const here = dirname(fileURLToPath(import.meta.url)), root = join(here, "..");
const payload = join(root, "shielded", "anchor", "avf", "payload"), vendor = join(root, "wasm", "ggml-shielded");

test("anchor_attach_instance.h, natively: its own transcript is signed under its domain; another VM's key, another pad key, another domain, a truncated, extended or missing transcript get nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "anchor-attach-instance-"));
  try {
    const bin = join(dir, "t");
    const cc = spawnSync("cc", ["-O1", "-g", "-fsanitize=address,undefined", "-Wall", "-Wextra", "-I", vendor, "-I", payload,
      join(here, "fixtures", "anchor-attach-instance.c"), join(vendor, "tweetnacl.c"), "-o", bin], { encoding: "utf8" });
    assert.equal(cc.status, 0, cc.stderr);
    const run = spawnSync(bin, [], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.match(run.stdout, /anchor-attach-instance: ok\n/);
    const f = Object.fromEntries(run.stdout.split("\n").filter((l) => /^(ipk|B|sig)=/.test(l)).map((l) => l.split("=")));
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(f.ipk, "hex")]);
    assert.equal(cryptoVerify(null, Buffer.concat([Buffer.from(ATTACH_INSTANCE_DOMAIN), Buffer.from(f.B, "hex")]), createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(f.sig, "hex")), true,
                 "the payload's signature verifies as the co-signer verifies it");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the instance SECRET never leaves the payload: g_isk used only in its four allowed places; INSTANCEATTACH prints only the SPKI and the signature", () => {
  const src = fs.readFileSync(join(payload, "anchor_payload.c"), "utf8").split("\n");
  const uses = src.map((l, i) => [i + 1, l]).filter(([, l]) => /\bg_isk\b/.test(l));
  const allowed = [/static unsigned char g_ipk\[32\], g_isk\[64\];/, /crypto_sign_ed25519_tweet_seed_keypair\(g_ipk, g_isk, seed\)/,
                   /crypto_sign\(sm, &smlen, m, sizeof m, g_isk\); memcpy\(inst->sig, sm, 64\);/, /anchor_attach_instance_sign\(bound, blen, g_tpk, g_ppk, g_isk, isig\)/];
  const stray = uses.filter(([, l]) => !allowed.some((re) => re.test(l)));
  assert.deepEqual(stray, [], `g_isk used outside its allowed places: ${JSON.stringify(stray)}`);
  assert.equal(uses.length, 4, `exactly the four allowed uses (${uses.map(([n]) => n).join(",")})`);
  const outs = src.filter((l) => /INSTANCEATTACH/.test(l) && /OUT\(/.test(l));
  assert.equal(outs.length, 1); assert.match(outs[0], /OUT\("INSTANCEATTACH key=%s sig=%s", isph, isigh\);/, "the SPKI and the signature, nothing else");
  const h = fs.readFileSync(join(payload, "anchor_attach_instance.h"), "utf8");
  assert.doesNotMatch(h, /printf|OUT\(|fprintf|write\(|memcpy\(sig, isk|memcpy\([^,]+, isk/, "the header never prints or copies the secret");
});
