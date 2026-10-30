import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sha256Hex } from "./derive.mjs";
import { deriveDesktop } from "./desktop-derive.mjs";
import { validateDesktopPlatform, validateDesktopMapping, hashTreeBytes, MAX_ROOT_BLOCKS, MAX_MODEL_BLOCKS,
  MAX_TOTAL_PAYLOAD_BYTES, PLATFORM_KEYS } from "./desktop-platform.mjs";

// Context copies; the parent may repoint these into the repository.
const FIXTURES = new URL("./testdata/desktop-platform/", import.meta.url);
const fixture = (name) => readFileSync(new URL(name, FIXTURES), "utf8");
const REAL_PROFILE_TEXT = fixture("profile.json");
const CANDIDATE = JSON.parse(fixture("candidate.json"));
const VECTORS = JSON.parse(readFileSync(new URL("../../../isolation/contract/catalog/desktop_vectors.json", import.meta.url), "utf8"));
const COMPONENT = Buffer.from(VECTORS.component_hex, "hex");
const CONTROLLER = sha256Hex(COMPONENT);
const OFFSET = 65536;
const PLATFORM_ERR = /^Error: desktop platform: /;

const text = (p) => JSON.stringify(p) + "\n";
const shaText = (t) => sha256Hex(Buffer.from(t, "utf8"));
// The real profile with its controller repinned to the vector component.
function syntheticProfile() { const p = JSON.parse(REAL_PROFILE_TEXT); p.controllerSha256 = CONTROLLER; return p; }
const SYN = syntheticProfile();
const SYN_TEXT = text(SYN);

function mediaFor(p) {
  const m = (role, payloadBytes, payloadSha256, sha256) => ({ role, path: `C:\\enclave\\${role}.iso`, sha256,
    bytes: payloadBytes + OFFSET, payloadBytes, payloadSha256, payloadOffset: OFFSET });
  return [m("root", p.root.imageBytes, p.root.imageSha256, "a".repeat(64)),
    m("hashes", p.root.hashBytes, p.root.hashSha256, "b".repeat(64)),
    m("models", p.models.imageBytes, p.models.imageSha256, "c".repeat(64))];
}
function configFor(profileText, p = SYN) {
  return { igvmSha256: CANDIDATE.files.igvm.sha256, runtimeId: CANDIDATE.runtimeId, profileText,
    profileSha256: shaText(profileText), media: mediaFor(p) };
}

test("the real profile parses with its canonical hash and verity geometry", () => {
  const f = CANDIDATE.files;
  const pick = (role, e) => ({ role, path: `C:\\enclave\\${e.file}`, sha256: e.sha256, bytes: e.bytes,
    payloadBytes: e.payloadBytes, payloadSha256: e.payloadSha256, payloadOffset: e.payloadOffset });
  const platform = validateDesktopPlatform({ igvmSha256: f.igvm.sha256, runtimeId: CANDIDATE.runtimeId,
    profileText: REAL_PROFILE_TEXT, profileSha256: shaText(REAL_PROFILE_TEXT),
    media: [pick("root", f["root.iso"]), pick("hashes", f["hashes.iso"]), pick("models", f["models.iso"])] });
  assert.equal(platform.controllerSha256, JSON.parse(REAL_PROFILE_TEXT).controllerSha256);
  assert.equal(text(platform.profile), REAL_PROFILE_TEXT);
  assert.equal(hashTreeBytes(137918), 4456448);
  assert.equal(hashTreeBytes(621588), 20054016);
  assert.equal(platform.profile.root.imageBytes, 137918 * 4096);
  assert.equal(platform.profile.models.imageBytes, 621589 * 4096 + 20054016);
  assert.deepEqual(Object.keys(platform), [...PLATFORM_KEYS]);
  assert.ok(Object.isFrozen(platform) && Object.isFrozen(platform.profile.root) && Object.isFrozen(platform.media[2]));
});

test("the candidate pins the sha256 of the real profile text", () => {
  assert.equal(shaText(REAL_PROFILE_TEXT), CANDIDATE.profileSha256);
});

