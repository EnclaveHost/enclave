// The release pre-warm (relay/secrets-release.mjs prewarmReleasePredictions; enclave-87, 2026-09-26): every deployment
// listed for attested release gets its predictions computed ahead of the first release - ONE at a time, the admitted
// ("release") set first then the "cert" set, with the consumers' own options - and nothing else is predicted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prewarmReleasePredictions } from "../relay/secrets-release.mjs";

const id = (c) => "0x" + c.repeat(64);
const A = id("a"), B = id("b"), C = id("c"), NOT_LISTED = id("d");
const rows = [{ id: A, appRef: "catalog://0x" + "11".repeat(32) + "/1", isPublic: true },
              { id: B, appRef: "catalog://0x" + "22".repeat(32) + "/3", isPublic: false },
              { id: NOT_LISTED, appRef: "catalog://0x" + "33".repeat(32) + "/1", isPublic: true }];
function withListed(value, fn) {
  const saved = process.env.SECRETS_RELEASE_DEPLOYMENTS;
  if (value === undefined) delete process.env.SECRETS_RELEASE_DEPLOYMENTS; else process.env.SECRETS_RELEASE_DEPLOYMENTS = value;
  return Promise.resolve().then(fn).finally(() => { if (saved === undefined) delete process.env.SECRETS_RELEASE_DEPLOYMENTS; else process.env.SECRETS_RELEASE_DEPLOYMENTS = saved; });
}
// a predictor stub that records every call, the calls in flight at once, and answers per (deployment, set)
function ctxWith(answer = () => ({ ok: true })) {
  const calls = []; let inFlight = 0, maxInFlight = 0;
  return { calls, get maxInFlight() { return maxInFlight; },
    ledgerRows: async () => rows,
    predictorProblems: () => [],
    expectedGuestFor: async (row, o) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push({ id: row.id, set: o.set, forPrivate: o.forPrivate, waitMs: o.waitMs });
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return answer(row, o);
    } };
}
const quiet = () => {};
// a recorded, instant sleep: the pacing is asserted, never waited for
const fast = () => { const waits = []; return { waits, sleep: async (ms) => { waits.push(ms); } }; };

test("pre-warm: each LISTED deployment on the ledger, one prediction at a time, release set then cert set, with the consumers' options", async () => {
  await withListed(`${B},${A},${C}`, async () => {
    const ctx = ctxWith();
    const out = await prewarmReleasePredictions(ctx, { log: quiet, sleep: fast().sleep });
    assert.deepEqual(ctx.calls, [
      { id: A, set: "release", forPrivate: false, waitMs: undefined }, { id: A, set: "cert", forPrivate: false, waitMs: undefined },
      { id: B, set: "release", forPrivate: true, waitMs: undefined }, { id: B, set: "cert", forPrivate: false, waitMs: undefined }]);
    assert.equal(ctx.maxInFlight, 1, "never more than one of the predictor's slots");
    assert.equal(out.warmed, 4); assert.deepEqual(out.missing, [C], "a listed id not on the ledger is reported, not predicted");
    assert.ok(!ctx.calls.some((c) => c.id === NOT_LISTED), "an unlisted deployment is never predicted");
  });
});

test("pre-warm: a busy predictor ends the round (live releases own the slots); a failure is reported and the round goes on", async () => {
  await withListed(`${A},${B}`, async () => {
    const ctx = ctxWith((row, o) => (row.id === A && o.set === "cert" ? { ok: false, code: "busy" } : { ok: true }));
    const out = await prewarmReleasePredictions(ctx, { log: quiet, sleep: fast().sleep });
    assert.equal(out.busy, true); assert.equal(ctx.calls.length, 2, "nothing after the busy answer");
    const ctx2 = ctxWith((row) => (row.id === A ? { ok: false, code: "catalog_unreachable" } : { ok: true }));
    const out2 = await prewarmReleasePredictions(ctx2, { log: quiet, sleep: fast().sleep });
    // catalog_unreachable is retried once (pacing): A's two predictions are asked twice, then reported
    assert.equal(ctx2.calls.length, 6); assert.equal(out2.warmed, 2); assert.equal(out2.failed.length, 2); assert.equal(out2.retried, 2);
    const ctx3 = { ...ctxWith(), expectedGuestFor: async () => { throw new Error("boom"); } };
    const out3 = await prewarmReleasePredictions(ctx3, { log: quiet, sleep: fast().sleep });
    assert.equal(out3.failed.length, 4); assert.match(out3.failed[0], /prediction_failed/);
  });
});

