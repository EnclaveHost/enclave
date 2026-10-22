#!/bin/bash
# OFFLINE: rebuild worker 6054's handoff plan from its pins (no RPC, no key) and compare its calldata with this release's
cd "$(dirname "$0")"
node --input-type=module -e '
import { createHash } from "node:crypto";
import fs from "node:fs";
const { buildHandoffPlan } = await import("../../publisher-wallet-handoff/handoff-plan.mjs");
const { plan, sha256 } = buildHandoffPlan();
const h = (d) => createHash("sha256").update(Buffer.from(d.slice(2), "hex")).digest("hex");
const wallet = JSON.parse(fs.readFileSync("wallet-prep.json", "utf8")), prep = JSON.parse(fs.readFileSync("release-prep.json", "utf8"));
console.log(JSON.stringify({ planSha256: sha256, appRefNext: plan.appRefNext,
  publish: { sha: h(plan.publishData), equalsReleasePrep: h(plan.publishData) === prep.publishSimulation.dataSha256 },
  config: { sha: h(plan.configData), equalsCliUnsigned: plan.configData === wallet.steps.configSet.unsigned.data },
  upgrade: { sha: h(plan.upgradeData), selector: plan.upgradeData.slice(0, 10) },
  steps: plan.steps.map((s) => ({ n: s.n, step: s.step, kind: s.kind, to: s.to, value: s.value })) }, null, 1));'
