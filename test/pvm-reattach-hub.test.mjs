// Reconnect in place (RUNNER-AGENT.md "Reconnect in place"; design reviewed with the verifier session) on the REAL tunnel hub
// (relay/tunnel.js), with a synthetic AVF phone (test/fixtures/avf-synthetic.mjs) presenting a fake VM's transport key
// (test/fixtures/pvm-fake-vm.mjs, whose evidence endpoint answers EVIDENCE3 like the payload's). What the design takes from
// the hub, held here:
//   - the SAME transport key re-takes its live, registered name on a NEW connection, with a certificate over THAT connection's
//     nonce and the owner's co-signature for it: newest wins, and exactly one tunnel and one row remain;
//   - a certificate for another nonce, an old co-signature, and a whole old attest frame are each refused on a new connection;
//   - the re-attached tunnel's ABI/2 comes from the VM's own EVIDENCE3 answer for the hub's fresh nonce, copied field for
//     field as RelayAttach.sendAbi2FromEvidence does, and verifies; another VM's evidence (another transport key) is refused;
//   - repeated re-attaches work the same way each time.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { tmpdir, makeCa, haveOpenssl, issueLeaf, extension, AUTH } from "./fixtures/avf-synthetic.mjs";
import { startFakeVm, newInstance } from "./fixtures/pvm-fake-vm.mjs";
import { createAttachCosigner, ATTACH_INSTANCE_DOMAIN } from "../shielded/anchor/avf/runner/attach-cosigner.mjs";

const skip = !haveOpenssl && "no openssl";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const PVMCODE = createHash("sha256").update("pvm-cpu protected build (reattach test)").digest();
const APP = createHash("sha256").update("the served component (reattach test)").digest("hex");
const askVm = (port, line) => new Promise((resolve, reject) => {
  const c = net.connect(port, "127.0.0.1", () => c.write(line + "\n")); let b = "";
  c.on("data", (d) => (b += d)); c.on("end", () => resolve(b)); c.on("error", reject);
});
// RelayAttach.sendAbi2FromEvidence, in node: the VM's v3 answer's fields, passed through
const abi2FromEvidence = (ev) => ({ t: "abi2", chain: ev.chain, identity: ev.identity, selftest: ev.selftest, app: ev.app, instanceKey: ev.instanceKey, instanceSig: ev.instanceSig });

