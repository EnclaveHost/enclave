// verifier/tuf-refresh.mjs: the TUF-verified refresh of the pinned Sigstore trusted root. Through the real client
// (@freedomofpress/tuf-browser) against a repository minted for the run (test/helpers/tuf-fake-repo.mjs: real keys,
// real signatures): the happy path with a root rotation; a failed signature; expired metadata (a freeze); a rollback of
// timestamp and snapshot versions; an update interrupted half-way and its recovery, with the last trusted state
// preserved throughout; a target whose bytes do not match; a rotation signed below threshold; and the pinned files
// written only from a verified refresh. Then Sigstore's REAL chain (fixture sigstore-2026-09-25, root 1..15 and the
// current metadata) walked offline: verified while its timestamp is unexpired, the freeze refusal after.
//   run: node --test test/verifier-tuf-refresh.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { refreshTrustedRoot, createFileBackend, writePinned, TARGET_NAME } from "../verifier/tuf-refresh.mjs";
import { createRepo, mintKey, bytesOf } from "./helpers/tuf-fake-repo.mjs";

const REPO = new URL("..", import.meta.url).pathname;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tuf-refresh-"));
const ROOT_A = Buffer.from(JSON.stringify({ certificateAuthorities: [{ n: 1 }], tlogs: [], ctlogs: [], v: "A" }));
const ROOT_B = Buffer.from(JSON.stringify({ certificateAuthorities: [{ n: 2 }], tlogs: [], ctlogs: [], v: "B" }));
const versionsOf = (r) => ({ root: r.versions.root?.version ?? null, timestamp: r.versions.timestamp?.version ?? null, snapshot: r.versions.snapshot?.version ?? null, targets: r.versions.targets?.version ?? null });
async function withRepo(opts, fn) { const repo = createRepo(opts); const s = await repo.serve(); try { return await fn(repo, s); } finally { await s.close(); } }
const refresh = (repo, s, extra = {}) => refreshTrustedRoot({ metadataUrl: s.metadataUrl, targetsUrl: s.targetsUrl, startingRoot: repo.startingRoot(1), currentTrustedRoot: ROOT_A, ...extra });

