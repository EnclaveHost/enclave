// The pVM carrier's OWN resolver (relay/pvm-serving.mjs pvmRunnerResolver; RELAY-SERVING.md "Routing: the carrier's own
// resolver"; reviewed with the verifier session), held to each rule it states, with a fake ledger and the hub's origins:
//   - a full canonical id only; the ledger's runner with a LIVE lease, judged at each request (a lapse mid-session refuses
//     the next); a miss gets exactly ONE fresh read, then no route; a failed read is no route; no cache of its own, no probe;
//   - only the hub's current tunnel whose MODE (the hub's verdict) is "avf" and whose public URL hashes to the runner: a
//     non-tunnel row, a token tunnel whose hello says avf, a vbs/snp tunnel, another avf tunnel -- no route;
//   - the tier is NOT required: an avf tunnel re-attached in place (no tier) IS routed.
// And in api-relay.js: pvm-serving resolves through it, never through the app router's runnerEndpointOf.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { keccak256, stringToBytes } from "viem";
import { pvmRunnerResolver, pvmServingFromEnv } from "../relay/pvm-serving.mjs";

const D = "0x" + "d1".repeat(32), OTHER_D = "0x" + "d2".repeat(32);
const URL_A = "https://relay.example/t/pixel-a", URL_B = "https://relay.example/t/pixel-b";
const idOf = (u) => keccak256(stringToBytes(u));
// seq: optional per-read answers (an array for the rows, or an Error to throw), used in order before falling back to s.rows
function rig({ rows, origins, seq = [] }) {
  const s = { t: 1_800_000_000_000, reads: 0, expires: 0, originsCalls: 0, fail: false, rows, origins };
  const resolve = pvmRunnerResolver({
    ledgerRows: async () => { const x = seq[s.reads++]; if (x instanceof Error || s.fail) throw x || new Error("rpc down"); return x || s.rows; },
    expire: () => { s.expires++; },
    origins: () => { s.originsCalls++; return s.origins; },
    endpointId: async (u) => idOf(u),
    now: () => s.t,
  });
  return { s, resolve };
}
const lease = (id, url, untilSec) => ({ id, runner: idOf(url), leaseUntil: BigInt(untilSec) });
const avf = (name, url, extra = {}) => ({ endpoint: `tunnel://${name}`, tunnel: true, mode: "avf", publicUrl: url, ...extra });
const NOW_S = 1_800_000_000;

test("routed: the ledger's live runner, the hub's avf tunnel for it -- with NO tier (a tunnel re-attached in place)", async () => {
  const { s, resolve } = rig({ rows: [lease(D, URL_A, NOW_S + 600)], origins: [avf("pixel-b", URL_B, { tier: "pvm-cpu" }), avf("pixel-a", URL_A)] });
  assert.equal(await resolve(D), "tunnel://pixel-a");
  assert.equal(s.reads, 1); assert.equal(s.expires, 0, "a hit needs no fresh read");
});

test("a full canonical id only: a prefix, uppercase, no 0x, a short or long id -- no route, and the ledger is not even read", async () => {
  const { s, resolve } = rig({ rows: [lease(D, URL_A, NOW_S + 600)], origins: [avf("pixel-a", URL_A)] });
  for (const bad of [D.slice(0, 10), D.toUpperCase().replace("0X", "0x"), D.slice(2), D + "00", D.slice(0, 65), "", null, undefined, "dep_abc"])
    assert.equal(await resolve(bad), null, String(bad));
  assert.equal(s.reads, 0);
});

test("a miss gets exactly ONE fresh ledger read, then no route: no row, an unleased row, a lapsed lease", async () => {
  for (const rows of [[], [lease(OTHER_D, URL_A, NOW_S + 600)], [{ id: D, runner: "0x" + "0".repeat(64), leaseUntil: 0n }], [lease(D, URL_A, NOW_S - 1)]]) {
    const { s, resolve } = rig({ rows, origins: [avf("pixel-a", URL_A)] });
    assert.equal(await resolve(D), null);
    assert.equal(s.expires, 1, "one cache expiry"); assert.equal(s.reads, 2, "the cached read and ONE fresh read");
    assert.equal(s.originsCalls, 0, "no tunnel is looked at for a deployment without a live lease");
  }
  // the fresh read is what makes a new lease routable at once: the cached read misses, the fresh one has it
  const { resolve } = rig({ rows: null, origins: [avf("pixel-a", URL_A)], seq: [[], [lease(D, URL_A, NOW_S + 600)]] });
  assert.equal(await resolve(D), "tunnel://pixel-a", "found on the one fresh read");
});

