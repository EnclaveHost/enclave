#!/usr/bin/env node
// verify-app-attest.mjs -- milestone 5 on a capture (PVM-CPU.md, "The app runtime"): the app run's ABI/2 evidence through
// relay/pvm-app-attest.mjs, as a relay would check it.
//   node cpu/verify-app-attest.mjs --log FILE --app <component sha256> --authority <APK signing authority hash>
//                                  [--runtime-id <hex>] [--code-hash <hex>]
// The nonce is the owner's challenge from the same capture (CONTROL challenge=...): a local run is not relay-bound, so this
// checks the binding and the chain, not a relay's freshness. The runtime pin defaults to the pVM's identity (pvm-rt,
// wasmtime 49.0.0, interpreter, pulley64). Without --code-hash the APK codeHash is taken from the same capture's ATTACH
// chain -- so this then proves the two certificates name the same build, not which build it is; pass --code-hash to pin it.
// Exit 0 only when the evidence verifies.
import fs from "node:fs";
import { createHash, X509Certificate } from "node:crypto";
import { evidenceFromLog, parseAvfExtension } from "../../../../relay/avf-verify.mjs";
import { abi2FromLog, verifyPvmAppAbi2 } from "../../../../relay/pvm-app-attest.mjs";

const PIXEL = '{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const log = arg("--log"), app = arg("--app"), authority = arg("--authority");
if (!log || !/^[0-9a-f]{64}$/.test(app || "") || !authority) { console.error("usage: verify-app-attest.mjs --log FILE --app <sha256> --authority <hash> [--runtime-id hex] [--code-hash hex]"); process.exit(2); }
const text = fs.readFileSync(log, "utf8");
const ev = abi2FromLog(text);
const spki = /SPKI ([0-9a-f]{88})/.exec(text);
const chal = /CONTROL challenge=([0-9a-f]{64})/.exec(text);
let codeHash = arg("--code-hash"), codeFrom = "pinned by the caller";
if (!codeHash) {
  for (const d of evidenceFromLog(text).chain) { try { const e = parseAvfExtension(new X509Certificate(d).raw); const a = e.components.find((c) => /apk/i.test(c.name)); if (a) codeHash = a.codeHash; } catch {} }
  codeFrom = "taken from the same capture's attach chain";
}
const out = { capture: log, app, codeHash, codeFrom, binding: ev.binding, identity: ev.identity, selftest: ev.selftest, abi2Certs: ev.chain.length };
if (!spki || !chal || !codeHash) {
  out.verdict = { ok: false, reasons: [!spki ? "no SPKI line" : !chal ? "no CONTROL challenge (the owner's nonce)" : "no APK codeHash"] };
} else {
  out.verdict = verifyPvmAppAbi2({ chain: ev.chain, identity: ev.identity, selftest: ev.selftest, spki: Buffer.from(spki[1], "hex"),
                                   nonce: chal[1], appId: app },
    { allowedRuntimeIds: [arg("--runtime-id") || createHash("sha256").update(PIXEL).digest("hex")],
      allowedCodeHashes: [codeHash], allowedAuthorityHashes: [authority] });
}
console.log(JSON.stringify(out, null, 1));
process.exit(out.verdict.ok ? 0 : 1);