test("noncanonical or malformed profile text is refused even with a matching hash", () => {
  const t = SYN_TEXT;
  const cases = {
    duplicate: t.replace('{"controllerSha256"', `{"schema":"${SYN.schema}","controllerSha256"`),
    duplicateLastWins: t.replace('"schema":', '"schema":"x","schema":'),
    unknown: t.replace('"schema":', '"extra":1,"schema":'),
    unknownNested: t.replace('"release":', '"extra":1,"release":'),
    missing: text({ ...SYN, schema: undefined }),
    reordered: text({ schema: SYN.schema, ...SYN }),
    floatSpelling: t.replace('"dataBlocks":137918', '"dataBlocks":137918.0'),
    exponentSpelling: t.replace('"dataBlocks":137918', '"dataBlocks":1.37918e5'),
    roundsToSafe: t.replace('"dataBlocks":137918', '"dataBlocks":137918.0000000000001'),
    unsafeInteger: t.replace('"dataBlocks":137918', '"dataBlocks":9007199254740993'),
    negative: t.replace('"dataBlocks":137918', '"dataBlocks":-137918'),
    stringNumber: t.replace('"dataBlocks":137918', '"dataBlocks":"137918"'),
    escapedString: t.replace('"profile":"kvm-box-masked-v1"', '"profile":"kvm-box-masked-v\\u0031"'),
    nullObject: t.replace(/"kernel":\{[^}]*\}/, '"kernel":null'),
    noNewline: t.slice(0, -1),
    twoNewlines: t + "\n",
    crlf: t.slice(0, -1) + "\r\n",
    leadingSpace: " " + t,
    pretty: JSON.stringify(SYN, null, 2) + "\n",
    trailingJson: t + "{}\n",
    trailingBeforeLF: t.slice(0, -1) + "{}\n",
    bom: "\ufeff" + t,
    notJson: "{\n",
    empty: "",
    oversize: t.slice(0, -1) + " ".repeat(16384) + "\n",
  };
  for (const [name, bad] of Object.entries(cases)) {
    assert.notEqual(bad, t, name);
    assert.throws(() => validateDesktopPlatform(configFor(bad)), PLATFORM_ERR, name);
  }
  assert.throws(() => validateDesktopPlatform({ ...configFor(t), profileText: Buffer.from(t) }), /profileText must be a string/);
});

test("canonical profiles outside profile.go Validate are refused", () => {
  const variants = {
    schema: (p) => { p.schema = "enclave-native-desktop-profile/2"; },
    profile: (p) => { p.profile = "kvm-box-open-v1"; },
    release: (p) => { p.kernel.release = "6.6.87.2"; },
    upperHash: (p) => { p.kernel.elfSha256 = p.kernel.elfSha256.toUpperCase(); },
    zeroHash: (p) => { p.root.salt = "0".repeat(64); },
    shortHash: (p) => { p.models.rootHash = p.models.rootHash.slice(1); },
    rootImage: (p) => { p.root.imageBytes += 4096; },
    rootHashBytes: (p) => { p.root.hashBytes -= 4096; },
    rootOneBlock: (p) => { p.root.dataBlocks = 1; p.root.imageBytes = 4096; p.root.hashBytes = 0; },
    rootOverLimit: (p) => { const d = MAX_ROOT_BLOCKS + 1; p.root.dataBlocks = d; p.root.imageBytes = d * 4096; p.root.hashBytes = hashTreeBytes(d); },
    modelStart: (p) => { p.models.hashStartBlock += 1; p.models.imageBytes += 4096; },
    modelImage: (p) => { p.models.imageBytes -= 4096; },
    modelOverLimit: (p) => { const d = MAX_MODEL_BLOCKS + 1; p.models.dataBlocks = d; p.models.hashStartBlock = d + 1;
      p.models.imageBytes = (d + 1) * 4096 + hashTreeBytes(d); },
  };
  for (const [name, edit] of Object.entries(variants)) {
    const p = syntheticProfile();
    edit(p);
    assert.throws(() => validateDesktopPlatform(configFor(text(p), p)),
      /desktop platform: (unsupported desktop profile|invalid desktop digest|invalid (root|model) geometry)/, name);
  }
});

