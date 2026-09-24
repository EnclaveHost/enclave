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
  return { evidencePort, sealedPort, log, rid: rid.toString("hex"), close: () => { ev.close(); sealed.close(); } };
}
