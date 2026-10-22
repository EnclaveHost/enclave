// ---- policy-pressure measurements (e49, 2026-10-21; loopback mocks only; the deployed bundle's real quorum code) ----
const { LeaseReader } = await import(process.env.LEASE_READER_MODULE);   // the canonical source == deployed source 907ba85d
const admission = (opts = {}) => createHostAdmission({ hostId: HOST, ownershipContract: OWNERSHIP, registry: REGISTRY, catalog: CATALOG, rpc: rpcs.map((m) => m.url),
  addressBook: BOOK, policyDirectory: "", policyOrigins: [], ...opts });
const ref = (app, v = 1) => `catalog://${app}/${v}`;
const dep = (i) => "0x" + i.toString(16).padStart(64, "0");
const report = (k, v) => console.log(`# METRIC ${process.env.RPCSET === "5" ? "rpc5" : "rpc3"}.${k} ${JSON.stringify(v)}`);
const per = () => Object.fromEntries(rpcs.map((m) => [m.name, m.http]));
const N = 11;   // tracked deployments on minipc at 17:40:37Z (host-state.json count)

test("M1 one tick's sweep as deployed: N=11 sequential checks of 11 apps, drpc always 429 (as observed)", async () => {
  reset({ drpc: "deny" }); const a = admission(); const t0 = performance.now();
  for (let i = 1; i <= N; i++) assert.equal(await a.refusal({ deploymentId: dep(i), appRef: ref(APP(10 + i)) }), null);
  report("M1sweep", { checks: N, http: total(), perRpc: per(), perCheck: +(total() / N).toFixed(1), ms: Math.round(performance.now() - t0) });
});

test("M2 the 17:10:43 shape: drpc 429 at head, publicnode 429 on reads (block/call) for 12 s > the 10 s budget", async () => {
  reset({ drpc: "deny", publicnode: "readDeny" }); const a = admission(); const t0 = performance.now();
  let out;
  try { out = { verdict: await a.refusal({ deploymentId: dep(1), appRef: ref(APP(30)) }) }; } catch (e) { out = { unknown: e.message.slice(0, 260) }; }
  report("M2incident", { ...out, ms: Math.round(performance.now() - t0), perRpc: per() });
  if (process.env.RPCSET === "5") assert.deepEqual(out, { verdict: null }, "5 RPCs: tenderly+nodies+mainnet still agree");
  else { assert.match(out.unknown, /^no fresh agreeing chain quorum \(2 RPC failures: /, "3 RPCs: the production message"); assert.match(out.unknown, /: head code 15/); assert.match(out.unknown, /: read /); }
});

test("M3 PROPOSAL PROTOTYPE (not deployed code): ONE agreed() for all N apps' moderation (multicall), same reader rules", async () => {
  reset({ drpc: "deny" });
  const reader = new LeaseReader({ rpc: rpcs.map((m) => m.url), addressBook: BOOK, rateLimitRetryMs: 10000 });
  const t0 = performance.now(); const failures = [];
  const refs = Array.from({ length: N }, (_, i) => [APP(10 + i + 1), 1n]);
  const snap = await reader.agreed(async (client, blockNumber) => {
    const rows = await Promise.all(refs.map(([app, v]) => Promise.all([
      client.readContract({ address: CATALOG, abi: catAbi, functionName: "getApp", args: [app], blockNumber }),
      client.readContract({ address: CATALOG, abi: catAbi, functionName: "getVersion", args: [app, v], blockNumber })])));
    return { rows: rows.map(([app, v], i) => ({ app: refs[i][0], active: app.active === true, yanked: v.yanked, approval: Number(v.approval) })) };
  }, failures);
  assert.equal(snap.rows.length, N); assert.ok(snap.rows.every((r) => r.active && !r.yanked));
  report("M3batch", { apps: N, http: total(), perRpc: per(), ms: Math.round(performance.now() - t0), block: snap.blockNumber });
});
