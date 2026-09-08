import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { createPadsLedger, signedMessage, boxToPadKey, PAD_INDEX_LIMIT } from "../relay/pads.mjs";
import { seedGrantMessage, windowMessageV2 } from "../relay/pad-grant.mjs";

function fixture(dir) {
  const ed = generateKeyPairSync("ed25519"), x = generateKeyPairSync("x25519");
  const spki = ed.publicKey.export({ type: "spki", format: "der" });
  const padKey = x.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  const name = "pixel_8-Pro", model_digest = "ab".repeat(32), calib_digest = "cd".repeat(32);
  const tunnel = { name, mode: "avf", spki: spki.toString("base64"), padKey, keyFp: createHash("sha256").update(spki).digest("hex") };
  const ledger = createPadsLedger({ dir, hub: { info: (n) => n === name ? tunnel : null }, log: () => {} });
  const request = (changes = {}, kind = "seed-v2") => {
    const r = { name, model_digest, calib_digest, nonce: randomBytes(32).toString("hex"), ...changes };
    r.sig = sign(null, Buffer.from(signedMessage(kind, [r.name, r.model_digest, r.calib_digest, r.nonce])), ed.privateKey).toString("hex");
    return r;
  };
  const ledgerPk = createPublicKey({ format: "der", type: "spki", key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(ledger.key(), "hex")]) });
  const reserve = (seed_id, nonce, want = 8) => ({ name, seed_id, want, nonce,
    sig: sign(null, Buffer.from(signedMessage("reserve", [name, seed_id, want, nonce])), ed.privateKey).toString("hex") });
  const signedRequest = (kind, fields, body = {}) => {
    const nonce = randomBytes(16).toString("hex");
    return { name, nonce, ...body, sig: sign(null, Buffer.from(signedMessage(kind, [name, ...fields, nonce])), ed.privateKey).toString("hex") };
  };
  return { ledger, request, reserve, ledgerPk, tunnel, signedRequest };
}