test("root at exactly 8 GiB is accepted", () => {
  const p = syntheticProfile();
  const d = MAX_ROOT_BLOCKS;
  p.root.dataBlocks = d; p.root.imageBytes = d * 4096; p.root.hashBytes = hashTreeBytes(d);
  assert.equal(validateDesktopPlatform(configFor(text(p), p)).profile.root.imageBytes, 8 * 1024 ** 3);
});

test("total media payload is bounded at 128 GiB", () => {
  const image = (d) => (d + 1) * 4096 + hashTreeBytes(d);
  let lo = 2, hi = MAX_MODEL_BLOCKS; // largest models volume whose ISO still fits one medium
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (image(mid) + OFFSET <= MAX_TOTAL_PAYLOAD_BYTES) lo = mid; else hi = mid - 1; }
  const p = syntheticProfile();
  p.models.dataBlocks = lo; p.models.hashStartBlock = lo + 1; p.models.imageBytes = image(lo);
  assert.throws(() => validateDesktopPlatform(configFor(text(p), p)), /desktop platform: total media payload/);
});

test("profileSha256 must hash the exact profile text", () => {
  const c = configFor(SYN_TEXT);
  assert.equal(validateDesktopPlatform(c).profileSha256, shaText(SYN_TEXT));
  for (const sha of [shaText(SYN_TEXT.slice(0, -1)), shaText(REAL_PROFILE_TEXT), "f".repeat(64)])
    assert.throws(() => validateDesktopPlatform({ ...c, profileSha256: sha }), /profileSha256 is not the sha256/);
});

test("platform config has exactly its fields and nonzero lowercase pins", () => {
  const c = configFor(SYN_TEXT);
  const { media, ...noMedia } = c;
  for (const bad of [{ ...c, extra: 1 }, noMedia, { ...c, igvmSha256: "0".repeat(64) },
    { ...c, runtimeId: c.runtimeId.toUpperCase() }, { ...c, profileSha256: "0".repeat(64) }, Object.assign(Object.create({ x: 1 }), c)])
    assert.throws(() => validateDesktopPlatform(bad), PLATFORM_ERR);
  assert.ok(media);
});

test("media that differ from the profile are refused", () => {
  const cases = {
    rootSha: (m) => { m[0].payloadSha256 = "d".repeat(64); },
    rootBytes: (m) => { m[0].payloadBytes += 4096; m[0].bytes += 4096; },
    hashesBytes: (m) => { m[1].payloadBytes += 4096; m[1].bytes += 4096; },
    hashesSha: (m) => { m[1].payloadSha256 = m[0].payloadSha256; },
    modelsSha: (m) => { m[2].payloadSha256 = m[0].payloadSha256; },
    swapped: (m) => { [m[0], m[1]] = [m[1], m[0]]; },
    missing: (m) => { m.pop(); },
  };
  for (const [name, edit] of Object.entries(cases)) {
    const c = configFor(SYN_TEXT);
    edit(c.media);
    assert.throws(() => validateDesktopPlatform(c), /desktop (platform|media): /, name);
  }
});

test("the platform is an owned, deeply frozen copy", () => {
  const c = configFor(SYN_TEXT);
  const pl = validateDesktopPlatform(c);
  c.media[0].path = "C:\\other\\root.iso";
  c.runtimeId = "e".repeat(64);
  assert.equal(pl.media[0].path, "C:\\enclave\\root.iso");
  assert.equal(pl.runtimeId, CANDIDATE.runtimeId);
  assert.notEqual(pl.media, c.media);
  assert.throws(() => { pl.profile.root.dataBlocks = 3; }, TypeError);
  assert.throws(() => { pl.media[1].sha256 = "1".repeat(64); }, TypeError);
});

// ---- mappings ----

const PLATFORM = validateDesktopPlatform(configFor(SYN_TEXT));
const PUBLIC_CONFIG = { codec: "h264", display: { height: 1080, width: 1920 }, egress: "public-web", input: "masked" };
const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v), "utf8").toString("base64");
function recordFor(edit = () => {}) {
  const r = structuredClone(VECTORS.ok[0].record);
  r.runtimeId = PLATFORM.runtimeId;
  r.desktop.profileSha256 = PLATFORM.profileSha256;
  r.configBase64 = b64(PUBLIC_CONFIG);
  edit(r);
  return r;
}
const mappingFor = (edit, component = COMPONENT) => deriveDesktop({ record: recordFor(edit), component });

