// verifier/index-memory.mjs: freshness beside authenticity. The regression evidence Codex asked for on 2026-09-25:
// successive publications after more than a hundred releases (the order is the signing run's, never a count), an old
// signed index replayed, the same publication with other bytes (equivocation), a legitimate retry (the same run's next
// attempt) and a re-dispatch (a new run), a floor that may only rise, and the record surviving a process (a file).
//   run: node --test test/verifier-index-memory.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIndexMemory as createCoreMemory, webStorageStore } from "../verifier/index-memory.mjs";
import { createFileIndexMemory as createIndexMemory, fileStore } from "../verifier/index-memory-file.mjs";
import { buildReleaseIndex, indexBytesOf, comparePublications, publicationOf, normalizePublication } from "../verifier/release-index.mjs";
import { createHash } from "node:crypto";

const D = (n) => n.toString(16).padStart(64, "0");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const at = (i) => new Date(Date.UTC(2026, 8, 25, 3, i)).toISOString();
// the publication ids are GitHub's run ids, as seen on this repository: ~3.6e10, increasing with every run created
const RUN = (k) => 36086615986 + k;
const rec = (k, { attempt = 1, floor = [0, 5, 841], bytes = null } = {}) => ({ publication: { runId: RUN(k), attempt }, digest: sha(bytes ?? Buffer.from(`index ${k} ${attempt}`)), minimumRelease: floor, tag: `v0.5.${847 + k}` });

