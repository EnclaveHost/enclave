// A fleet member that sells only a SUBSET of the platform's features — the
// Windows consumer node in windows/node/, which hosts CPU-only public apps and
// implements no WAF, no secrets, no custom domains, no SET threads — must be
// able to appear as a serving enclave with REAL capacity and take the work it
// can honour, without:
//
//   (a) removing a capability from what the console offers every other
//       customer (every capability flag on the aggregate is an AND over the
//       fleet, and a false one hides the control);
//   (b) becoming the fleet's cheapest ask, which is what defaults a new
//       deployment's rate cap — a cheap limited box would pin every new
//       deployment to the one box that can meet that price;
//   (c) setting the fleet's sizing minima, which every app spec is sized
//       against (a share below a runner's minimum is unclaimable there
//       forever, because created shares are immutable).
//
// It declares itself with `fullService: false` on its own /availability, and
// aggregateAvailability() computes the two protective halves — what the
// platform OFFERS and what it COSTS — over the full-service boxes only,
// falling back to the whole serving set when none of them is serving (then a
// partial box IS the honest state of the fleet).
//
// Everything here is asserted over HTTP against the REAL relay running as a
// child process (same harness shape as test/api-relay.test.mjs), because the
// answers under test are exactly what the console reads: GET /availability is
// the fleet aggregate, GET /enclaves is the roster plus the buyable-capacity
// totals.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { bootDaemon, listenOnFreePort } from "./helpers/daemon.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const RELAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");

// ---------- the smallest ledger that boots the relay ------------------------
// Nothing here reads a deployment: /availability and /enclaves are computed
// from the polled fleet alone. But the relay resolves its ledger at startup,
// and BASE_RPC unset would send it to a PUBLIC endpoint, so the stub answers
// the three calls that startup makes and plays an EMPTY ledger (count 0).
const W = (v) => (typeof v === "string" ? v.replace(/^0x/, "").toLowerCase() : BigInt(v).toString(16)).padStart(64, "0");
function stubRpc() {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const q = JSON.parse(body);
      const one = (m) => {
        if (m.method !== "eth_call") return "0x";
        const data = m.params[0].data;
        if (data.startsWith("0x5d1b72b6")) return "0x" + W(2);      // deploymentsSchema() -> rev 2
        if (data.startsWith("0x06661abd")) return "0x" + W(0);      // count() -> no deployments
        return "0x" + W(32) + W(0);                                  // getPage(...) -> zero rows
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(q)
        ? q.map((m) => ({ jsonrpc: "2.0", id: m.id, result: one(m) }))
        : { jsonrpc: "2.0", id: q.id, result: one(q) }));
    });
  });
}

// ---------- harness ----------------------------------------------------------
// A fake enclave is just its /availability: that payload is the ONLY thing the
// aggregate is built from, so it is the whole fixture.
async function fakeBox(t, availability) {
  const srv = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/availability") return res.end(JSON.stringify(availability));
    res.statusCode = 404; res.end("{}");
  });
  srv.listen(0, "127.0.0.1"); await once(srv, "listening");
  t.after(() => srv.close());
  return `http://127.0.0.1:${srv.address().port}`;
}