test("pre-warm: nothing listed, '*', an unconfigured predictor or an unreadable ledger predict nothing", async () => {
  for (const [label, listed, over] of [["unset", undefined, {}], ["star", "*", {}], ["no valid id", "0x12,nothex", {}],
                                       ["predictor problems", A, { predictorProblems: () => ["the toolchain commit"] }],
                                       ["ledger down", A, { ledgerRows: async () => { throw new Error("rpc down"); } }],
                                       ["no predictor", A, { expectedGuestFor: undefined }]]) {
    await withListed(listed, async () => {
      const ctx = { ...ctxWith(), ...over };
      const calls = ctx.calls;
      const out = await prewarmReleasePredictions(ctx, { log: quiet, sleep: fast().sleep });
      assert.ok(out.skipped, `${label}: skipped`); assert.equal(calls.length, 0, `${label}: no prediction`);
    });
  }
});

test("pacing: a gap between two predictions (none before the first); catalog_unreachable is retried ONCE after the negative cache, nothing else is", async () => {
  await withListed(`${A},${B}`, async () => {
    // A's cert read is throttled the first time only; B's release fails for another reason (never retried)
    let throttled = true;
    const ctx = ctxWith((row, o) => {
      if (row.id === A && o.set === "cert" && throttled) { throttled = false; return { ok: false, code: "catalog_unreachable" }; }
      if (row.id === B && o.set === "release") return { ok: false, code: "version_not_admitted" };
      return { ok: true };
    });
    const f = fast();
    const out = await prewarmReleasePredictions(ctx, { log: quiet, sleep: f.sleep, gapMs: 500, retryAfterMs: 61_000 });
    assert.deepEqual(ctx.calls.map((c) => `${c.id.slice(2, 3)}:${c.set}`), ["a:release", "a:cert", "b:release", "b:cert", "a:cert"], "one pass, then the throttled one again");
    assert.deepEqual(f.waits, [500, 500, 500, 61_000, 500], "a gap between calls, the cache-length wait before the retry");
    assert.equal(out.retried, 1); assert.equal(out.warmed, 3, "the retried one counts once it succeeds");
    assert.deepEqual(out.failed, [`${B.slice(0, 10)} release: version_not_admitted`], "a refusal is not a transport blip: not retried");
    assert.ok(61_000 > 60_000, "the retry waits past the predictor's 60 s negative cache");
  });
});

test("pacing: a retry that fails again is reported; busy ends the round with no retry pass", async () => {
  await withListed(`${A}`, async () => {
    const ctx = ctxWith((row, o) => (o.set === "release" ? { ok: false, code: "catalog_unreachable" } : { ok: true }));
    const out = await prewarmReleasePredictions(ctx, { log: quiet, sleep: fast().sleep });
    assert.equal(out.retried, 1); assert.deepEqual(out.failed, [`${A.slice(0, 10)} release: catalog_unreachable (after a retry)`]);
    const ctx2 = ctxWith((row, o) => (o.set === "release" ? { ok: false, code: "catalog_unreachable" } : { ok: false, code: "busy" }));
    const f = fast();
    const out2 = await prewarmReleasePredictions(ctx2, { log: quiet, sleep: f.sleep });
    assert.equal(out2.busy, true); assert.equal(out2.retried, 0, "busy: the live traffic owns the slots, no retry pass");
    assert.ok(!f.waits.includes(61_000));
  });
});
