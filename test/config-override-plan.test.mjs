// Exercise the editor's real planner without loading its browser component.
// Existing pinned overrides must remain editable during a mixed-fleet rollout.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../site/components/deployments/deployments.js", import.meta.url), "utf8");
const start = src.indexOf('const MANIFEST_KEYS =');
const end = src.indexOf('\nfunction encTier(', start);
assert.ok(start > 0 && end > start, "config planner source boundaries exist");
const cfgPlan = new Function(src.slice(start, end) + '\nreturn cfgPlan;')();

const cid = "bafkreig" + "a".repeat(52);
const nextCid = "bafkreig" + "b".repeat(52);
const config = { volumes: ["model"], prompt: "x".repeat(8197) };
assert.equal(Buffer.byteLength(JSON.stringify(config)), 8230);
const other = { network: { relay: "us-west" }, waf: { rps: 10 }, gpu: { optional: true } };

function context({ pinned = true, splitOk = false, ...changes } = {}) {
  const cur = { ...other, ...(pinned ? { configCid: cid, config: { volumes: config.volumes } } : {}) };
  return { raw: JSON.stringify(cur), cur, curBase: other, cap: 4096,
    stockC: '{"default":true}', hasOv: pinned, ovCid: pinned ? cid : "",
    ovLost: false, o0: pinned ? config : null, splitOk, ...changes };
}

test("8230-byte pinned override is unchanged even when fleet support is false or unavailable", () => {
  for (const splitOk of [false, undefined]) {
    assert.deepEqual(cfgPlan(context({ splitOk })).verdictOf(config), { same: true });
  }
});

test("updating an existing pinned override keeps the whole document off-chain", () => {
  const edited = { ...config, prompt: config.prompt + " revised" };
  const plan = cfgPlan(context());
  const verdict = plan.verdictOf(edited);
  assert.equal(verdict.mode, "split");
  assert.equal(verdict.set, true);
  assert.deepEqual(JSON.parse(verdict.body), edited);
  const envelope = plan.splitEnvelope(verdict.cfg, nextCid);
  assert.deepEqual(JSON.parse(envelope), { ...other, configCid: nextCid, config: { volumes: ["model"] } });
  assert.ok(Buffer.byteLength(envelope) <= 4096);
});

test("the Models panel can update volumes on an existing pinned override", () => {
  const edited = { ...config, volumes: ["model", "another-model"] };
  const plan = cfgPlan(context());
  const verdict = plan.verdictOf(edited);
  assert.equal(verdict.mode, "split");
  assert.deepEqual(JSON.parse(verdict.body), edited);
  assert.deepEqual(JSON.parse(plan.splitEnvelope(verdict.cfg, nextCid)).config.volumes, edited.volumes);
});

test("new pinned overrides still require fleet support, including conversion from inline", () => {
  for (const hasOv of [false, true]) {
    const verdict = cfgPlan(context({ pinned: false, hasOv })).verdictOf(config);
    assert.match(verdict.err, /8230 bytes.*4096/);
    assert.equal(verdict.set, undefined);
  }
  assert.equal(cfgPlan(context({ pinned: false, splitOk: true })).verdictOf(config).mode, "split");
});

test("an existing pinned override with an unreadable body can be repaired", () => {
  const verdict = cfgPlan(context({ ovLost: true, o0: null })).verdictOf(config);
  assert.equal(verdict.mode, "split");
  assert.deepEqual(JSON.parse(verdict.body), config);
});

test("unchanged pinned configs do not need an estimated replacement envelope to fit", () => {
  const ctx = context();
  ctx.cap = Buffer.byteLength(ctx.raw); // real CID is shorter than the preview stand-in
  assert.deepEqual(cfgPlan(ctx).verdictOf(config), { same: true });
});

test("changed pinned configs still cannot exceed the ledger's manifest limit", () => {
  const verdict = cfgPlan(context()).verdictOf({ ...config, volumes: ["v".repeat(4096)] });
  assert.match(verdict.err, /even split.*4096/);
  assert.equal(verdict.set, undefined);
});

test("shrinking an override to inline or resetting it preserves the other namespaces", () => {
  const plan = cfgPlan(context());
  const verdict = plan.verdictOf({ small: true });
  assert.equal(verdict.mode, "inline");
  assert.deepEqual(JSON.parse(verdict.envelope), { ...other, config: { small: true } });
  assert.deepEqual(plan.verdictOf({ default: true }), { clear: true });
  assert.deepEqual(JSON.parse(plan.clearEnvelope()), other);
});
