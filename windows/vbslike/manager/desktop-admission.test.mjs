import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sha256Hex } from "./derive.mjs";
import { DESKTOP_PORTS } from "./desktop-derive.mjs";
import { validateDesktopPlatform } from "./desktop-platform.mjs";
import { validateDesktopAdmission, desktopSpawnRefusal, ADMISSION_KEYS } from "./desktop-admission.mjs";
import { runtimeId } from "../../../isolation/contract/runtime.mjs";

// Context copies; the parent may repoint these into the repository.
const FIXTURES = new URL("./testdata/desktop-platform/", import.meta.url);
const fixture = (name) => readFileSync(new URL(name, FIXTURES), "utf8");
const REAL_PROFILE_TEXT = fixture("profile.json");
const CANDIDATE = JSON.parse(fixture("candidate.json"));
const VECTORS = JSON.parse(readFileSync(new URL("../../../isolation/contract/catalog/desktop_vectors.json", import.meta.url), "utf8"));
const COMPONENT = Buffer.from(VECTORS.component_hex, "hex");
const OFFSET = 65536;
const ADMISSION_ERR = /^Error: desktop admission: /;
const PLATFORM_ERR = /^Error: desktop platform: /;

const text = (p) => JSON.stringify(p) + "\n";
const shaText = (t) => sha256Hex(Buffer.from(t, "utf8"));
const ridHex = (r) => runtimeId(r).toString("hex");

// A test runtime pin: the native x86_64 JIT profile, under a version no release uses.
const RUNTIME = Object.freeze({ name: "wasmtime", version: "0.0.0-desktop-admission-test", execution: "jit",
  targetIsa: "x86_64", hostIsa: "x86_64", cpuFeatures: "baseline", wx: "enforced", cache: "none" });
const RID = ridHex(RUNTIME);

// The real profile with its controller repinned to the vector component.
const SYN = (() => { const p = JSON.parse(REAL_PROFILE_TEXT); p.controllerSha256 = sha256Hex(COMPONENT); return p; })();
const SYN_TEXT = text(SYN);

function mediaFor(p) {
  const m = (role, payloadBytes, payloadSha256, sha256) => ({ role, path: `C:\\enclave\\${role}.iso`, sha256,
    bytes: payloadBytes + OFFSET, payloadBytes, payloadSha256, payloadOffset: OFFSET });
  return [m("root", p.root.imageBytes, p.root.imageSha256, "a".repeat(64)),
    m("hashes", p.root.hashBytes, p.root.hashSha256, "b".repeat(64)),
    m("models", p.models.imageBytes, p.models.imageSha256, "c".repeat(64))];
}
// The raw platform config, pinned to the test runtime. If the repository's PLATFORM_CONFIG_KEYS
// has a field beyond these, the parent adds it here.
function platformConfig(rid = RID) {
  return { igvmSha256: CANDIDATE.files.igvm.sha256, runtimeId: rid, profileText: SYN_TEXT,
    profileSha256: shaText(SYN_TEXT), media: mediaFor(SYN) };
}
const admissionFor = (runtime = { ...RUNTIME }, platform = platformConfig()) => ({ platform, runtime });

// ---- admission ----

test("the real profile, repinned to the test controller and runtime, is admitted", () => {
  assert.equal(SYN.profile, JSON.parse(REAL_PROFILE_TEXT).profile);
  const cfg = admissionFor();
  const a = validateDesktopAdmission(cfg);
  assert.deepEqual(Object.keys(a), [...ADMISSION_KEYS]);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.platform) && Object.isFrozen(a.runtime));
  assert.deepEqual(a.platform, validateDesktopPlatform(platformConfig()));
  assert.equal(a.platform.runtimeId, RID);
  assert.equal(a.platform.controllerSha256, sha256Hex(COMPONENT));
  assert.deepEqual(a.runtime, { ...RUNTIME });
  assert.notEqual(a.runtime, cfg.runtime);
  assert.throws(() => { a.runtime.version = "x"; }, TypeError);
});

test("admission config has exactly platform and runtime, as data", () => {
  const ok = admissionFor();
  const withGetter = { platform: ok.platform };
  Object.defineProperty(withGetter, "runtime", { enumerable: true, get: () => ({ ...RUNTIME }) });
  for (const bad of [null, [ok], "x", { ...ok, extra: 1 }, { platform: ok.platform }, { runtime: ok.runtime },
    Object.assign(Object.create({ platform: ok.platform }), { runtime: ok.runtime }), withGetter])
    assert.throws(() => validateDesktopAdmission(bad), ADMISSION_ERR);
});

