// A FAKE pVM for host tests of the browser channel: the real wire protocol on two TCP ports -- the evidence endpoint
// (`EVIDENCE <hex>` -> an enclave-pvm-app-evidence/v2 envelope over a SYNTHETIC chain, test/fixtures/avf-synthetic.mjs) and
// the sealed endpoint (u32 length || nonce || hdr || enc || ct -> a sealed canned response) -- with the VM's rules: a request
// only under an answered nonce, each (nonce, enc) once. Nothing here is a real attestation; the device run is the evidence.
import net from "node:net";
import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { bind2, appKeyMessage, PVM_APP_EVIDENCE_FORMAT_V2 } from "../../relay/pvm-app-attest.mjs";
import { issueLeaf, extension } from "./avf-synthetic.mjs";
import * as S from "../../shielded/anchor/avf/web/pvm-sealed.js";

export const PIXEL = '{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}';
const te = new TextEncoder();
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

export async function startFakeVm({ dir, ca, code, appId, identity = PIXEL, response = '{"tokens":[1,2,3],"fake":true}' }) {
  const vm = generateKeyPairSync("ed25519"), app = generateKeyPairSync("x25519");
  const spki = vm.publicKey.export({ type: "spki", format: "der" });
  const appKey = app.publicKey.export({ type: "spki", format: "der" }).subarray(12);
  const rid = createHash("sha256").update(identity).digest();
  const nonces = new Map(), log = [];
  const ev = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d; const i = buf.indexOf("\n"); if (i < 0) return;
      const m = /^EVIDENCE ([0-9a-f]{64})$/.exec(buf.slice(0, i));
      if (!m) return c.end('{"error":"request is EVIDENCE <64 lowercase hex>"}\n');
      const nonce = Buffer.from(m[1], "hex");
      const leaf = issueLeaf(dir, { ext: extension({ challenge: Buffer.concat([bind2(spki, nonce, rid), Buffer.from(appId, "hex")]), code }) });
      const env = { format: PVM_APP_EVIDENCE_FORMAT_V2, nonce: m[1], app: appId, spki: spki.toString("hex"), appKey: appKey.toString("hex"),
                    appKeySig: edSign(null, appKeyMessage(nonce, appId, appKey.toString("hex")), vm.privateKey).toString("hex"),
                    identity, selftest: "exec_pages=refused:EACCES wx=clean maps=1 scope=self", chain: [leaf.leaf, ca.inter, ca.root].map((x) => x.toString("base64")) };
      nonces.set(m[1], new Set()); log.push({ evidence: m[1].slice(0, 16) });
      c.end(JSON.stringify(env) + "\n");
    });
    c.on("error", () => {});
  });
  const kemSuite = new Uint8Array([...te.encode("KEM"), 0x00, 0x20]);
  const sealed = net.createServer((c) => {
    let buf = Buffer.alloc(0);
    c.on("error", () => {});
    c.on("data", async (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4 || buf.length < 4 + buf.readUInt32BE(0)) return;
      const body = buf.subarray(4, 4 + buf.readUInt32BE(0)); buf = Buffer.alloc(0);
      const nonce = body.subarray(0, 32), enc = body.subarray(39, 71), ct = body.subarray(71);
      const refuse = (why) => { log.push({ refused: why }); c.end(Buffer.concat([Buffer.from([1]), Buffer.from(why)])); };
      const seen = nonces.get(nonce.toString("hex"));
      if (!seen) return refuse("unknown evidence nonce: fetch fresh evidence");
      if (seen.has(enc.toString("hex"))) return refuse("replayed request: refused before it runs");
      try {
        const dh = diffieHellman({ privateKey: app.privateKey, publicKey: createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), enc]), format: "der", type: "spki" }) });
        const prk = await S.extract(new Uint8Array(0), new Uint8Array([...te.encode("HPKE-v1"), ...kemSuite, ...te.encode("eae_prk"), ...dh]));
        const shared = await S.expand(prk, new Uint8Array([0, 32, ...te.encode("HPKE-v1"), ...kemSuite, ...te.encode("shared_secret"), ...enc, ...appKey]), 32);
        const ks = await S.keySchedule(shared, S.requestInfo(Buffer.from(appId, "hex"), rid));
        const k = await crypto.subtle.importKey("raw", ks.key, "AES-GCM", false, ["decrypt"]);
        const req = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ks.baseNonce, additionalData: nonce }, k, ct));
        seen.add(enc.toString("hex")); log.push({ served: new TextDecoder().decode(req).split("\r\n")[0] });
        const resp = te.encode(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${te.encode(response).length}\r\n\r\n${response}`);
        c.end(Buffer.from(await S.sealResponseForTest({ enc, exporterSecret: ks.exporterSecret }, resp, randomBytes(16))));
      } catch { refuse("cannot open"); }
    });
  });
  const evidencePort = await listen(ev), sealedPort = await listen(sealed);
  return { evidencePort, sealedPort, log, rid: rid.toString("hex"), close: () => { ev.close(); sealed.close(); } };
}
