// The owner-side attach co-signer (shielded/anchor/avf/runner/attach-cosigner.mjs) against the REAL tunnel hub (relay/tunnel.js)
// with synthetic AVF phones (test/fixtures/avf-synthetic.mjs: a lab CA stands in for Google's roots, pinned explicitly). A name
// the registry assigns to the owner takes an attach only with the owner's operator signature; the co-signer gives one only for
// the owner's OWN instance, over this attach's transcript -- every refusal below leaves nothing signed and nothing attached.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { tmpdir, makeCa, haveOpenssl, issueLeaf, extension, AUTH } from "./fixtures/avf-synthetic.mjs";
import { createAttachCosigner, serveAttachCosigner, ATTACH_INSTANCE_DOMAIN, attachMessage } from "../shielded/anchor/avf/runner/attach-cosigner.mjs";

const skip = !haveOpenssl && "no openssl";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const PVMCODE = createHash("sha256").update("pvm-cpu protected build (cosigner test)").digest();
const OTHER_BUILD = createHash("sha256").update("another build").digest();

async function rig() {
  const { WebSocket } = await import("ws");
  const { createTunnelHub } = await import("../relay/tunnel.js");
  const { pvmCpuPolicy } = await import("../relay/pvm-cpu-tier.mjs");
  const { AVF_PAD_FORMAT, avfPadBinding } = await import("../relay/avf-binding.mjs");
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const dir = tmpdir("pvm-cosign-"), ca = makeCa(dir);
  const operator = privateKeyToAccount(generatePrivateKey());
  const registered = new Map([["pixel-owned", operator.address.toLowerCase()]]);   // the registry: pixel-owned is the owner's
  const hub = createTunnelHub({ allow: [], operatorFor: async (n) => registered.get(n) || null,
    attest: { avf: { codeHashes: [], padCodeHashes: [], authorityHashes: [AUTH.toString("hex")], rootPins: [ca.rootPin] },
              pvmCpu: pvmCpuPolicy({ codeHashes: [PVMCODE.toString("hex")], authorityHashes: [AUTH.toString("hex")], models: [{ sha256: "5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48", name: "m", selftestSha256: "d".repeat(64), minDecodeTokS: 10 }] }) } });
  const srv = http.createServer((_q, s) => s.end("ok")); srv.on("upgrade", (q, sock, head) => hub.handleUpgrade(q, sock, head));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const relay = `http://127.0.0.1:${srv.address().port}`, hubUrl = `ws://127.0.0.1:${srv.address().port}/v1/fleet-tunnel`;
  const owner = generateKeyPairSync("ed25519"), ownerId = sha(owner.publicKey.export({ type: "spki", format: "der" }));
  const journalFile = path.join(dir, "cosign", "journal.jsonl");
  const cosigner = createAttachCosigner({ account: operator, name: "pixel-owned", relay, codeHashes: [PVMCODE.toString("hex")], authorityHashes: [AUTH.toString("hex")],
                                          rootPins: [ca.rootPin], instanceIds: [ownerId], journalFile, rate: { max: 50, ms: 60000 } });
  const sockets = [];
  const wait = async (frames, pred, ms = 8000) => { const until = Date.now() + ms; while (Date.now() < until) { const f = frames.find(pred); if (f) return f; await new Promise((r) => setTimeout(r, 20)); } return null; };
  // a phone VM: its own transport and pad keys per boot; `instance` its instance key; builds the rad over the HUB's nonce
  const phone = () => ({ transport: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }),
                         padKey: generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex") });
  const radFor = (p, nonce, { code = PVMCODE } = {}) => {
    const B = avfPadBinding(p.transport, p.padKey, nonce), leaf = issueLeaf(dir, { ext: extension({ challenge: createHash("sha256").update(B).digest(), code }) });
    return { B, rad: { format: AVF_PAD_FORMAT, body: Buffer.from(JSON.stringify({ chain: [leaf.leaf, ca.inter, ca.root].map((x) => x.toString("base64")), signature: leaf.sign(B).toString("base64") })).toString("base64"),
                       transportKey: p.transport.toString("base64"), padKey: p.padKey } };
  };
  const instanceProof = (inst, B) => ({ instanceKey: inst.publicKey.export({ type: "spki", format: "der" }).toString("hex"),
                                        instanceSig: edSign(null, Buffer.concat([Buffer.from(ATTACH_INSTANCE_DOMAIN), B]), inst.privateKey).toString("hex") });
  // open an attach: returns { nonce, send(frame), result() }
  const open = async (name) => {
    const frames = [], ws = new WebSocket(hubUrl, { headers: { "x-metal-name": name, "x-metal-attest": "1" } }); sockets.push(ws);
    ws.on("message", (d) => { try { frames.push(JSON.parse(d)); } catch {} });
    await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
    const nonce = Buffer.from((await wait(frames, (f) => f.t === "challenge")).nonce, "base64");
    return { nonce, ws, send: (f) => ws.send(JSON.stringify(f)), result: () => wait(frames, (f) => f.t === "attest-result") };
  };
  return { hub, relay, operator, owner, ownerId, cosigner, journalFile, phone, radFor, instanceProof, open,
           close: () => { for (const s of sockets) s.close(); srv.close(); cosigner.close(); } };
}