test("unknown or missing platform config keys are refused by the platform validator", () => {
  const { media, ...noMedia } = platformConfig();
  assert.ok(media);
  for (const platform of [{ ...platformConfig(), extra: 1 }, noMedia, { ...platformConfig(), profileSha256: "1".repeat(64) }, null])
    assert.throws(() => validateDesktopAdmission(admissionFor(undefined, platform)), PLATFORM_ERR);
});

test("an inadmissible or non-plain runtime is refused", () => {
  const { cache, ...noCache } = RUNTIME;
  assert.ok(cache);
  for (const runtime of [{ ...RUNTIME, extra: "x" }, noCache, { ...RUNTIME, wx: "relaxed" }, { ...RUNTIME, cache: "disk" },
    { ...RUNTIME, version: 1 }, { ...RUNTIME, targetIsa: "aarch64" }, null, [RUNTIME], new Map(), Object.assign(new (class R {})(), RUNTIME)])
    assert.throws(() => validateDesktopAdmission(admissionFor(runtime)), ADMISSION_ERR);
});

test("a runtime whose hash is not the platform pin is refused", () => {
  assert.throws(() => validateDesktopAdmission(admissionFor({ ...RUNTIME, version: "0.0.1" })), /does not hash to the platform runtimeId/);
  assert.throws(() => validateDesktopAdmission(admissionFor(undefined, platformConfig(CANDIDATE.runtimeId))), /does not hash/);
  assert.throws(() => validateDesktopAdmission(admissionFor(undefined, platformConfig("9".repeat(64)))), /does not hash/);
});

test("admissible runtimes outside the native x86_64 JIT profile are refused even when pinned", () => {
  for (const runtime of [{ ...RUNTIME, hostIsa: "aarch64", targetIsa: "aarch64" }, { ...RUNTIME, execution: "interpreter", targetIsa: "pulley64" },
    { ...RUNTIME, hostIsa: "aarch64", execution: "interpreter", targetIsa: "pulley64" }])
    assert.throws(() => validateDesktopAdmission(admissionFor(runtime, platformConfig(ridHex(runtime)))),
      /requires hostIsa x86_64 and execution jit/);
});

test("the admission is isolated from later caller writes", () => {
  const cfg = admissionFor();
  const a = validateDesktopAdmission(cfg);
  cfg.runtime.version = "changed";
  cfg.platform.runtimeId = "e".repeat(64);
  cfg.platform.media[0].path = "C:\\other\\root.iso";
  assert.equal(a.runtime.version, RUNTIME.version);
  assert.equal(a.platform.runtimeId, RID);
  assert.equal(a.platform.media[0].path, "C:\\enclave\\root.iso");
});

// ---- spawn ----

const RECORD = VECTORS.ok[0].record;
const MILLI = RECORD.desktop.gpuMilli;
const bodyFor = (extra = {}) => ({ name: RECORD.secretDeployment, hasSecrets: true, isPublic: true,
  gpuMilli: MILLI, cpuShare: 0.5, ...extra });
const deepFreeze = (v) => { if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze(v[k]); Object.freeze(v); } return v; };

test("a matching spawn body is not refused, and neither input is mutated", () => {
  assert.equal(MILLI, 750);
  const record = deepFreeze(structuredClone(RECORD));
  const { gpuMilli, ...shareOnly } = bodyFor({ gpuShare: 0.75 });
  assert.ok(gpuMilli);
  for (const body of [bodyFor(), shareOnly, bodyFor({ gpuShare: 0.75 }), bodyFor({ gpuShare: 0.75 + 1e-11 }),
    bodyFor({ firewall: [...DESKTOP_PORTS] }), bodyFor({ firewall: undefined, config: undefined, bootstrap: undefined }),
    bodyFor({ cpuShare: 1 }), bodyFor({ env: { A: "1" } })]) {
    const before = structuredClone(body);
    assert.equal(desktopSpawnRefusal(record, deepFreeze(body)), null, JSON.stringify(body));
    assert.deepEqual(body, before);
  }
  assert.deepEqual(record, RECORD);
});