async function rig() {
  const { WebSocket } = await import("ws");
  const { createTunnelHub } = await import("../relay/tunnel.js");
  const { pvmCpuPolicy } = await import("../relay/pvm-cpu-tier.mjs");
  const { AVF_PAD_FORMAT, avfPadBinding } = await import("../relay/avf-binding.mjs");
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const dir = tmpdir("pvm-reattach-"), ca = makeCa(dir);
  const owner = newInstance(), ownerId = sha(owner.publicKey.export({ type: "spki", format: "der" }));
  const vm = await startFakeVm({ dir, ca, code: PVMCODE, appId: APP, instance: owner });              // the owner's VM, alive throughout
  const other = await startFakeVm({ dir, ca, code: PVMCODE, appId: APP, instance: newInstance() });   // another genuine VM
  const operator = privateKeyToAccount(generatePrivateKey());
  const hub = createTunnelHub({ allow: [], operatorFor: async (n) => (n === "pixel-owned" ? operator.address.toLowerCase() : null),
    attest: { avf: { codeHashes: [], padCodeHashes: [], authorityHashes: [AUTH.toString("hex")], rootPins: [ca.rootPin] },
              pvmCpu: pvmCpuPolicy({ codeHashes: [PVMCODE.toString("hex")], authorityHashes: [AUTH.toString("hex")], models: [{ sha256: "5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48", name: "m", selftestSha256: "d".repeat(64), minDecodeTokS: 10 }] }),
              pvmApp: { appIds: [APP], runtimeIds: [vm.rid] } } });
  const srv = http.createServer((_q, s) => s.end("ok")); srv.on("upgrade", (q, sock, head) => hub.handleUpgrade(q, sock, head));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const relay = `http://127.0.0.1:${srv.address().port}`, hubUrl = `ws://127.0.0.1:${srv.address().port}/v1/fleet-tunnel`;
  const cosigner = createAttachCosigner({ account: operator, name: "pixel-owned", relay, codeHashes: [PVMCODE.toString("hex")], authorityHashes: [AUTH.toString("hex")],
                                          rootPins: [ca.rootPin], instanceIds: [ownerId], journalFile: `${dir}/cosign/journal.jsonl`, rate: { max: 50, ms: 60000 } });
  const sockets = [];
  const wait = async (frames, pred, ms = 8000) => { const until = Date.now() + ms; while (Date.now() < until) { const f = frames.find(pred); if (f) return f; await new Promise((r) => setTimeout(r, 20)); } return null; };
  // the owner's VM as the phone presents it: ITS transport key, a pad key; the rad over a connection's nonce
  const phone = { transport: Buffer.from(vm.transportSpki, "hex"), padKey: generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex") };
  const radFor = (nonce) => {
    const B = avfPadBinding(phone.transport, phone.padKey, nonce), leaf = issueLeaf(dir, { ext: extension({ challenge: createHash("sha256").update(B).digest(), code: PVMCODE }) });
    return { B, rad: { format: AVF_PAD_FORMAT, body: Buffer.from(JSON.stringify({ chain: [leaf.leaf, ca.inter, ca.root].map((x) => x.toString("base64")), signature: leaf.sign(B).toString("base64") })).toString("base64"),
                       transportKey: phone.transport.toString("base64"), padKey: phone.padKey } };
  };
  const cosign = async (nonce, x) => cosigner.sign({ relay, name: "pixel-owned", nonce: nonce.toString("base64"), rad: x.rad,
    instanceKey: owner.publicKey.export({ type: "spki", format: "der" }).toString("hex"), instanceSig: edSign(null, Buffer.concat([Buffer.from(ATTACH_INSTANCE_DOMAIN), x.B]), owner.privateKey).toString("hex") });
  const open = async () => {
    const frames = [], ws = new WebSocket(hubUrl, { headers: { "x-metal-name": "pixel-owned", "x-metal-attest": "1" } }); sockets.push(ws);
    let closed = false; ws.on("close", () => { closed = true; });
    ws.on("message", (d) => { try { frames.push(JSON.parse(d)); } catch {} });
    await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
    const nonce = Buffer.from((await wait(frames, (f) => f.t === "challenge")).nonce, "base64");
    return { nonce, ws, frames, closed: () => closed, send: (f) => ws.send(JSON.stringify(f)), result: () => wait(frames, (f) => f.t === "attest-result"), next: (t) => wait(frames, (f) => f.t === t) };
  };
  // one full attach of the owner's VM on a new connection: its certificate over THIS nonce, the owner's co-signature, hello
  const attach = async () => {
    const c = await open(), x = radFor(c.nonce), s = await cosign(c.nonce, x);
    assert.equal(s.ok, true, s.reason);
    c.send({ t: "attest", rad: x.rad, operatorSig: s.operatorSig });
    const r = await c.result(); assert.equal(r.ok, true, JSON.stringify(r));
    c.send({ t: "hello", name: "pixel-owned", mode: "avf", publicUrl: `https://relay.example/t/pixel-owned` });
    return { c, x, s };
  };
  const abi2 = async (c, fromVm) => {
    const ch = await c.next("abi2-challenge"); assert.ok(ch, "the hub issues a fresh ABI/2 nonce to the new tunnel");
    const hex = Buffer.from(ch.nonce, "base64").toString("hex"), ev = JSON.parse((await askVm(fromVm.evidencePort, `EVIDENCE3 ${hex}`)).split("\n")[0]);
    assert.equal(ev.format, "enclave-pvm-app-evidence/v3"); assert.equal(ev.nonce, hex);
    c.send(abi2FromEvidence(ev));
    return c.next("abi2-result");
  };
  const rows = () => hub.origins().filter((o) => o.name === "pixel-owned");
  return { hub, vm, other, ownerId, open, attach, abi2, radFor, cosign, rows,
           close: () => { for (const s of sockets) try { s.close(); } catch {} srv.close(); cosigner.close(); vm.close(); other.close(); } };
}

test("reconnect in place on the real hub: the same transport key re-takes its live name on a fresh nonce with the owner's co-signature (newest wins, one tunnel); ABI/2 from the VM's EVIDENCE3 verifies; another VM's evidence, another nonce's certificate, an old co-signature and an old attest frame are refused",
     { skip, timeout: 90000 }, async () => {
  const R = await rig();
  try {
    // the boot attach, and its ABI/2 through the same EVIDENCE3 path
    const A = await R.attach();
    assert.equal((await R.abi2(A.c, R.vm)).ok, true);
    assert.equal(R.rows().length, 1); assert.equal(R.rows()[0].pvmApp.instanceId, R.ownerId);
    // the relay still holds A (a half-open drop, as the relay sees it): every stale form is refused on a new connection
    const c1 = await R.open(), x1 = R.radFor(c1.nonce), s1 = await R.cosign(c1.nonce, x1);
    c1.send({ t: "attest", rad: A.x.rad, operatorSig: s1.operatorSig });        // A's certificate (A's nonce) on c1, with c1's valid co-signature
    const r1 = await c1.result(); assert.equal(r1.ok, false); assert.doesNotMatch(r1.reason, /held by another/);
    const c2 = await R.open(), x2 = R.radFor(c2.nonce);
    c2.send({ t: "attest", rad: x2.rad, operatorSig: A.s.operatorSig });        // a fresh certificate with A's (old) co-signature
    const r2 = await c2.result(); assert.equal(r2.ok, false); assert.match(r2.reason, /registered on chain to .*, not /);
    const c3 = await R.open();
    c3.send({ t: "attest", rad: A.x.rad, operatorSig: A.s.operatorSig });       // A's whole attest frame, replayed
    const r3 = await c3.result(); assert.equal(r3.ok, false);
    assert.equal(R.hub.count(), 1); assert.equal(A.c.closed(), false, "no refused attach disturbed the live tunnel");
    // the genuine in-place re-attach: newest wins, one tunnel, one row
    const B = await R.attach();
    for (let i = 0; i < 100 && !A.c.closed(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(A.c.closed(), true, "the hub terminated the previous socket");
    assert.equal(R.hub.count(), 1); assert.equal(R.rows().length, 1);
    // its ABI/2: another genuine VM's evidence for the hub's nonce is refused (not THIS tunnel's transport key) -- the nonce is spent
    const bad = await R.abi2(B.c, R.other);
    assert.equal(bad.ok, false, JSON.stringify(bad));
    assert.equal(R.rows()[0].pvmApp, undefined, "no verified app on this tunnel");
    // again (a repeated drop): the next in-place re-attach, with the owner's VM's own evidence, verifies
    const C = await R.attach();
    for (let i = 0; i < 100 && !B.c.closed(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(B.c.closed(), true);
    const ok = await R.abi2(C.c, R.vm);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(R.hub.count(), 1); assert.equal(R.rows().length, 1);
    assert.equal(R.rows()[0].pvmApp.instanceId, R.ownerId); assert.equal(R.rows()[0].pvmApp.transportSpki, R.vm.transportSpki);
    assert.equal(R.rows()[0].tier, undefined, "no caps on an in-place re-attach: the row has no tier");
  } finally { R.close(); }
});
