// relay/reverify.mjs: the relay's re-verification of dialed rows, through the real consumer module (a local TLS "enclave"
// serving the authentic Genoa document, a local release index serving the v0.5.841 fixtures, offline AMD collateral), and
// the three modes' effect on eligibility. The positive (`verified`) path cannot come from a live capture here: no local
// server holds the key the Genoa report binds, so it is driven through the injectable verify function with a verdict of the
// real shape; everything else is the real path.
//   run: node --test test/relay-reverify.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createReverifier, modeOf, MODES } from "../relay/reverify.mjs";
import * as consumer from "../verifier/consumer.mjs";
import { verifyReleaseIndex } from "../verifier/release-index.mjs";
import { verifyReleaseAttestation } from "../verifier/provenance.mjs";
import { createIndexMemory } from "../verifier/index-memory.mjs";
import { mintLocalCa, serveTls } from "./helpers/local-tls.mjs";

const REPO = new URL("..", import.meta.url).pathname, F = path.join(REPO, "test", "fixtures", "verifier");
const rd = (...p) => fs.readFileSync(path.join(F, ...p));
const rad = JSON.parse(rd("genoa-tinfoil", "rad.json").toString());
const collateral = () => consumer.memoryCollateral({ chains: { Genoa: fs.readFileSync(path.join(REPO, "test", "fixtures", "amd", "Genoa-cert_chain.pem"), "utf8") }, vceks: { Genoa: rd("genoa-tinfoil", "vcek-kds-amd.der") }, crls: { Genoa: rd("amd", "Genoa-crl.der") } });
const candidate = (tag) => { const j = JSON.parse(rd("release", `${tag}.attestation.json`).toString()); return { tag, digest: rd("release", `${tag}.tinfoil.hash`).toString().trim(), bundle: j.attestations ? j.attestations[0]?.bundle : j }; };
const ours = () => consumer.releaseExpectationsFrom([candidate("v0.5.841"), candidate("v0.5.841-cpu")]);
const NOW = "2026-09-24T05:00:00Z";
// a bundle stand-in with the consumer's exports and a collateral adapter that is the fixtures (the relay's is KDS through the disk cache)
const bundle = { ...consumer, httpCollateral: () => collateral(), cachedCollateral: () => collateral() };
const row = (endpoint, extra = {}) => ({ endpoint, id: "0x" + "11".repeat(32), tunnel: false, relay: false, availability: { teeCpu: "amd-sev-snp", claimEnabled: true }, ...extra });

