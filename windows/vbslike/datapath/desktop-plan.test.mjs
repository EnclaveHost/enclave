import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isolationPlan, BACKEND } from "./node-bridge.mjs";
import { IsolationManagerClient } from "../../node/isolation-client.mjs";
import { desktopSpawnRefusal } from "../manager/desktop-admission.mjs";
import { DESKTOP_DERIVATION, DESKTOP_PORTS } from "../../../relay/shield-desktop-derive.mjs";
import { deriveApprovedDesktop } from "../../../relay/shield-desktop-release.mjs";

const vectors = JSON.parse(readFileSync(new URL("../../../isolation/contract/catalog/desktop_vectors.json", import.meta.url)));
const v = vectors.ok.find(x => x.name === "baseline");
const release = { schema: "enclave-desktop-release/1", controllerCid: v.record.cid,
  controllerSha256: v.mapping.componentSha256, runtimeId: v.record.runtimeId,
  profileSha256: v.record.desktop.profileSha256, igvmSha256: "55".repeat(32),
  launchMeasurement: "66".repeat(32), minimumCpuMilli: 250, policy: { cpuPercent: 800, vcpus: 8 } };
const input = () => ({ deploymentId: v.record.secretDeployment,
  deployment: { cpuMilli: 500n, gpuMilli: 750n, isPublic: true, appPort: 8000 },
  version: { appId: v.record.catalog.app, index: 1, cid: v.record.cid, memMb: 16384,
    ports: ["http:8000", ...DESKTOP_PORTS].join(","), configCid: "", yanked: false },
  desktopRelease: structuredClone(release), runtimeId: "77".repeat(32),
  appConfig: { egress: "public-web", codec: "h264" }, appConfigCid: "", hasSecrets: true,
  waf: {}, volumes: [], require: BACKEND,
  manager: { backend: BACKEND, canStart: true, catalog: { derivations: [DESKTOP_DERIVATION] },
    desktop: { ready: true, ...release }, supports: { desktop: true, config: true, configCid: true, secrets: true, ports: true } } });

test("native purchase builds a V8 spawn accepted by the native manager body guard", () => {
  const plan = isolationPlan(input());
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.derivation, DESKTOP_DERIVATION);
  assert.equal(plan.spawn.derive.runtimeId, release.runtimeId);
  assert.equal(plan.spawn.cpuShare, .5);
  assert.equal(plan.spawn.gpuShare, .75);
  assert.equal(Object.hasOwn(plan.spawn, "config"), false);
  assert.equal(Object.hasOwn(plan.spawn, "configCid"), false);
  const body = IsolationManagerClient.spawnBody(plan.spawn);
  assert.equal(desktopSpawnRefusal(body.derive, body), null);
  const mapping = deriveApprovedDesktop({ release, record: body.derive, component: Buffer.from(vectors.component_hex, "hex") });
  assert.equal(mapping.record.secretDeployment, input().deploymentId);
});

test("native selection requires explicit independent release approval", () => {
  for (const change of [x => { delete x.desktopRelease; },
    x => { x.desktopRelease.controllerCid = "Qm" + "a".repeat(44); },
    x => { x.desktopRelease.runtimeId = "a"; }]) {
    const x = input(); change(x); assert.equal(isolationPlan(x).ok, false);
  }
  for (const key of ["runtimeId", "igvmSha256", "profileSha256", "controllerSha256"]) {
    const x = input(); x.manager.desktop[key] = "99".repeat(32);
    assert.equal(isolationPlan(x).input, `manager.desktop.${key}`);
  }
});

test("native planning preserves tenant, catalog and public workload gates", () => {
  for (const change of [x => { x.require = ""; }, x => { x.manager.backend = "other"; },
    x => { x.deployment.isPublic = false; }, x => { x.version.yanked = true; },
    x => { x.version.appId = "bad"; }, x => { x.deploymentId = "0x" + "00".repeat(32); }]) {
    const x = input(); change(x); assert.equal(isolationPlan(x).ok, false);
  }
});

test("native planning refuses unavailable manager capabilities and unknown inputs", () => {
  for (const key of ["desktop", "config", "secrets", "ports"]) {
    const x = input(); x.manager.supports[key] = false;
    assert.equal(isolationPlan(x).input, `manager.supports.${key}`);
  }
  for (const key of ["appConfig", "appConfigCid", "hasSecrets", "waf", "volumes"]) {
    const x = input(); delete x[key];
    assert.equal(isolationPlan(x).unknown, true, key);
  }
  for (const change of [x => { x.manager.canStart = false; }, x => { x.manager.desktop.ready = false; },
    x => { x.manager.catalog.derivations = []; }, x => { x.hasSecrets = false; },
    x => { x.waf = []; }, x => { x.waf = { auth: true }; }, x => { x.volumes = ["model"]; },
    x => { x.appConfigCid = "Qm" + "a".repeat(44); x.manager.supports.configCid = false; }]) {
    const x = input(); change(x); assert.equal(isolationPlan(x).ok, false);
  }
});

test("native purchase refuses invalid resources, extra ports and public configuration", () => {
  for (const change of [x => { x.deployment.cpuMilli = 249; }, x => { x.deployment.gpuMilli = 499; },
    x => { x.version.memMb = 8191; }, x => { x.version.memMb = 16384.5; },
    x => { x.version.ports += ",tcp:22"; }, x => { x.appConfig.egress = "all"; },
    x => { x.appConfig.volumes = ["model"]; }, x => { x.deployment.gpuMilli = null; }]) {
    const x = input(); change(x); assert.equal(isolationPlan(x).ok, false);
  }
});