test("wrong deployment, secrets or public flags are refused", () => {
  const cases = {
    otherName: [{ name: "0x" + "4".repeat(64) }, /name/], upperName: [{ name: RECORD.secretDeployment.toUpperCase() }, /name/],
    noName: [{ name: undefined }, /name/],
    secretsFalse: [{ hasSecrets: false }, /hasSecrets/], secretsString: [{ hasSecrets: "true" }, /hasSecrets/],
    secretsMissing: [{ hasSecrets: undefined }, /hasSecrets/],
    publicFalse: [{ isPublic: false }, /isPublic/], publicOne: [{ isPublic: 1 }, /isPublic/],
  };
  for (const [name, [edit, re]] of Object.entries(cases)) assert.match(desktopSpawnRefusal(RECORD, bodyFor(edit)), re, name);
});

test("bootstrap, custody and alternate configuration inputs are refused whatever their value", () => {
  for (const k of ["bootstrap", "custody"])
    for (const v of [null, false, 0, "", {}, "x"])
      assert.match(desktopSpawnRefusal(RECORD, bodyFor({ [k]: v })), /may not carry/, `${k}=${JSON.stringify(v)}`);
  for (const k of ["config", "configCid", "appConfigCid"])
    for (const v of [null, false, "", {}, RECORD.configBase64, RECORD.cid])
      assert.match(desktopSpawnRefusal(RECORD, bodyFor({ [k]: v })), /configBase64/, `${k}=${JSON.stringify(v)}`);
});

test("missing, non-numeric or conflicting GPU shares are refused", () => {
  const cases = {
    neither: { gpuMilli: undefined },
    milliWrong: { gpuMilli: 751 }, milliString: { gpuMilli: "750" }, milliNull: { gpuMilli: null },
    milliNaN: { gpuMilli: NaN }, milliInf: { gpuMilli: Infinity }, milliFraction: { gpuMilli: 750.5 },
    shareString: { gpuShare: "0.75" }, shareNull: { gpuShare: null }, shareNaN: { gpuShare: NaN },
    shareZero: { gpuShare: 0 }, shareNegative: { gpuShare: -0.75 }, shareOver: { gpuShare: 1.5 },
    shareOff: { gpuShare: 0.7501 }, shareJustOff: { gpuShare: 0.75 + 1e-9 }, shareAsMilli: { gpuShare: 750 },
    conflict: { gpuShare: 0.5 }, conflictShareOnly: { gpuMilli: undefined, gpuShare: 0.5 },
  };
  for (const [name, edit] of Object.entries(cases)) assert.match(desktopSpawnRefusal(RECORD, bodyFor(edit)), /gpu/i, name);
  const full = structuredClone(RECORD);
  full.desktop.gpuMilli = 1000;
  assert.equal(desktopSpawnRefusal(full, bodyFor({ gpuMilli: 1000, gpuShare: 1 })), null);
});

test("cpuShare must be a finite number in (0, 1]", () => {
  for (const v of [undefined, null, 0, -0.5, 1.01, "0.5", NaN, Infinity, [0.5]])
    assert.match(desktopSpawnRefusal(RECORD, bodyFor({ cpuShare: v })), /cpuShare/, String(v));
});

test("firewall, when present, is exactly the record's ports in order", () => {
  const ports = [...RECORD.ports];
  const sparse = new Array(ports.length);
  for (const fw of [[], ports.slice(1), [...ports, "tcp:8000"], [...ports].reverse(), ports.join(","), null, sparse,
    ports.map((p) => p.toUpperCase()), { ...ports }])
    assert.match(desktopSpawnRefusal(RECORD, bodyFor({ firewall: fw })), /firewall/, JSON.stringify(fw));
});

test("a malformed record or body is refused with a reason, never thrown", () => {
  const edits = [(r) => { delete r.secretDeployment; }, (r) => { r.derivation = "enclave-catalog-bundle/7"; },
    (r) => { r.ports = r.ports.slice(1); }, (r) => { r.extra = 1; }, (r) => { r.desktop.gpuMilli = 499; },
    (r) => { r.secretDeployment = "0x" + "0".repeat(64); }];
  for (const edit of edits) {
    const r = structuredClone(RECORD);
    edit(r);
    const why = desktopSpawnRefusal(r, bodyFor());
    assert.equal(typeof why, "string");
    assert.ok(why.length > 0);
  }
  const throwing = { ...RECORD };
  Object.defineProperty(throwing, "cid", { enumerable: true, get() { throw new Error("getter ran"); } });
  for (const record of [null, undefined, [], "x", throwing])
    assert.equal(typeof desktopSpawnRefusal(record, bodyFor()), "string");
  for (const body of [null, undefined, [bodyFor()], "x", new Map(), { ...bodyFor(), fn: () => 1 }])
    assert.equal(typeof desktopSpawnRefusal(RECORD, body), "string");
});
