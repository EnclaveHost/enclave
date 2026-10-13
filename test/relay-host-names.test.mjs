// GET /v1/hosts/name/<name> (relay/host-names.mjs): the installer's name check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostNames, nameShapeProblem } from "../relay/host-names.mjs";

test("shape: lowercase letters, digits, inner hyphens, 3..32, nothing reserved", () => {
  for (const ok of ["nucbox-k11-2", "abc", "my-gaming-pc", "a1b2c3", "x".repeat(32)]) assert.equal(nameShapeProblem(ok), null, ok);
  for (const [bad, re] of [["", /required/], ["ab", /3 to 32/], ["x".repeat(33), /3 to 32/], ["NucBox", /lowercase/],
                           ["-box", /lowercase/], ["box-", /lowercase/], ["my_box", /lowercase/], ["my box", /lowercase/],
                           ["a--b", /double hyphens/], ["api", /kept for the platform/], ["enclave", /kept/], [null, /required/]])
    assert.match(nameShapeProblem(bad), re, String(bad));
});

test("taken: by a live tunnel or a registry entry; free otherwise; an unreadable registry is not 'free'", async () => {
  const live = new Set(["attached-box"]), registered = new Set(["nucbox-k11"]);
  let fail = false;
  const names = hostNames({ hub: { info: (n) => (live.has(n) ? { name: n } : null) },
                            ownerOf: async (n) => { if (fail) throw new Error("rpc"); return registered.has(n) ? "0x389C" : ""; } });
  assert.deepEqual(await names.check("my-new-box"), { name: "my-new-box", available: true });
  assert.deepEqual(await names.check("attached-box"), { name: "attached-box", available: false, reason: "a host is attached under that name right now" });
  assert.deepEqual(await names.check("nucbox-k11"), { name: "nucbox-k11", available: false, reason: "that name is registered to another host" });
  assert.equal((await names.check("Bad Name")).available, false);
  fail = true;
  assert.deepEqual(await names.check("my-new-box"), { name: "my-new-box", available: false, reason: "the registry could not be read; try again" });
});
