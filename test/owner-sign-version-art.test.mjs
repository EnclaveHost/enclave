// rpc/snp/owner-sign/version-art.mjs: new art is the newest version again with `_media` alone changed, named by the
// CIDs the gateway will return, and published only once the files are served and the app's versions are as planned.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { rawCid, withArt, versionArtStatus, RAW_BLOCK_MAX } from "../rpc/snp/owner-sign/version-art.mjs";

test("a small file's CID is computed as the gateway returns it", () => {
  // the preview banner, pinned on 2026-10-28 under the CID versions 0 to 6 carry on chain
  assert.equal(rawCid(fs.readFileSync(new URL("../ops/unified-funding-20261028/rpc-preview-publish-r2/frozen/banner.svg", import.meta.url))), "bafkreigk5wlaubssoere2f2v4gfjmyxvbob27wqzwcwc7gqq2xgpeex2ki");
  assert.throws(() => rawCid(Buffer.alloc(RAW_BLOCK_MAX + 1)), /over 256 KiB/);
});

test("only _media changes, and a config that is not the canonical object is refused", () => {
  const M = { thumbnail: "bafkreia", banner: "bafkreib" };
  assert.equal(withArt('{"schema":"x","image":{"rootHash":"ab"},"_media":null}', M), '{"schema":"x","image":{"rootHash":"ab"},"_media":{"thumbnail":"bafkreia","banner":"bafkreib"}}');
  assert.equal(withArt('{"a":1}', M), '{"a":1,"_media":{"thumbnail":"bafkreia","banner":"bafkreib"}}');
  for (const bad of ['{"a": 1}', "[]", "null", "x", ""]) assert.throws(() => withArt(bad, M), /not JSON|not a canonical JSON object/);
  assert.throws(() => withArt(JSON.stringify({ pad: "x".repeat(4090) }), M), /over 4096/);
});

const bytes = { thumbnail: Buffer.from("<svg>t</svg>"), banner: Buffer.from("<svg>b</svg>") };
const u = (id) => ({ cid: rawCid(bytes[id]), sha256: crypto.createHash("sha256").update(bytes[id]).digest("hex"), gateways: ["https://pin.test"] });
const CONFIG = '{"a":1,"_media":{}}';
const plan = { owner: "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61",
  steps: [{ id: "thumbnail", upload: {} }, { id: "banner", upload: {} }, { id: "publish", to: "0xca", data: "0x01" }],
  status: { catalog: "0xca", appId: "0x" + "0f".repeat(32), versionIndex: 11, label: "1.5.1-art", cid: "bafkreic", config: CONFIG, uploads: { thumbnail: u("thumbnail"), banner: u("banner") } } };
const net = (have) => async (url) => { const id = Object.keys(bytes).find((k) => url.endsWith(plan.status.uploads[k].cid));
  return have.includes(id) ? new Response(bytes[id]) : new Response("no", { status: 404 }); };
function chain({ versions = 11, version = null, revert = false } = {}) {
  const calls = [];
  return { calls, call: async (c) => { calls.push(c); if (revert) throw new Error("execution reverted"); },
    readContract: async ({ functionName }) => functionName === "numVersions" ? BigInt(versions) : version };
}
const V = { version: "1.5.1-art", cid: "bafkreic", config: CONFIG, approval: 1, yanked: false };

test("the publish waits for both files, for unchanged versions and for a clean simulation", async () => {
  let c = chain(), st = await versionArtStatus(plan, c, { fetchImpl: net(["thumbnail"]) });
  assert.deepEqual([st.thumbnail, st.banner, st.publish], [true, false, false]);
  assert.deepEqual(st.ready, { thumbnail: false, banner: true, publish: false });
  assert.match(st.blocked.publish, /pin\.test does not serve/);
  assert.deepEqual(c.calls, []);

  c = chain(); st = await versionArtStatus(plan, c, { fetchImpl: net(["thumbnail", "banner"]) });
  assert.deepEqual(st.ready, { thumbnail: false, banner: false, publish: true });
  assert.deepEqual(c.calls, [{ account: plan.owner, to: "0xca", data: "0x01" }]);

  st = await versionArtStatus(plan, chain({ revert: true }), { fetchImpl: net(["thumbnail", "banner"]) });
  assert.match(st.blocked.publish, /would revert/);

  st = await versionArtStatus(plan, chain({ versions: 12, version: { ...V, version: "1.6.0" } }), { fetchImpl: net(["thumbnail", "banner"]) });
  assert.equal(st.ready.publish, false);
  assert.match(st.blocked.publish, /not this one/);
  st = await versionArtStatus(plan, chain({ versions: 10 }), { fetchImpl: net(["thumbnail", "banner"]) });
  assert.match(st.blocked.publish, /versions changed/);

  c = chain({ versions: 12, version: V }); st = await versionArtStatus(plan, c, { fetchImpl: net(["thumbnail", "banner"]) });
  assert.equal(st.publish, true);
  assert.deepEqual(c.calls, []);
});

test("a gateway serving other bytes under the CID does not count as uploaded", async () => {
  const st = await versionArtStatus(plan, chain(), { fetchImpl: async () => new Response("other") });
  assert.deepEqual([st.thumbnail, st.banner], [false, false]);
  assert.match(st.blocked.publish, /serves other bytes/);
});
