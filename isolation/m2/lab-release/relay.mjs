// The release LAB relay: contract v1.2 (docs/security/attested-release.md) over the RELAY'S OWN code - enclave-99's
// relay/secrets-release.mjs (binding, seal, response signature; loaded from LAB_RELEASE_MODULE, a copy of the file on
// security/attested-release) and relay/snp-verify.mjs (the SNP report: VCEK signature to the pinned AMD root, TCB
// floor, VMPL, DEBUG/MIGRATE_MA, measurement, report_data) - so the lab judges a REAL guest the way the relay will.
//
// What is LAB and says so:
//   - tickets are issued without the operator signature, the lease or the chip checks (those are the relay's, and
//     tested there); a ticket is still 32 random bytes, one-use, 120 s;
//   - the expected measurement, AppID and runtime id are TOLD to it by the lab harness (POST /lab/expect) from guestd's
//     own prediction, where the relay predicts them from the chain;
//   - the config and secrets are SYNTHETIC (LAB_RELEASE_FILE), never an owner's.
// Nothing sensitive is ever logged: ids are shortened, tickets and secrets never printed.

import https from "node:https";
import { readFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { verifyQuote, seedCertChain } from "../../../relay/snp-verify.mjs";
import { runtimeId } from "../../contract/runtime.mjs";
import { vcekTable } from "../judge.mjs";

const env = (k) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };
const R = await import(env("LAB_RELEASE_MODULE"));
const port = Number(process.env.PORT || 18443);
const signingKey = R.signingKeyFromSeed(Buffer.from(readFileSync(env("LAB_SIGNING_SEED"), "utf8").trim(), "hex"));
const keyId = R.keyIdOf(R.ed25519RawPublic(signingKey));
const vcek = readFileSync(env("LAB_VCEK"));
const product = process.env.LAB_PRODUCT || "Turin";
seedCertChain(product, readFileSync(env("LAB_CHAIN"), "utf8"));
const minTcb = JSON.parse(readFileSync(env("LAB_MIN_TCB"), "utf8"));
const synthetic = JSON.parse(readFileSync(env("LAB_RELEASE_FILE"), "utf8"));   // {config, secrets}
const envelope = JSON.stringify({ isolation: { require: "snp-guest-per-app" }, config: synthetic.config });

const expects = new Map();   // id -> {measurement, appId, runtimeId}
const tickets = new Map();   // base64 ticket -> {id, exp}
const short = (id) => String(id).slice(0, 10) + "…";
const log = (m) => console.log(`[lab-relay] ${m}`);

function json(res, code, body) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
function bad(res, code, error) { json(res, code, { error }); return true; }

