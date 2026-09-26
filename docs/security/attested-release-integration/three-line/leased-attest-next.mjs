// leased-attest-next.mjs: rs-10's guard with the scope hosts DERIVED from /enclaves (verified mode snp) instead of metal-iso0's id -
// for the NEXT retire (retarget LISTED's pins to the kept release). rs-10's precondition (the retire of f7888d86), CHIP-VERIFIED: EVERY release-listed deployment that holds a LIVE LEASE (from
// the ledger: running-ness is never judged by whether a guest happens to answer) runs on 5db18199 at its pinned measurement,
// read from the serving guest ITSELF over its public TLS (/.well-known/enclave-attestation?nonce=), with no key of ours:
//   - the report is AMD-signed (VCEK from KDS -> ASK -> the pinned ARK; chip and TCB match: relay/snp-verify.mjs);
//   - HOST_DATA is the deployment id; report_data[0:32] = the ABI/2 binding (Bind2: sha256("enclave-bind-v2\n" || the SPKI of
//     the TLS handshake WE made || our fresh nonce || the admitted runtime ccadb38a)); report_data[32:64] = the pinned AppID;
//   - the launch MEASUREMENT equals the pinned f7888d86 value (63's and bf's independent pins for the canaries, api-mcp-adapter and
//     7ae476a3; mine for d9798e4c and a77d0c57, which 63 holds no bundle for).
// A listed deployment with no live lease runs nowhere and is reported, not checked. Exit 0 only if every leased one passes
// and the 3 canaries are among them. usage: node leased-attest.mjs [relay dir, default ../../../../relay]
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createVerify, randomBytes, X509Certificate } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const relayDir = path.resolve(process.argv[2] || path.join(here, "../../../../relay"));
const { parseSnpReport, snpProductHint, kdsVcekUrl, certChain, vcekMatchesReport } = await import(path.join(relayDir, "snp-verify.mjs"));

const RID = Buffer.from("ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8", "hex");   // the admitted runtime
const bind2 = (spki, nonce) => createHash("sha256").update(Buffer.concat([Buffer.from("enclave-bind-v2\n"), spki, nonce, RID])).digest();
// [deployment id, AppID, the 5db18199 measurement, canary?] for every release-listed deployment (the 7 of 09-26 03:02Z)
const LISTED = [
  ["0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76", "d2c4dfc0ec475910aa509d1045ae4f2997346c1cd666a167cd5fc959c036aa24", "6716ef1462e1ebabc4fd388c44dea5da1fe6902a60bedbc47aaaeae5199ee91003c8c842c34dde264b31d10c68d5871b", true],
  ["0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595", "9c3d10f1450e17bc6a21478723193ef7e3da409afe353e264714cb801d180d45", "be2bb73c799fa8315d23101521da7f2bf944d7964a56793ce713266426af47237758961ee2b9c2ca22683e43aac13f2b", true],
  ["0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e", "9c3d10f1450e17bc6a21478723193ef7e3da409afe353e264714cb801d180d45", "be2bb73c799fa8315d23101521da7f2bf944d7964a56793ce713266426af47237758961ee2b9c2ca22683e43aac13f2b", true],
  ["0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77", "94c04c0edb6b4ca11b9bd0b6e4adfa98afdfa04692e6c10af79755e6db0ba0f2", "c8ac2d720194e41668b56adbf3e4e35b35f38267f59736a3580583d42245593a5e19094a6c75828e0536321d850f0ed8", false],
  ["0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a", "e95a23b61e99c631e59deb0faa1b3cb4cc435131c03eba3e3f2a47dcddf9da37", "3c1098f83ae4ea1da65ce6504083f017e6cac1a4ffa4c8ff3529f29acf17c9989ee08faf14577a37086b6a4f083ac47f", false],
  ["0xa77d0c577c1ca48510ff72545f9e050dc7d1fc9c6d1129f056494a5190cb8371", "c8a709d9cfcfdcf1c5137befc264bdbe80f81e66538015d8d184260aedae7f5b", "717930251607142551955b93028593af4610a45b912b7656c271580b574527955214b048b4d571d87ff485c860246abe", false],
  ["0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33", "f187928c68071bf05ff50de307479a3cdbfad7b96c00ebcb6b2caa6424d52189", "183701659801814c0b00ffd06c297dfdbbf0fdbfab6403e600af0af44b64484e59d0008049eabec6ac6afc882efaec52", false],
];
// the live lease, from the ledger on Base (two providers must agree): running-ness never comes from a guest answering
const { createPublicClient, http } = await import(path.join(relayDir, "node_modules/viem/_esm/index.js")).catch(() => import("viem"));
const { base } = await import(path.join(relayDir, "node_modules/viem/_esm/chains/index.js")).catch(() => import("viem/chains"));
const DEP = [["id","bytes32"],["owner","address"],["appRef","string"],["ports","string"],["configCid","string"],["gpuMilli","uint16"],["cpuMilli","uint16"],["appPort","uint32"],["isPublic","bool"],["active","bool"],["createdAt","uint64"],["rate","uint256"],["balance6","uint256"],["spent6","uint256"],["runner","bytes32"],["runnerOperator","address"],["leaseUntil","uint64"]].map(([name, type]) => ({ name, type }));
const GET = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: DEP }] }];
const LEDGER = "0xF9e71385C5cB49844F2457ba6567De0742f8B89a";
async function leaseOf(id) {
  const rows = await Promise.all(["https://base-rpc.publicnode.com", "https://base.drpc.org"].map((u) =>
    createPublicClient({ chain: base, transport: http(u, { timeout: 10000 }) }).readContract({ address: LEDGER, abi: GET, functionName: "get", args: [id] })));
  const [a, b] = rows.map((d) => `${String(d.runner).toLowerCase()} ${d.leaseUntil}`);
  if (a !== b) throw new Error(`the two RPCs disagree about ${id.slice(0, 10)}'s lease`);
  const d = rows[0];
  return !/^0x0{64}$/i.test(String(d.runner)) && Number(d.leaseUntil) > Date.now() / 1000;
}

