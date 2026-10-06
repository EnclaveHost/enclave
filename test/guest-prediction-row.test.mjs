import test from "node:test";
import assert from "node:assert/strict";
import { expectedForRow, prepareForRow } from "../relay/guest-prediction-row.mjs";

const app = "0x" + "12".repeat(32);
const current = `catalog://${app}/68`, next = `catalog://${app}/69`;
const model = "qwen3.8-27b-mtp-q4-vl-gguf";
function fixture(over = {}) {
  const row = { id: "deployment", appRef: current, configCid: "", gpuMilli: 970n, isPublic: true, ...over };
  const calls = [], configs = [];
  const deps = {
    confirmRow: async () => ({ ...row }),
    readVersionConfig: async ref => { configs.push(ref); return { config: JSON.stringify({ volumes: [model] }) }; },
    predict: async (ref, options) => { calls.push({ ref, options }); return { ok: true }; },
  };
  return { row, calls, configs, deps };
}

test("live prediction cannot be redirected by options or a forged row", async () => {
  const f = fixture();
  await expectedForRow(f.row, { appRef: next, preparedRef: next, set: "cert" }, f.deps);
  assert.equal(f.calls[0].ref, current);
  assert.equal((await expectedForRow({ ...f.row, appRef: next }, {}, f.deps)).code, "deployment_changed");
  assert.equal(f.calls.length, 1);
});

test("preparation uses the next version's stock config and confirmed allocation", async () => {
  const f = fixture();
  assert.deepEqual(await prepareForRow(f.row, next, { forPrivate: true, set: "release" }, f.deps), { ok: true });
  assert.deepEqual(f.configs, [next]);
  assert.deepEqual(f.calls[0], { ref: next, options: {
    forPrivate: false, set: "release", inference: { model, gpuMilli: 970 },
  } });
  assert.equal(f.row.appRef, current, "the ledger snapshot is never modified");
});

test("a deployment override is preserved while a candidate is prepared", async () => {
  const small = "qwen2.5-0.5b-q8-gguf";
  const f = fixture({ configCid: JSON.stringify({ config: { volumes: [small] } }) });
  await prepareForRow(f.row, next, {}, f.deps);
  assert.deepEqual(f.configs, []);
  assert.equal(f.calls[0].options.inference.model, small);
  assert.equal(f.calls[0].options.inference.gpuMilli, 970);
});

test("preparation cannot cross apps, downgrade, jump ahead, or use a private deployment", async () => {
  const f = fixture();
  for (const ref of [`catalog://${app}/67`, `catalog://${app}/70`, `catalog://0x${"34".repeat(32)}/69`, "unpublished", undefined])
    assert.equal((await prepareForRow(f.row, ref, {}, f.deps)).code, "version_not_admitted");
  f.row.isPublic = false;
  assert.equal((await prepareForRow(f.row, next, {}, f.deps)).code, "version_not_admitted");
  assert.equal(f.calls.length, 0);
});

test("invalid resources and a concurrent ledger update still fail closed", async () => {
  const f = fixture({ gpuMilli: 1001n });
  assert.equal((await prepareForRow(f.row, next, {}, f.deps)).code, "unsupported_inference");
  f.row.gpuMilli = 970n;
  const stale = { ...f.row };
  f.row.configCid = "{}";
  assert.equal((await prepareForRow(stale, next, {}, f.deps)).code, "deployment_changed");
  assert.equal(f.calls.length, 0);
});

test("the predictor's public-version refusal is not bypassed by preparation", async () => {
  const f = fixture();
  f.deps.predict = async (_, options) => {
    assert.equal(options.forPrivate, false);
    return { ok: false, code: "version_not_admitted", reason: "yanked" };
  };
  assert.equal((await prepareForRow(f.row, next, { forPrivate: true }, f.deps)).code, "version_not_admitted");
});

test("the release this deployment's guest last ran is passed on to be measured first (ordering only)", async () => {
  const f = fixture();
  const asked = [];
  await expectedForRow(f.row, { set: "release" }, { ...f.deps, preferFor: (id) => { asked.push(id); return ["ab".repeat(32)]; } });
  assert.deepEqual(asked, ["deployment"]);
  assert.deepEqual(f.calls[0].options.prefer, ["ab".repeat(32)]);
  await expectedForRow(f.row, { set: "release" }, { ...f.deps, preferFor: () => [] });
  assert.equal("prefer" in f.calls[1].options, false, "nothing to prefer: the options are unchanged");
});