test("the vector component reproduces the baseline vector", () => {
  const v = VECTORS.ok[0];
  assert.equal(v.name, "baseline");
  assert.equal(deriveDesktop({ record: v.record, component: COMPONENT }).appId, v.mapping.appId);
  // That vector has another runtime/profile and no egress; it does not fit this platform.
  assert.throws(() => validateDesktopMapping(deriveDesktop({ record: v.record, component: COMPONENT }), PLATFORM), PLATFORM_ERR);
});

test("a rederived mapping is returned as an owned copy", () => {
  const input = mappingFor();
  const before = Buffer.from(input.bundle);
  const out = validateDesktopMapping(input, PLATFORM);
  assert.deepEqual(Object.keys(out), Object.keys(input));
  for (const k of ["recordSha256", "componentSha256", "componentBytes", "appId", "bundleBytes"]) assert.equal(out[k], input[k]);
  assert.deepEqual(out.record, input.record);
  assert.ok(out.bundle.equals(before));
  assert.notEqual(out.record, input.record);
  assert.notEqual(out.bundle, input.bundle);
  assert.notEqual(out.bundle.buffer, input.bundle.buffer);
  assert.equal(out.bundle.buffer.byteLength, out.bundle.length);
  assert.ok(Object.isFrozen(out.record) && Object.isFrozen(out.record.policy) && Object.isFrozen(out.record.ports));
  input.record.policy.memMiB = 8192;
  input.bundle.fill(0);
  assert.equal(out.record.policy.memMiB, 16384);
  assert.ok(out.bundle.equals(before));
  out.bundle.fill(1);
  assert.ok(input.bundle.every((b) => b === 0));
});

test("tampered mapping metadata is refused", () => {
  const m0 = mappingFor();
  const cases = [["appId", "1".repeat(64)], ["appId", m0.appId.toUpperCase()], ["recordSha256", "1".repeat(64)],
    ["componentSha256", "1".repeat(64)], ["componentBytes", m0.componentBytes + 1], ["bundleBytes", String(m0.bundleBytes)],
    ["bundleBytes", m0.bundleBytes - 1]];
  for (const [k, v] of cases)
    assert.throws(() => validateDesktopMapping({ ...mappingFor(), [k]: v }, PLATFORM), /desktop platform: mapping\./, k);
});

test("a tampered record is refused", () => {
  const edits = {
    policy: [(r) => { r.policy.memMiB = 32768; }, /mapping\.bundle is not the derivation/],
    catalog: [(r) => { r.catalog.version = 2; }, /mapping\.recordSha256/],
    cid: [(r) => { r.cid = "Qm" + "z".repeat(44); }, /mapping\.recordSha256/],
    noSecret: [(r) => { delete r.secretDeployment; }, /declared fields/],
    zeroSecret: [(r) => { r.secretDeployment = "0x" + "0".repeat(64); }, /sealed-secret/],
  };
  for (const [name, [edit, re]] of Object.entries(edits)) {
    const m = mappingFor();
    edit(m.record);
    assert.throws(() => validateDesktopMapping(m, PLATFORM), re, name);
  }
});

test("a tampered bundle is refused", () => {
  const m = mappingFor();
  const manifest = Buffer.from(m.bundle);
  const at = manifest.indexOf('"memMiB":16384');
  assert.ok(at > 0);
  manifest[at + 9] = "3".charCodeAt(0);
  const artifact = Buffer.from(m.bundle);
  artifact[artifact.length - 1] ^= 1;
  for (const bundle of [manifest, artifact])
    assert.throws(() => validateDesktopMapping({ ...m, bundle }, PLATFORM), /mapping\.bundle is not the derivation/);
});