test("a ledger read that fails is NO route -- never a cached owner, never a probe of live rows", async () => {
  const { s, resolve } = rig({ rows: [lease(D, URL_A, NOW_S + 600)], origins: [avf("pixel-a", URL_A)] });
  assert.equal(await resolve(D), "tunnel://pixel-a");
  s.fail = true;
  assert.equal(await resolve(D), null, "the resolver keeps no owner of its own to fall back on");
  assert.equal(s.originsCalls, 1, "the failed read looked at no tunnel");
  // a failure on the fresh read after a miss is no route too
  const r2 = rig({ rows: null, origins: [avf("pixel-a", URL_A)], seq: [[], new Error("rpc down")] });
  assert.equal(await r2.resolve(D), null);
  assert.equal(r2.s.originsCalls, 0);
});

test("a lease that lapses mid-session: routed, then the next request is refused (judged at each request, from the cached row)", async () => {
  const { s, resolve } = rig({ rows: [lease(D, URL_A, NOW_S + 60)], origins: [avf("pixel-a", URL_A)] });
  assert.equal(await resolve(D), "tunnel://pixel-a");
  s.t += 61_000;
  assert.equal(await resolve(D), null);
  assert.equal(s.expires, 1, "the lapse triggers the one fresh read, which still shows it lapsed");
});

test("only the hub's avf tunnel for THAT runner: a non-tunnel row, a token tunnel whose hello says avf, vbs and snp tunnels, another avf tunnel, a malformed endpoint -- no route", async () => {
  const cases = [
    [{ endpoint: "https://box.example", tunnel: false, mode: "avf", publicUrl: URL_A }, "a dialed row claiming avf"],
    [{ endpoint: "tunnel://pixel-a", mode: "avf", publicUrl: URL_A }, "tunnel flag missing"],
    [{ endpoint: "tunnel://pixel-a", tunnel: true, mode: "", declaredMode: "avf", publicUrl: URL_A }, "a token tunnel whose hello says avf (the hub's mode is empty)"],
    [{ endpoint: "tunnel://pixel-a", tunnel: true, mode: "vbs", publicUrl: URL_A }, "a vbs tunnel"],
    [{ endpoint: "tunnel://pixel-a", tunnel: true, mode: "snp", publicUrl: URL_A }, "an snp tunnel"],
    [avf("pixel-b", URL_B), "another avf tunnel (its public URL is another runner)"],
    [{ endpoint: "tunnel://pixel-a", tunnel: true, mode: "avf", publicUrl: "" }, "no public URL (no hello yet)"],
    [{ endpoint: "tunnel://pixel a/x", tunnel: true, mode: "avf", publicUrl: URL_A }, "a malformed endpoint"],
  ];
  for (const [o, what] of cases) {
    const { resolve } = rig({ rows: [lease(D, URL_A, NOW_S + 600)], origins: [o] });
    assert.equal(await resolve(D), null, what);
  }
});

test("api-relay.js: pvm-serving resolves through pvmRunnerResolver (its own), never the app router's runnerEndpointOf; the factory comes with the ON switch", () => {
  const src = fs.readFileSync(new URL("../relay/api-relay.js", import.meta.url), "utf8");
  const i = src.indexOf("const pvmServe = PVM_SERVING.enabled ? PVM_SERVING.handler({"), block = src.slice(i, src.indexOf("}) : null;", i));
  assert.ok(i > 0);
  assert.match(block, /resolve: PVM_SERVING\.pvmRunnerResolver\(\{ ledgerRows, expire: \(\) => \{ _ledger\.at = 0; \}, origins: \(\) => tunnelHub\.origins\(\), endpointId \}\),/);
  assert.doesNotMatch(block, /runnerEndpointOf/);
  assert.equal(pvmServingFromEnv({}).pvmRunnerResolver, undefined, "OFF: nothing is handed out");
  assert.equal(typeof pvmServingFromEnv({ PVM_SERVING: "1" }, { avfOn: true, pvmCpuOn: true }).pvmRunnerResolver, "function");
});
