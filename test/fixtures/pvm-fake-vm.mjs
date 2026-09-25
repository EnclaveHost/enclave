// A FAKE pVM for host tests of the browser channel: the real wire protocol on two TCP ports -- the evidence endpoint
// (`EVIDENCE <hex>` -> an enclave-pvm-app-evidence/v2 envelope over a SYNTHETIC chain, test/fixtures/avf-synthetic.mjs;
// `EVIDENCE3 <hex>` -> v3, bound to this VM's INSTANCE key, INSTANCE-BINDING.md) and
// the sealed endpoint (u32 length || nonce || hdr || enc || ct -> a sealed canned response) -- with the VM's rules: a request
// only under an answered nonce, each (nonce, enc) once. Nothing here is a real attestation; the device run is the evidence.
import net from "node:net";
import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { bind2, bind3, instanceIdOf, instanceSigMessage, appKeyMessage, appKeyMessageV3, PVM_APP_EVIDENCE_FORMAT_V2, PVM_APP_EVIDENCE_FORMAT_V3,
         proofKeyMessage, PROOF_KEY_FORMAT, INSTANCE_TYPES, SIG_ALGS } from "../../relay/pvm-app-attest.mjs";
import { issueLeaf, extension } from "./avf-synthetic.mjs";
import * as S from "../../shielded/anchor/avf/web/pvm-sealed.js";

export const PIXEL = '{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}';
const te = new TextEncoder();
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