test("successive publications after more than a hundred releases: the order is the signing run's; a list count never orders anything", () => {
  // a release list longer than any page (GitHub serves 100 per page) built into successive indexes: their order is the run id
  const many = Array.from({ length: 140 }, (_, i) => ({ tag: `v0.5.${700 + i}`, digest: D(700 + i), publishedAt: at(0) }));
  const a = buildReleaseIndex({ releases: many, policy: { minimumRelease: [0, 5, 700], revoked: [] }, repository: "EnclaveHost/enclave", publication: { runId: RUN(0), attempt: 1 } });
  const b = buildReleaseIndex({ releases: [...many, { tag: "v0.5.840", digest: D(840) }], policy: { minimumRelease: [0, 5, 700], revoked: [] }, repository: "EnclaveHost/enclave", publication: { runId: RUN(5000), attempt: 1 } });
  assert.equal(a.sequence, RUN(0)); assert.equal(b.sequence, RUN(5000)); assert.equal(a.attempt, 1); assert.equal(b.attempt, 1);
  assert.notEqual(a.sequence, many.length, "never the list length"); assert.ok(comparePublications({ runId: b.sequence, attempt: b.attempt }, { runId: a.sequence, attempt: a.attempt }) > 0);
  assert.throws(() => buildReleaseIndex({ releases: many, policy: { minimumRelease: [0, 5, 700], revoked: [] }, repository: "EnclaveHost/enclave" }), /publication .* is required/, "no publication, no index");
  assert.throws(() => buildReleaseIndex({ releases: many, policy: { minimumRelease: [0, 5, 700], revoked: [] }, repository: "EnclaveHost/enclave", publication: { runId: many.length, attempt: 0 } }), /publication .* is required/);
  const m = createIndexMemory();
  assert.equal(m.consider(rec(0)).kind, "first-seen"); assert.equal(m.consider(rec(1)).kind, "newest-seen"); assert.equal(m.consider(rec(5000)).kind, "newest-seen");
  assert.deepEqual(m.record().publication, { runId: RUN(5000), attempt: 1 });
});
test("an old signed index replayed is refused, whatever its bytes; the remembered record does not move", () => {
  const m = createIndexMemory(); m.consider(rec(10));
  const r = m.consider(rec(3)); assert.equal(r.ok, false); assert.equal(r.kind, "replay"); assert.match(r.why, /older than the remembered run 36086615996 attempt 1 \(v0\.5\.857\)/);
  assert.deepEqual(m.record().publication, { runId: RUN(10), attempt: 1 });
  const same = m.consider(rec(10)); assert.equal(same.ok, true); assert.equal(same.kind, "same", "the same publication re-fetched with the same bytes is idempotent");
});
test("equivocation: the same publication with other bytes is refused and remembered, and from then on BOTH sets of bytes are refused (the first ones included), across a process reload too; only a later publication recovers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-memory-eq-")), file = path.join(dir, "index-memory.json");
  try {
    const A = "a".repeat(64), B = "b".repeat(64);
    const m = createIndexMemory({ file }); assert.equal(m.consider({ ...rec(10), digest: A }).kind, "first-seen");
    const e = m.consider({ ...rec(10), digest: B });
    assert.equal(e.ok, false); assert.equal(e.kind, "equivocation"); assert.match(e.why, /equivocation: publication run 36086615996 attempt 1/); assert.equal(e.persisted, true, "the equivocation itself is written");
    assert.ok(m.record().equivocation, "remembered");
    const a1 = m.consider({ ...rec(10), digest: A }); assert.equal(a1.ok, false); assert.equal(a1.kind, "equivocation", "the FIRST bytes are refused too: nothing from an equivocated publication is taken"); assert.match(a1.why, /nothing from it is taken/);
    const b1 = m.consider({ ...rec(10), digest: B }); assert.equal(b1.ok, false); assert.equal(b1.kind, "equivocation");
    const reloaded = createIndexMemory({ file });
    assert.ok(reloaded.record().equivocation, "the equivocation survives the process");
    assert.equal(reloaded.consider({ ...rec(10), digest: A }).kind, "equivocation"); assert.equal(reloaded.consider({ ...rec(10), digest: B }).kind, "equivocation");
    assert.equal(reloaded.consider(rec(9)).kind, "replay", "an older publication is still a replay");
    const later = reloaded.consider(rec(11)); assert.equal(later.ok, true); assert.equal(later.kind, "newest-seen"); assert.equal(reloaded.record().equivocation, undefined, "superseded by a newer publication");
    assert.equal(createIndexMemory({ file }).record().equivocation, undefined, "and the file says so");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("a legitimate retry (the same run's next attempt) and a re-dispatch (a new run) are both newer; a retry's earlier attempt is then a replay", () => {
  const m = createIndexMemory(); m.consider(rec(20));
  const retry = m.consider(rec(20, { attempt: 2 })); assert.equal(retry.ok, true); assert.equal(retry.kind, "newest-seen");
  assert.equal(m.consider(rec(20, { attempt: 1 })).kind, "replay");
  assert.equal(m.consider(rec(21)).kind, "newest-seen"); assert.equal(m.consider(rec(20, { attempt: 3 })).kind, "replay", "an attempt of an OLDER run does not outrank a newer run");
  assert.equal(comparePublications({ runId: 5, attempt: 9 }, { runId: 6, attempt: 1 }) < 0, true);
});
test("the floor only rises across publications: a newer index with a lower floor is refused; floor() is what the fallback applies", () => {
  const m = createIndexMemory(); m.consider(rec(30, { floor: [0, 5, 845] }));
  assert.deepEqual(m.floor(), [0, 5, 845]);
  const down = m.consider(rec(31, { floor: [0, 5, 841] })); assert.equal(down.ok, false); assert.equal(down.kind, "floor-regression"); assert.deepEqual(m.floor(), [0, 5, 845]);
  assert.equal(m.consider(rec(32, { floor: [0, 5, 845] })).ok, true); assert.equal(m.consider(rec(33, { floor: [0, 5, 850] })).ok, true); assert.deepEqual(m.floor(), [0, 5, 850]);
  assert.equal(createIndexMemory().floor(), null, "no record, no floor");
  for (const bad of [{}, { publication: { runId: 1, attempt: 1 } }, { publication: { runId: 1, attempt: 1 }, digest: "x" }, { publication: { runId: 1, attempt: 1 }, digest: D(1), minimumRelease: "v1" }]) assert.equal(createIndexMemory().consider(bad).kind, "invalid");
});
test("the record survives a process: written atomically to a file, read back by a new instance; an unreadable or foreign file is 'no record' and says so; a directory that cannot be written is reported, never a reason to accept more", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-memory-")), file = path.join(dir, "deep", "index-memory.json");
  try {
    const a = createIndexMemory({ file }); const r = a.consider(rec(40, { floor: [0, 5, 843] })); assert.equal(r.persisted, true); assert.ok(fs.existsSync(file));
    const b = createIndexMemory({ file }); assert.deepEqual(b.record().publication, { runId: RUN(40), attempt: 1 }); assert.deepEqual(b.floor(), [0, 5, 843]);
    assert.equal(b.consider(rec(39)).kind, "replay", "the replay is refused by the NEW instance from the file alone");
    assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp")).length, 0, "no temp file left behind");
    fs.writeFileSync(file, "{not json");
    const c = createIndexMemory({ file }); assert.equal(c.record(), null); assert.match(c.note(), /unreadable/);
    fs.writeFileSync(file, JSON.stringify({ schema: "something-else/v9", publication: { runId: 1, attempt: 1 } }));
    const d = createIndexMemory({ file }); assert.equal(d.record(), null); assert.match(d.note(), /not a record this version understands/);
    // an unwritable location: a regular FILE where a directory would have to be (mkdir fails with ENOTDIR, at once)
    const blocker = path.join(dir, "not-a-dir"); fs.writeFileSync(blocker, "x");
    const ro = createIndexMemory({ file: path.join(blocker, "sub", "index-memory.json") }); const w = ro.consider(rec(41));
    assert.equal(w.ok, true); assert.equal(w.persisted, false, "accepted for this process, and the failure to persist is reported"); assert.equal(ro.durable(), false);
    const again = ro.consider(rec(41)); assert.equal(again.kind, "same"); assert.equal(again.persisted, false, "an unsaved memory is never labelled durable, on any branch");
    assert.equal(ro.consider(rec(40)).kind, "replay", "the in-process record still orders");
    assert.equal(createIndexMemory({ file: path.join(blocker, "sub", "index-memory.json") }).record(), null, "and a new process starts with nothing: the gap is real and stated by persisted:false");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("publicationOf reads GitHub's run invocation as the certificate carries it; anything else orders nothing", () => {
  assert.deepEqual(publicationOf("https://github.com/EnclaveHost/enclave/actions/runs/36086615986/attempts/1"), { runId: 36086615986, attempt: 1, uri: "https://github.com/EnclaveHost/enclave/actions/runs/36086615986/attempts/1" });
  for (const bad of ["", null, "https://github.com/EnclaveHost/enclave/actions/runs/36086615986", "runs/1/attempts/x", "https://evil/actions/runs/12345678901234567890/attempts/1"]) assert.equal(publicationOf(bad), null, String(bad));
  assert.equal(normalizePublication({ runId: "36086615986", attempt: "2" })?.attempt, 2); assert.equal(normalizePublication({ runId: 0, attempt: 1 }), null); assert.equal(normalizePublication({ runId: 1.5, attempt: 1 }), null);
});