test("modes: off, shadow (default), enforce; anything else is shadow", () => {
  assert.deepEqual([...MODES], ["off", "shadow", "enforce"]);
  for (const [raw, want] of [["off", "off"], ["shadow", "shadow"], ["enforce", "enforce"], ["", "shadow"], [undefined, "shadow"], ["yes", "shadow"]]) assert.equal(modeOf(raw), want, String(raw));
});
test("shadow, the real path: a dialed row serving the Genoa document is captured over the relay's own TLS connection, judged against our releases' verified provenance, and annotated `rejected` on the measurement; eligibility is untouched; tunnel and relay rows are never touched", async () => {
  const ca = mintLocalCa(); const logs = [];
  const enclave = await serveTls(ca, (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(rad)); });
  try {
    const R = createReverifier({ mode: "shadow", bundle, expectationsFor: ours, log: (m) => logs.push(m), now: () => new Date(NOW),
                                 verify: (o) => consumer.verifyHost({ ...o, tls: { ca: ca.caPem }, reference: false, now: NOW }) });
    const rows = [row(`https://localhost:${enclave.port}`), { endpoint: "wss://box", tunnel: true, mode: "snp" }, row("https://relay.example", { relay: true })];
    const done = await R.run(rows);
    assert.deepEqual([...done.keys()], [`https://localhost:${enclave.port}`], "only the dialed, non-relay row was re-verified");
    const v = R.verdictOf(`https://localhost:${enclave.port}`);
    assert.equal(v.status, "rejected"); assert.deepEqual(v.failedChecks, ["measurement"]); assert.deepEqual(v.expected, ["v0.5.841", "v0.5.841-cpu"]); assert.equal(v.release, null); assert.match(v.measurement, /^[0-9a-f]{96}$/);
    assert.equal(v.at, new Date(NOW).toISOString()); assert.ok(v.reasons.length <= 3);
    assert.equal(R.annotate(rows[0]).reverify.status, "rejected"); assert.equal("reverify" in R.annotate(rows[1]), false); assert.equal("reverify" in R.annotate(rows[2]), false);
    assert.equal(R.eligible(rows[0], true), true, "shadow never changes eligibility"); assert.equal(R.eligible(rows[0], false), false); assert.equal(R.ineligibleReason(rows[0]), null);
    assert.match(logs.join("\n"), /localhost: rejected \(measurement\)/);
    const s = R.stats(); assert.equal(s.rows, 1); assert.equal(s.other, 1); assert.equal(s.verified, 0); assert.deepEqual(s.expectations.allowed, ["v0.5.841", "v0.5.841-cpu"]);
  } finally { await enclave.close(); ca.cleanup(); }
});
test("enforce: a dialed row is eligible only on a `verified` re-verification; rejected, unsupported, unavailable and pending rows are out, with the reason; tunnel rows keep the base rule", async () => {
  const verdicts = { "https://a": { status: "verified", matched: "v0.5.841-cpu", measurement: "aa".repeat(48), failedChecks: [], omissions: [], expected: ["v0.5.841-cpu"], reasons: ["ok"] },
                     "https://b": { status: "rejected", matched: null, measurement: "bb".repeat(48), failedChecks: ["measurement"], omissions: [], expected: ["v0.5.841-cpu"], reasons: ["no"] },
                     "https://c": { status: "unsupported", matched: null, measurement: null, failedChecks: [], omissions: [], expected: [], reasons: ["UNSUPPORTED: tdx"] },
                     "https://d": { status: "limited", matched: "v0.5.841-cpu", measurement: "aa".repeat(48), failedChecks: [], omissions: ["tcb-floor-unjudged"], expected: [], reasons: ["limited"] } };
  const R = createReverifier({ mode: "enforce", bundle, expectationsFor: ours, now: () => new Date(NOW),
                               verify: async ({ host }) => { const v = verdicts[`https://${host}`]; if (!v) throw new Error("connect ECONNREFUSED"); return { enclave: { ...v, at: NOW } }; } });
  const rows = ["a", "b", "c", "d", "e"].map((h) => row(`https://${h}`));
  const tunnel = { endpoint: "wss://t", tunnel: true, mode: "snp" };
  assert.equal(R.eligible(rows[0], true), false, "before any run a row is pending, and pending is not verified"); assert.match(R.ineligibleReason(rows[0]), /pending/);
  await R.run([...rows, tunnel]);
  assert.equal(R.eligible(rows[0], true), true); assert.equal(R.ineligibleReason(rows[0]), null);
  assert.equal(R.eligible(rows[0], false), false, "verified re-verification never promotes a row the base rule refuses");
  assert.equal(R.eligible(rows[1], true), false); assert.match(R.ineligibleReason(rows[1]), /rejected: measurement/);
  assert.equal(R.eligible(rows[2], true), false); assert.match(R.ineligibleReason(rows[2]), /unsupported/);
  assert.equal(R.eligible(rows[3], true), false, "limited is not verified"); assert.match(R.ineligibleReason(rows[3]), /limited/);
  assert.equal(R.eligible(rows[4], true), false); assert.equal(R.verdictOf("https://e").status, "unavailable"); assert.match(R.verdictOf("https://e").reasons[0], /ECONNREFUSED/);
  assert.equal(R.eligible(tunnel, true), true); assert.equal(R.eligible(tunnel, false), false); assert.equal(R.ineligibleReason(tunnel), null);
  const s = R.stats(); assert.equal(s.verified, 1); assert.equal(s.other, 4);
});
test("off: nothing runs, rows carry no annotation, eligibility is the base rule", async () => {
  const R = createReverifier({ mode: "off", bundle, expectationsFor: ours, verify: async () => { throw new Error("must not be called"); } });
  const r = row("https://a"); const done = await R.run([r]);
  assert.equal(done.size, 0); assert.equal("reverify" in R.annotate(r), false); assert.equal(R.eligible(r, true), true); assert.equal(R.eligible(r, false), false); assert.equal(R.stats().runs, 0);
});
test("no verified provenance: every row is judged with no expected measurement (rejected, the reason on the row), never verified; a later good refresh replaces the empty set", async () => {
  let good = false;
  const R = createReverifier({ mode: "shadow", bundle, expectationsTtlMs: 0, now: () => new Date(NOW),
                               expectationsFor: async () => good ? ours() : consumer.releaseExpectationsFrom([{ tag: "v0.5.841", error: "HTTP 503" }]),
                               verify: async ({ expectations }) => ({ enclave: { status: expectations.ok ? "rejected" : "rejected", at: NOW, matched: null, measurement: "cc".repeat(48), failedChecks: ["measurement"], omissions: [], expected: expectations.allowed.map((a) => a.tag), reasons: ["measurement"] } }) });
  const r = row("https://a");
  await R.run([r]); let v = R.verdictOf("https://a");
  assert.equal(v.status, "rejected"); assert.deepEqual(v.expected, []); assert.match(v.reasons.at(-1), /no release's provenance verified/); assert.equal(R.stats().expectations.ok, false);
  good = true; await R.run([r]); v = R.verdictOf("https://a");
  assert.deepEqual(v.expected, ["v0.5.841", "v0.5.841-cpu"]); assert.equal(R.stats().expectations.ok, true);
});
test("the vendored bundle is what the relay loads by default, and it carries the exports the reverifier uses", async () => {
  const B = await import(new URL("../relay/vendor/enclave-verifier-node.mjs", import.meta.url).href);
  for (const n of ["verifyHost", "releaseExpectations", "httpCollateral", "cachedCollateral"]) assert.equal(typeof B[n], "function", n);
  const R = createReverifier({ mode: "shadow", expectationsFor: ours, now: () => new Date(NOW), verify: async () => ({ enclave: { status: "rejected", at: NOW, failedChecks: ["measurement"], omissions: [], expected: [], reasons: [] } }) });
  await R.run([row("https://a")]); assert.equal(R.verdictOf("https://a").status, "rejected");
});

test("the mirror serves the verified index bytes, their attestation and the release attestations, with the relay's freshness state; a client verifies all of it against ITS pinned root and orders it with ITS memory; altered bytes fail that client's check (the mirror is not an authority); before a refresh, or with the index refused, no bytes are served", async () => {
  const FX = (tag) => path.join(REPO, "test", "fixtures", "verifier", "release-index", tag);
  const indexBytes = fs.readFileSync(path.join(FX("v0.5.848"), "release-index.json")), indexBundle = JSON.parse(fs.readFileSync(path.join(FX("v0.5.848"), "attestation.json"), "utf8")).attestations[0].bundle;
  const expectationsFor = async ({ indexMemory, keepArtifacts }) => {
    // what a real refresh yields: the fixture index verified, the memory consulted, the artifacts kept (the releases' bundles here are the v0.5.841 fixtures: real bundles, other tags)
    const v = await verifyReleaseIndex({ indexBytes, bundle: indexBundle, trustedRoot: consumer.TRUSTED_ROOT });
    const m = indexMemory ? indexMemory.consider({ publication: v.publication, digest: v.digest, minimumRelease: v.minimumRelease, tag: v.claims.tag }) : null;
    const rel = await consumer.releaseExpectationsFrom([candidate("v0.5.841"), candidate("v0.5.841-cpu")], { keepArtifacts });
    return { ...rel, index: { status: m && !m.ok ? "refused" : "verified", authenticity: "signed", freshness: m ? m.kind : "not-remembered", publication: v.publication, sequenceAuthenticated: v.sequenceAuthenticated, signedTag: v.claims.tag, floorApplied: "v0.5.841", reasons: m && !m.ok ? [m.why] : [] },
             ...(keepArtifacts ? { artifacts: { index: m && !m.ok ? null : { bytes: indexBytes.toString("base64"), sha256: v.digest, bundle: indexBundle }, releases: rel.artifacts.releases } } : {}) };
  };
  const R = createReverifier({ mode: "shadow", bundle, expectationsFor, now: () => new Date(NOW), verify: async () => ({ enclave: { status: "rejected", at: NOW, failedChecks: ["measurement"], omissions: [], expected: [], reasons: [] } }) });
  assert.equal(R.mirror().status, "not-yet");
  await R.run([row("https://a")]);
  const m = R.mirror();
  assert.equal(m.status, "verified"); assert.equal(m.authenticity, "signed"); assert.equal(m.freshness, "not-remembered"); assert.deepEqual(m.publication, { runId: 36089632273, attempt: 1, uri: "https://github.com/EnclaveHost/enclave/actions/runs/36089632273/attempts/1" });
  assert.equal(m.indexSha256, "9ef3346a0b2ec50d15fdba2521e1713914326bf23c860c336a1c474e1567ed5e"); assert.equal(m.index.schema, "enclave-release-index/v2"); assert.match(m.note, /not a verdict/);
  // the CLIENT's verification of what was served: the index against its own pinned root and its own memory, each release against the same root
  const served = Buffer.from(m.indexBytes, "base64");
  const v = await verifyReleaseIndex({ indexBytes: served, bundle: m.attestation.bundle, trustedRoot: consumer.TRUSTED_ROOT }); assert.equal(v.ok, true); assert.equal(v.sequenceAuthenticated, true);
  const mem = createIndexMemory(); assert.equal(mem.consider({ publication: v.publication, digest: v.digest, minimumRelease: v.minimumRelease }).kind, "first-seen");
  assert.equal(m.releases.length, 2);
  for (const r of m.releases) { const a = await verifyReleaseAttestation({ bundle: r.attestation.bundle, digestHex: r.digest, trustedRoot: consumer.TRUSTED_ROOT }); assert.equal(a.ok, true, `${r.tag}: ${a.reasons.at(-1)}`); assert.equal(a.claims.tag, r.tag); }
  // altered bytes on the wire: the client's check fails, whatever the relay said
  const altered = Buffer.from(served); altered[altered.length - 2] ^= 0x01;
  const bad = await verifyReleaseIndex({ indexBytes: altered, bundle: m.attestation.bundle, trustedRoot: consumer.TRUSTED_ROOT }); assert.equal(bad.ok, false); assert.equal(bad.signed, false);
  const other = m.releases[0]; const swapped = await verifyReleaseAttestation({ bundle: other.attestation.bundle, digestHex: m.releases[1].digest, trustedRoot: consumer.TRUSTED_ROOT }); assert.equal(swapped.ok, false, "a bundle served for another release's digest is refused by the client");
  // the relay's own memory keeps a replay out of the mirror: a memory that saw a newer publication refuses this index, and the mirror serves the status, no bytes
  const newer = createIndexMemory(); newer.consider({ publication: { runId: 36089632273 + 5, attempt: 1 }, digest: "aa".repeat(32), minimumRelease: [0, 5, 841] });
  const R2 = createReverifier({ mode: "shadow", bundle: { ...bundle, createIndexMemory: () => newer }, indexMemoryFile: "/dev/null/never", expectationsFor, now: () => new Date(NOW), verify: async () => ({ enclave: { status: "rejected", at: NOW, failedChecks: ["measurement"], omissions: [], expected: [], reasons: [] } }) });
  await R2.run([row("https://a")]);
  const m2 = R2.mirror(); assert.equal(m2.status, "refused"); assert.equal(m2.freshness, "replay"); assert.equal(m2.indexBytes, undefined); assert.equal(m2.attestation, undefined); assert.match(m2.reasons[0], /replay/);
  assert.equal(createReverifier({ mode: "off" }).mirror().status, "off");
});
