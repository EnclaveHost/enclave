// The node's isolation client, against a fake manager that answers guestd's contract.
//
// The rule these hold to: the body under test is the one supervisor.js actually builds, not one
// invented here. The defect that started this lane was a test whose spawn body carried isPublic
// and hasSecrets - fields the supervisor never sends - so 77 tests passed over a contract that
// 400s in production. A fake that accepts a body the real caller cannot send proves nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IsolationManagerClient, IsolationError, instanceAlive, instanceServing, attestedCapacity } from "./isolation-client.mjs";

const DEP = "0xe64f7cba307e2d97485bde356d75564ccb74c5e31c272b5ab3349abfe122569b";
const APPID = "9c3d10f1".padEnd(64, "0");

/** supervisor.js's own literal (3551-3556), reproduced field for field. */
const supervisorBody = (over = {}) => IsolationManagerClient.spawnBody({
  image: "ipfs://bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza",
  name: DEP, cpuShare: 0.25, gpuShare: 0, appPort: 8080, ports: [], config: "", configCid: "",
  egress: "", derive: { derivation: "enclave-catalog-bundle/1", policy: { cpuPercent: 100, memMiB: 512, vcpus: 1 } },
  isPublic: true, hasSecrets: false,
  ...over,
});

const view = (over = {}) => ({
  id: "hv1a2b3c4d", name: DEP, status: "starting", appId: APPID,
  runtimeId: "cc".repeat(32), recordSha256: "bf".repeat(32),
  image: "2d".repeat(32), transportKeySha256: "ab".repeat(32),
  tier: "T0-hv", hostExcluded: false, verdict: "monitor-signed",
  boundary: { tier: "t0-hv", partition: "hcs-child", hostExcluded: false, attested: false },
  ...over,
});

/** A fake manager speaking guestd's contract. Records every request it was given. */
function manager({ routes = {}, live = new Map() } = {}) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    seen.push({ method, path: u.pathname, body });
    const key = `${method} ${u.pathname}`;
    const custom = routes[key] || routes[`${method} *`];
    if (custom) {
      const r = await custom({ body, path: u.pathname });
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
    }
    if (key === "POST /vms") {
      const existing = [...live.values()].find((v) => v.name === body.name);
      if (existing) return new Response(JSON.stringify({ error: "already live", id: existing.id }), { status: 409 });
      const v = view({ id: "hv" + "0".repeat(8), name: body.name });
      live.set(v.id, v);
      return new Response(JSON.stringify(v), { status: 201 });
    }
    if (method === "GET" && u.pathname.startsWith("/vms/")) {
      const v = live.get(decodeURIComponent(u.pathname.slice(5)));
      return new Response(JSON.stringify(v ?? { error: "not found" }), { status: v ? 200 : 404 });
    }
    if (key === "GET /vms") return new Response(JSON.stringify([...live.values()]), { status: 200 });
    if (method === "DELETE" && u.pathname.startsWith("/vms/")) {
      const id = decodeURIComponent(u.pathname.slice(5));
      const had = live.delete(id);
      return new Response(JSON.stringify(had ? { ok: true } : { error: "not found" }), { status: had ? 200 : 404 });
    }
    return new Response(JSON.stringify({ error: "unroutable" }), { status: 404 });
  };
  return { fetchImpl, seen, live };
}

const client = (m) => new IsolationManagerClient({ base: "http://127.0.0.1:8091", fetchImpl: m.fetchImpl });

test("the body carries every field the manager demands, stated and not assumed", () => {
  const b = supervisorBody();
  assert.deepEqual(Object.keys(b).sort(),
    ["appPort", "config", "configCid", "cpuShare", "derive", "egress", "gpuShare", "hasSecrets",
     "image", "isPublic", "name", "ports"]);
  // the manager refuses a spawn that does not STATE these; supervisor.js never did, so every real
  // spawn 400'd while a test that invented them passed. The caller knows both from the ledger.
  assert.equal(b.isPublic, true);
  assert.equal(b.hasSecrets, false);
});

test("an unstated isPublic or hasSecrets is refused HERE rather than 400'd at the manager", () => {
  assert.throws(() => IsolationManagerClient.spawnBody({ image: "ipfs://x", name: DEP, derive: {}, hasSecrets: false }),
    /isPublic must be stated/);
  assert.throws(() => IsolationManagerClient.spawnBody({ image: "ipfs://x", name: DEP, derive: {}, isPublic: true }),
    /hasSecrets must be stated/);
  // and "falsy" is not the same as "stated false"
  assert.throws(() => IsolationManagerClient.spawnBody({ image: "ipfs://x", name: DEP, derive: {}, isPublic: true, hasSecrets: undefined }),
    /hasSecrets must be stated/);
});

