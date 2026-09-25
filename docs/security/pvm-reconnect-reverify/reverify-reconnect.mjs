// enclave-99's INDEPENDENT offline re-verification of a pVM reconnect run's attach transcripts.
// It uses node:crypto and viem only: no module from the pVM lane, and none of the relay's AVF verifier. The Google root pins
// come from origin/main's relay/avf-verify.mjs SOURCE (passed in), never from the run's own run.json.
//   usage: node reverify-reconnect.mjs <results dir> <pins file: one sha256 hex per line>
import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, verify as cryptoVerify, X509Certificate } from "node:crypto";
import { recoverMessageAddress } from "viem";

const dir = path.resolve(process.argv[2]);
const PINS = new Set(fs.readFileSync(process.argv[3], "utf8").split(/\s+/).filter(Boolean));
const jl = (f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
const sha = (b) => createHash("sha256").update(b).digest();
const hex = (b) => Buffer.from(b).toString("hex");
const NAME = run.endpoint.split("/t/")[1], OP = run.pins.operator.toLowerCase(), OWNER = run.ownerInstanceOutOfBand;
const fails = []; const expect = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };

// the pad-binding transcript B, written here from its definition (RUNNER-AGENT/INSTANCE-BINDING): domain || SPKI || padKey || nonce
const PAD_DOMAIN = Buffer.from("enclave-avf-pad-bind-v1\n"), INST_DOMAIN = Buffer.from("enclave-pvm-attach-instance-v1\n");
const ED_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

expect([...PINS].every((p) => run.googleRootPins.includes(p)) && run.googleRootPins.every((p) => PINS.has(p)),
       `the run's root pins are exactly main's production pins (${[...PINS].map((p) => p.slice(0, 12)).join(", ")})`);

// one AVF chain: every link signed by the next, the root self-signed and pinned, valid at `when`; returns the parsed chain
function chainOk(chainB64, when, where) {
  const certs = chainB64.map((c) => new X509Certificate(Buffer.from(c, "base64")));
  for (let i = 0; i < certs.length - 1; i++) if (!certs[i].verify(certs[i + 1].publicKey)) return [null, `${where}: link ${i} not signed by ${i + 1}`];
  const root = certs[certs.length - 1];
  if (!root.verify(root.publicKey)) return [null, `${where}: root not self-signed`];
  const fp = root.fingerprint256.replace(/:/g, "").toLowerCase();
  if (!PINS.has(fp)) return [null, `${where}: root ${fp.slice(0, 12)} not a production pin`];
  const t = new Date(when);
  for (const [i, c] of certs.entries()) if (!(new Date(c.validFrom) <= t && t <= new Date(c.validTo))) return [null, `${where}: cert ${i} not valid at ${when}`];
  return [certs, null];
}
const contains = (hay, needle) => Buffer.from(hay).indexOf(Buffer.from(needle)) >= 0;

