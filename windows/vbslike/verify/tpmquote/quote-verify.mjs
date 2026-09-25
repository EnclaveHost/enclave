// quote-verify.mjs - the VERIFIER's side of one TPM quote from nucbox-k11, using the relay's own code.
//
//   node quote-verify.mjs mint   <keys.txt> <workdir>   read the helper's `keys` reply; check the EK certificate chains
//                                                       to the pinned AMD root BEFORE minting anything; mint a fresh
//                                                       32-byte credential with TPM2_MakeCredential(EK, AK name) and a
//                                                       fresh 32-byte nonce, both from THIS machine's RNG; write
//                                                       in.txt (for the box) and verifier-secret.json (stays here)
//   node quote-verify.mjs verify <workdir>              relay/vbs-verify.mjs verifyVbsEvidence on the reply, then
//                                                       negative controls that MUST each be refused
//
// Scope: TPM and measured-boot evidence ONLY. There is no enclave report on this boot (the test-signed engine does
// not load under Secure Boot), so the enclave checks (6, 7) are reported as NOT APPLICABLE, never as passes. Nothing
// here says anything about who signs the paravisor's VM report.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../relay");
const { verifyVbsEvidence, loadTpmRoots, verifyEkChain, tpmNameOf } = await import(path.join(RELAY, "vbs-verify.mjs"));
const { makeCredential, ekPublicFrom } = await import(path.join(RELAY, "vbs-credential.mjs"));
const { VBS_DEFAULT_EK_ROOTS } = await import(path.join(RELAY, "vbs-policy.mjs"));
import { X509Certificate } from "node:crypto";

const kv = (file) => Object.fromEntries(fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => /^\S+ /.test(l))
  .map((l) => [l.slice(0, l.indexOf(" ")), l.slice(l.indexOf(" ") + 1)]));
const need = (o, k, f) => { if (!o[k]) throw new Error(`${f}: no "${k}" line`); return o[k]; };
const ROOTS = fs.readFileSync(VBS_DEFAULT_EK_ROOTS, "utf8");
const sha = (b) => createHash("sha256").update(b).digest("hex");

function mint(keysFile, dir) {
  const k = kv(keysFile);
  const ekDer = Buffer.from(need(k, "ek-cert", keysFile), "hex");
  const aikPub = Buffer.from(need(k, "aik-pub", keysFile), "hex");
  const aikName = Buffer.from(need(k, "aik-name", keysFile), "hex");
  if (!tpmNameOf(aikPub).equals(aikName)) throw new Error("aik-name is not 0x000B || sha256(aik-pub): refusing to mint");
  const trust = loadTpmRoots(ROOTS);
  const chain = verifyEkChain(new X509Certificate(ekDer), [], trust);
  if (!chain.ok) throw new Error(`EK certificate does not chain to a pinned root: ${chain.reason}: refusing to mint`);
  const credential = randomBytes(32), nonce = randomBytes(32);
  const mc = makeCredential(ekPublicFrom(ekDer), aikName, credential);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "in.txt"), `blob=${mc.credentialBlob.toString("hex")}\nsecret=${mc.secret.toString("hex")}\nnonce=${nonce.toString("hex")}\n`);
  fs.writeFileSync(path.join(dir, "verifier-secret.json"), JSON.stringify({ credential: credential.toString("hex"), nonce: nonce.toString("hex"),
    ekCertSha256: sha(ekDer), aikName: aikName.toString("hex") }, null, 1));
  console.log(`EK certificate chains to pinned root sha256 ${chain.root ? createHash("sha256").update(chain.root.raw).digest("hex") : "?"}`);
  console.log(`EK cert sha256 ${sha(ekDer)}; AK name ${aikName.toString("hex")}; nonce ${nonce.toString("hex").slice(0, 16)}...; credential minted (kept here)`);
}

function evidenceFrom(dir) {
  const k = kv(path.join(dir, "keys.txt")), a = kv(path.join(dir, "activate.txt")), q = kv(path.join(dir, "quote.txt"));
  const p0 = kv(path.join(dir, "pcr0.txt"));
  const pcr0 = String(need(p0, "pcr", "pcr0.txt")).split(" ").pop();
  const log = fs.readFileSync(path.join(dir, "measuredboot.log"));
  const b64 = (hex) => Buffer.from(hex, "hex").toString("base64");
  return {
    ev: { ek: { cert: b64(need(k, "ek-cert", "keys.txt")), chain: [] },
          quote: { attest: b64(need(q, "attest", "quote.txt")), sig: b64(need(q, "sig", "quote.txt")), aikPub: b64(need(q, "aik-pub", "quote.txt")) },
          credential: b64(need(a, "credential", "activate.txt")), log: log.toString("base64"), pcr0 },
    ekDer: Buffer.from(k["ek-cert"], "hex"), aikName: Buffer.from(k["aik-name"], "hex"), logSha: sha(log), activate: a,
  };
}

