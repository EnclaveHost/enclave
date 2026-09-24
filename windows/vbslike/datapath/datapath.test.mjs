// node --test windows/vbslike/datapath/datapath.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { parsePreamble, createDataPlane } from "./datapath.mjs";
import { routeFor, openSplice } from "../../../isolation/m4/guestd/supervisor-splice.mjs";

const H = (c, n = 32) => c.repeat(2 * n);
const ID = "hv0a1b2c3d";
const good = { id: ID, app: H("a"), image: H("b"), runtime: H("c"), key: H("d") };
const line = (w) => `ENCLAVE-SPLICE/1 id=${w.id} app=${w.app} image=${w.image} runtime=${w.runtime} key=${w.key}`;

// A stand-in for the launcher's relay to a domain: echoes, and counts who reached it.
async function relay() {
  const r = { accepted: 0, conns: [] };
  r.server = net.createServer((c) => { r.accepted++; r.conns.push(c); c.on("error", () => {}); c.pipe(c); });
  r.server.listen(0, "127.0.0.1");
  await once(r.server, "listening");
  r.port = r.server.address().port;
  return r;
}

async function plane(recs, opts = {}) {
  const dp = createDataPlane({ lookup: (id) => recs[id] ?? null, ...opts });
  dp.server.listen(0, "127.0.0.1");
  await once(dp.server, "listening");
  dp.addr = `127.0.0.1:${dp.server.address().port}`;
  return dp;
}

// connect, send the first line (and maybe more), read the answer line
function ask(dp, first, extra = "") {
  return new Promise((resolve) => {
    const [host, port] = dp.addr.split(":");
    const c = net.connect({ host, port: Number(port) });
    let buf = "";
    c.on("data", (d) => { buf += d.toString("latin1"); const nl = buf.indexOf("\n"); if (nl >= 0) resolve({ c, answer: buf.slice(0, nl), rest: buf.slice(nl + 1) }); });
    c.on("close", () => resolve({ c, answer: buf || "(closed)" }));
    c.on("error", () => {});
    c.write(first + extra);
  });
}

const rec = (r, over = {}) => ({ status: "running", appId: good.app, image: good.image, runtimeId: good.runtime, key: good.key,
  relay: { host: "127.0.0.1", port: r.port }, ...over });

test("the first line is strict", () => {
  assert.deepEqual(parsePreamble(line(good)), good);
  const bad = {
    "an SNP route (measurement=)": line(good).replace(`image=${good.image}`, `measurement=${H("b", 48)}`),
    "a guestd instance id": line({ ...good, id: "gd0a1b2c3d" }),
    "uppercase hex": line({ ...good, app: H("A") }),
    "a short key": line({ ...good, key: H("d", 31) }),
    "reordered": `ENCLAVE-SPLICE/1 app=${good.app} id=${ID} image=${good.image} runtime=${good.runtime} key=${good.key}`,
    "an extra field": line(good) + " x=1",
    "another protocol": line(good).replace("ENCLAVE-SPLICE/1", "ENCLAVE-SPLICE/2"),
  };
  for (const [what, l] of Object.entries(bad)) assert.throws(() => parsePreamble(l), undefined, what);
});

test("an admitted splice carries bytes both ways, including bytes sent right after the first line", async () => {
  const r = await relay(); const dp = await plane({ [ID]: rec(r) });
  const { c, answer, rest } = await ask(dp, line(good) + "\n", "early");
  assert.equal(answer, "OK");
  let got = rest;
  c.on("data", (d) => { got += d.toString(); });
  c.write("-hello");
  for (let i = 0; i < 50 && got !== "early-hello"; i++) await new Promise((s) => setTimeout(s, 20));
  assert.equal(got, "early-hello");
  assert.equal(dp.stats().open, 1);
  c.destroy(); dp.server.close(); r.server.close();
});

test("every refusal answers NO and never reaches the domain", async () => {
  const r = await relay();
  const recs = { [ID]: rec(r), hv00000001: rec(r, { status: "starting" }), hv00000002: rec(r, { relay: null }) };
  const dp = await plane(recs);
  const cases = {
    "no such instance": line({ ...good, id: "hv99999999" }),
    "not running": line({ ...good, id: "hv00000001" }),
    "another app": line({ ...good, app: H("e") }),
    "another guest image": line({ ...good, image: H("e") }),
    "another runtime": line({ ...good, runtime: H("e") }),
    "another key": line({ ...good, key: H("e") }),
    "no relay": line({ ...good, id: "hv00000002" }),
    "malformed": "hello",
    "oversized": "x".repeat(600),
  };
  for (const [what, l] of Object.entries(cases)) {
    const { answer } = await ask(dp, l + (what === "oversized" ? "" : "\n"));
    assert.match(answer, /^NO /, `${what}: ${answer}`);
  }
  assert.equal(r.accepted, 0, "a refused connection reached the domain");
  dp.server.close(); r.server.close();
});

test("busy, reclaim, idle and an unreachable domain", async () => {
  const r = await relay();
  const dead = net.createServer(); dead.listen(0, "127.0.0.1"); await once(dead, "listening");
  const deadPort = dead.address().port; dead.close();
  const dp = await plane({ [ID]: rec(r), hv00000003: rec(r, { relay: { host: "127.0.0.1", port: deadPort } }) },
    { maxPerInstance: 1, idleMs: 300 });
  const a = await ask(dp, line(good) + "\n");
  assert.equal(a.answer, "OK");
  const b = await ask(dp, line(good) + "\n");
  assert.match(b.answer, /^NO too many/);
  const closed = once(a.c, "close");
  dp.closeInstance(ID, "test reclaim");
  await closed;
  assert.equal(dp.stats().open, 0);
  const idle = await ask(dp, line(good) + "\n");
  assert.equal(idle.answer, "OK");
  const t0 = Date.now(); await once(idle.c, "close");
  assert.ok(Date.now() - t0 < 3000, "an idle splice was not closed");
  const u = await ask(dp, line({ ...good, id: "hv00000003" }) + "\n");
  assert.match(u.answer, /^NO the domain did not accept/);
  dp.server.close(); r.server.close();
});

test("interop: the supervisor's own routeFor + openSplice reach a partition through this plane", async () => {
  const r = await relay();
  const dp = await plane({ [ID]: rec(r) });
  const view = { id: ID, status: "running", appId: good.app, image: good.image, runtimeId: good.runtime, transportKeySha256: good.key };
  const transport = { request: async () => ({ status: 200, body: view }) };
  const route = await routeFor(transport, ID, good.app);
  assert.equal(route.image, good.image);
  assert.equal(route.measurement, undefined);
  const s = await openSplice(dp.addr, route);
  s.resume();
  let got = "";
  s.on("data", (d) => { got += d.toString(); });
  s.write("ping");
  for (let i = 0; i < 50 && got !== "ping"; i++) await new Promise((x) => setTimeout(x, 20));
  assert.equal(got, "ping");
  s.destroy();
  // a view that states a measurement for an hv instance, or no image, is no route at all
  for (const bad of [{ ...view, image: undefined, measurement: H("b", 48) }, { ...view, image: "x" }, { ...view, id: "hv0a1b2c3" }]) {
    await assert.rejects(routeFor({ request: async () => ({ status: 200, body: bad }) }, bad.id, good.app));
  }
  // and an SNP route sent to this plane is refused by it
  const snp = { id: "gd0a1b2c3d", appId: good.app, measurement: H("b", 48), runtimeId: good.runtime, key: good.key };
  await assert.rejects(openSplice(dp.addr, snp), /refused the splice/);
  dp.server.close(); r.server.close();
});
