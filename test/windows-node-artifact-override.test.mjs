// The operator artifact override runs a PINNED file in place of a catalog CID, or nothing at all.
//
// It exists because risc-box's fix is built and tested but its permanent form - a new catalog
// version and the deployment moved onto it - needs two signatures on the governance hardware wallet.
// Until then the node can run the fixed bytes. The one property that matters is that it runs
// EXACTLY the bytes the operator pinned: a file whose hash differs is refused and never reaches the
// compiler. Driven through the real Host.ensureApp, with only the catalog lookup bypassed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Host } from "../windows/node/host.mjs";
import { servedOwner } from "./helpers/owners.mjs";

const ID = "0x" + "e6".repeat(32);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "artovr-"));
const art = path.join(dir, "fixed.wasm");
// A core module, not a component: ensureApp stops right after the artifact stage, which is all
// these tests need to observe - which bytes were taken, or that none were.
fs.writeFileSync(art, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
const SHA = crypto.createHash("sha256").update(fs.readFileSync(art)).digest("hex");

const deployment = { appRef: "catalog://0x" + "ab".repeat(32) + "/54", leaseUntil: 0n, cpuMilli: 350n,
                     gpuMilli: 0n, isPublic: true, owner: "0x" + "0b".repeat(20) };
const version = { yanked: false, cid: "bafy-catalog-cid", version: "0.6.54", memMb: 3072n, config: "{}" };
function host(logs) {
  return servedOwner(new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test", appsEnabled: true,
                    cpuPricePerSec6: 12, log: (m) => logs.push(String(m)) }), "0x" + "0b".repeat(20));
}
async function run(patch) {
  const logs = [];
  const prev = process.env.ENCLAVE_APP_ARTIFACT_PATCH;
  if (patch === undefined) delete process.env.ENCLAVE_APP_ARTIFACT_PATCH;
  else process.env.ENCLAVE_APP_ARTIFACT_PATCH = JSON.stringify(patch);
  try {
    const h = host(logs);
    const rec = await h.ensureApp(ID, deployment, { version }).catch((e) => ({ thrown: e.message }));
    return { rec: rec && rec.thrown ? rec : h.records.get(ID), logs };
  } finally {
    if (prev === undefined) delete process.env.ENCLAVE_APP_ARTIFACT_PATCH; else process.env.ENCLAVE_APP_ARTIFACT_PATCH = prev;
  }
}

test("a pinned file whose hash matches is what runs, and the override says so", async () => {
  const { rec, logs } = await run({ [ID]: { file: art, sha256: SHA } });
  assert.equal(rec.artifactOverride?.sha256, SHA, "the record names the bytes that ran");
  assert.equal(rec.artifactOverride?.replaces, "bafy-catalog-cid");
  assert.ok(logs.some((l) => /ARTIFACT OVERRIDE .*NOT the catalog's bytes/.test(l)), "announced in the log");
  // it got past the artifact stage on THOSE bytes: the core-module refusal is about this file
  assert.match(String(rec.reason || ""), /core wasm module/);
});

test("a file whose hash does not match is refused and never run", async () => {
  const { rec, logs } = await run({ [ID]: { file: art, sha256: "0".repeat(64) } });
  assert.equal(rec.status, "failed");
  assert.match(rec.reason, /artifact override: .*not the pinned .*refusing to run it/);
  assert.equal(rec.artifactOverride, undefined, "nothing was taken");
  assert.ok(!logs.some((l) => /ARTIFACT OVERRIDE/.test(l)));
});

test("an override without a pinned hash is refused, not trusted", async () => {
  const { rec } = await run({ [ID]: { file: art } });
  assert.equal(rec.status, "failed");
  assert.match(rec.reason, /needs \{file, sha256\}/);
});

test("another deployment's override does not touch this one", async () => {
  const { rec, logs } = await run({ ["0x" + "11".repeat(32)]: { file: art, sha256: SHA } });
  assert.equal(rec.artifactOverride, undefined);
  assert.ok(!logs.some((l) => /ARTIFACT OVERRIDE/.test(l)));
  assert.match(String(rec.reason || ""), /^artifact: /, "it went to the catalog's CID as usual");
});
