// windows/vbslike/review/manager-contract.test.mjs: the Windows app manager judged against its REAL consumer.
//
// Independent review tests (enclave-99, 2026-09-24, review/nucbox-manager-tests). The manager's own suite drives it with
// bodies its tests compose; this file drives it with what supervisor.js ACTUALLY sends and reads, extracted from that
// source at test time so the test moves when either side does. Every assertion states the contract the supervisor
// enforces today (or the rule the owners agreed), so a failure here is a defect on one side or the other, named.
//
// Mocked backend (an injected launch), no partition, no host: the defects this catches are in the wire contract.
//   run: node --test windows/vbslike/review/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { Manager, createServer } from "../manager/server.mjs";
import { HyperVPartitionBackend } from "../manager/backend.mjs";

const ROOT = new URL("../../../", import.meta.url);
const SUPERVISOR = fs.readFileSync(new URL("supervisor.js", ROOT), "utf8");
const GUESTD = fs.readFileSync(new URL("isolation/m4/guestd/server.go", ROOT), "utf8");
const VEC = JSON.parse(fs.readFileSync(new URL("isolation/contract/catalog/derive_vectors.json", ROOT), "utf8"));
const component = Buffer.from(VEC.component_hex, "hex");
const REC = VEC.ok.find((v) => v.name === "v1").record;          // the shared vectors' v1 record: any backend must accept it
const DEPLOYMENT = "0x" + "4e".repeat(32);