test("a registered name: no operator signature, no attach -- the owner's instance, co-signed over its own transcript, attaches; the journal records it", { skip, timeout: 60000 }, async () => {
  const R = await rig();
  try {
    const p = R.phone();
    const a = await R.open("pixel-owned"), { rad } = R.radFor(p, a.nonce);
    a.send({ t: "attest", rad });
    const r0 = await a.result();
    assert.equal(r0.ok, false); assert.match(r0.reason, /registered on chain; attach must carry operatorSig/);
    const b = await R.open("pixel-owned"), x = R.radFor(p, b.nonce);
    const s = await R.cosigner.sign({ relay: R.relay, name: "pixel-owned", nonce: b.nonce.toString("base64"), rad: x.rad, ...R.instanceProof(R.owner, x.B) });
    assert.equal(s.ok, true, s.reason); assert.equal(s.message, attachMessage("pixel-owned", b.nonce));
    b.send({ t: "attest", rad: x.rad, operatorSig: s.operatorSig });
    const r1 = await b.result();
    assert.equal(r1.ok, true, JSON.stringify(r1));
    const j = fs.readFileSync(R.journalFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(j.length, 1); assert.equal(j[0].instanceId, R.ownerId); assert.equal(j[0].nonceSha256, sha(b.nonce));
    assert.equal(j[0].spkiSha256, sha(p.transport)); assert.equal(j[0].name, "pixel-owned");
  } finally { R.close(); }
});

test("the co-signer refuses, and signs nothing: another nonce, another build or authority, another format, another name or relay, a non-canonical nonce, an instance not the owner's, the owner's instance over ANOTHER transcript, a nonce twice", { skip, timeout: 60000 }, async () => {
  const R = await rig();
  try {
    const p = R.phone(), N = createHash("sha256").update("nonce N").digest(), N2 = createHash("sha256").update("nonce N'").digest();
    const good = () => { const x = R.radFor(p, N); return { relay: R.relay, name: "pixel-owned", nonce: N.toString("base64"), rad: x.rad, ...R.instanceProof(R.owner, x.B) }; };
    const refused = async (req, re, what) => { const r = await R.cosigner.sign(req); assert.equal(r.ok, false, what); assert.match(r.reason, re, what); };
    // the rad is over N; the request names N' -> the transcript rebuilt over N' is not what the VM certified
    await refused({ ...good(), nonce: N2.toString("base64") }, /the rad:/, "a rad over another nonce");
    { const x = R.radFor(p, N, { code: OTHER_BUILD }); await refused({ ...good(), rad: x.rad, ...R.instanceProof(R.owner, x.B) }, /the rad:/, "another build"); }
    await refused({ ...good(), rad: { ...good().rad, format: "android-avf-pvm/v1" } }, /must be android-avf-pvm\/v2/, "another format");
    await refused({ ...good(), name: "someone-else" }, /its own name pixel-owned only/, "a requested name");
    await refused({ ...good(), relay: "http://127.0.0.1:1" }, /signs for http:\/\/127\.0\.0\.1:\d+ only/, "another relay");
    await refused({ ...good(), nonce: N.toString("base64").replace(/=$/, "") }, /canonical base64/, "a non-canonical nonce");
    await refused({ ...good(), extra: 1 }, /must be exactly/, "an unknown field");
    const stranger = generateKeyPairSync("ed25519");
    { const x = R.radFor(p, N); await refused({ ...good(), rad: x.rad, ...R.instanceProof(stranger, x.B) }, /is not one of the owner's/, "an instance not the owner's"); }
    // an impostor's rad (another VM's transport key) with the owner's instance signature from the OWNER's transcript
    { const impostor = R.phone(), xi = R.radFor(impostor, N), xo = R.radFor(p, N);
      await refused({ ...good(), rad: xi.rad, ...R.instanceProof(R.owner, xo.B) }, /does not verify over THIS transcript/, "the owner's instance paired with another boot's rad"); }
    assert.equal(fs.existsSync(R.journalFile) ? fs.readFileSync(R.journalFile, "utf8").trim() : "", "", "nothing was signed");
    const s = await R.cosigner.sign(good()); assert.equal(s.ok, true, s.reason);
    await refused(good(), /never twice/, "the same nonce again");
    // across a restart: the journal still knows the nonce
    const again = createAttachCosigner({ account: R.operator, name: "pixel-owned", relay: R.relay, codeHashes: [PVMCODE.toString("hex")], authorityHashes: [AUTH.toString("hex")],
                                         rootPins: undefined, instanceIds: [R.ownerId], journalFile: R.journalFile });
    const r2 = await again.sign(good()); assert.equal(r2.ok, false); assert.match(r2.reason, /never twice/); again.close();
    // the rate
    const tight = createAttachCosigner({ account: R.operator, name: "pixel-owned", relay: R.relay, codeHashes: [PVMCODE.toString("hex")], authorityHashes: [AUTH.toString("hex")],
                                         instanceIds: [R.ownerId], journalFile: path.join(path.dirname(R.journalFile), "tight.jsonl"), rate: { max: 1, ms: 60000 } });
    await tight.sign({ ...good(), nonce: N2.toString("base64") });
    const r3 = await tight.sign(good()); assert.equal(r3.ok, false); assert.match(r3.reason, /^rate/); tight.close();
  } finally { R.close(); }
});

test("the hub: a co-signature for nonce N refused on a connection whose nonce is N'; a second attach with a VALID co-signature and another transport key refused while the owner's tunnel is live", { skip, timeout: 60000 }, async () => {
  const R = await rig();
  try {
    const p = R.phone();
    const a = await R.open("pixel-owned"), b = await R.open("pixel-owned");
    const xa = R.radFor(p, a.nonce), sa = await R.cosigner.sign({ relay: R.relay, name: "pixel-owned", nonce: a.nonce.toString("base64"), rad: xa.rad, ...R.instanceProof(R.owner, xa.B) });
    assert.equal(sa.ok, true, sa.reason);
    const xb = R.radFor(p, b.nonce);
    b.send({ t: "attest", rad: xb.rad, operatorSig: sa.operatorSig });   // N's signature on N''s connection
    const rb = await b.result();
    assert.equal(rb.ok, false); assert.match(rb.reason, /registered on chain to .*, not /, "the signature recovers to another signer over N'");
    a.send({ t: "attest", rad: xa.rad, operatorSig: sa.operatorSig });
    assert.equal((await a.result()).ok, true, "the owner's attach, with its own co-signature");
    // another boot of the owner's own instance (a new transport key), validly co-signed, while the first tunnel is live
    const p2 = R.phone(), c = await R.open("pixel-owned"), xc = R.radFor(p2, c.nonce);
    const sc = await R.cosigner.sign({ relay: R.relay, name: "pixel-owned", nonce: c.nonce.toString("base64"), rad: xc.rad, ...R.instanceProof(R.owner, xc.B) });
    assert.equal(sc.ok, true, sc.reason);
    c.send({ t: "attest", rad: xc.rad, operatorSig: sc.operatorSig });
    const rc = await c.result();
    assert.equal(rc.ok, false); assert.match(rc.reason, /held by another enclave/, "a live name with another keyFp is not taken over");
  } finally { R.close(); }
});

test("the HTTP wrapper: loopback only; POST /attach-sign answers the co-signer's verdict; anything else 404", { skip, timeout: 60000 }, async () => {
  const R = await rig();
  let w;
  try {
    await assert.rejects(serveAttachCosigner(R.cosigner, { host: "0.0.0.0" }), /loopback only/);
    w = await serveAttachCosigner(R.cosigner, { port: 0 });
    const post = (p, body) => fetch(`http://127.0.0.1:${w.port}${p}`, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
    const p = R.phone(), a = await R.open("pixel-owned"), x = R.radFor(p, a.nonce);
    const ok = await post("/attach-sign", { relay: R.relay, name: "pixel-owned", nonce: a.nonce.toString("base64"), rad: x.rad, ...R.instanceProof(R.owner, x.B) });
    assert.equal(ok.status, 200); assert.match(ok.json.operatorSig, /^0x[0-9a-f]{130}$/);
    a.send({ t: "attest", rad: x.rad, operatorSig: ok.json.operatorSig });
    assert.equal((await a.result()).ok, true);
    const no = await post("/attach-sign", { relay: R.relay, name: "other" });
    assert.equal(no.status, 403); assert.match(no.json.error, /must be exactly|own name/);
    assert.equal((await post("/sign", {})).status, 404);
  } finally { if (w) w.close(); R.close(); }
});