async function startRelay(t, endpoints) {
  const rpc = stubRpc(); await listenOnFreePort(rpc);
  // The relay must prove it won the port before /health means anything: every
  // daemon in this suite serves /health, so a stranger holding the port answers
  // 200 just as happily. api-relay logs "[api-relay] :<port>" from inside its
  // listen callback, which is reached only on a successful bind — and its
  // startup awaits pollAvailability() BEFORE listening, so the fleet is already
  // polled by the time that line appears.
  const { child, port } = await bootDaemon({
    start: (port) => spawn(process.execPath, [path.join(RELAY_DIR, "api-relay.js")], {
      env: { ...process.env, ENCLAVES: endpoints.join(","), API_RELAY_PORT: String(port), API_RELAY_BIND: "127.0.0.1",
             BASE_RPC: `http://127.0.0.1:${rpc.address().port}`, RPC_FALLBACKS: "0", DEPLOYMENTS_ADDRESS: "0x" + "12".repeat(20),
             FEATURED_VIEWS_FILE: path.join(os.tmpdir(), `feat-views-${port}.json`) },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    claimed: (log, port) => log.includes(`[api-relay] :${port}`),
    ready: async (port) => (await fetch(`http://127.0.0.1:${port}/health`)).ok,
  });
  t.after(() => { child.kill("SIGKILL"); rpc.close(); });
  return `http://127.0.0.1:${port}`;
}
const getJson = async (origin, p) => {
  const r = await fetch(origin + p);
  return { status: r.status, body: await r.json().catch(() => null) };
};

// Every capability the console gates a control on, and which this change moved
// onto the full-service set. `secrets`, `secretsInConfig` and `customDomains`
// are deliberately NOT here: they are additionally AND-ed with relay-side
// config (SECRETS_KEY, a data dir, CUSTOM_DOMAINS), so they are false in this
// harness for a reason that has nothing to do with a partial box.
const FLEET_FLAGS = ["waf", "configOverride", "configEdit", "shareResize", "gpuOptional",
                     "cpuFallback", "networkOptions", "rateCap", "proofOfTime", "p3",
                     "devDeploy", "configCid"];

// The full-service box: implements everything, publishes a config ceiling, and
// is the EXPENSIVE one. Its price being the higher of the two is the point —
// the fleet's quoted floor must come from the box that can actually honour a
// full deployment, even when a cheaper box is live.
const FULL = {
  gpu: false, type: "cpu", claimEnabled: true,
  cpuShareFree: 0.25, maxShare: 0.25,
  nodeVcpus: 8, nodeRamGb: 32, nodeGflops: 500,
  askCpuPricePerSec6: 834,
  configMaxBytes: 1048576,
  ...Object.fromEntries(FLEET_FLAGS.map((f) => [f, true])),
};
// The partial box: says `fullService: false`, implements none of the flags,
// publishes no config ceiling, and is BIG and CHEAP — a consumer PC with more
// cores and RAM than the hosted box, sold at a fraction of the price. Its
// nodeGflops is deliberately LOWER than the full-service box's: that is the
// axis on which it would collapse the fleet's sizing floor if it were counted
// (vCPU and RAM it happens to win on, so those two cannot prove the rule).
const PARTIAL = {
  fullService: false,
  gpu: false, type: "cpu", claimEnabled: true,
  cpuShareFree: 0.5, maxShare: 0.5,
  nodeVcpus: 16, nodeRamGb: 112, nodeGflops: 180,
  askCpuPricePerSec6: 120,
};

// ---------- 1. what the platform OFFERS, and what it COSTS -------------------
test("partial box: the fleet keeps every capability, its ceiling and its price", async (t) => {
  const origin = await startRelay(t, [await fakeBox(t, FULL), await fakeBox(t, PARTIAL)]);
  const { status, body: a } = await getJson(origin, "/availability");
  assert.equal(status, 200);
  assert.equal(a.aggregate, true);
  assert.equal(a.enclaves, 2, "both boxes are live — the partial one is a fleet member, not a reject");

  // (a) no capability is taken away. Under the old fleet-wide AND every one of
  // these was false the moment the partial box appeared, and each false flag
  // hides a control the rest of the fleet can honour perfectly well.
  for (const f of FLEET_FLAGS)
    assert.equal(a[f], true, `${f} must stay offered: the full-service fleet still honours it`);

  // ...including the config ceiling, which is a capability with a number. A box
  // that publishes none is silent, not zero-byte.
  assert.equal(a.configMaxBytes, 1048576, "the ceiling is the full-service box's, not the silent box's 0");

  // (b) the cheap limited box must not become the fleet's default rate cap.
  assert.equal(a.cheapestCpuPricePerSec6, 834, "quoted floor = the full-service box, not the cheap partial one");
  assert.equal(a.cheapestGpuPricePerSec6, undefined, "no card in this fleet, so no card price is invented");

  // (c) sizing minima come from the boxes a full deployment can actually land
  // on. gpflops is the discriminating axis (see PARTIAL): counting the partial
  // box would drop the floor to 180 and undersell every spec sized against it.
  assert.equal(a.specNodeGflops, 500, "the partial box must not set the fleet's GFLOPS floor");
  assert.equal(a.specNodeVcpus, 8, "sizing minima are the full-service box's numbers");
  assert.equal(a.specNodeRamGb, 32);

  // ...and the other half of the intent: its capacity is REAL capacity. The
  // capacity view (best free slice, and the node that slice sits on) still
  // describes the partial box, which is the box with room right now.
  assert.equal(a.cpuShareFree, 0.5, "the biggest free CPU slice is the partial box's, and it is buyable");
  assert.equal(a.nodeVcpus, 16, "the capacity view describes THAT box, not the sizing floor");
  assert.equal(a.nodeRamGb, 112);
});

// ---------- 2. it is listed, and it counts as capacity -----------------------
// Excluding a box from the OFFERING set is not excluding it from the fleet. The
// deploy target list and the fleet panel render from /enclaves, and a box that
// can take work must be visible there with a `serving: true` verdict and its
// free share inside the buyable totals — otherwise the change would just be a
// quieter way of dropping the box.
test("partial box: still listed, still serving, still counted as buyable capacity", async (t) => {
  const origin = await startRelay(t, [await fakeBox(t, FULL), await fakeBox(t, PARTIAL)]);
  const { status, body } = await getJson(origin, "/enclaves");
  assert.equal(status, 200);

  const rows = Object.fromEntries(body.enclaves.map((r) => [r.availability.nodeVcpus, r]));
  const fullRow = rows[8], partialRow = rows[16];
  assert.ok(fullRow && partialRow, "both boxes appear in the roster");
  assert.equal(partialRow.serving, true, "a partial box takes the work it can honour");
  assert.equal(partialRow.relay, false, "it sells compute — it is a host, not a relay row");
  assert.equal(partialRow.availability.fullService, false, "and it says so itself, for the console to badge");
  assert.equal(fullRow.serving, true);

  assert.equal(body.aggregate.enclaves, 2);
  assert.equal(body.aggregate.serving, 2, "both count as serving");
  assert.equal(body.aggregate.totalCpuShareFree, 0.75, "0.25 + 0.5 — the partial box's free share is real, buyable capacity");
});

// ---------- 3. the honest-fallback branch ------------------------------------
// With no full-service box serving, the partial box IS the fleet. Reporting the
// absent capabilities as true here would hand a customer a control that nothing
// live can honour (deployment Queued, funding tied up), and quoting a price
// nobody posts would be a lie in the other direction. So the aggregate falls
// back to the whole serving set and reports what is actually there.
test("only a partial box serving: the aggregate reports ITS capabilities and ITS price", async (t) => {
  const origin = await startRelay(t, [await fakeBox(t, PARTIAL)]);
  const { status, body: a } = await getJson(origin, "/availability");
  assert.equal(status, 200);
  assert.equal(a.enclaves, 1);

  for (const f of FLEET_FLAGS)
    assert.equal(a[f], false, `${f} is honestly false: no live box implements it`);
  assert.equal(a.configMaxBytes, 0, "nobody publishes a ceiling, so there is no number to quote");
  assert.equal(a.cheapestCpuPricePerSec6, 120, "its price is the only price, and it is the real one");
  // its hardware is the only hardware, so it does set the minima now
  assert.equal(a.specNodeVcpus, 16);
  assert.equal(a.specNodeRamGb, 112);
  assert.equal(a.specNodeGflops, 180);

  const { body: list } = await getJson(origin, "/enclaves");
  assert.equal(list.aggregate.serving, 1, "and it is serving — the fallback is not a fleet-down state");

  // ...but the CONTROL PLANE is not its to serve. sticky() picks the box that /v1/auth, /v1/pricing
  // and /v1/version land on, and a partial box implements none of them: picking one turned those
  // three into 404s for the whole platform once already. The pricing fallback above is an honest
  // answer to "what does the fleet cost"; there is no honest answer to "where do I sign in", so
  // this must be a named 503 and not a proxy to a box that will 404.
  const { status: cpStatus, body: cp } = await getJson(origin, "/v1/pricing");
  assert.equal(cpStatus, 503, "no full-service box is serving, so there is nowhere to ask");
  assert.equal(cp.error, "no_serving_enclave");
});

// ---------- 4. regression: silence is not a zero-byte ceiling ----------------
// configMaxBytes read a missing value as 0 and then took the fleet MINIMUM, so
// one ordinary full-service box that simply doesn't publish the field capped
// the whole fleet at zero bytes — every app config rejected by the publish UI,
// which is the exact opposite of a floor. The fix counts only the boxes that
// publish a positive one. Nothing about fullService is involved: both boxes
// here are full-service, which is why this is a regression test and not a
// re-run of case 1.
test("configMaxBytes: a box that publishes no ceiling does not cap the fleet at zero", async (t) => {
  const quiet = { ...FULL, nodeVcpus: 12, nodeRamGb: 48, askCpuPricePerSec6: 400 };
  delete quiet.configMaxBytes;                             // an older build, or one that just doesn't say
  const origin = await startRelay(t, [await fakeBox(t, { ...FULL, configMaxBytes: 262144 }), await fakeBox(t, quiet)]);
  const { body: a } = await getJson(origin, "/availability");

  assert.equal(a.configMaxBytes, 262144, "the one published ceiling stands; the silent box is not a 0");
  assert.ok(a.configMaxBytes > 0, "a fleet that accepts no config at all is never the right answer here");
  // and the fleet-minimum rules themselves are untouched by the fix: two
  // full-service boxes still AND their flags and still floor price and sizing
  for (const f of FLEET_FLAGS) assert.equal(a[f], true);
  assert.equal(a.cheapestCpuPricePerSec6, 400, "cheapest of two full-service boxes is still the cheaper one");
  assert.equal(a.specNodeVcpus, 8, "and the sizing floor is still the fleet minimum");
  assert.equal(a.specNodeRamGb, 32);
});