async function release(b, res) {
  const id = String(b.id || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(id)) return bad(res, 422, "bad_id");
  let ticket, sealKey;
  try { ticket = Buffer.from(String(b.ticket), "base64"); sealKey = Buffer.from(String(b.sealKey), "base64"); } catch { return bad(res, 422, "bad_ticket"); }
  if (ticket.length !== 32 || sealKey.length !== 32) return bad(res, 422, "bad_ticket");
  const t = tickets.get(ticket.toString("base64"));
  tickets.delete(ticket.toString("base64"));                     // one use, whatever the verdict (as the relay)
  if (!t || t.id !== id || t.exp < Date.now() / 1000) return bad(res, 403, "bad_ticket");
  const want = expects.get(id);
  if (!want) return bad(res, 403, "release_not_enabled");
  const doc = b.evidence;
  if (!doc || doc.format !== "sev-snp-guest-domain-v1" || doc.abi !== "enclave-domain-abi/2" || typeof doc.report !== "string") return bad(res, 422, "bad_evidence");
  if (doc.nonce !== undefined) return bad(res, 422, "bad_evidence");
  let rid;
  try { rid = Buffer.from(runtimeId(doc.runtime)); } catch (e) { log(`${short(id)}: runtime: ${e.message}`); return bad(res, 422, "bad_evidence"); }
  if (rid.toString("hex") !== want.runtimeId) { log(`${short(id)}: runtime not admitted`); return bad(res, 403, "runtime_not_admitted"); }
  const spki = Buffer.from(doc.transportKey, "base64");
  const report = Buffer.from(doc.report, "base64");
  const binding = R.releaseBinding({ id, transportSpki: spki, ticket, runtimeId: rid, sealKey });
  const v = await verifyQuote(report, { transportKeySpki: spki, allowedMeasurements: [want.measurement],
    auxblob: doc.certs ? Buffer.from(doc.certs, "base64") : vcekTable(vcek), kds: false, requireVcek: true, minTcb,
    expectedVmpl: 0, expectedBinding: binding });
  if (!v.ok) { log(`${short(id)}: evidence refused: ${v.reasons.at(-1)}`); return bad(res, 403, "evidence_refused"); }
  const f = R.reportFields(report);
  if (f.hostData.toString("hex") !== id.slice(2)) return bad(res, 403, "evidence_refused");
  if (f.reportData.subarray(32, 64).toString("hex") !== want.appId) { log(`${short(id)}: another app`); return bad(res, 403, "evidence_refused"); }
  const plaintext = JSON.stringify({ id, envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
    config: R.configValue(synthetic.config), secrets: synthetic.secrets || {}, issuedAt: new Date().toISOString() });
  const sealed = R.sealRelease({ id, ticket, sealKey, plaintext });
  const sig = R.signResponse(signingKey, { id, ticket, sealKey, sealed });
  log(`${short(id)}: released to a verified guest (measurement ${want.measurement.slice(0, 12)}…, TCB ${JSON.stringify(v.tcb || {})})`);
  json(res, 200, { id, sealed: sealed.toString("base64"), sig: Buffer.from(sig).toString("base64"), keyId });
  return true;
}

const server = https.createServer({ cert: readFileSync(env("LAB_TLS_CERT")), key: readFileSync(env("LAB_TLS_KEY")) }, (req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 1 << 20) req.destroy(); });
  req.on("end", async () => {
    try {
      const u = new URL(req.url, "https://x");
      const b = body ? JSON.parse(body) : {};
      if (req.method === "POST" && u.pathname === "/lab/expect") {
        // the harness, over loopback: what guestd predicted for this deployment's guest
        expects.set(String(b.id).toLowerCase(), { measurement: String(b.measurement), appId: String(b.appId), runtimeId: String(b.runtimeId) });
        log(`${short(b.id)}: expecting measurement ${String(b.measurement).slice(0, 12)}…`);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && u.pathname === "/v1/secrets/release-ticket") {
        const id = String(b.id || "").toLowerCase();
        if (!/^0x[0-9a-f]{64}$/.test(id)) return bad(res, 422, "bad_id");
        if (!expects.has(id)) return bad(res, 403, "release_not_enabled");
        const ticket = randomBytes(32).toString("base64");
        tickets.set(ticket, { id, exp: Math.floor(Date.now() / 1000) + 120 });
        log(`${short(id)}: ticket issued (LAB: no operator/lease/chip checks)`);
        return json(res, 200, { ticket, expiresAt: Math.floor(Date.now() / 1000) + 120 });
      }
      if (req.method === "POST" && u.pathname === "/v1/secrets/release") return await release(b, res);
      if (req.method === "GET" && u.pathname === "/v1/secrets/release-status") {
        const id = String(u.searchParams.get("id") || "").toLowerCase();
        return json(res, 200, { id, listed: expects.has(id) });
      }
      json(res, 404, { error: "not_found" });
    } catch (e) { log(`error: ${e.message}`); json(res, 500, { error: "internal" }); }
  });
});
server.listen(port, "127.0.0.1", () => log(`listening on 127.0.0.1:${port} (key ${keyId})`));
