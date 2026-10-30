// verifier/history-checkpoint.mjs: attested history checkpoints for the owner's tools (cli: enclave history checkpoint;
// work/history-checkpoint-transport-interface.txt). The envelope a measured SEV-SNP guest serves at
// /.well-known/enclave-history-checkpoint (isolation/m2/bootstrap/checkpoint_producer.go) is read here as strictly as a
// consuming guest reads it (checkpoint.go AdoptCheckpoint: exact members, the statement in its canonical form, this
// chain/ledger/deployment, every log inside the range, ordered, a lease log of this deployment), and its evidence is judged
// with this repository's SNP primitives (verifier/snp.mjs, relay/snp-verify.mjs): VCEK -> ASK -> the PINNED ARK, an
// ARK-signed CRL that is REQUIRED and fresh, DEBUG/MIGRATE_MA off, VMPL0, the VCEK naming the report's chip and TCB, a
// TCB floor on the reported AND committed TCB, the expected measurement, HOST_DATA = the deployment, and REPORT_DATA =
// sha256("enclave-history-checkpoint-v1\0" || statement) || 32 zero bytes.
//
// The tools only help an owner carry and refresh checkpoints: the guest that adopts one verifies it again, against its
// OWN measurement and TCB. Collateral (the certificate table, the CRL) may come from anywhere (AMD's KDS by default):
// AMD's chain authenticates it, not its carrier. No verdict here is weaker than "rejected" on a failed check; without an
// expected measurement the evidence is NOT judged and the result says so ("unverified").
import { createHash, X509Certificate } from "node:crypto";
import { parseReportStrict, checkChain, checkCrl, verifyReportSignature, JUDGED_MAX_REPORT_VERSION } from "./snp.mjs";
import { AMD_ARK_SHA256, decodeTcb, TCB_FIELDS, snpProductHint, kdsVcekUrl, vcekMatchesReport, checkMinTcb } from "../relay/snp-verify.mjs";
import { TCB_FLOORS } from "./metal-box.mjs";
import { parseUniqueJSON } from "../sdk/bootstrap/package.mjs";

export const CHECKPOINT_PATH = "/.well-known/enclave-history-checkpoint";
export const MAX_CHECKPOINT_BYTES = 32 << 20;
const DOMAIN = Buffer.from("enclave-history-checkpoint-v1\0");
const TOPICS = new Set([
  "0xa8cc21eb0ec0b0b7328426babbe37866c627edfd2ae57aeaed4f54abc0534bc0", // Claimed
  "0xc3f167f2092d6942fb4264b1759de5eda7eedc20287375c9eddd62e98a560b3e", // Renewed
  "0x0e334fd11ab7bea6d2bda89338c0f25674e099b70dd28aaaee262fbecba48882", // Released
]);
const GUID = { vcek: "63da758de6644564adc5f4b93be8accd", ask: "4ab7b379bbac4fe4a02f05aef327c782", ark: "c0b406a4a803495297433fb6014cd0ae" };
const word = (s) => typeof s === "string" && /^0x[0-9a-f]{64}$/.test(s);
const uint = (n) => Number.isSafeInteger(n) && n >= 0;
const b64 = /^[A-Za-z0-9+/]*={0,2}$/;

// The top-level member `key` of a JSON object text, as its exact bytes (the statement binding covers them).
function rawMember(text, key) {
  let i = 0, depth = 0, found = null;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const s = text.slice(i, j + 1);
      i = j + 1;
      if (depth === 1 && JSON.parse(s) === key) {
        let k = i;
        while (/\s/.test(text[k])) k++;
        if (text[k] !== ":") continue; // a value that spells the key, not the key
        i = k + 1;
        while (/\s/.test(text[i])) i++;
        const start = i;
        let d = 0;
        for (; i < n; i++) {
          const ch = text[i];
          if (ch === '"') { i++; while (i < n && text[i] !== '"') i += text[i] === "\\" ? 2 : 1; continue; }
          if (ch === "{" || ch === "[") d++;
          else if (ch === "}" || ch === "]") { d--; if (d === 0) { found = text.slice(start, i + 1); break; } }
        }
        return found;
      }
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    i++;
  }
  return null;
}

