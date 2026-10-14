// Hyper-V's own account of a partition that went away (windows/node/hyperv-events.mjs): the Worker-Admin events naming
// a partition's VM, parsed and filtered. MOCKED: the PowerShell runner is injected; nothing is executed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { vmPrefixFor, hyperVEventsScript, parseHyperVEvents, recentHyperVEvents, HYPERV_WORKER_LOG } from "../windows/node/hyperv-events.mjs";

const INSTANCE = "hv3f70187449d4ee0e7a0c1d2e3f405162";
const PREFIX = "enclave-app-hv3f70187449d4ee";

test("the VM prefix is 'enclave-app-' + the first 16 characters of the instance id", () => {
  assert.equal(vmPrefixFor(INSTANCE), PREFIX);
  assert.equal(vmPrefixFor("hv3f-7018-7449-d4ee-0e7a"), PREFIX, "as the manager builds it: alphanumerics only");
  assert.equal(vmPrefixFor(""), null);
  assert.equal(vmPrefixFor("';--"), null);
});

test("the query reads the Worker-Admin log since the given time, filtered to that prefix, at most 10", () => {
  const s = hyperVEventsScript({ prefix: PREFIX, since: Date.parse("2026-10-14T03:42:30Z") });
  assert.ok(s.includes(`LogName = '${HYPERV_WORKER_LOG}'`));
  assert.ok(s.includes("StartTime = $since"));
  assert.ok(s.includes("'2026-10-14T03:42:30.000Z'"));
  assert.ok(s.includes(`-like '*${PREFIX}*'`));
  assert.ok(s.includes("Select-Object -First 10"));
  assert.throws(() => hyperVEventsScript({ prefix: "enclave-app-x'; Remove-Item C:\\", since: Date.now() }), /not a partition VM prefix/);
  assert.throws(() => hyperVEventsScript({ prefix: PREFIX, since: "never" }), /not a time/);
});

test("parse: only events naming the VM, oldest first, one line of at most 200 characters, at most 10", () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ time: `2026-10-14T03:${String(10 + i).padStart(2, "0")}:00.0000000Z`, id: 18500 + i,
    message: `'${PREFIX}-322c5206' event ${i}` }));
  const out = parseHyperVEvents(JSON.stringify([
    { time: "2026-10-14T03:52:30.1234567Z", id: 18502, message: `'${PREFIX}-322c5206' was turned off.\r\n\tVM ID ${"x".repeat(400)}` },
    { time: "2026-10-14T03:52:31Z", id: 18502, message: "'enclave-app-someoneelse000-1' was turned off." },
    ...many,
  ]), PREFIX);
  assert.equal(out.length, 10);
  assert.ok(out.every((e) => e.message.includes(PREFIX)), "another VM's events are dropped");
  assert.ok(out.every((e) => e.message.length <= 200 && !/[\r\n\t]/.test(e.message)));
  assert.deepEqual(out.map((e) => e.time), [...out.map((e) => e.time)].sort(), "oldest first");
  assert.equal(out.at(-1).id, 18502); assert.equal(out.at(-1).time, "2026-10-14T03:52:30.123Z");
  assert.match(out.at(-1).message, /^'enclave-app-hv3f70187449d4ee-322c5206' was turned off\. VM ID x+$/);
  // a single object (PowerShell's ConvertTo-Json of one item), nothing, and output that is not JSON
  assert.equal(parseHyperVEvents(JSON.stringify({ time: "2026-10-14T03:52:30Z", id: 18502, message: `${PREFIX}-1 off` }), PREFIX).length, 1);
  assert.deepEqual(parseHyperVEvents("", PREFIX), []);
  assert.deepEqual(parseHyperVEvents("[]", PREFIX), []);
  assert.equal(parseHyperVEvents("Get-WinEvent : access denied", PREFIX), null);
});

test("recentHyperVEvents: through the injected runner; null on any failure and when not on Windows", async () => {
  const seen = [];
  const run = async (s) => { seen.push(s); return JSON.stringify([{ time: "2026-10-14T03:52:30Z", id: 18502, message: `'${PREFIX}-322c5206' was turned off.` }]); };
  const got = await recentHyperVEvents({ instanceId: INSTANCE, now: Date.parse("2026-10-14T04:00:00Z"), run });
  assert.deepEqual(got, [{ time: "2026-10-14T03:52:30.000Z", id: 18502, message: `'${PREFIX}-322c5206' was turned off.` }]);
  assert.ok(seen[0].includes("'2026-10-14T03:50:00.000Z'"), "ten minutes back by default");
  assert.equal(await recentHyperVEvents({ instanceId: INSTANCE, run: async () => { throw new Error("timed out"); } }), null);
  assert.equal(await recentHyperVEvents({ instanceId: INSTANCE, run: async () => "garbage" }), null);
  assert.equal(await recentHyperVEvents({ instanceId: INSTANCE, platform: "linux" }), null, "no runner off Windows");
  assert.equal(await recentHyperVEvents({ instanceId: "", run }), null);
});
