// windows/node/client.mjs -- a client of a Windows VBS node: seals the prompt to the enclave's ATTESTED pad key and
// opens the sealed answer, so the relay, the tunnel and the node's own host see only ciphertext.
//   node client.mjs <hub base url> <node name> "<prompt>" [max_tokens]
// The pad key comes from the hub's attested row for the node (what the relay verified in the attestation
// handshake), never from the node's own answer. Uses tweetnacl (npm) for crypto_box.
import { createRequire } from 'node:module';
const nacl = createRequire(import.meta.url)('tweetnacl');
const [hub, name, prompt, maxTokens = '16'] = process.argv.slice(2);
if (!hub || !name || !prompt) { console.error('usage: node client.mjs <hub url> <node name> "<prompt>" [max_tokens]'); process.exit(2); }
const info = await (await fetch(`${hub}/info/${name}`)).json();
if (!info || !info.padKey) { console.error(`no attested row for ${name} on ${hub}`); process.exit(1); }
const enclavePk = Buffer.from(info.padKey, 'hex');
const me = nacl.box.keyPair();
const nonce = nacl.randomBytes(24);
const req = Buffer.concat([Buffer.from(new Uint32Array([Number(maxTokens)]).buffer), Buffer.from(prompt, 'utf8')]);
const sealed = nacl.box(req, nonce, enclavePk, me.secretKey);
const blob = Buffer.concat([Buffer.from(me.publicKey), Buffer.from(nonce), Buffer.from(sealed)]);
const t0 = Date.now();
const r = await (await fetch(`${hub}/t/${name}/v1/session`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: blob })).json();
if (!r.blob) { console.error('node answered:', JSON.stringify(r)); process.exit(1); }
const out = Buffer.from(r.blob, 'base64');
const opened = nacl.box.open(out.subarray(24), out.subarray(0, 24), enclavePk, me.secretKey);
if (!opened) { console.error('the answer does not open under my key: not sealed by the attested enclave'); process.exit(1); }
const n = new DataView(Buffer.from(opened).buffer, Buffer.from(opened).byteOffset, 4).getUint32(0, true);
console.log(JSON.stringify({ node: name, tier: info.tier, padKey: info.padKey.slice(0, 16) + '…', text: Buffer.from(opened.subarray(4)).toString('utf8'), tokens: n, ms: Date.now() - t0, shielded: r.shielded }));