test("happy path: from the pinned root v1, one rotation to v2, timestamp/snapshot/targets to threshold, the target by hash and length; a second refresh from the same state is idempotent; a new target version is picked up as changed", async () => {
  await withRepo({ targetBytes: ROOT_A }, async (repo, s) => {
    repo.publishRoot(); repo.publish();                         // root v2 (signed by v1's and v2's keys), metadata v2
    const state = tmp();
    const r = await refresh(repo, s, { stateDir: state });
    assert.equal(r.ok, true, r.reasons.join(" | ")); assert.deepEqual(versionsOf(r), { root: 2, timestamp: 2, snapshot: 2, targets: 2 }); assert.equal(r.startingRootVersion, 1);
    assert.equal(r.sha256, sha(ROOT_A)); assert.equal(r.changed, false, "the pinned copy equals the target"); assert.match(r.reasons.at(-1), /root v1 -> v2 \(1 rotation\(s\)\)/);
    const again = await refresh(repo, s, { stateDir: state }); assert.equal(again.ok, true); assert.deepEqual(versionsOf(again), versionsOf(r));
    repo.publish({ targetBytes: ROOT_B });
    const b = await refresh(repo, s, { stateDir: state }); assert.equal(b.ok, true); assert.equal(b.changed, true); assert.equal(b.sha256, sha(ROOT_B)); assert.deepEqual(versionsOf(b), { root: 2, timestamp: 3, snapshot: 3, targets: 3 });
  });
});
test("a failed signature on any role refuses, and the state keeps the last trusted metadata; a rotation signed below the old root's threshold refuses", async () => {
  await withRepo({ targetBytes: ROOT_A }, async (repo, s) => {
    const state = tmp(); const ok = await refresh(repo, s, { stateDir: state }); assert.equal(ok.ok, true);
    const before = fs.readdirSync(path.join(state, "sigstore")).map((f) => [f, sha(fs.readFileSync(path.join(state, "sigstore", f)))]);
    repo.publish(); repo.tamperSignature("timestamp.json");
    const t = await refresh(repo, s, { stateDir: state }); assert.equal(t.ok, false); assert.match(t.error, /timestamp/i); assert.equal(t.current.sha256, sha(ROOT_A), "the pinned copy is untouched");
    assert.deepEqual(fs.readdirSync(path.join(state, "sigstore")).map((f) => [f, sha(fs.readFileSync(path.join(state, "sigstore", f)))]), before, "no cached role moved on a refused signature");
    repo.clearTamper(); repo.tamperSignature(`${repo.state.versions.snapshot}.snapshot.json`);
    const sn = await refresh(repo, s, { stateDir: state }); assert.equal(sn.ok, false); assert.match(sn.error, /snapshot/i);
    repo.clearTamper(); repo.tamperSignature(`${repo.state.versions.targets}.targets.json`);
    const tg = await refresh(repo, s, { stateDir: state }); assert.equal(tg.ok, false); assert.match(tg.error, /targets/i);
    repo.clearTamper(); const fine = await refresh(repo, s, { stateDir: state }); assert.equal(fine.ok, true, "the same repository, untampered, verifies");
  });
  // a root rotation must be signed to the OLD root's threshold: two root keys, threshold 2; v2 signed by one key only
  const k1 = mintKey(), k2 = mintKey();
  await withRepo({ targetBytes: ROOT_A, rootKeys: [k1, k2], rootThreshold: 2 }, async (repo, s) => {
    const state = tmp(); assert.equal((await refresh(repo, s, { stateDir: state })).ok, true);
    repo.publishRoot({ signers: [k1] }); repo.publish();
    const r = await refresh(repo, s, { stateDir: state }); assert.equal(r.ok, false); assert.match(r.error, /verify|root/i);
    assert.equal(fs.existsSync(path.join(state, "sigstore", "root.json")) ? JSON.parse(fs.readFileSync(path.join(state, "sigstore", "root.json"), "utf8")).signed?.version ?? 1 : 1, 1, "the cached root did not advance");
  });
});
test("expired metadata is a freeze: an expired timestamp, snapshot or targets refuses; an expired root at the end of the chain refuses", async () => {
  await withRepo({ targetBytes: ROOT_A }, async (repo, s) => {
    const state = tmp(); assert.equal((await refresh(repo, s, { stateDir: state })).ok, true);
    const past = new Date(Date.now() - 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    repo.publish({ expires: { timestamp: past } }); const t = await refresh(repo, s, { stateDir: state }); assert.equal(t.ok, false); assert.match(t.error, /[Ff]reeze.*timestamp/);
    repo.publish({ expires: { snapshot: past } }); const sn = await refresh(repo, s, { stateDir: state }); assert.equal(sn.ok, false); assert.match(sn.error, /[Ff]reeze.*snapshot/);
    repo.publish({ expires: { targets: past } }); const tg = await refresh(repo, s, { stateDir: state }); assert.equal(tg.ok, false); assert.match(tg.error, /[Ff]reeze.*targets/);
    repo.publish(); assert.equal((await refresh(repo, s, { stateDir: state })).ok, true, "fresh metadata verifies again");
    repo.publishRoot({ expires: past }); repo.publish(); const rt = await refresh(repo, s, { stateDir: tmp() }); assert.equal(rt.ok, false); assert.match(rt.error, /[Ff]reeze.*root/);
  });
});
test("rollback: after a verified refresh, a served timestamp with a lower version refuses, and a timestamp whose snapshot version went backwards refuses; the cached versions stay", async () => {
  await withRepo({ targetBytes: ROOT_A }, async (repo, s) => {
    const state = tmp(); assert.equal((await refresh(repo, s, { stateDir: state })).ok, true);
    repo.publish(); repo.publish(); const r3 = await refresh(repo, s, { stateDir: state }); assert.equal(r3.ok, true); assert.equal(versionsOf(r3).timestamp, 3);
    repo.tamperBody("timestamp.json", (signed) => { signed.version = 2; });      // re-signed? no: the signature no longer matches, which is also a refusal; so sign a genuine old one instead
    repo.clearTamper();
    const older = repo.files().get("timestamp.json"); repo.publish();            // v4 exists; now serve v3 again (genuine, signed) after a v4 was cached
    const r4 = await refresh(repo, s, { stateDir: state }); assert.equal(r4.ok, true); assert.equal(versionsOf(r4).timestamp, 4);
    repo.tamperRaw("timestamp.json", () => older);
    const back = await refresh(repo, s, { stateDir: state }); assert.equal(back.ok, false); assert.match(back.error, /lower version|rollback/i); assert.equal(versionsOf(back).timestamp, 4, "the cached timestamp stays at v4");
    repo.clearTamper();
    // a genuine timestamp whose snapshot pointer goes backwards: version 5, snapshot meta pointing at snapshot v1
    const k = repo.keys().timestamp; const { signMeta } = await import("./helpers/tuf-fake-repo.mjs");
    const snap1 = repo.files().get("1.snapshot.json");
    const bad = bytesOf(signMeta({ _type: "timestamp", spec_version: "1.0", version: 5, expires: new Date(Date.now() + 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z"), meta: { "snapshot.json": { version: 1, length: snap1.length, hashes: { sha256: sha(snap1) } } } }, k));
    repo.tamperRaw("timestamp.json", () => bad);
    const sb = await refresh(repo, s, { stateDir: state }); assert.equal(sb.ok, false); assert.match(sb.error, /snapshot version has been rolled back/i);
  });
});
test("interrupted update and recovery: the snapshot vanishes half-way, the refresh refuses, the last trusted target and cached roles stand; served again, the refresh completes; a target whose bytes changed under its name refuses on hash", async () => {
  await withRepo({ targetBytes: ROOT_A }, async (repo, s) => {
    const state = tmp(); const first = await refresh(repo, s, { stateDir: state }); assert.equal(first.ok, true);
    repo.publish({ targetBytes: ROOT_B });
    repo.state.missing.add(`${repo.state.versions.snapshot}.snapshot.json`);
    const cut = await refresh(repo, s, { stateDir: state }); assert.equal(cut.ok, false); assert.match(cut.error, /Failed to fetch/i);
    assert.equal(cut.current.sha256, sha(ROOT_A), "the pinned trusted root is still A"); assert.equal(versionsOf(cut).snapshot, 1, "the cached snapshot is the last trusted one"); assert.equal(versionsOf(cut).timestamp, 2, "the verified timestamp was kept, as the client persists per role");
    repo.state.missing.clear();
    const rec = await refresh(repo, s, { stateDir: state }); assert.equal(rec.ok, true); assert.equal(rec.sha256, sha(ROOT_B)); assert.equal(rec.changed, true); assert.deepEqual(versionsOf(rec), { root: 1, timestamp: 2, snapshot: 2, targets: 2 });
    const name = `targets/${sha(ROOT_B)}.${TARGET_NAME}`; repo.tamperRaw(name, () => Buffer.concat([ROOT_B.subarray(0, ROOT_B.length - 2), Buffer.from("}}")]));
    const bad = await refresh(repo, s, { stateDir: state }); assert.equal(bad.ok, false); assert.match(bad.error, /hash mismatch|length mismatch/i);
  });
});
test("writePinned writes the trusted root, the starting root and the sources only from a verified refresh, atomically; a refused refresh cannot be written; a mirror that serves a different signed repository is refused by the pinned root's keys, never accepted", async () => {
  await withRepo({ targetBytes: ROOT_A }, async (repo, s) => {
    const roots = tmp(); fs.writeFileSync(path.join(roots, "SOURCES.json"), JSON.stringify({ "sigstore-trusted-root.json": { what: "old" } }));
    repo.publishRoot(); repo.publish({ targetBytes: ROOT_B });
    const r = await refresh(repo, s, { stateDir: tmp() }); assert.equal(r.ok, true);
    const w = writePinned(r, { rootsDir: roots, metadataUrl: s.metadataUrl, targetsUrl: s.targetsUrl });
    assert.equal(sha(fs.readFileSync(w.trustedRoot)), sha(ROOT_B)); assert.equal(JSON.parse(fs.readFileSync(w.startingRoot, "utf8")).signed.version, 2, "the starting root advanced to the verified v2");
    const src = JSON.parse(fs.readFileSync(w.sources, "utf8")); assert.equal(src["sigstore-trusted-root.json"].tuf.rootVersion, 2); assert.equal(src["sigstore-trusted-root.json"].what, "old", "existing notes kept"); assert.equal(src["sigstore-tuf-root.json"].version, 2);
    assert.equal(fs.readdirSync(roots).filter((f) => f.endsWith(".tmp")).length, 0);
    repo.tamperSignature("timestamp.json"); const bad = await refresh(repo, s, { stateDir: tmp() }); assert.equal(bad.ok, false); assert.throws(() => writePinned(bad, { rootsDir: roots }), /only a verified refresh/);
  });
  // another repository entirely (other keys) served at the same URLs: refused by the pinned root, whatever it signs
  const other = createRepo({ targetBytes: ROOT_B }); const so = await other.serve();
  try {
    const mine = createRepo({ targetBytes: ROOT_A });
    const r = await refreshTrustedRoot({ metadataUrl: so.metadataUrl, targetsUrl: so.targetsUrl, startingRoot: mine.startingRoot(1), currentTrustedRoot: ROOT_A, stateDir: tmp() });
    assert.equal(r.ok, false); assert.match(r.error, /verify|signature|root/i, "a mirror is not an authority: nothing it serves verifies against the pinned root");
  } finally { await so.close(); }
});
test("Sigstore's real chain, offline (fixture sigstore-2026-09-25): from the anchored root v1 through fourteen rotations to v15, timestamp v790, snapshot v165, targets v14, and the trusted_root.json target that IS the pinned one; after the fixture's timestamp expiry the correct outcome is the freeze refusal", async () => {
  const F = path.join(REPO, "test", "fixtures", "verifier", "tuf", "sigstore-2026-09-25");
  const srv = http.createServer((req, res) => { const p = path.join(F, decodeURIComponent((req.url || "/").replace(/^\//, "").split("?")[0])); if (p.startsWith(F) && fs.existsSync(p) && fs.statSync(p).isFile()) { res.writeHead(200); res.end(fs.readFileSync(p)); } else { res.writeHead(404); res.end(); } });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r)); const base = `http://127.0.0.1:${srv.address().port}/`;
  try {
    const expires = new Date(JSON.parse(fs.readFileSync(path.join(F, "timestamp.json"), "utf8")).signed.expires).getTime();
    const r = await refreshTrustedRoot({ metadataUrl: base, targetsUrl: `${base}targets/`, startingRoot: fs.readFileSync(path.join(F, "1.root.json"), "utf8"), stateDir: tmp() });
    if (Date.now() < expires) {
      assert.equal(r.ok, true, r.reasons.join(" | ")); assert.equal(r.startingRootVersion, 1); assert.deepEqual(versionsOf(r), { root: 15, timestamp: 790, snapshot: 165, targets: 14 });
      assert.equal(r.sha256, "6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66", "the target is the pinned trusted root"); assert.equal(r.changed, false); assert.match(r.reasons.at(-1), /14 rotation\(s\)/);
    } else {
      assert.equal(r.ok, false); assert.match(r.error, /[Ff]reeze/, "the fixture's timestamp expired on 2026-09-29: stale metadata is refused, which is the correct outcome");
    }
    // the anchor: root v1 as served by the CDN and as recorded in sigstore/root-signing metadata/root_history/1.root.json (two independent sources, one digest)
    const anchor = fs.readFileSync(path.join(F, "1.root.json")); assert.equal(sha(anchor), "cd7549b15e7b4e660a89c950bca1bce262a524a5cf909952b66951b5c8667bc6"); assert.equal(JSON.parse(anchor.toString()).signed.version, 1);
  } finally { await new Promise((r) => srv.close(() => r())); }
});

test("the refresh workflow: weekly and on dispatch, pinned actions, the lockfile install, refresh from the pinned root written only on success, the report kept, a PULL REQUEST on change and never a push to main, no secret beyond the job token", () => {
  const y = fs.readFileSync(path.join(REPO, ".github", "workflows", "verifier-tuf-refresh.yml"), "utf8");
  assert.match(y, /^\s+schedule:\n\s+- cron: "41 5 \* \* 1"/m); assert.match(y, /workflow_dispatch: \{\}/); assert.equal(/^\s+push:/m.test(y), false); assert.equal(/^\s+pull_request:/m.test(y), false);
  for (const m of y.matchAll(/uses: ([^@\s]+)@([0-9a-f]{40})/g)) assert.ok(m[2], m[1]); assert.equal((y.match(/uses: /g) || []).length, 3, "three pinned actions");
  assert.match(y, /npm ci --ignore-scripts --no-audit --no-fund/); assert.match(y, /node verifier\/tuf-refresh\.mjs refresh --state \.tuf-state --out tuf-refresh-report\.json --write/);
  assert.match(y, /gh pr create --base main --head "\$BR"/); assert.equal(/git push origin (main|HEAD:main)/.test(y), false, "never a push to main"); assert.match(y, /git push origin "\$BR"/);
  assert.equal(/secrets\./.test(y), false, "no secret"); assert.match(y, /pull-requests: write/); assert.match(y, /^permissions:\n  contents: read/m, "read-only by default; the job raises what it needs");
});