// AMD KDS rate-limits: one fetch per distinct VCEK URL (the canaries share a chip), a status check, and backoff retries
const _vcek = new Map();
async function vcekOf(url) {
  if (_vcek.has(url)) return _vcek.get(url);
  let last = "";
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url);
    if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); _vcek.set(url, b); return b; }
    last = `KDS ${r.status}`; await new Promise((ok) => setTimeout(ok, 3000 * (i + 1)));
  }
  throw new Error(`the VCEK could not be fetched (${last})`);
}
async function amdVerified(report) {
  const p = parseSnpReport(report), product = snpProductHint(p);
  if (!product) return "the report names no product line";
  const vcek = new X509Certificate(await vcekOf(kdsVcekUrl(product, p)));
  const [ask, ark] = await certChain(product);
  if (!vcek.verify(ask.publicKey) || !ask.verify(ark.publicKey)) return "the VCEK does not chain to the pinned ARK";
  const r = Buffer.from(p.signature.subarray(0, 48)).reverse(), s = Buffer.from(p.signature.subarray(0x48, 0x48 + 48)).reverse();
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b; };
  const R = int(r), S = int(s), seq = Buffer.concat([Buffer.from([2, R.length]), R, Buffer.from([2, S.length]), S]);
  const v = createVerify("sha384"); v.update(p.signedRegion); v.end();
  if (!v.verify({ key: vcek.publicKey, dsaEncoding: "der" }, Buffer.concat([Buffer.from([0x30, seq.length]), seq]))) return "the VCEK signature does not verify";
  return vcekMatchesReport(vcek.raw, product, p) || null;
}
// GET over public TLS (normal WebPKI verification), returning the body AND the handshake's SPKI
function attest(label, nonceHex) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: `${label}.app.enclave.host`, path: `/.well-known/enclave-attestation?nonce=${nonceHex}`, timeout: 20000, agent: false }, (res) => {
      const spki = new X509Certificate(res.socket.getPeerCertificate(false).raw).publicKey.export({ type: "spki", format: "der" });
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b, spki }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout"))); req.on("error", reject);
  });
}

