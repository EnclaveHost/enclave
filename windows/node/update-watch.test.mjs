import { test } from "node:test";
import assert from "node:assert/strict";
import { newer, createUpdateWatch, RETRY_MS } from "./update-watch.mjs";

test("versions compare numerically, part by part", () => {
  assert.equal(newer("2026.10.12.10", "2026.10.12.9"), true, "10 > 9, not as text");
  assert.equal(newer("2026.10.12.9", "2026.10.12.10"), false);
  assert.equal(newer("2026.10.13", "2026.10.12.9"), true);
  assert.equal(newer("2026.10.12", "2026.10.12.0"), false);
  for (const bad of ["", "x", "2026.10.x", null]) assert.equal(newer(bad, "1.0"), false, String(bad));
});
test("a newer live release starts the update at once, once; again only after the retry time; nothing for the same or older", async () => {
  let t = 0, latest = { version: "2026.10.12.9" }; const runs = [];
  const w = createUpdateWatch({ installed: "2026.10.12.9", fetchLatest: async () => latest, trigger: async () => runs.push(latest.version), now: () => t });
  assert.equal(await w.check(), null); assert.equal(runs.length, 0, "the same version: nothing");
  latest = { version: "2026.10.12.10" };
  assert.equal(await w.check(), "2026.10.12.10"); assert.deepEqual(runs, ["2026.10.12.10"]);
  t += 60_000; assert.equal(await w.check(), null, "a minute later the update is still running: not started twice");
  t += RETRY_MS; assert.equal(await w.check(), "2026.10.12.10", "still not installed after the retry time: tried again");
  latest = { version: "2026.10.11" }; t += RETRY_MS; assert.equal(await w.check(), null, "an older one never");
});
test("a failed fetch or trigger is logged and the next minute asks again", async () => {
  const logs = []; let fail = true;
  const w = createUpdateWatch({ installed: "1.0", fetchLatest: async () => { if (fail) throw new Error("offline"); return { version: "1.1" }; },
                                trigger: async () => {}, log: (m) => logs.push(m) });
  assert.equal(await w.check(), null); assert.match(logs[0], /offline/);
  fail = false; assert.equal(await w.check(), "1.1");
});