test("a CID with no derivation record is refused before anything is sent", () => {
  assert.throws(() => IsolationManagerClient.spawnBody({ image: "ipfs://x", name: DEP }),
    /derivation record is required/);
});

test("201 with the record is a launch; the view is normalised and the boundary survives", async () => {
  const m = manager();
  const { adopted, view: v } = await client(m).spawn(supervisorBody());
  assert.equal(adopted, false);
  assert.equal(v.name, DEP);
  assert.equal(v.status, "starting");
  assert.equal(v.appId, APPID);
  assert.deepEqual(v.boundary, { tier: "t0-hv", partition: "hcs-child", hostExcluded: false, attested: false },
    "the boundary is carried up verbatim, never summarised away");
});

test("409 is an ADOPTION of the id the manager named, whatever shape that id has", async () => {
  const m = manager();
  await client(m).spawn(supervisorBody());              // first one lands
  const second = await client(m).spawn(supervisorBody()); // same deployment again
  assert.equal(second.adopted, true, "a live name is adopted, not treated as a failure");
  assert.equal(second.view.name, DEP);
  assert.match(second.view.id, /^hv[0-9a-f]{8}$/, "the manager's own id form, not guestd's, and not rejected for it");
});

test("a 409 that names no instance is an error rather than a silent respawn", async () => {
  const m = manager({ routes: { "POST /vms": async () => ({ status: 409, body: { error: "already live" } }) } });
  await assert.rejects(() => client(m).spawn(supervisorBody()), /named no instance to adopt/);
});

test("adoption after a restart matches on NAME, not on the id's shape", async () => {
  const m = manager();
  await client(m).spawn(supervisorBody());
  const found = await client(m).findByName(DEP);
  assert.ok(found, "a domain started before the restart is found again by its deployment id");
  assert.equal(found.name, DEP);
  assert.equal(await client(m).findByName("0xdeadbeef"), null);
});

test("a status the contract does not define is a protocol error, never treated as alive", async () => {
  const m = manager({ routes: { "POST /vms": async () => ({ status: 201, body: view({ status: "guest-booted" }) }) } });
  await assert.rejects(() => client(m).spawn(supervisorBody()), (e) =>
    e instanceof IsolationError && e.kind === "protocol" && /guest-booted/.test(e.message));
});

test("starting is alive but NOT serving, so a booted guest never reads as a running app", () => {
  assert.equal(instanceAlive(view({ status: "starting" })), true);
  assert.equal(instanceServing(view({ status: "starting" })), false, "guest-booted is not app-ready");
  assert.equal(instanceServing(view({ status: "running" })), true);
  assert.equal(instanceAlive(view({ status: "failed" })), false);
  assert.equal(instanceAlive(null), false);
});

test("a T0-hv partition is NEVER verified host-excluded capacity, however healthy it looks", () => {
  assert.equal(attestedCapacity(view({ status: "running" })), false,
    "hostExcluded=false means it cannot count as verified capacity");
  // even a backend claiming exclusion needs a chain-verified verdict, not its own word
  assert.equal(attestedCapacity(view({ status: "running", hostExcluded: true, verdict: "monitor-signed" })), false,
    "a self-asserted boundary is not evidence");
  assert.equal(attestedCapacity(view({ status: "running", hostExcluded: true, verdict: "chain-verified" })), true);
});

test("a refusal carries the manager's own reason rather than a generic failure", async () => {
  const m = manager({ routes: { "POST /vms": async () => ({ status: 400, body: { error: "unverified secret state" } }) } });
  await assert.rejects(() => client(m).spawn(supervisorBody()), /unverified secret state/);
});

test("a missing instance reads as absent, not as an error", async () => {
  const m = manager();
  assert.equal(await client(m).get("hvdeadbeef"), null);
  assert.deepEqual(await client(m).remove("hvdeadbeef"), { removed: false, absent: true });
});

test("remove reports what the manager said and does not assume the domain is gone", async () => {
  const m = manager();
  const { view: v } = await client(m).spawn(supervisorBody());
  assert.deepEqual((await client(m).remove(v.id)).removed, true);
  assert.equal(await client(m).get(v.id), null);
});

test("a manager that never answers is a timeout, not a hang", async () => {
  const hang = { fetchImpl: (url, init) => new Promise((_, rj) => init.signal.addEventListener("abort", () => rj(new Error("aborted")))) };
  const c = new IsolationManagerClient({ base: "http://127.0.0.1:8091", fetchImpl: hang.fetchImpl, timeoutMs: 40 });
  await assert.rejects(() => c.spawn(supervisorBody()), (e) => e.kind === "timeout");
});