// The canonical statement text, exactly as the guest's json.Marshal writes it.
export function canonicalStatement(st) {
  return JSON.stringify({ v: st.v, chainId: st.chainId, ledger: st.ledger, deployment: st.deployment, lo: st.lo, hi: st.hi,
    logs: st.logs.map((l) => ({ block: l.block, index: l.index, blockHash: l.blockHash, topics: l.topics, data: l.data })) });
}

export function checkpointReportData(statementText) {
  return Buffer.concat([createHash("sha256").update(DOMAIN).update(Buffer.from(statementText, "utf8")).digest(), Buffer.alloc(32)]);
}

// parseCheckpoint(bytes, scope) -> { statement, statementText, report, certs, crl }; throws the guest's refusal otherwise.
// scope: { chainId, ledger, deployment } the statement must name (lowercase hex).
export function parseCheckpoint(bytes, { chainId, ledger, deployment }) {
  bytes = Buffer.from(bytes);
  if (!bytes.length || bytes.length > MAX_CHECKPOINT_BYTES) throw Error("checkpoint size");
  let text, env;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); env = parseUniqueJSON(text); } catch { throw Error("checkpoint envelope: not an unambiguous JSON object"); }
  if (!env || typeof env !== "object" || Array.isArray(env)) throw Error("checkpoint envelope: not an unambiguous JSON object");
  for (const k of Object.keys(env)) if (!["statement", "report", "certs", "crl"].includes(k)) throw Error(`checkpoint envelope: unknown member "${k}"`);
  for (const k of ["report", "certs"]) if (typeof env[k] !== "string") throw Error(`checkpoint envelope: ${k} missing`);
  if (env.crl !== undefined && typeof env.crl !== "string") throw Error("checkpoint envelope: crl is not a string");
  for (const k of ["report", "certs", "crl"]) if (env[k] !== undefined && !b64.test(env[k])) throw Error("checkpoint evidence is not base64");
  const statementText = rawMember(text, "statement");
  if (!statementText) throw Error("checkpoint envelope: statement missing");
  const st = env.statement;
  if (!st || typeof st !== "object" || Array.isArray(st) || !Array.isArray(st.logs)) throw Error("checkpoint statement: not an object");
  if (canonicalStatement(st) !== statementText) throw Error("checkpoint statement is not in canonical form");
  if (st.v !== 1 || st.chainId !== chainId || st.ledger !== String(ledger).toLowerCase() || st.deployment !== String(deployment).toLowerCase())
    throw Error("checkpoint statement names another chain, ledger or deployment");
  if (!uint(st.lo) || !uint(st.hi) || st.lo < 1 || st.lo > st.hi || st.logs.length > 100000) throw Error("checkpoint statement range is invalid");
  let prev = null;
  for (const l of st.logs) {
    if (!uint(l.block) || !uint(l.index) || l.block < st.lo || l.block > st.hi || (prev && (l.block < prev.block || (l.block === prev.block && l.index <= prev.index))))
      throw Error("checkpoint logs are outside the range or out of order");
    if (!Array.isArray(l.topics) || l.topics.length < 2 || l.topics[1] !== st.deployment || !TOPICS.has(l.topics[0])) throw Error("checkpoint holds a log that is not this deployment's lease log");
    if (!word(l.blockHash) || typeof l.data !== "string" || !/^0x[0-9a-f]*$/.test(l.data)) throw Error("checkpoint log is not canonical");
    if (!l.topics.every(word)) throw Error("checkpoint log topic is not canonical");
    prev = l;
  }
  const dec = (s) => (s === undefined ? null : Buffer.from(s, "base64"));
  return { statement: st, statementText, report: dec(env.report), certs: dec(env.certs), crl: dec(env.crl) };
}