/** The isolation spawn body EXACTLY as supervisor.js composes it (the literal between the tier branch and its POST). */
function supervisorBody({ derive, deploymentId = DEPLOYMENT }) {
  const start = SUPERVISOR.indexOf('if (PROVISION_BACKEND === "vm" && ISOLATION_BACKEND) {');
  const end = SUPERVISOR.indexOf('let r = await vmReq("POST", "/vms", body, SPAWN_TIMEOUT_MS);', start);
  assert.ok(start > 0 && end > start, "supervisor.js still has the isolation spawn branch");
  const lit = /const body = \{([\s\S]*?)\};/.exec(SUPERVISOR.slice(start, end));
  assert.ok(lit, "the spawn body literal");
  const keys = [...lit[1].matchAll(/(?:^|[,{\s])([A-Za-z_]+)(?=\s*:|,|\s*\})/g)].map((m) => m[1]).filter((k) => !["null", "undefined"].includes(k));
  // the values the supervisor would put there for a public hello-world deployment with nothing else declared
  const values = { image: `ipfs://${derive.cid}`, name: deploymentId, cpuShare: 0.05, gpuShare: 0, appPort: 8080, ports: [], config: "", configCid: "", egress: "", derive };
  const body = {};
  for (const k of keys) if (k in values) body[k] = values[k];
  assert.deepEqual(Object.keys(body).sort(), Object.keys(values).sort(), `the literal names exactly these keys (found ${keys.join(",")})`);
  return body;
}
/** What supervisor.js requires of the answer, read from its source rather than remembered. */
const REQUIRED_STATUS = Number((/if \(r\.status !== (\d{3})\) throw new Error\(`guestd refused the launch/.exec(SUPERVISOR) || [])[1]);
const ADOPT_ID_RE = new RegExp((/r\.status === 409 && r\.body && (\/\^gd\[0-9a-f\]\{8\}\$\/)\.test/.exec(SUPERVISOR) || [, "/^gd[0-9a-f]{8}$/"])[1].slice(1, -1));
const GUESTD_CREATED = Number((/s\.json\(w, (\d{3}), pub\)/.exec(GUESTD) || [])[1]);

/** A backend whose launch answers like the launcher does after a boot with no readiness handshake. */
const bootedBackend = () => new HyperVPartitionBackend({ launch: async (mapping, { instanceId }) => ({
  instanceId, name: `enclave-app-${instanceId}`, vmId: "B4E9F747-7966-5EB8-BF85-FD2CD717DF44", state: "Running",
  guest: { booted: true, bytes: 64, head: "MON boundary tier=t0-hv" }, appReady: false, appId: mapping.appId, stop: async () => {} }) });
const mk = (over = {}) => new Manager({ backend: bootedBackend(), fetchComponent: async () => component, runtimeId: REC.runtimeId, ...over });

async function viaHttp(manager, method, path, body) {
  const srv = createServer(manager); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const port = srv.address().port;
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json" } }, (res) => {
        let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
      });
      req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  } finally { srv.close(); }
}

test("the supervisor's ACTUAL spawn body is accepted: it carries no hasSecrets and no isPublic, and the manager must not refuse what its consumer never sends", async () => {
  const body = supervisorBody({ derive: REC });
  assert.equal("hasSecrets" in body, false); assert.equal("isPublic" in body, false);
  const r = await mk().spawn(body);       // today: 400 "unverified secret state: it must be known to be absent, not assumed"
  assert.ok(r && r.id, "a record");
  assert.equal(r.appId, VEC.ok.find((v) => v.name === "v1").mapping.appId, "and the AppID is the shared vectors' for this record");
});

test("POST /vms answers the status the supervisor requires, which is the one guestd gives", async () => {
  assert.equal(REQUIRED_STATUS, 201, "supervisor.js requires 201"); assert.equal(GUESTD_CREATED, 201, "guestd answers 201");
  const r = await viaHttp(mk(), "POST", "/vms", { ...supervisorBody({ derive: REC }), isPublic: true, hasSecrets: false });   // the owner's own body, so only the status is under test here
  assert.equal(r.status, REQUIRED_STATUS, `the manager answered ${r.status}: the supervisor reads that as "guestd refused the launch"`);
});

test("the record carries what the supervisor reads: id, appId, recordSha256, name = the deployment, and status in the supervisor's vocabulary; never running on console bytes", async () => {
  const m = mk();
  const r = await m.spawn({ ...supervisorBody({ derive: REC }), isPublic: true, hasSecrets: false });
  for (const k of ["id", "appId", "recordSha256"]) assert.ok(r[k], `record.${k}`);
  assert.equal(r.name, DEPLOYMENT, "supervisor.js adoption matches v.name === deploymentId");
  assert.ok(["starting", "running", "failed"].includes(r.status), `status is ${JSON.stringify(r.status)}: instanceAlive reads r.body.status and knows starting|running|failed`);
  assert.equal(r.status, "starting", "guest booted, app not ready: a live launch the supervisor must not respawn, and not SERVING");
  assert.notEqual(r.status, "running", "running needs the verified document on the handshake key plus enclave-ready 200 (the agreed rule), never console bytes");
  const got = await viaHttp(m, "GET", `/vms/${encodeURIComponent(r.id)}`);
  assert.equal(got.status, 200); assert.equal(got.body.status, r.status); assert.equal(got.body.name, DEPLOYMENT);
});

test("a second spawn under a live deployment name is 409 with the live id, in the form the supervisor's adoption path accepts", async () => {
  const m = mk();
  const first = await m.spawn({ ...supervisorBody({ derive: REC }), isPublic: true, hasSecrets: false });
  const again = await viaHttp(m, "POST", "/vms", { ...supervisorBody({ derive: REC }), isPublic: true, hasSecrets: false });
  assert.equal(again.status, 409, `guestd answers 409 "an instance for this name is live"; the manager answered ${again.status} (a second record, the first handle forgotten)`);
  assert.equal(again.body && again.body.id, first.id, "the 409 names the live instance");
  assert.match(String(first.id), ADOPT_ID_RE, `supervisor.js adopts a 409 only when the id matches ${ADOPT_ID_RE}; ids are ${first.id}. Either side may change; today they disagree`);
  assert.equal(m.list().length, 1, "one live record for one deployment");
});

test("an explicit duplicate id is refused rather than overwriting a live record", async () => {
  const m = mk();
  const a = await m.spawn({ ...supervisorBody({ derive: REC }), isPublic: true, hasSecrets: false, id: "dup-1" });
  assert.equal(a.state ?? a.status, a.status ?? a.state);
  await assert.rejects(() => m.spawn({ ...supervisorBody({ derive: REC }), isPublic: true, hasSecrets: false, id: "dup-1" }), /409|live|already/i,
    "today the second spawn replaces the record and the first VM's handle is lost");
  assert.equal(m.list().length, 1);
});

test("DELETE of a domain whose stop FAILED does not answer ok and does not forget the domain", async () => {
  const backend = new HyperVPartitionBackend({ launch: async (mapping, { instanceId }) => ({
    instanceId, name: `enclave-app-${instanceId}`, state: "Running", guest: { booted: true, bytes: 1, head: "" }, appReady: false, appId: mapping.appId,
    stop: async () => { throw Object.assign(new Error("could not stop: access denied"), { code: "stop_failed" }); } }) });
  const m = new Manager({ backend, fetchComponent: async () => component, runtimeId: REC.runtimeId });
  const r = await m.spawn({ ...supervisorBody({ derive: REC }), isPublic: true, hasSecrets: false });
  const d = await viaHttp(m, "DELETE", `/vms/${encodeURIComponent(r.id)}`);
  assert.notEqual(d.status, 200, `DELETE answered ${d.status} ok while the VM is still running: an orphan the manager no longer lists`);
  assert.ok(m.get(r.id), "the record stays until the VM is really gone");
});