/** A VM INSTANCE's key (on the device: derived from AVmPayload_getVmInstanceSecret, the same across restarts). */
export const newInstance = () => generateKeyPairSync("ed25519");
// instance: the instance key pair (a "restart" is a new fake VM with the SAME instance and a fresh transport key); forge
// (tests only) makes v3 answers WRONG in one named way: "bind2" (the certificate over Bind2 -- the instance not attested),
// "sig-by-transport" (instanceSig made by the transport key), "instance-is-transport" (instanceKey = the transport SPKI),
// "appkey-v2" (appKeySig under the v2 message, without the instance); and for EVIDENCE3 as a whole: "no-v3" (an OLD build that
// does not know the request) and "downgrade" (answers a v2 envelope to it)
// The lease proof key (PROOF-KEY.md): proofSeed stands for AVmPayload_getVmInstanceSecret("enclave-pvm-proof-key-v1") -- the
// same instance, the same seed, the same key; proofPins are the launch pins ({ chainId, proofOfTime, registry, deployment,
// enclaveId, operator }, strings as in the statement). PROOFKEY <nonce> answers the attested statement; CHECKPOINT <upto>
// <anchorBlock> <anchorHash> signs a ProofOfTime checkpoint under the VM's policy (serving, strictly increasing upto,
// non-decreasing anchor, one per checkpointEveryMs). setServing(false) stands for the app having stopped.
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export function proofKeyFromSeed(seed) {
  let s = Buffer.from(seed);
  for (;;) { const k = BigInt("0x" + s.toString("hex")); if (k > 0n && k < SECP_N) return "0x" + s.toString("hex"); s = createHash("sha256").update(s).digest(); }
}
export async function startFakeVm({ dir, ca, code, appId, identity = PIXEL, response = '{"tokens":[1,2,3],"fake":true}', instance = newInstance(), forge = null,
                                    proofSeed = randomBytes(32), proofPins = null, checkpointEveryMs = 60000 }) {
  const { privateKeyToAccount } = await import("viem/accounts");
  const { typedDataOf } = await import("../../relay/pvm-checkpoint.mjs");
  const proofAcct = privateKeyToAccount(proofKeyFromSeed(proofSeed));
  let serving = true, lastUpto = 0n, lastAnchor = 0n, lastSignedAt = 0;
  const vm = generateKeyPairSync("ed25519"), app = generateKeyPairSync("x25519");
  const ispki = instance.publicKey.export({ type: "spki", format: "der" }), iid = instanceIdOf(ispki);
  const spki = vm.publicKey.export({ type: "spki", format: "der" });
  const appKey = app.publicKey.export({ type: "spki", format: "der" }).subarray(12);
  const rid = createHash("sha256").update(identity).digest();
  const nonces = new Map(), log = [];
  const ev = net.createServer((c) => {
    let buf = "";
    c.on("data", async (d) => {
      buf += d; const i = buf.indexOf("\n"); if (i < 0) return;
      const line = buf.slice(0, i); buf = "\uffff";   // one request per connection
      const refuse = (why) => { log.push({ proofRefused: why }); c.end(JSON.stringify({ error: why }) + "\n"); };
      const cp = /^CHECKPOINT (0|[1-9][0-9]{0,19}) (0|[1-9][0-9]{0,19}) ([0-9a-f]{64})$/.exec(line);
      if (line.startsWith("CHECKPOINT")) {   // the VM's signing policy, in its order
        if (!cp) return refuse("request is CHECKPOINT <upto> <anchorBlock> <64 lowercase hex>");
        if (!proofPins) return refuse("no proof pins: this VM signs no checkpoint");
        if (!serving) return refuse("the app is not serving: no checkpoint");
        const upto = BigInt(cp[1]), anchorBlock = BigInt(cp[2]);
        if (upto >= 1n << 64n || anchorBlock >= 1n << 64n) return refuse("upto and anchorBlock are u64");
        if (upto <= lastUpto) return refuse("upto must strictly increase");
        if (anchorBlock < lastAnchor) return refuse("anchorBlock must not decrease");
        if (lastSignedAt && Date.now() - lastSignedAt < checkpointEveryMs) return refuse(`at most one checkpoint every ${checkpointEveryMs / 1000} s`);
        const anchorHash = "0x" + cp[3];
        const sig = await proofAcct.signTypedData(typedDataOf(proofPins, { upto, anchorBlock, anchorHash }));
        lastUpto = upto; lastAnchor = anchorBlock; lastSignedAt = Date.now(); log.push({ checkpoint: String(upto) });
        return c.end(JSON.stringify({ format: "enclave-pvm-checkpoint/v1", chainId: proofPins.chainId, proofOfTime: proofPins.proofOfTime, registry: proofPins.registry,
          deployment: proofPins.deployment, enclaveId: proofPins.enclaveId, operator: proofPins.operator, upto: String(upto), anchorBlock: String(anchorBlock), anchorHash, sig }) + "\n");
      }
      const pk = /^PROOFKEY ([0-9a-f]{64})$/.exec(line);
      if (line.startsWith("PROOFKEY") && (!pk || !proofPins)) return refuse(pk ? "no proof pins: no proof-key statement" : "request is PROOFKEY <64 lowercase hex>");
      const m = pk ? ["", "EVIDENCE3", pk[1]] : /^(EVIDENCE3?) ([0-9a-f]{64})$/.exec(line);
      if (!m) return c.end('{"error":"request is EVIDENCE <64 lowercase hex>"}\n');
      if (m[1] === "EVIDENCE3" && forge === "no-v3") return c.end('{"error":"request is EVIDENCE <64 lowercase hex>"}\n');
      const v3 = m[1] === "EVIDENCE3" && forge !== "downgrade", hex = m[2], nonce = Buffer.from(hex, "hex");
      const bind = v3 && forge !== "bind2" ? bind3(spki, nonce, rid, iid) : bind2(spki, nonce, rid), challenge = Buffer.concat([bind, Buffer.from(appId, "hex")]);
      const leaf = issueLeaf(dir, { ext: extension({ challenge, code }) });
      const common = { nonce: hex, app: appId, spki: spki.toString("hex"), appKey: appKey.toString("hex"), identity, selftest: "exec_pages=refused:EACCES wx=clean maps=1 scope=self",
                       chain: [leaf.leaf, ca.inter, ca.root].map((x) => x.toString("base64")) };
      const env = !v3 ? { format: PVM_APP_EVIDENCE_FORMAT_V2, ...common, appKeySig: edSign(null, appKeyMessage(nonce, appId, appKey.toString("hex")), vm.privateKey).toString("hex") }
        : { format: PVM_APP_EVIDENCE_FORMAT_V3, ...common,
            instanceKey: (forge === "instance-is-transport" ? spki : ispki).toString("hex"),
            instanceSig: edSign(null, instanceSigMessage(challenge), forge === "sig-by-transport" ? vm.privateKey : instance.privateKey).toString("hex"),
            appKeySig: edSign(null, forge === "appkey-v2" ? appKeyMessage(nonce, appId, appKey.toString("hex")) : appKeyMessageV3(nonce, appId, iid, appKey.toString("hex")), vm.privateKey).toString("hex") };
      if (pk) {   // the attested statement: the transport key vouches for the proof key, this instance, these pins
        const p = proofPins, msg = proofKeyMessage({ nonce: hex, appId, instanceType: INSTANCE_TYPES["pvm-instance-id"], instanceValue: iid.toString("hex"),
          sigAlg: SIG_ALGS.ed25519, proofKey: proofAcct.address.toLowerCase(), chainId: p.chainId, proofOfTime: p.proofOfTime, registry: p.registry,
          deployment: p.deployment, enclaveId: p.enclaveId, operator: p.operator });
        log.push({ proofKeyStatement: hex.slice(0, 16) });
        return c.end(JSON.stringify({ format: PROOF_KEY_FORMAT, evidence: env, instance: { type: "pvm-instance-id", value: iid.toString("hex") }, sigAlg: "ed25519",
          proofKey: proofAcct.address.toLowerCase(), ...p, sig: edSign(null, msg, vm.privateKey).toString("hex") }) + "\n");
      }
      nonces.set(hex, new Set()); log.push({ evidence: hex.slice(0, 16), format: env.format });
      c.end(JSON.stringify(env) + "\n");
    });
    c.on("error", () => {});
  });
  const recipientKey = { privateKey: app.privateKey ? await crypto.subtle.importKey("pkcs8", app.privateKey.export({ type: "pkcs8", format: "der" }), { name: "X25519" }, true, ["deriveBits"]) : null,
                         publicKey: await crypto.subtle.importKey("raw", appKey, { name: "X25519" }, true, []) };
  const sealed = net.createServer((c) => {
    let buf = Buffer.alloc(0);
    c.on("error", () => {});
    c.on("data", async (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4 || buf.length < 4 + buf.readUInt32BE(0)) return;
      const body = buf.subarray(4, 4 + buf.readUInt32BE(0)); buf = Buffer.alloc(0);
      const nonce = body.subarray(0, 32), hdr = body.subarray(32, 39), enc = body.subarray(39, 71), ct = body.subarray(71);
      const chunked = hdr[0] === 1;
      const refuse = (why) => { log.push({ refused: why }); c.end(Buffer.concat([Buffer.from([1]), Buffer.from(why)])); };
      const seen = nonces.get(nonce.toString("hex"));
      if (!seen) return refuse("unknown evidence nonce: fetch fresh evidence");
      if (seen.has(enc.toString("hex"))) return refuse("replayed request: refused before it runs");
      try {
        const rc = await S.suite.createRecipientContext({ recipientKey, enc, info: S.requestInfo(Buffer.from(appId, "hex"), rid, chunked) });
        const req = new Uint8Array(await rc.open(ct, nonce));
        const ctx = { enc, nonce, chunked, secret: new Uint8Array(await rc.export(new TextEncoder().encode(`${S.LABEL}${chunked ? " chunked" : ""} response`), 16)) };
        seen.add(enc.toString("hex")); log.push({ served: new TextDecoder().decode(req).split("\r\n")[0], chunked });
        if (!chunked) {
          const resp = te.encode(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${te.encode(response).length}\r\n\r\n${response}`);
          return c.end(Buffer.from(await S.sealResponseForTest(ctx, resp, randomBytes(16))));
        }
        // streamed: the head, then one NDJSON line per chunk (chunked transfer encoding), then FIN
        const lines = [0, 1, 2].map((i) => `{"i":${i},"token":${7 + i}}\n`);
        const parts = ["HTTP/1.1 200 OK\r\ncontent-type: application/x-ndjson\r\ntransfer-encoding: chunked\r\n\r\n",
                       ...lines.map((l) => `${te.encode(l).length.toString(16)}\r\n${l}\r\n`), "0\r\n\r\n"];
        c.end(Buffer.from(await S.sealStreamForTest(ctx, randomBytes(16), [...parts.map((p) => ({ type: S.CHUNK.DATA, pt: te.encode(p) })), { type: S.CHUNK.FIN, pt: new Uint8Array(0) }])));
      } catch { refuse("cannot open"); }
    });
  });
  const evidencePort = await listen(ev), sealedPort = await listen(sealed);
  return { evidencePort, sealedPort, log, rid: rid.toString("hex"), instanceId: iid.toString("hex"), transportSpki: spki.toString("hex"),
           proofKey: proofAcct.address.toLowerCase(), setServing: (v) => { serving = v; }, close: () => { ev.close(); sealed.close(); } };
}