test("extra, truncated or malformed bundle framing is refused", () => {
  const m = mappingFor();
  const magic = 17;
  const edit = (f) => { const b = Buffer.from(m.bundle); f(b); return b; };
  const artifactLengthAt = magic + 4 + m.bundle.readUInt32LE(magic);
  const cases = {
    trailing: Buffer.concat([m.bundle, Buffer.from([0])]),
    truncated: m.bundle.subarray(0, m.bundle.length - 1),
    truncatedManifest: m.bundle.subarray(0, 40),
    magicOnly: m.bundle.subarray(0, magic),
    empty: Buffer.alloc(0),
    badMagic: edit((b) => { b[0] ^= 1; }),
    hugeManifestLength: edit((b) => b.writeUInt32LE(0xffffffff, magic)),
    zeroManifestLength: edit((b) => b.writeUInt32LE(0, magic)),
    hugeArtifactLength: edit((b) => b.writeUInt32LE(0xffffffff, artifactLengthAt)),
    shortArtifactLength: edit((b) => b.writeUInt32LE(m.componentBytes - 1, artifactLengthAt)),
    uint8: new Uint8Array(m.bundle),
    oversize: Buffer.alloc((64 << 20) + (64 << 10) + 26),
  };
  for (const [name, bundle] of Object.entries(cases))
    assert.throws(() => validateDesktopMapping({ ...m, bundle, bundleBytes: bundle.length }, PLATFORM), /desktop platform: mapping\.bundle/, name);
});

test("wrong controller, runtime or profile is refused", () => {
  const other = Buffer.concat([COMPONENT, Buffer.from("x")]);
  assert.throws(() => validateDesktopMapping(mappingFor(undefined, other), PLATFORM), /profile's controller/);
  assert.throws(() => validateDesktopMapping(mappingFor((r) => { r.runtimeId = "9".repeat(64); }), PLATFORM), /runtimeId/);
  assert.throws(() => validateDesktopMapping(mappingFor((r) => { r.desktop.profileSha256 = "8".repeat(64); }), PLATFORM), /profileSha256/);
});

test("top-level egress must be exactly public-web", () => {
  const { egress, ...noEgress } = PUBLIC_CONFIG;
  assert.equal(egress, "public-web");
  for (const cfg of [noEgress, { ...PUBLIC_CONFIG, egress: "none" }, { ...PUBLIC_CONFIG, egress: ["public-web"] },
    { ...noEgress, Egress: "public-web" },
    { ...noEgress, display: { egress: "public-web" } }])
    assert.throws(() => validateDesktopMapping(mappingFor((r) => { r.configBase64 = b64(cfg); }), PLATFORM), /egress/);
});

test("CPU percent must fit the vCPUs", () => {
  assert.ok(validateDesktopMapping(mappingFor((r) => { r.policy.cpuPercent = 800; r.policy.vcpus = 8; }), PLATFORM));
  assert.throws(() => validateDesktopMapping(mappingFor((r) => { r.policy.cpuPercent = 900; r.policy.vcpus = 8; }), PLATFORM), /cpuPercent/);
});

test("mapping and platform shapes are exact", () => {
  const m = mappingFor();
  const { appId, ...noAppId } = m;
  assert.ok(appId);
  for (const bad of [{ ...m, extra: 1 }, noAppId, null, [m]])
    assert.throws(() => validateDesktopMapping(bad, PLATFORM), PLATFORM_ERR);
  const { profile, ...noProfile } = PLATFORM;
  assert.ok(profile);
  for (const bad of [noProfile, { ...PLATFORM, controllerSha256: "1".repeat(64) }, { ...PLATFORM, profileSha256: "1".repeat(64) },
    { ...PLATFORM, runtimeId: "0".repeat(64) }])
    assert.throws(() => validateDesktopMapping(m, bad), PLATFORM_ERR);
  assert.ok(validateDesktopMapping(m, { ...PLATFORM }));
});


test("egress lookup matches the guest's exact map key, without interpreting unrelated keys", () => {
  for (const cfg of [{...PUBLIC_CONFIG, EGRESS:"none"}, {...PUBLIC_CONFIG, "egreſs":"none"}])
    assert.equal(validateDesktopMapping(mappingFor(r=>{r.configBase64=b64(cfg);}),PLATFORM).record.configBase64,b64(cfg));
});
