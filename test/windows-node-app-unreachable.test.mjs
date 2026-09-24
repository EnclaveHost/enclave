// What a node says when its own app stops answering.
//
// The defect, from a user's screenshot: https://d9798e4c.app.enclave.host/ showed ERR_EMPTY_RESPONSE.
// Two apps (ipns-publisher d9798e4c, s3-ipfs-adapter 7ae476a3) stopped accepting on the brokered
// loopback port they serve from inside the enclave. Measured on the node:
//
//   app-zone 0xd9798e4c: app connect ECONNREFUSED 127.0.0.1:9776     (192 times)
//   app-zone 0x7ae476a3: app connect ECONNREFUSED 127.0.0.1:9799     (183 times)
//
// Two separate faults follow from that, and this file is about both:
//   1. the app-zone DESTROYED the TLS socket, so a browser got a blank tab rather than an error;
//   2. the records still said "running" for two hours, because alive() was consulted only by
//      proveAll, where a silent app merely loses a checkpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const zone = fs.readFileSync(path.join(ROOT, "windows/node/appzone.mjs"), "utf8");
const host = fs.readFileSync(path.join(ROOT, "windows/node/host.mjs"), "utf8");

test("a connect that fails before the app speaks becomes a 502 with a body, not a closed socket", () => {
  const splice = zone.slice(zone.indexOf('app = net.connect(target.port'), zone.indexOf("wsStream.on(\"error\""));
  assert.match(splice, /HTTP\/1\.1 502 Bad Gateway/, "a browser must get an answer it can render");
  assert.match(splice, /app_unreachable/, "and a body naming what happened");
  assert.match(splice, /content-length: \$\{body\.length\}/, "a real response, not a dangling header block");
  assert.match(splice, /spoke \? abort\(.*\) : refuse\(/,
               "once the app HAS written, the response is its own: appending to it would corrupt the answer");
  assert.match(splice, /app\.once\("data", \(\) => \{ spoke = true; \}\)/);
});

test("the 502 says the node holds the lease, so nobody re-diagnoses it as routing", () => {
  const splice = zone.slice(zone.indexOf('app = net.connect(target.port'), zone.indexOf("wsStream.on(\"error\""));
  assert.match(splice, /the node holds the lease; the app inside the enclave is not answering/);
  assert.match(splice, /not accepting connections on the node right now/);
});

test("the tick notices an app that stopped answering and stops calling it running", () => {
  const tick = host.slice(host.indexOf("async tick()"), host.indexOf("async proveAll()"));
  assert.match(tick, /await live\.alive\(\)/, "alive() was only ever asked by proveAll");
  assert.match(tick, /status: "unreachable"/, "a record that says running while the port refuses is the wrong answer");
  assert.match(tick, /the lease is still held/, "unreachable is not the same as lost: the lease has not moved");
  assert.match(tick, /Date\.now\(\) - since >= TICK_MS/, "one tick of grace, so a lost race is not a verdict");
});

test("noticing is not releasing: the tick must not hand the lease back on a failed probe", () => {
  const tick = host.slice(host.indexOf("async tick()"), host.indexOf("async proveAll()"));
  const block = tick.slice(tick.indexOf("const live = this.apps.get(id)"), tick.indexOf("#applyEnvelopeEdit"));
  assert.doesNotMatch(block, /#giveUp|release/, "a silent app is a reason to say so, not to give the deployment away");
  assert.doesNotMatch(block, /#stopApp/, "nor to tear it down under a tenant who may be about to get it back");
});

test("alive() is the port for a socket app and the gate for a gate-served one", () => {
  const run = fs.readFileSync(path.join(ROOT, "windows/node/apprun.mjs"), "utf8");
  const fn = run.slice(run.indexOf("  async alive() {\n    if (!this.slot)"), run.indexOf("  /**", run.indexOf("  async alive() {\n    if (!this.slot)")));
  assert.match(fn, /this\.world === 4/, "a wasi:cli app owns a socket, and the socket is the evidence");
  assert.match(fn, /waitPort/);
});
