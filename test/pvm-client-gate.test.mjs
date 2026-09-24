// shielded/anchor/avf/client/src/gate.js held to the Enclave verifier session's admission rule, case by case
// (test/fixtures/verifier-admission/admission-vectors.json, from research/independent-verifier 68250600: 49 cases, with the
// v3 instance-binding cases). This client serves android-avf pVM apps only: on every case it must reach the vectors'
// decision (and the vectors' pinned output on release), and on every pVM case their exact reason too; the vectors' AMD
// SEV-SNP releases are outside its scope and it must HOLD them (fail closed), never release.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { admit, verdictOf } from "../shielded/anchor/avf/client/src/gate.js";

const V = JSON.parse(fs.readFileSync(new URL("./fixtures/verifier-admission/admission-vectors.json", import.meta.url), "utf8"));

test("the release rule matches the verifier session's admission vectors on every pVM and technology-neutral case", async () => {
  let same = 0, snpHeld = 0;
  for (const c of V.cases) {
    const got = await admit(c.verdict, c.expect, { clientKind: c.clientKind, observedPeerSpki: c.observedPeerSpki, usedNonces: c.usedNonces });
    const tech = c.verdict && typeof c.verdict === "object" ? c.verdict.claims?.technology : null;
    if (tech === "amd-sev-snp" && c.decision === "release") {
      assert.equal(got.decision, "hold", `${c.name}: an SNP release is out of this client's scope and must hold`);
      snpHeld++; continue;
    }
    assert.equal(got.decision, c.decision, `${c.name}: ${got.reason} vs ${c.reason}`);
    if (tech === "android-avf") assert.equal(got.reason, c.reason, `${c.name}: the pVM rule's own reason`);
    if (c.decision === "release") assert.deepEqual(got.pinned, c.pinned, `${c.name}: pinned output`);
    same++;
  }
  assert.equal(same + snpHeld, V.cases.length);
  assert.equal(snpHeld, 3, "exactly the three SNP releases are held for scope");
  assert.ok(V.cases.length === 49 && same === 46);
  assert.ok(V.cases.filter((c) => /pVM v3|deployment is bound/.test(c.name)).length >= 9, "the instance-binding cases are in the vectors");
});

test("the client's own verdict for a verified envelope passes through the same rule", async () => {
  const nonce = "22".repeat(32), app = "a2".repeat(32), rid = "f0".repeat(32), spki = "302a300506032b6570032100" + "6c".repeat(32);
  const v = { ok: true, freshness: "client-nonce", appId: app, runtimeId: rid, transportSpki: spki, appKey: "1c".repeat(32), sealedWindowSeconds: 600, sealedMaxRequests: 256 };
  const env = { format: "enclave-pvm-app-evidence/v2", nonce };
  const expect = { nonce, appId: app, allowedRuntimeIds: [rid], allowedCodeHashes: ["7f".repeat(32)], allowedAuthorityHashes: ["8c".repeat(64)], rootPins: ["d8".repeat(32)] };
  const r = await admit(await verdictOf(v, env, nonce), expect, { clientKind: "browser" });
  assert.equal(r.decision, "release", r.reason); assert.deepEqual(r.pinned, { appKey: "1c".repeat(32), sealed: { windowSeconds: 600, maxRequests: 256 } });
  assert.equal((await admit(await verdictOf({ ...v, ok: false }, env, nonce), expect, { clientKind: "browser" })).decision, "hold");
  assert.equal((await admit(await verdictOf(v, env, nonce), expect, { clientKind: "browser", usedNonces: [nonce] })).decision, "hold");
  assert.equal((await admit(await verdictOf({ ...v, appKey: null }, { ...env, format: "enclave-pvm-app-evidence/v1" }, nonce), expect, { clientKind: "browser" })).decision, "hold");
});