test("a v2 final receipt closes new reservations and cannot replay after old nonce eviction, restart, or legacy downgrade", () => {
  const dir = mkdtempSync(join(tmpdir(), "pad-final-receipt-"));
  try {
    const f = fixture(dir); let L = f.ledger;
    const seed_id = L.seed(f.request()).body.seed_id;
    assert.equal(L.reserve(f.reserve(seed_id,randomBytes(16).toString("hex"),64)).status,200);
    const receipt = f.signedRequest("receipt", [seed_id,123,17], {seed_id,pads:123,tokens:17});
    assert.equal(L.receipt(receipt).status,200);
    const file=join(dir,"pads-ledger.json"), before=readFileSync(file,"utf8");
    for (let i=0;i<270;i++) {
      const res=L.reserve(f.reserve(seed_id,randomBytes(16).toString("hex"),1));
      assert.deepEqual([res.status,res.body.error,res.body.reseed_required],[409,"seed_finalized",true]);
    }
    assert.equal(readFileSync(file,"utf8"),before,"refusals do not consume nonces, change totals or advance mark");
    // Import the state an older relay could leave after reserve traffic evicted
    // the receipt nonce. Finalization must protect the upgraded process too.
    const state=JSON.parse(before); state.seeds[seed_id].nonces=[];
    writeFileSync(file,JSON.stringify(state));
    assert.equal(state.seeds[seed_id].nonces.includes(receipt.nonce),false);
    assert.equal(L.receipt(receipt).body.error,"receipt_finalized");
    L=createPadsLedger({dir,hub:{info:(n)=>n===f.tunnel.name?f.tunnel:null},log:()=>{}});
    assert.equal(L.receipt(receipt).body.error,"receipt_finalized");
    assert.equal(L.reserve(f.reserve(seed_id,randomBytes(16).toString("hex"),1)).body.error,"seed_finalized");
    // Downgrading the request does not downgrade this seed's durable policy.
    assert.equal(L.seed(f.signedRequest("seed",[])).status,200);
    assert.equal(L.receipt(receipt).body.error,"receipt_finalized");
    assert.equal(L.seed(f.request()).body.seed_id,seed_id,"renewing the same transport is not a fresh seed");
    assert.equal(L.reserve(f.reserve(seed_id,randomBytes(16).toString("hex"),1)).body.error,"seed_finalized");
    const second=f.signedRequest("receipt",[seed_id,1,1],{seed_id,pads:1,tokens:1});
    assert.equal(L.receipt(second).body.error,"receipt_finalized");
    assert.deepEqual([L.receipts(seed_id).pads,L.receipts(seed_id).tokens,L.receipts(seed_id).runs],[123,17,1]);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("seed grants bind asset identities, current request, recipient, and complete encrypted seed", () => {
  const dir = mkdtempSync(join(tmpdir(), "pad-grant-"));
  try {
    const f = fixture(dir), r = f.request(), result = f.ledger.seed(r);
    assert.equal(result.status, 200);
    const g = result.body;
    assert.equal(g.request_nonce, r.nonce);
    assert.equal(g.transport_key, Buffer.from(f.tunnel.spki, "base64").toString("hex"));
    assert.equal(g.pad_key, f.tunnel.padKey);
    const ok = (grant, key = f.ledgerPk) => verify(null, Buffer.from(seedGrantMessage(grant)), key, Buffer.from(grant.grant_sig, "hex"));
    assert.ok(ok(g));
    for (const [key, value] of Object.entries(g)) {
      if (key === "grant_sig" || key === "grant_version") continue;
      const changed = key === "name" ? value + "x" : key === "epoch" ? value + 1 :
        key === "transport_key" ? value.slice(0, -2) + (value.endsWith("00") ? "01" : "00") :
        (value[0] === "0" ? "1" : "0") + value.slice(1);
      assert.equal(ok({ ...g, [key]: changed }), false, `${key} is signed`);
    }
    assert.equal(ok(g, generateKeyPairSync("ed25519").publicKey), false, "Android cannot replace the measured ledger pin");
    const forged = { ...g, ...boxToPadKey(g.pad_key, Buffer.alloc(32, 7)) };
    assert.equal(ok(forged), false, "an app-chosen known seed has valid recipient encryption but no platform authentication");
    const mismatch = f.request(); mismatch.model_digest = "aa".repeat(32);
    assert.equal(f.ledger.seed(mismatch).status, 403, "request signature binds the model too");
    assert.equal(f.ledger.seed(f.request({}, "seed")).status, 403, "legacy signature cannot request a v2 grant");
    for (const invalid of [
      { model_digest: null }, { calib_digest: undefined }, { model_digest: "aa".repeat(32) + "\n" },
      { calib_digest: "CD".repeat(32) }, { nonce: "00".repeat(16) }, { nonce: "00".repeat(32) + "\n" },
    ]) assert.equal(f.ledger.seed(f.request(invalid)).status, 400);
    for (const invalid of [
      { grant_version: 2 }, { name: "pixel\n8" }, { name: "x".repeat(65) }, { epoch: -1 },
      { epoch: 0 }, { epoch: Number.MAX_SAFE_INTEGER+1 }, { box: g.box + "\n" }, { epk: "00" },
    ]) assert.throws(() => seedGrantMessage({ ...g, ...invalid }), /invalid/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a seed keeps its asset identity across grants, legacy requests and restart, and exposes it to dealers", () => {
  const dir = mkdtempSync(join(tmpdir(), "pad-grant-assets-"));
  try {
    const f = fixture(dir), request = f.request();
    const first = f.ledger.seed(request); assert.equal(first.status, 200);
    assert.equal(f.ledger.seed(f.request()).status, 200, "same asset pair may renew its grant");
    for (const changes of [{model_digest: "ee".repeat(32)}, {calib_digest: "ff".repeat(32)}])
      assert.equal(f.ledger.seed(f.request(changes)).body.error, "seed_asset_mismatch");
    assert.equal(f.ledger.seed(f.signedRequest("seed", [])).status, 200);
    const restored = createPadsLedger({dir, hub: {
      info: n => n === f.tunnel.name ? f.tunnel : null,
      origins: () => [{name: f.tunnel.name}],
    }, log: () => {}});
    for (const view of [restored.pvm(f.tunnel.name), ...restored.consumers()]) {
      assert.equal(view.model_digest, request.model_digest);
      assert.equal(view.calib_digest, request.calib_digest);
      assert.equal(view.seed_id, first.body.seed_id);
    }
    assert.equal(restored.seed(f.request({model_digest: "ef".repeat(32)})).status, 409);
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test("an old unbound seed cannot be relabelled as newly bound assets", () => {
  const dir = mkdtempSync(join(tmpdir(), "pad-grant-old-assets-"));
  try {
    const f = fixture(dir);
    assert.equal(f.ledger.seed(f.signedRequest("seed", [])).status, 200);
    assert.equal(f.ledger.seed(f.request()).body.error, "seed_asset_mismatch");
    assert.equal(f.ledger.pvm(f.tunnel.name).model_digest, undefined);
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test("the relay exhausts each seed before its 24-bit pad index can repeat", () => {
  const dir = mkdtempSync(join(tmpdir(), "pad-window-limit-"));
  try {
    const f = fixture(dir), seed = f.ledger.seed(f.request()).body.seed_id;
    const file = join(dir, "pads-ledger.json"), state = JSON.parse(readFileSync(file, "utf8"));
    const reopen = (mark) => {
      state.seeds[seed].mark = mark;
      writeFileSync(file, JSON.stringify(state));
      return createPadsLedger({ dir, hub: { info: (n) => n === f.tunnel.name ? f.tunnel : null }, log: () => {} });
    };
    let ledger = reopen(PAD_INDEX_LIMIT-1);
    const last = ledger.reserve(f.reserve(seed, randomBytes(16).toString("hex"), 1));
    assert.equal(last.status, 200);
    assert.equal(last.body.lo, PAD_INDEX_LIMIT-1); assert.equal(last.body.hi, PAD_INDEX_LIMIT);
    assert.equal(ledger.reserve(f.reserve(seed, randomBytes(16).toString("hex"), 1)).body.error, "seed_exhausted");
    assert.equal(ledger.mark(seed).mark, PAD_INDEX_LIMIT);
    for (const mark of [PAD_INDEX_LIMIT-1, PAD_INDEX_LIMIT, PAD_INDEX_LIMIT+1, -1, null, Number.MAX_SAFE_INTEGER]) {
      ledger = reopen(mark);
      const r = ledger.reserve(f.reserve(seed, randomBytes(16).toString("hex"), 8));
      assert.equal(r.status, 409); assert.equal(r.body.error, "seed_exhausted");
      assert.equal(ledger.mark(seed).mark, mark, "invalid/exhausted counters never advance or wrap");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reserve reply binds the pVM nonce; an old signed window cannot be replayed on reconnect", () => {
  const dir = mkdtempSync(join(tmpdir(), "pad-window-v2-"));
  const source = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
  try {
    const f = fixture(join(dir, "ledger")), seed = f.ledger.seed(f.request()).body.seed_id;
    const bin = join(dir, "probe");
    execFileSync("cc", ["-std=c11", "-O1", "-g", "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
      "-I", source("wasm/ggml-shielded"), source("test/fixtures/shielded-pad-window.c"),
      source("wasm/ggml-shielded/tweetnacl.c"), "-o", bin], { timeout: 30_000, stdio: "pipe" });
    const options = { timeout: 10_000, encoding: "utf8", env: { ...process.env,
      ASAN_OPTIONS: "detect_leaks=1:abort_on_error=1", UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1" } };
    for (const bytes of [16, 32, 64]) {
      const nonce = randomBytes(bytes).toString("hex"), req = f.reserve(seed, nonce);
      const result = f.ledger.reserve(req); assert.equal(result.status, 200);
      const w = result.body;
      assert.equal(w.window_version, 2); assert.equal(w.request_nonce, nonce);
      assert.ok(verify(null, Buffer.from(windowMessageV2(seed, w.lo, w.hi, w.iat, nonce)), f.ledgerPk, Buffer.from(w.sig_v2, "hex")));
      const args = [f.ledger.key(), seed, String(w.lo), String(w.hi), String(w.iat), nonce, w.sig_v2];
      assert.equal(execFileSync(bin, args, options).trim(), "ok");
      const bad = (i, value, why) => {
        const changed = [...args]; changed[i] = value;
        const r = spawnSync(bin, changed, options);
        assert.equal(r.status, 1, `${why}: ${r.stderr}`); assert.equal(r.stdout.trim(), "rejected", why);
      };
      bad(5, randomBytes(bytes).toString("hex"), "old response after a new pVM request");
      bad(6, w.sig, "legacy window signature cannot downgrade freshness");
      bad(1, "00".repeat(16), "another seed");
      bad(2, String(w.lo+1), "changed low edge");
      bad(3, String(w.hi+1), "changed high edge");
      bad(4, String(w.iat+1), "changed issue time");
      bad(3, String(w.lo), "empty window");
      bad(3, "18446744073709551615", "overflowing window");
      bad(5, nonce + "\n", "noncanonical nonce");
      assert.equal(f.ledger.reserve(req).status, 409, "request replay remains refused");
    }
    for (const nonce of ["a".repeat(33), "a".repeat(32) + "\n", "AA".repeat(16), "a".repeat(130)])
      assert.equal(f.ledger.reserve(f.reserve(seed, nonce)).status, 403, "malformed nonce is refused before reserve");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("platform seed grants verify in C against trusted context; substitutions fail before unboxing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pad-grant-c-"));
  const source = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
  try {
    const f = fixture(join(dir, "ledger")), g = f.ledger.seed(f.request()).body;
    const bin = join(dir, "probe");
    execFileSync("cc", ["-std=c11", "-O1", "-g", "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
      "-I", source("wasm/ggml-shielded"), source("test/fixtures/shielded-pad-grant.c"),
      source("wasm/ggml-shielded/tweetnacl.c"), "-o", bin], { timeout: 30_000, stdio: "pipe" });
    const args = [f.ledger.key(), g.name, g.transport_key.slice(24), g.pad_key, g.model_digest,
      g.calib_digest, g.request_nonce, g.seed_id, String(g.epoch), g.epk, g.nonce, g.box, g.grant_sig];
    const options = { timeout: 30_000, encoding: "utf8", env: { ...process.env,
      ASAN_OPTIONS: "detect_leaks=1:abort_on_error=1", UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1" } };
    assert.equal(execFileSync(bin, args, options).trim(), seedGrantMessage(g));
    const maxSigner = generateKeyPairSync("ed25519");
    const maxGrant = { ...g, name: "n".repeat(64), epoch: Number.MAX_SAFE_INTEGER };
    maxGrant.grant_sig = sign(null, Buffer.from(seedGrantMessage(maxGrant)), maxSigner.privateKey).toString("hex");
    const maxArgs = [...args];
    maxArgs[0] = maxSigner.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
    maxArgs[1] = maxGrant.name; maxArgs[8] = String(maxGrant.epoch); maxArgs[12] = maxGrant.grant_sig;
    assert.equal(execFileSync(bin, maxArgs, options).trim(), seedGrantMessage(maxGrant), "maximum canonical context fits bounded C buffers");
    // A valid box encrypted by Android is not a valid platform seed grant.
    const forged = boxToPadKey(g.pad_key, Buffer.alloc(32, 7));
    const forgedArgs = [...args]; forgedArgs[9] = forged.epk; forgedArgs[10] = forged.nonce; forgedArgs[11] = forged.box;
    const denied = spawnSync(bin, forgedArgs, options);
    assert.equal(denied.status, 1, denied.stderr); assert.equal(denied.stdout.trim(), "rejected");
    // S+L was accepted by the original TweetNaCl verification primitive.
    const sig = Buffer.from(g.grant_sig, "hex"), order = Buffer.from("edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010", "hex");
    assert.equal(order.length, 32);
    let carry = 0;
    for (let i = 0; i < 32; i++) { const n = sig[32+i] + order[i] + carry; sig[32+i] = n & 255; carry = n >>> 8; }
    const malleable = [...args]; malleable[12] = sig.toString("hex");
    const rejected = spawnSync(bin, malleable, options);
    assert.equal(rejected.status, 1, rejected.stderr); assert.equal(rejected.stdout.trim(), "rejected");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
