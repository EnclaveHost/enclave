// Driven by chaos_test.go: a guestd-control/1 client against the chaos wrapper in front of the REAL Go server.
//   node client-chaos.mjs <url> <key hex> <client module> <bundle path> [concurrent]
// Prints one JSON object: each scenario's outcome, with server-side counts taken from /__stats.
const [url, keyHex, clientPath, bundle, only] = process.argv.slice(2);
const { GuestdControl, parseKey } = await import(clientPath);
const key = parseKey(keyHex);
const chaos = (cfg) => fetch(url + "/__chaos", { method: "POST", body: JSON.stringify(cfg) });
const stats = async () => (await fetch(url + "/__stats")).json();
const restart = () => fetch(url + "/__restart", { method: "POST" });
const out = {};
const run = async (name, f) => {
  try { out[name] = await f(); }
  catch (e) { out[name] = { threw: e.message, kind: e.kind, mayHaveExecuted: e.mayHaveExecuted }; }
  await chaos({});
};
const failure = (e) => ({ threw: e.message, kind: e.kind, mayHaveExecuted: e.mayHaveExecuted });

// the reported repro: two concurrent FIRST requests, the second hello delayed 20 ms, every signed answer by 50 ms
await run("concurrentFirst", async () => {
  const s0 = await stats();
  await chaos({ helloDelayN: s0.hellos + 2, helloDelayMs: 20, respDelayMs: 50 });
  const c = new GuestdControl(url, key);
  const r = await Promise.allSettled([c.request("GET", "/health"), c.request("GET", "/health")]);
  const s1 = await stats();
  return { results: r.map((x) => x.status === "fulfilled" ? x.value.status : "REJECTED: " + x.reason.message),
           handshakes: s1.sessions - s0.sessions };
});
if (only === "concurrent") { console.log(JSON.stringify(out)); process.exit(0); }

const c = new GuestdControl(url, key);
await c.request("GET", "/health");

await run("restartConcurrent", async () => {
  await restart();
  const s0 = await stats();
  await chaos({ respDelayMs: 30 });
  const r = await Promise.allSettled([c.request("GET", "/vms"), c.request("GET", "/vms"), c.request("GET", "/vms")]);
  const s1 = await stats();
  return { results: r.map((x) => x.status === "fulfilled" ? x.value.status : "REJECTED: " + x.reason.message),
           handshakes: s1.sessions - s0.sessions };
});

await run("stall", async () => {
  await chaos({ stallPath: "/vms" });
  const q = new GuestdControl(url, key, { requestTimeoutMs: 400 });
  const t0 = Date.now();
  try { await q.request("GET", "/vms"); return { kind: "ANSWERED" }; }
  catch (e) { return { ...failure(e), bounded: Date.now() - t0 < 3000 }; }
});

await run("helloStall", async () => {
  await chaos({ helloStall: true });
  const q = new GuestdControl(url, key, { handshakeTimeoutMs: 400 });
  try { await q.request("GET", "/health"); return { kind: "ANSWERED" }; } catch (e) { return failure(e); }
});

await run("truncated", async () => {
  await chaos({ truncatePath: "/health" });
  let refused = false;
  try { await c.request("GET", "/health"); } catch { refused = true; }
  await chaos({});
  return { refused, after: (await c.request("GET", "/health")).status };
});

for (const [name, chunked] of [["oversize", false], ["oversizeChunked", true]]) {
  await run(name, async () => {
    await chaos({ oversizePath: "/health", oversizeBytes: 2 << 20, oversizeChunked: chunked });
    try { await c.request("GET", "/health"); return { kind: "ANSWERED" }; } catch (e) { return failure(e); }
  });
}

const launch = (name, opts) => c.request("POST", "/vms", { image: "file://" + bundle, name }, opts);
const executed = async (name) => ((await stats()).names || {})[name] || 0;
const findByName = (name) => async (cl) => (await cl.request("GET", "/vms")).body.vms.find((v) => v.name === name) || null;

await run("mutNoReconcile", async () => {
  await chaos({ fake401Method: "POST", fake401Path: "/vms", fake401Times: 1 });
  try { await launch("0xm1"); return { kind: "ANSWERED" }; }
  catch (e) { return { ...failure(e), executed: await executed("0xm1") }; }
});

await run("mutReconcile", async () => {
  await chaos({ fake401Method: "POST", fake401Path: "/vms", fake401Times: 1 });
  const r = await launch("0xm2", { reconcile: findByName("0xm2") });
  return { status: r.status, executed: await executed("0xm2") };
});

await run("mutAfterRestart", async () => {
  await restart();                          // a GENUINE reauth: the request is refused before it is processed
  const r = await launch("0xm3", { reconcile: findByName("0xm3") });
  return { status: r.status, executed: await executed("0xm3") };
});

await run("getReplaced", async () => {
  await chaos({ fake401Method: "GET", fake401Path: "/vms", fake401Times: 1 });
  return { status: (await c.request("GET", "/vms")).status };
});

await run("leaseReplaced", async () => {
  await chaos({ fake401Method: "POST", fake401Path: "/vms/lease", fake401Times: 1 });
  return { status: (await c.request("POST", "/vms/lease", { ids: [] }, { idempotent: true })).status };
});

console.log(JSON.stringify(out));