// ---- the owner-co-signed attaches ----
const AT = jl("attach.jsonl"), owner = AT.filter((x) => x.signer === "owner" && x.verdict && x.verdict.ok);
const parents = new Set(), spkis = new Set(), nonces = [];
let good = 0;
for (const x of owner) {
  const q = x.request, why = [];
  const nonce = Buffer.from(q.nonce, "base64"), spki = Buffer.from(q.rad.transportKey, "base64");
  if (nonce.length !== 32) why.push("nonce not 32 bytes");
  if (!(spki.length === 44 && spki.subarray(0, 12).equals(ED_PREFIX))) why.push("transport key not an Ed25519 SPKI");
  if (!/^[0-9a-f]{64}$/.test(q.rad.padKey)) why.push("padKey not 32 bytes hex");
  const Bt = Buffer.concat([PAD_DOMAIN, spki, Buffer.from(q.rad.padKey, "hex"), nonce]);
  const ev = JSON.parse(Buffer.from(q.rad.body, "base64").toString("utf8"));
  const [certs, cerr] = chainOk(ev.chain, x.utc, `attach ${x.step}`);
  if (cerr) why.push(cerr);
  else {
    parents.add(hex(sha(Buffer.from(ev.chain[1], "base64"))));
    // the leaf's key signed exactly transcript B (ECDSA/SHA-256 for an EC key, else the key's own scheme)
    const leafKey = certs[0].publicKey, alg = leafKey.asymmetricKeyType === "ec" ? "sha256" : null;
    if (!cryptoVerify(alg, Bt, leafKey, Buffer.from(ev.signature, "base64"))) why.push("leaf signature over B does not verify");
    // sha256(B) is the attested challenge, and the build's code hash is attested: both appear in the chain's attested bytes
    const der = Buffer.concat(ev.chain.map((c) => Buffer.from(c, "base64")));
    if (!contains(Buffer.from(ev.chain[0], "base64"), sha(Bt))) why.push("sha256(B) is not in the leaf certificate");
    if (!contains(der, Buffer.from(run.code, "hex"))) why.push("the build's code hash is not in the chain");
  }
  // the owner's out-of-band VM instance signed THIS transcript
  const ik = Buffer.from(q.instanceKey, "hex");
  if (hex(sha(ik)) !== OWNER) why.push("instance key is not the owner's out-of-band instance");
  else if (!cryptoVerify(null, Buffer.concat([INST_DOMAIN, Bt]), createPublicKey({ key: ik, format: "der", type: "spki" }), Buffer.from(q.instanceSig, "hex"))) why.push("instance signature over B does not verify");
  // the owner's operator key signed exactly this name and nonce
  const signer = (await recoverMessageAddress({ message: `enclave-tunnel-attach:${NAME}:${q.nonce}`, signature: x.verdict.operatorSig })).toLowerCase();
  if (signer !== OP) why.push(`operator signature recovers to ${signer.slice(0, 10)}, not the owner`);
  if (q.name !== NAME || q.rad.name !== NAME) why.push("name mismatch");
  spkis.add(q.rad.transportKey); nonces.push(q.nonce);
  if (why.length) console.log(`   attach ${x.step}: ${why.join("; ")}`); else good++;
}
expect(owner.length >= 9 && good === owner.length, `every owner-co-signed attach re-verifies independently (${good}/${owner.length}): chain to a production Google root, leaf signature over B, sha256(B) and the build attested, the owner's instance over B, the operator over name+nonce`);
expect(spkis.size === 1, `ONE transport key across every attach (${spkis.size})`);
expect(new Set(nonces).size === nonces.length, "no nonce co-signed twice");

// ---- the statements' chains hang off the same AVF parent ----
const EX = jl("exchanges.jsonl");
let stChains = 0;
for (const e of EX) {
  const scan = (o) => { if (!o || typeof o !== "object") return; if (Array.isArray(o.chain) && o.chain.length >= 2 && typeof o.chain[1] === "string") { try { const [c, err] = chainOk(o.chain, e.utc || new Date().toISOString(), "statement"); if (c) { parents.add(hex(sha(Buffer.from(o.chain[1], "base64")))); stChains++; } else console.log("   " + err); } catch {} } for (const v of Object.values(o)) if (v && typeof v === "object") scan(v); };
  for (const k of ["answer", "doc", "response"]) { const s = e[k]; if (typeof s === "string") { for (const line of s.split("\n")) { try { scan(JSON.parse(line)); } catch {} } } else scan(s); }
}
expect(parents.size === 1, `every chain (${owner.length} attaches + ${stChains} statement chains) hangs off ONE AVF parent (${[...parents].map((p) => p.slice(0, 12)).join(", ")})`);

// ---- the refusals R3 records: the wrong operator recovers to the wrong key; the stale signature is an earlier owner one ----
const wrong = AT.filter((x) => x.signer === "wrong-operator"), stale = AT.filter((x) => x.signer === "proxy-stale");
const wr = wrong.length === 1 ? (await recoverMessageAddress({ message: `enclave-tunnel-attach:${NAME}:${wrong[0].request.nonce}`, signature: wrong[0].verdict.operatorSig })).toLowerCase() : "";
const st = stale.length === 1 ? stale[0] : null;
const stOk = !!st && owner.some((x) => x.verdict.operatorSig === st.verdict.operatorSig && x.request.nonce !== st.request.nonce && x.utc < st.utc)
  && (await recoverMessageAddress({ message: `enclave-tunnel-attach:${NAME}:${st.request.nonce}`, signature: st.verdict.operatorSig })).toLowerCase() !== OP;
expect(wr === String(run.wrongOperator).toLowerCase() && stOk, "R3: the wrong operator's signature recovers to that key; the stale one is an earlier owner signature that, over the new nonce, recovers to someone else");

console.log(fails.length ? `FAIL ${fails.length}` : `PASS independent re-verification (${path.basename(dir)})`);
process.exit(fails.length ? 1 : 0);
