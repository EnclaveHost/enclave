import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appConfigText, sha256Hex } from "./shield-derive.mjs";
import { DESKTOP_PORTS, validateDesktopRecord, deriveDesktop } from "./shield-desktop-derive.mjs";
import * as helper from "./shield-desktop-release.mjs";

const { DESKTOP_RELEASE_SCHEMA, validateDesktopRelease, desktopRecordFor, deriveApprovedDesktop } = helper;
const vectors = JSON.parse(readFileSync(new URL("../isolation/contract/catalog/desktop_vectors.json", import.meta.url), "utf8"));
const component = Buffer.from(vectors.component_hex, "hex");
const baseline = vectors.ok.find(v => v.name === "baseline");
const RUNTIME = "22".repeat(32); // pinned runtime test hash from the vectors, not an identity object
const PROFILE = "44".repeat(32);
const CID0 = "Qm123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk";
const OTHER_CID = "Qm" + "a".repeat(44);
const DEPLOYMENT = "0x" + "33".repeat(32);
const APP = "0x" + "11".repeat(32);
const PORTS = ["http:8000", ...DESKTOP_PORTS];
const HASH_FIELDS = ["controllerSha256", "runtimeId", "igvmSha256", "profileSha256", "launchMeasurement"];
const RECORD_FIELDS = ["catalog", "cid", "configBase64", "derivation", "desktop", "http", "policy",
  "ports", "runtimeId", "secretDeployment"];

const rawRelease = (over = {}) => ({ schema: DESKTOP_RELEASE_SCHEMA, controllerCid: CID0,
  controllerSha256: sha256Hex(component), runtimeId: RUNTIME, igvmSha256: "55".repeat(32),
  profileSha256: PROFILE, launchMeasurement: "66".repeat(32), minimumCpuMilli: 250,
  policy: { cpuPercent: 800, vcpus: 8 }, ...over });
const request = (over = {}) => ({ release: rawRelease(), app: APP, version: 1, cid: CID0, memMiB: 16384,
  ports: PORTS.join(","), deploymentId: DEPLOYMENT, cpuMilli: 500, gpuMilli: 750,
  config: { egress: "public-web", codec: "h264" }, ...over });
const decode = r => Buffer.from(r.configBase64, "base64").toString("utf8");
const withPolicy = policy => rawRelease({ policy: { cpuPercent: 800, vcpus: 8, ...policy } });

test("validated release and record are owned copies, deeply frozen", () => {
  const raw = rawRelease();
  const v = validateDesktopRelease(raw);
  raw.policy.vcpus = 16; raw.runtimeId = "77".repeat(32); raw.extra = true;
  assert.deepEqual(v, rawRelease());
  assert.ok(Object.isFrozen(v) && Object.isFrozen(v.policy));
  assert.throws(() => { v.policy.cpuPercent = 1600; }, TypeError);
  assert.deepEqual(validateDesktopRelease(v), v);

  const config = { egress: "public-web", codec: "h264", nested: { a: [1] } };
  const req = request({ config });
  const rec = desktopRecordFor(req);
  const text = decode(rec);
  config.egress = "none"; config.nested.a.push(2); req.release.policy.vcpus = 4;
  assert.equal(decode(rec), text);
  assert.equal(rec.policy.vcpus, 8);
  for (const part of [rec, rec.catalog, rec.policy, rec.ports, rec.desktop]) assert.ok(Object.isFrozen(part));
  assert.throws(() => { rec.policy.memMiB = 65536; }, TypeError);
});

