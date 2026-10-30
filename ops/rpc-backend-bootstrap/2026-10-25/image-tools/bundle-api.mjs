// bundle-api.mjs SUPERVISOR_JS LABEL=BUNDLE [LABEL=BUNDLE...]   (offline: no reader, policy or gate is started)
// For each host-admission bundle: its sha256, its exports, whether it exports every name the given supervisor.js imports
// from ./windows/node/host-admission.bundle.mjs, whether createHostAdmission(...) (fixed pins, a scripted reader that is
// never called) has decision() and refusal(), whether hostPolicyCarriersFromEnv exists and parses a peers carrier, and the
// production platform-policy mirrors resolveHostPolicyConfig selects for the production chain + book with no operator
// setting (the "default"). Prints one JSON line per bundle; exits 0 (the caller judges each record).
import fs from "node:fs";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const [supervisor, ...pairs] = process.argv.slice(2);
const src = fs.readFileSync(supervisor, "utf8");
const m = /import\s*\{([^}]*)\}\s*from\s*["']\.\/windows\/node\/host-admission\.bundle\.mjs["']/.exec(src);
if (!m) { console.error("the supervisor imports nothing from ./windows/node/host-admission.bundle.mjs"); process.exit(2); }
const wanted = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean).sort();
const BOOK = "0xab214342d5a490150a4a977063a2f88e21f80907";
const pin = (b) => "0x" + b.repeat(20);
for (const pair of pairs) {
  const i = pair.indexOf("="); const label = pair.slice(0, i), file = pair.slice(i + 1);
  const bytes = fs.readFileSync(file);
  const r = { label, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  const mod = await import(pathToFileURL(file).href + "?" + label);
  r.exports = Object.keys(mod).sort();
  r.supervisorImports = wanted;
  r.missingForSupervisor = wanted.filter((n) => typeof mod[n] === "undefined");
  try {
    const a = mod.createHostAdmission({ hostId: "0x" + "11".repeat(32), ownershipContract: pin("22"), registry: pin("33"), catalog: pin("44"),
      reader: { agreed: async () => { throw new Error("never called"); } }, loadPolicy: async () => { throw new Error("never called"); } });
    r.admissionMethods = Object.keys(a).filter((k) => typeof a[k] === "function").sort();
    r.hasDecision = typeof a.decision === "function";
  } catch (e) { r.admissionError = String(e.message).slice(0, 200); r.hasDecision = false; }
  try {
    const c = mod.resolveHostPolicyConfig({ env: {}, chainId: 8453, book: BOOK });
    r.productionDefault = { on: c.on, source: c.source, activation: c.config?.activation, mirrors: c.config?.mirrors, rpcs: c.config?.rpcs?.length };
  } catch (e) { r.productionDefaultError = String(e.message).slice(0, 200); }
  r.hasCarriers = typeof mod.hostPolicyCarriersFromEnv === "function";
  if (r.hasCarriers) {
    r.carrierParse = mod.hostPolicyCarriersFromEnv({ ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS: JSON.stringify({ peers: ["https://carrier.example/platform-policy"] }) });
    try { mod.hostPolicyCarriersFromEnv({ ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS: "{\"bogus\":1}" }); r.carrierMalformed = "accepted"; }
    catch (e) { r.carrierMalformed = "refused: " + String(e.message).slice(0, 120); }
  }
  console.log(JSON.stringify(r));
}