let all = true, canariesOk = 0;
// the LIVE listing (rs-8.sh passes it from nan's env; enclave-87 item 4): a listed deployment this table has no pin for refuses
const live = String(process.env.LISTED_IDS || "").toLowerCase().split(/[\s,]+/).filter((x) => /^0x[0-9a-f]{64}$/.test(x));
if (!live.length) { console.log("FAIL the live listing was not given (LISTED_IDS)"); all = false; }
for (const id of live) if (!LISTED.some(([x]) => x === id)) { console.log(`FAIL ${id.slice(2, 10)}: listed on the relay but no 5db18199 pin here`); all = false; }
// SCOPE (enclave-bf's REQUIRED addition, enclave-87): the retire removes f7888d86 from the prediction AND certificate sets, so
// ANY guest still on it - listed or not - loses its certificate renewal. So from the ledger (both providers must agree), EVERY
// deployment with a LIVE lease on metal-iso0 must be release-listed (and so chip-verified below); an unlisted one refuses
// unless OVERRIDE=<reason>.
// the isolation hosts, DERIVED (enclave-87's backlog, enclave-bf's note): every /enclaves row whose mode the relay VERIFIED at
// attach as "snp" (never the row's own isolation word) - today metal-iso0. Conservative: a future shared-enclave SNP host would
// show its (unlisted) leases here and refuse, which OVERRIDE=<reason> can pass knowingly. None at all = fail closed.
// SCOPE BOUNDARY (enclave-bf): an SNP machine that attached some OTHER way (not mode snp) is outside HOSTS - its LISTED leases are
// still chip-verified below, only its unlisted leases escape this check (today only metal-iso0 runs guestd). A network error is a
// readable FAIL (fail closed), not an uncaught rejection.
let ENCL = null;
try { ENCL = await (await fetch("https://api.enclave.host/enclaves", { signal: AbortSignal.timeout(20000) })).json(); }
catch (e) { console.log(`FAIL scope: /enclaves could not be read (${e.message})`); }
const HOSTS = new Set(((ENCL && ENCL.enclaves) || []).filter((e) => e && e.mode === "snp" && /^0x[0-9a-f]{64}$/i.test(String(e.id || ""))).map((e) => String(e.id).toLowerCase()));
if (!HOSTS.size) { console.log("FAIL scope: no verified SNP host in /enclaves (unreadable or empty): refuse"); all = false; }
else console.log(`--   scope hosts (verified mode snp): ${[...HOSTS].map((x) => x.slice(0, 10)).join(", ")}`);
const COUNT = [{ type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];
const GETPAGE = [{ type: "function", name: "getPage", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "tuple[]", components: DEP }] }];
const nowSec = Math.floor(Date.now() / 1000);
async function leasedOnIso0(url) {
  const c = createPublicClient({ chain: base, transport: http(url, { timeout: 15000 }) });
  const total = Number(await c.readContract({ address: LEDGER, abi: COUNT, functionName: "count" }));
  const rows = [];
  for (let at = 0; at < total; at += 50) rows.push(...await c.readContract({ address: LEDGER, abi: GETPAGE, functionName: "getPage", args: [BigInt(at), 50n] }));
  return rows.filter((d) => HOSTS.has(String(d.runner).toLowerCase()) && Number(d.leaseUntil) > nowSec).map((d) => String(d.id).toLowerCase()).sort();
}
try {
  const [a, b] = await Promise.all(["https://base-rpc.publicnode.com", "https://base.drpc.org"].map(leasedOnIso0));
  if (JSON.stringify(a) !== JSON.stringify(b)) { console.log("FAIL the two RPCs disagree about the leases on the SNP hosts"); all = false; }
  else {
    const extra = a.filter((id) => !live.includes(id));
    if (extra.length && !process.env.OVERRIDE) { console.log(`FAIL scope: ${extra.length} deployment(s) leased on a verified SNP host are NOT release-listed (a guest of theirs on f7888d86 would lose its certificate): ${extra.map((x) => x.slice(0, 10)).join(", ")}; OVERRIDE=<reason> to proceed`); all = false; }
    else if (extra.length) console.log(`OVERRIDE (${process.env.OVERRIDE}): ${extra.length} unlisted deployment(s) leased on a verified SNP host NOT checked: ${extra.map((x) => x.slice(0, 10)).join(", ")}`);
    else console.log(`ok   scope: ${a.length} deployment(s) leased on a verified SNP host, every one release-listed (each chip-verified below)`);
  }
} catch (e) { console.log(`FAIL scope: the ledger could not be read (${e.message})`); all = false; }
for (const [id, appId, want, canary] of LISTED.filter(([x]) => live.includes(x))) {
  const label = id.slice(2, 10), nonce = randomBytes(32);
  let leased;
  try { leased = await leaseOf(id); } catch (e) { console.log(`FAIL ${label}: the lease could not be read (${e.message})`); all = false; continue; }
  if (!leased) {
    if (canary) { console.log(`FAIL ${label}: a canary with no live lease`); all = false; } else console.log(`--   ${label}: no live lease (runs nowhere): not checked`);
    continue;
  }
  let why = null, meas = "";
  try {
    const r = await attest(label, nonce.toString("hex"));
    if (r.status !== 200) throw new Error(`attestation answered ${r.status}`);
    const d = JSON.parse(r.body);
    if (!d.report) throw new Error(`no hardware report (tier ${d.tier}: ${d.reason || "none"})`);
    const report = Buffer.from(d.report, "base64"), p = parseSnpReport(report);
    meas = Buffer.from(p.measurement).toString("hex");
    const amd = await amdVerified(report);
    if (amd) why = `not AMD-verified: ${amd}`;
    else if ("0x" + Buffer.from(report.subarray(0xc0, 0xe0)).toString("hex") !== id) why = "HOST_DATA is not this deployment";
    else if (!Buffer.from(p.reportData.subarray(0, 32)).equals(bind2(r.spki, nonce)))
      why = "report_data is not the ABI/2 binding of this TLS handshake's key, our nonce and the admitted runtime";
    else if (Buffer.from(p.reportData.subarray(32, 64)).toString("hex") !== appId) why = "report_data[32:64] is not the pinned AppID";
    else if (meas !== want) why = `measurement ${meas.slice(0, 12)} is not 5db18199's ${want.slice(0, 12)} (still on f7888d86?)`;
  } catch (e) { why = e.message; }
  console.log(`${why ? "FAIL" : "ok  "} ${label}: ${why || `leased; AMD-verified report of the serving guest (fresh nonce, TLS key bound), measurement ${meas.slice(0, 12)} = 5db18199's`}`);
  if (why) all = false; else if (canary) canariesOk++;
}
all = all && canariesOk === 3;
console.log(all ? "EVERY leased listed deployment chip-verified on 5db18199 (the 3 canaries among them)" : "NOT every leased listed deployment is on 5db18199: rs-10 must not run");
process.exit(all ? 0 : 1);