test("release refuses inexact schema, fields and non-data inputs", () => {
  const { policy, ...missing } = rawRelease();
  const getter = rawRelease();
  Object.defineProperty(getter, "runtimeId", { get: () => RUNTIME, enumerable: true });
  const symbol = rawRelease(); symbol[Symbol("x")] = 1;
  const hidden = rawRelease(); Object.defineProperty(hidden, "x", { value: 1, enumerable: false });
  const protoKey = JSON.parse(JSON.stringify(rawRelease()).replace(/^\{/, '{"__proto__":{},'));
  class Release { constructor() { Object.assign(this, rawRelease()); } }
  for (const bad of [null, [], "release", 1, missing, rawRelease({ extra: 1 }),
    rawRelease({ schema: "enclave-desktop-release/2" }), rawRelease({ schema: "Enclave-desktop-release/1" }),
    rawRelease({ policy: { cpuPercent: 800, vcpus: 8, memMiB: 16384 } }), rawRelease({ policy: { cpuPercent: 800 } }),
    rawRelease({ policy: [800, 8] }), getter, symbol, hidden, protoKey, new Release(),
    Object.assign(Object.create({ inherited: 1 }), rawRelease())])
    assert.throws(() => validateDesktopRelease(bad), Error);
});

test("release refuses malformed hashes and CIDs", () => {
  for (const k of HASH_FIELDS)
    for (const bad of ["AA".repeat(32), "0".repeat(64), "a".repeat(63), "a".repeat(65), "0x" + "a".repeat(64),
      "g".repeat(64), " " + "a".repeat(63), 1, null])
      assert.throws(() => validateDesktopRelease(rawRelease({ [k]: bad })), /nonzero lowercase 64-hex/);
  for (const bad of ["ipfs://" + CID0, CID0 + "\n", " " + CID0, "Qm" + "0".repeat(44), "Qm" + "a".repeat(45), "", 1])
    assert.throws(() => validateDesktopRelease(rawRelease({ controllerCid: bad })), /CID/);
  for (const ok of [OTHER_CID, "b" + "a".repeat(58), "z" + "a".repeat(40)])
    assert.equal(validateDesktopRelease(rawRelease({ controllerCid: ok })).controllerCid, ok);
});

test("release bounds policy and minimum CPU share", () => {
  for (const policy of [{ cpuPercent: 399, vcpus: 4 }, { cpuPercent: 1601, vcpus: 16 }, { cpuPercent: 800.5 },
    { cpuPercent: "800" }, { vcpus: 3 }, { vcpus: 17 }, { cpuPercent: 900, vcpus: 8 }, { cpuPercent: 500, vcpus: 4 }])
    assert.throws(() => validateDesktopRelease(withPolicy(policy)), Error);
  for (const policy of [{ cpuPercent: 400, vcpus: 4 }, { cpuPercent: 1600, vcpus: 16 }, { cpuPercent: 400, vcpus: 16 }])
    assert.deepEqual(validateDesktopRelease(withPolicy(policy)).policy, policy);
  for (const bad of [0, 1001, 1.5, NaN, Infinity, "250", -0])
    assert.throws(() => validateDesktopRelease(rawRelease({ minimumCpuMilli: bad })), Error);
  for (const ok of [1, 1000]) assert.equal(validateDesktopRelease(rawRelease({ minimumCpuMilli: ok })).minimumCpuMilli, ok);
});

test("ports must be exactly HTTP 8000 plus the Moonlight set", () => {
  for (const ports of [" HTTP:8000 , tcp:47984,TCP:47989,tcp:48010,udp:47998,UDP:47999,\tudp:48000 ",
    [...PORTS].reverse(), PORTS.map(p => ` ${p.toUpperCase()} `)])
    assert.deepEqual(desktopRecordFor(request({ ports })).ports, DESKTOP_PORTS);
  const sparse = [...PORTS]; delete sparse[3];
  const replaced = [...PORTS.slice(0, -1), "tcp:47984"];
  for (const ports of [PORTS.join(",") + ",tcp:47984", [...PORTS, "tcp:47984"], replaced, replaced.join(","),
    PORTS.slice(1), PORTS.slice(0, -1).join(","), [...PORTS.slice(0, -1), "tcp:22"], PORTS.join(",") + ",",
    PORTS.join(",") + ",tcp:22", ["http:8001", ...DESKTOP_PORTS], PORTS.join(";"), "tcp: 47984," + PORTS.join(","),
    "", [], [...PORTS.slice(0, -1), 48000], sparse, PORTS.join(",") + " ".repeat(256), 8000, null, { 0: "http:8000" }])
    assert.throws(() => desktopRecordFor(request({ ports })), Error);
});

test("configuration bytes are appConfigText for strings, objects and _media", () => {
  const config = { zeta: 1, egress: "public-web", alpha: { b: 1, a: 2 }, volumes: [] };
  const want = '{"zeta":1,"egress":"public-web","alpha":{"b":1,"a":2},"volumes":[]}';
  const forms = [config, JSON.stringify(config), { ...config, _media: { poster: "ipfs://x" } },
    JSON.stringify({ _media: ["x"], ...config }), ' {"zeta" : 1, "egress":"public-web", "alpha":{"b":1,"a":2},"volumes":[]} '];
  for (const form of forms) {
    const rec = desktopRecordFor(request({ config: form }));
    assert.equal(decode(rec), want);
    assert.equal(decode(rec), appConfigText(form));
    assert.equal(rec.configBase64, Buffer.from(want, "utf8").toString("base64"));
  }
  const unicode = { egress: "public-web", label: "bureau été \u{1f5a5}" };
  assert.equal(decode(desktopRecordFor(request({ config: unicode }))), appConfigText(unicode));
  assert.equal(decode(desktopRecordFor(request({ config: { egress: "public-web" } }))), '{"egress":"public-web"}');
});

test("configuration refuses wrong or missing egress, volumes and non-objects", () => {
  const getter = { egress: "public-web" };
  Object.defineProperty(getter, "codec", { get: () => "h264", enumerable: true });
  for (const config of [{}, "", "{}", { egress: "none" }, { egress: "PUBLIC-WEB" }, { egress: ["public-web"] },
    { net: { egress: "public-web" } }, { _media: { egress: "public-web" } }, '{"_media":{"egress":"public-web"}}',
    { egress: "public-web", volumes: ["model"] }, { egress: "public-web", volumes: [{ name: "model", path: "/models" }] },
    { egress: "public-web", volumes: {} }, { egress: "public-web", volumes: null }, { egress: "public-web", volumes: "model" },
    '{"egress":"public-web","volumes":["model"]}', "[]", "null", "42", "not json", [], 42, null, true,
    getter, new Date(0), { egress: "public-web", when: new Date(0) },
    { egress: "public-web", pad: "x".repeat(32 << 10) }])
    assert.throws(() => desktopRecordFor(request({ config })), Error);
});

test("configuration arrays cannot hide sparse elements behind named properties", () => {
  const sparse = [1, , 3]; sparse.extra = 2;
  const named = [1, 2]; named.extra = 3;
  for (const nested of [sparse, named])
    assert.throws(() => desktopRecordFor(request({ config: { egress: "public-web", nested } })), /dense/);
});

test("CPU and GPU shares and memory are bounded at record construction", () => {
  for (const [over, ok] of [[{ cpuMilli: 249 }, false], [{ cpuMilli: 250 }, true], [{ cpuMilli: 1000 }, true],
    [{ cpuMilli: 1001 }, false], [{ cpuMilli: 500.5 }, false], [{ cpuMilli: "500" }, false],
    [{ gpuMilli: 499 }, false], [{ gpuMilli: 500 }, true], [{ gpuMilli: 1000 }, true], [{ gpuMilli: 1001 }, false],
    [{ gpuMilli: 750.5 }, false], [{ memMiB: 8191 }, false], [{ memMiB: 8192 }, true], [{ memMiB: 65536 }, true],
    [{ memMiB: 65537 }, false], [{ memMiB: 16384.5 }, false],
    [{ release: rawRelease({ minimumCpuMilli: 1000 }), cpuMilli: 999 }, false],
    [{ release: rawRelease({ minimumCpuMilli: 1000 }), cpuMilli: 1000 }, true]]) {
    if (ok) assert.equal(validateDesktopRecord(desktopRecordFor(request(over))), undefined);
    else assert.throws(() => desktopRecordFor(request(over)), Error);
  }
  const rec = desktopRecordFor(request({ memMiB: 32768, gpuMilli: 600 }));
  assert.deepEqual(rec.policy, { cpuPercent: 800, memMiB: 32768, vcpus: 8 });
  assert.equal(rec.desktop.gpuMilli, 600);
  for (const over of [{ cid: OTHER_CID }, { cid: CID0 + " " }, { deploymentId: "0x" + "00".repeat(32) },
    { deploymentId: "33".repeat(32) }, { app: "0x" + "AA".repeat(32) }, { version: -1 }, { release: rawRelease({ extra: 1 }) }])
    assert.throws(() => desktopRecordFor(request(over)), Error);
  const { gpuMilli, ...missing } = request();
  for (const bad of [missing, request({ secret: "value" }), request({ policy: { cpuPercent: 1600 } })])
    assert.throws(() => desktopRecordFor(bad), /declared fields/);
});

test("approved derivation checks release pins and component hash", () => {
  const release = rawRelease();
  const got = deriveApprovedDesktop({ release, record: baseline.record, component });
  assert.equal(got.appId, baseline.mapping.appId);
  assert.equal(got.recordSha256, baseline.mapping.recordSha256);
  assert.equal(got.componentSha256, baseline.mapping.componentSha256);
  const edit = change => { const r = structuredClone(baseline.record); change(r); return r; };
  for (const record of [edit(r => { r.cid = OTHER_CID; }), edit(r => { r.runtimeId = "77".repeat(32); }),
    edit(r => { r.desktop.profileSha256 = "88".repeat(32); }), edit(r => { r.policy.cpuPercent = 900; }),
    edit(r => { r.policy.vcpus = 9; })]) {
    validateDesktopRecord(record);
    assert.throws(() => deriveApprovedDesktop({ release, record, component }), /approved release pins/);
  }
  const tampered = Buffer.from(component); tampered[tampered.length - 1] ^= 1;
  for (const c of [tampered, Buffer.concat([component, Buffer.from([0])]), component.subarray(0, -1)])
    assert.throws(() => deriveApprovedDesktop({ release, record: baseline.record, component: c }), /approved release hash/);
  assert.throws(() => deriveApprovedDesktop({ release, record: baseline.record, component: new Uint8Array(component) }), /Buffer/);
  assert.throws(() => deriveApprovedDesktop({ release: rawRelease({ controllerSha256: "99".repeat(32) }),
    record: baseline.record, component }), /approved release hash/);
  assert.throws(() => deriveApprovedDesktop({ release, record: baseline.record, component, cpuMilli: 500 }), /declared fields/);
  const getter = structuredClone(baseline.record);
  Object.defineProperty(getter, "cid", { get: () => CID0, enumerable: true });
  assert.throws(() => deriveApprovedDesktop({ release, record: getter, component }), /data-only/);
  assert.throws(() => deriveApprovedDesktop({ release, record: edit(r => { r.extra = 1; }), component }), /declared fields/);
});

test("node planner and relay share one helper and derive the same identity", () => {
  assert.deepEqual(Object.keys(helper).sort(),
    ["DESKTOP_RELEASE_SCHEMA", "deriveApprovedDesktop", "desktopRecordFor", "validateDesktopRelease"]);
  assert.equal(DESKTOP_RELEASE_SCHEMA, "enclave-desktop-release/1");
  // Node planner: build the record from a purchase and derive locally.
  const rec = desktopRecordFor(request());
  validateDesktopRecord(rec);
  assert.deepEqual(Object.keys(rec).sort(), RECORD_FIELDS);
  assert.equal(rec.secretDeployment, DEPLOYMENT);
  assert.equal(rec.runtimeId, RUNTIME);
  const node = deriveApprovedDesktop({ release: rawRelease(), record: rec, component });
  // Relay: receives the release and record as JSON and derives independently.
  const relayRelease = JSON.parse(JSON.stringify(validateDesktopRelease(rawRelease())));
  const relayRecord = JSON.parse(JSON.stringify(rec));
  const relay = deriveApprovedDesktop({ release: relayRelease, record: relayRecord, component: Buffer.from(component) });
  assert.equal(relay.appId, node.appId);
  assert.equal(relay.recordSha256, node.recordSha256);
  assert.ok(relay.bundle.equals(node.bundle));
  // The helper adds nothing of its own to the measured bundle.
  assert.equal(deriveDesktop({ record: relayRecord, component }).appId, node.appId);
});