// The extended report's certificate table ({guid(16), offset(4), length(4)}*, zero-terminated).
export function auxblobEntry(aux, guid) {
  if (!aux || aux.length > 64 * 1024) return null;
  for (let o = 0; o + 24 <= aux.length; o += 24) {
    const g = aux.subarray(o, o + 16).toString("hex");
    if (/^0+$/.test(g)) break;
    const off = aux.readUInt32LE(o + 16), len = aux.readUInt32LE(o + 20);
    if (g === guid) return len > 0 && off + len <= aux.length ? aux.subarray(off, off + len) : null;
  }
  return null;
}
export function buildAuxblob({ vcek, ask, ark }) {
  const ents = [[GUID.vcek, vcek], [GUID.ask, ask], [GUID.ark, ark]];
  let off = 24 * (ents.length + 1);
  const tab = [], data = [];
  for (const [g, der] of ents) {
    const w = Buffer.alloc(8);
    w.writeUInt32LE(off, 0); w.writeUInt32LE(der.length, 4); off += der.length;
    tab.push(Buffer.from(g, "hex"), w); data.push(der);
  }
  return Buffer.concat([...tab, Buffer.alloc(24), ...data]);
}
const pem = (der) => `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "")}\n-----END CERTIFICATE-----\n`;

// The envelope again, the statement's exact bytes kept, with this certificate table and CRL (as the guest's EncodeCheckpoint
// orders it).
export function encodeCheckpoint({ statementText, report, certs, crl }) {
  return Buffer.from(`{"statement":${statementText},"report":${JSON.stringify(report.toString("base64"))},"certs":${JSON.stringify(certs.toString("base64"))}`
    + (crl && crl.length ? `,"crl":${JSON.stringify(crl.toString("base64"))}` : "") + "}");
}

