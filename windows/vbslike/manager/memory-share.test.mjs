import { test } from "node:test";
import assert from "node:assert/strict";
import { appMemoryForShare } from "./memory-share.mjs";

test("RAM follows host pool and share, with catalog RAM only a minimum", () => {
  assert.equal(appMemoryForShare(65536, .25, 6144).appMiB, 16384);
  assert.equal(appMemoryForShare(90112, .25, 6144).appMiB, 22528);
  assert.equal(appMemoryForShare(65536, .07, 128).appMiB, 4587);
  assert.throws(() => appMemoryForShare(65536, .07, 6144), /requires 6144/);
  for (const pool of [0, -1, null, NaN, Infinity, 65536.5])
    assert.throws(() => appMemoryForShare(pool, .25, 6144), /valid advertised/);
});
