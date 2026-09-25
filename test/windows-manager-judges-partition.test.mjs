// The manager judges the report's PARTITION (enclave-d1, READINESS.md M1): a report signed by the right launcher key
// but naming ANOTHER partition must never reach running. Driven end to end: the real Manager, the real judgeRunning
// (ready.mjs), and a real TLS front serving a launcher-signed document bound to that session's key and our nonce.
// Before this, judge-hv could check partition.vmId but the manager never gave it one, so the only thing tying a report
// to THIS domain's VM was one launcher key per VM.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selfSigned } from "../windows/node/apptls.mjs";
import { Manager } from "../windows/vbslike/manager/server.mjs";
import { judgeRunning, transportKeyOf } from "../windows/vbslike/manager/ready.mjs";
import { canonical, SIGN_DOMAIN } from "../windows/vbslike/verify/judge-hv.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// the report's format and tier as the RUST launcher defines them (host/src/contract.rs), never as the judge does
const CONTRACT_RS = fs.readFileSync(path.join(HERE, "../windows/vbslike/host/src/contract.rs"), "utf8");
const FORMAT = CONTRACT_RS.match(/pub const FORMAT_HYPERV: &str = "([^"]+)";/)[1];
const TIER = CONTRACT_RS.match(/pub const TIER_HYPERV: &str = "([^"]+)";/)[1];
const v = JSON.parse(fs.readFileSync(path.join(HERE, "../isolation/contract/catalog/derive_vectors.json"), "utf8"));
const component = Buffer.from(v.component_hex, "hex"), REC = v.ok[0].mapping.record, APP = v.ok[0].mapping.appId;
const OURS = "3f1c0f6e-7a2b-4c3d-8e9f-0a1b2c3d4e5f", OTHER = "9b2d4e6f-1a3c-4e5f-8a9b-0c1d2e3f4a5b";
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const launcherKey = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64");

const servers = [];
after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } });
// a domain's front whose launcher-signed report names `vmId` as its partition
async function front(vmId) {
  const c = selfSigned("127.0.0.1"), spki = new crypto.X509Certificate(c.cert).publicKey.export({ type: "spki", format: "der" });
  const s = https.createServer({ key: c.key, cert: c.cert }, (req, res) => {
    const u = new URL(req.url, "https://127.0.0.1");
    if (u.pathname === "/.well-known/enclave-ready") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ready: true, appId: APP })); }
    if (u.pathname !== "/.well-known/enclave-attestation") { res.writeHead(404); return res.end(); }
    const nonce = Buffer.from(u.searchParams.get("nonce") || "", "hex");
    const binding = crypto.createHash("sha256").update(spki).update(nonce).digest();      // ABI/1: sha256(spki || nonce)
    const report = { format: FORMAT, tier: TIER, reportData: Buffer.concat([binding, Buffer.from(APP, "hex")]).toString("hex"),
      domain: { appSha256: APP }, partition: { vmId, guestImageSha256: "ab".repeat(32) }, launcher: { key: launcherKey },
      platform: { hostExcluded: false, partition: "hcs-child" }, boundary: "tier=T0-hv partition=hcs-child host_excluded=no" };
    const sig = crypto.sign(null, Buffer.concat([SIGN_DOMAIN, Buffer.from(canonical(report))]), privateKey).toString("base64");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ format: FORMAT, tier: TIER, nonce: nonce.toString("hex"), appSha256: APP,
                             report: Buffer.from(JSON.stringify({ doc: report, sig })).toString("base64") }));
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r)); servers.push(s);
  return { port: s.address().port, key: transportKeyOf(spki) };
}
// a backend whose domain's relay is that front, and whose launcher key signs for `launcherVmId`
const backend = (port, launcherVmId) => ({ supports: {}, backend: "hv",
  boundary: { tier: "t0-hv", partition: "hcs-child", hostExcluded: false, attested: false },
  start: async () => ({ name: "vm", state: "Running", guest: { booted: true, bytes: 9 }, appReady: false,
                        boundary: { tier: "t0-hv", partition: "hcs-child", hostExcluded: false, attested: false },
                        domainId: 1, guestPort: 40001, tcpPort: port, image: "ab".repeat(32), launcherKey, launcherVmId }),
  stop: async () => {} });
const spawnAndJudge = async (f, launcherVmId) => {
  const m = new Manager({ runtimeId: REC.runtimeId, fetchComponent: async () => component, backend: backend(f.port, launcherVmId),
                          judgeReady: (a) => judgeRunning({ ...a, deadlineMs: 10_000, attemptTimeoutMs: 3_000 }) });
  const r = await m.spawn({ derive: REC, name: "0x" + "e6".repeat(32), isPublic: true, hasSecrets: false });
  await m.judging.get(r.id);
  return m.get(r.id);
};

test("control: a report naming the partition the launcher is bound to reaches running, on the front's key", async () => {
  const f = await front(OURS), rec = await spawnAndJudge(f, OURS);
  assert.equal(rec.status, "running", rec.reason);
  assert.equal(rec.transportKeySha256, f.key);
  assert.equal(rec.verdict, "monitor-signed");
});

test("a report signed by the right launcher key but naming ANOTHER partition never reaches running", async () => {
  const f = await front(OTHER), rec = await spawnAndJudge(f, OURS);
  assert.equal(rec.status, "failed");
  assert.notEqual(rec.appReady, true);
  assert.match(rec.reason, /report names another partition/);
});

test("a handle that names no partition for its launcher key is refused before judging, never judged without the check", async () => {
  const f = await front(OURS), rec = await spawnAndJudge(f, undefined);
  assert.equal(rec.status, "failed");
  assert.match(rec.reason, /named no partition for its launcher key \(launcherVmId\)/);
  assert.equal(rec.transportKeySha256 ?? null, null, "nothing was judged, so no key was verified");
});