// completeCollateral(bytes, scope, collateral, { refreshCrl }) -> { bytes, sources }: the certificate table filled from
// `collateral` (verifier/collateral.mjs: AMD KDS by default in the CLI) where the producer's host attached none, and the CRL
// taken from it when the envelope has none or refreshCrl is set. Nothing is judged here (verifyCheckpoint does).
export async function completeCollateral(bytes, scope, collateral, { refreshCrl = false } = {}) {
  const cp = parseCheckpoint(bytes, scope);
  const p = parseReportStrict(cp.report);
  const product = snpProductHint(p);
  if (!product) throw Error("checkpoint report: the product line is unknown (report version 2 or an unknown CPUID)");
  const sources = {};
  let vcek = auxblobEntry(cp.certs, GUID.vcek), ask = auxblobEntry(cp.certs, GUID.ask), ark = auxblobEntry(cp.certs, GUID.ark);
  if (!vcek) {
    const tcb = p.reportedTcb.toString("hex"), chip = p.chipId.toString("hex");
    const v = await collateral.vcek(product, chip, tcb, kdsVcekUrl(product, p).replace(/^https:\/\/[^/]+\//, ""));
    if (!v) throw Error("no VCEK for this chip and TCB from the collateral source");
    vcek = Buffer.from(v.der); sources.vcek = v.source;
  }
  if (!ask || !ark) {
    const c = await collateral.chain(product);
    const certs = String(c.pem).split(/(?=-----BEGIN CERTIFICATE-----)/).filter((s) => s.includes("CERTIFICATE")).map((s) => new X509Certificate(s).raw);
    if (certs.length !== 2) throw Error("the collateral source's AMD chain is not ASK then ARK");
    [ask, ark] = certs; sources.chain = c.source;
  }
  let crl = cp.crl;
  if (!crl || !crl.length || refreshCrl) {
    const c = await collateral.crl(product);
    if (!c) throw Error("no CRL from the collateral source");
    crl = Buffer.from(c.der); sources.crl = c.source;
  }
  return { bytes: encodeCheckpoint({ statementText: cp.statementText, report: cp.report, certs: buildAuxblob({ vcek, ask, ark }), crl }), sources };
}

// verifyCheckpoint(bytes, { chainId, ledger, deployment, measurement?, minTcb?, now?, roots? })
//   -> { status: "verified" | "unverified" | "rejected", reasons, claims }
// "unverified": the envelope, the statement, its scope, the binding and HOST_DATA were checked, the AMD evidence was NOT
// (no expected measurement given): never something to rely on. minTcb defaults to this repository's published floors.
export async function verifyCheckpoint(bytes, { chainId, ledger, deployment, measurement = null, minTcb = TCB_FLOORS, now = new Date(), roots = AMD_ARK_SHA256 }) {
  const reasons = [], claims = {};
  const reject = (why) => ({ status: "rejected", reasons: [...reasons, `REJECT: ${why}`], claims });
  let cp;
  try { cp = parseCheckpoint(bytes, { chainId, ledger, deployment }); } catch (e) { return reject(e.message); }
  const st = cp.statement;
  Object.assign(claims, { lo: st.lo, hi: st.hi, logs: st.logs.length, claims: st.logs.filter((l) => l.topics[0].startsWith("0xa8cc")).length });
  reasons.push(`statement: canonical, chain ${st.chainId}, ledger ${st.ledger}, deployment ${st.deployment}, blocks ${st.lo}-${st.hi}, ${st.logs.length} lease log(s), each inside the range and this deployment's`);
  let p;
  try { p = parseReportStrict(cp.report); } catch (e) { return reject(`report shape: ${e.message}`); }
  if (p.version > JUDGED_MAX_REPORT_VERSION) return reject(`report version ${p.version} is outside the judged range 2..${JUDGED_MAX_REPORT_VERSION}`);
  const product = snpProductHint(p);
  if (!product) return reject("product line: report version 2 carries no CPUID, or an unknown CPUID");
  Object.assign(claims, { product, measurement: p.measurement.toString("hex"), tcb: decodeTcb(product, p.reportedTcb), chipId: p.chipId.toString("hex") });
  if (!p.reportData.equals(checkpointReportData(cp.statementText))) return reject("binding: REPORT_DATA is not this statement's binding");
  if (!p.hostData.equals(Buffer.from(String(deployment).slice(2), "hex"))) return reject("host data: HOST_DATA is not the expected deployment");
  reasons.push("REPORT_DATA binds exactly this statement; HOST_DATA is this deployment");
  if (!measurement) return { status: "unverified", reasons: [...reasons, "NOT VERIFIED: no expected measurement was given, so the AMD evidence was not judged (the adopting guest judges it against its own)"], claims };
  if (p.policyBits.debug) return reject("guest policy allows DEBUG: the host can read guest memory");
  if (p.policyBits.migrateMa) return reject("guest policy allows MIGRATE_MA");
  if (p.vmpl !== 0) return reject(`report is from VMPL${p.vmpl}, policy expects VMPL0`);
  const vcekDer = auxblobEntry(cp.certs, GUID.vcek), askDer = auxblobEntry(cp.certs, GUID.ask), arkDer = auxblobEntry(cp.certs, GUID.ark);
  if (!vcekDer || !askDer || !arkDer) return reject("collateral: the certificate table lacks the VCEK, ASK or ARK (complete it: enclave history checkpoint export/import)");
  const ch = checkChain({ vcekDer, chainPem: pem(askDer) + pem(arkDer), product, now, roots });
  if (!ch.ok) return reject(`chain: ${ch.why}`);
  reasons.push(...ch.reasons);
  const crl = checkCrl({ crlDer: cp.crl, ark: ch.ark, ask: ch.ask, now, mode: "required" });
  if (!crl.ok) return reject(crl.reasons.join("; "));
  reasons.push(...crl.reasons); claims.crlNextUpdate = crl.nextUpdate?.toISOString() ?? null;
  const sig = verifyReportSignature(p, ch.vcek);
  if (!sig.ok) return reject(`signature: ${sig.why}`);
  const mm = vcekMatchesReport(ch.vcek.raw, product, p);
  if (mm) return reject(`vcek identity: ${mm}`);
  const t = checkMinTcb(minTcb, product, p);
  if (!t.ok || !t.checked) return reject(`tcb policy: ${t.reason}`);
  const committed = decodeTcb(product, p.committedTcb), low = TCB_FIELDS[product].filter((k) => committed[k] < minTcb[product][k]);
  if (low.length) return reject(`tcb policy: committed TCB below the floor: ${low.map((k) => `${k} ${committed[k]} < ${minTcb[product][k]}`).join(", ")}`);
  if (p.measurement.toString("hex") !== String(measurement).toLowerCase()) return reject("measurement: the launch measurement is not the expected one");
  reasons.push(`PSP signature verifies with the VCEK of this chip and TCB; ${t.reason}; committed TCB meets it; the launch measurement is the expected one`);
  return { status: "verified", reasons, claims };
}