function run(ev, sec, { mintedFor, policy = { ekRoots: ROOTS, allowTestSigning: false } } = {}) {
  return verifyVbsEvidence({ evidence: ev, capture: { reportData: Buffer.from(sec.nonce, "hex"), quoteExtraData: Buffer.from(sec.nonce, "hex") },
    expectedCredential: Buffer.from(sec.credential, "hex"), mintedFor }, policy);
}
const TPM_SCOPE = /^(1|2|3|4|5) /;
const ENCLAVE_SCOPE = /^(6|7) /;

function verify(dir) {
  const sec = JSON.parse(fs.readFileSync(path.join(dir, "verifier-secret.json"), "utf8"));
  const { ev, ekDer, aikName, logSha, activate } = evidenceFrom(dir);
  const mintedFor = { ekCert: ekDer, aikName };
  if (sha(ekDer) !== sec.ekCertSha256) throw new Error("the EK certificate in keys.txt changed since minting");
  console.log(`activation ek-source=${activate["ek-source"] || "?"} ek-cert-match=${activate["ek-cert-match"] || "?"} policy-hmac=${activate["policy-hmac"] || "?"}`);
  console.log(`measured-boot log sha256 ${logSha}`);
  const res = run(ev, sec, { mintedFor });
  let tpmOk = true;
  console.log("== POSITIVE (this quote, fresh nonce and credential from this machine)");
  for (const c of res.checks) {
    const scope = TPM_SCOPE.test(c.name) ? "TPM/boot" : ENCLAVE_SCOPE.test(c.name) ? "enclave" : "binding";
    if (scope === "enclave") { console.log(`  N/A   ${c.name}  (no VBS enclave on this boot)`); continue; }
    if (scope === "TPM/boot" && !c.ok && (c.required && !c.dev)) tpmOk = false;
    console.log(`  ${c.ok ? "PASS " : c.dev ? "DEV  " : "FAIL "} ${c.name}${c.detail ? "  [" + c.detail + "]" : ""}`);
  }
  // NEGATIVE CONTROLS: each must fail the named check.
  const clone = () => JSON.parse(JSON.stringify(ev));
  const fails = (r, re) => r.checks.some((c) => re.test(c.name) && !c.ok);
  const flip = (b64s, i) => { const b = Buffer.from(b64s, "base64"); b[i % b.length] ^= 1; return b.toString("base64"); };
  const negs = [
    ["replay: the same quote against a NEW nonce", () => run(ev, { ...sec, nonce: randomBytes(32).toString("hex") }, { mintedFor }), /^4 quote: extraData == challenge/],
    ["one bit of the quote body flipped", () => { const e = clone(); e.quote.attest = flip(e.quote.attest, 40); return run(e, sec, { mintedFor }); }, /^4 quote: (signature|TPMS_ATTEST)/],
    ["one bit of the quote signature flipped", () => { const e = clone(); e.quote.sig = flip(e.quote.sig, 7); return run(e, sec, { mintedFor }); }, /^4 quote: signature/],
    ["wrong key binding: a credential this verifier never minted", () => run(ev, { ...sec, credential: randomBytes(32).toString("hex") }, { mintedFor }), /^3 credential/],
    ["wrong key binding: minted for a different AK name", () => { const n = Buffer.from(aikName); n[5] ^= 1; return run(ev, sec, { mintedFor: { ekCert: ekDer, aikName: n } }); }, /^2 aik: name/],
    ["substituted measurement: one byte of a PCR 12 record changed", () => { const e = clone(); const b = Buffer.from(e.log, "base64");
        const k = b.indexOf(Buffer.from([0x23, 0x00, 0x05, 0x00])); b[k + 40] ^= 1; e.log = b.toString("base64"); return run(e, sec, { mintedFor }); }, /^5 log: every SIPA record|^4 quote: PCR digest/],
    ["EK root not pinned", () => run(ev, sec, { mintedFor, policy: { ekRoots: "", allowTestSigning: false } }), /^1 ek: chains to a pinned/],
  ];
  let negOk = true;
  console.log("== NEGATIVE CONTROLS (each must be refused)");
  for (const [name, f, re] of negs) { const r = f(); const ok = fails(r, re); negOk = negOk && ok; console.log(`  ${ok ? "REFUSED" : "NOT REFUSED (CONTROL FAILED)"}  ${name}`); }
  console.log(`== RESULT: TPM/boot checks ${tpmOk ? "PASS" : "FAIL"}; negative controls ${negOk ? "all refused" : "NOT all refused"}; enclave checks N/A; relay tier ${res.tier || "(none)"}`);
  fs.writeFileSync(path.join(dir, "verdict.json"), JSON.stringify({ tpmOk, negOk, checks: res.checks, warnings: res.warnings, logSha256: logSha }, null, 1));
  return tpmOk && negOk ? 0 : 1;
}

const [cmd, a1, a2] = process.argv.slice(2);
if (cmd === "mint") mint(a1, a2);
else if (cmd === "verify") process.exit(verify(a1));
else { console.error("usage: quote-verify.mjs mint <keys.txt> <dir> | verify <dir>"); process.exit(2); }
