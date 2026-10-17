// relay/measurement-predict.mjs agreeingRead: a read through several independent RPCs needs two (or all, when fewer are
// configured) agreeing answers; one that fails drops out, one that disagrees fails the read closed. 2026-10-17 05:09Z: one
// of nan's two public RPCs failed for minutes and every Shield app's check failed with it; with a third configured, the
// remaining two decide.
import test from "node:test";
import assert from "node:assert/strict";
import { agreeingRead, catalogReader } from "../relay/measurement-predict.mjs";

const ok = (v) => async () => v, bad = (m) => async () => { throw new Error(m); };

test("two of three agreeing answers decide; the failed provider drops out", async () => {
  assert.deepEqual(await agreeingRead([ok({ a: 1 }), bad("limit reached"), ok({ a: 1 })], (f) => f()), { a: 1 });
});

test("with two providers configured both must answer, as before", async () => {
  await assert.rejects(agreeingRead([ok(1), bad("RPC Request failed")], (f) => f(), { what: "x" }), /only 1 of 2 RPCs answered x \(RPC Request failed\)/);
});

test("any disagreement among the answers fails closed, even when two agree", async () => {
  await assert.rejects(agreeingRead([ok({ a: 1 }), ok({ a: 1 }), ok({ a: 2 })], (f) => f(), { what: "y" }), (e) => e.code === "disagree" && /disagree about y/.test(e.message));
});

test("a single configured provider is enough on its own (callers that need two check that themselves)", async () => {
  assert.equal(await agreeingRead([ok(7)], (f) => f()), 7);
});

test("catalogReader: one of three RPCs failing still reads the version", async () => {
  const version = { cid: "bafy", memMb: 64n, ports: [], approval: 1, yanked: false };
  const client = (fail) => ({ readContract: async ({ functionName }) => {
    if (fail) throw new Error("request limit reached");
    return functionName === "getApp" ? { appId: "0x" + "11".repeat(32), active: true, versionCount: 1n } : version; } });
  const read = catalogReader([client(false), client(true), client(false)], "0x" + "ca".repeat(20));
  const got = await read("0x" + "11".repeat(32), 0);
  assert.equal(got.version.cid, "bafy");
  assert.equal(got.app.active, true);
});
