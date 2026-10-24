// Stated limitations, run against the PINNED custodian startup code (repo-r2 custody/v2/startup-state.mjs).
// The `todo` test is the property the design does NOT have: it is EXPECTED TO FAIL and is reported as TODO, never as a
// pass. The plain test pins the limitation itself, so a change in behaviour is noticed either way.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.env.CANARY_CLIENT_REPO || "/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-release-20261023/repo-r2";
const { loadStartupState } = await import(pathToFileURL(path.join(REPO, "custody/v2/startup-state.mjs")).href);

// A host that keeps history (host.mjs keeps 20 blobs) and hands back an OLDER valid one.
const sealedV1 = Buffer.from("sealed-state-version-1-older-checkpoint-and-shares");
const sealedV2 = Buffer.from("sealed-state-version-2-newer-checkpoint-and-shares");
const unseal = (b) => ({ version: b.includes("version-1") ? 1 : 2, identity: "0xsame" });
const start = (blob) => loadStartupState({ read: async () => blob, unseal, fresh: () => { throw new Error("must not mint"); }, persist: async () => { throw new Error("must not persist"); } });

test("LIMITATION (recorded): an older valid sealed blob opens under the same identity", async () => {
  const s = await start(sealedV1);
  assert.equal(s.identity, "0xsame");
  assert.equal(s.version, 1, "the older state is accepted: there is no monotonic anchor to compare against");
});

test("EXPECTED FAIL: a custodian detects a rolled-back sealed state (needs a monotonic anchor that does not exist)", { todo: "no monotonic anchor; spec 176-181; host keeps 20 blobs" }, async () => {
  await (await start(sealedV2));          // the newest state was seen once
  await assert.rejects(start(sealedV1), /rollback/, "an older blob after a newer one must be refused");
});
