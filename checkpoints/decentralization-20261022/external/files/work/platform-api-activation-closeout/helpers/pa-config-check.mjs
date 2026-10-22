#!/usr/bin/env node
// pa-config-check.mjs -- offline check of the members' direct configs BEFORE any boot. Pure: reads only the given JSON
// files (public config) and the reviewed tree's validator. Safe to run anywhere; touches no network.
//
//   node pa-config-check.mjs --direct-config m1.json --direct-config m2.json --direct-config m3.json [--relay-env relay-env.json]
//
// Uses the guest's own validator (canonicalDirectConfig, the exact bytes HOST_DATA binds), then the group rules the
// validator cannot see across files:
//   - every member carries the IDENTICAL platformApi (canonical JSON), and the set of configs covers its member list exactly;
//   - each config's identity (operator, publicUrl) is its own member entry and its controlUrl port is its controlPort;
//   - mode/isolation are fixed by the host launcher (snp, snp-guest-per-app), not here; distinct PHYSICAL hosts are proved
//     only by pa-preflight.mjs (distinct SEV-SNP CHIP_IDs), never by URLs;
//   - hostname is the original api.enclave.host; relayEnv keeps the old public configuration (optional --relay-env diff);
//   - no credential-shaped name in relayEnv; out-of-directory relay state (ROUTE_STATE_DIR, …) pointed into the data directory;
//   - at least one archive (0 archives = a whole-group loss loses ALL state), archiveMs <= 60000.
// Output: per-member config digest and HOST_DATA (what the launcher binds and the verifier expects), and refusals.
import fs from "node:fs";
import { args, die, load, PUBLIC_NAMES, OUTSIDE_STATE, GUEST_DATA, isCredential } from "./common.mjs";

export async function checkConfigs(raws, { relayEnv = null } = {}) {
  const MC = await load("metal/guest/measured-control.mjs");
  const refusals = [], warnings = [], members = [];
  const cfgs = raws.map((r, i) => { try { return MC.canonicalDirectConfig(r); } catch (e) { refusals.push(`config ${i}: ${e.message}`); return null; } });
  if (refusals.length) return { refusals, warnings, members };
  const pa0 = cfgs[0].platformApi;
  if (!pa0) return { refusals: ["config 0 has no platformApi member"], warnings, members };
  const want = MC.canonicalJson(pa0);
  cfgs.forEach((c, i) => { if (!c.platformApi || MC.canonicalJson(c.platformApi) !== want) refusals.push(`config ${i}: platformApi differs from config 0 (it must be identical on every member)`); });
  const seen = new Set();
  cfgs.forEach((c, i) => {
    const m = pa0.members.find((x) => x.operator === c.identity.operator);
    if (!m) { refusals.push(`config ${i}: operator ${c.identity.operator} is not a platformApi member`); return; }
    if (seen.has(m.operator)) refusals.push(`config ${i}: a second config for operator ${m.operator}`);
    seen.add(m.operator);
    if (m.publicUrl !== c.identity.publicUrl) refusals.push(`config ${i}: identity.publicUrl ${c.identity.publicUrl} is not its member publicUrl ${m.publicUrl}`);
    if (Number(new URL(m.controlUrl).port || 443) !== c.controlPort) refusals.push(`config ${i}: member controlUrl port is not controlPort ${c.controlPort}`);
    const digest = MC.configDigest(c);
    members.push({ operator: m.operator, publicUrl: m.publicUrl, controlUrl: m.controlUrl, configDigest: digest, hostData: MC.hostDataHex(digest), releaseId: c.releaseId });
  });
  if (seen.size !== pa0.members.length) refusals.push(`${pa0.members.length} members listed, ${seen.size} member config(s) given: give every member's config`);
  if (new Set(cfgs.map((c) => c.releaseId)).size !== 1) warnings.push("members name different releaseIds (allowed only during a rolling update with both measurements listed)");
  if (pa0.hostname !== "api.enclave.host") refusals.push(`hostname ${pa0.hostname}: the production origin is api.enclave.host (keep it; passkeys and SSO are bound to it)`);
  if (pa0.archives.length === 0) refusals.push("no archives: a whole-group loss (every member rebooted) would lose ALL state");
  if (pa0.archiveMs > 60000) warnings.push(`archiveMs ${pa0.archiveMs}: a whole-group loss can lose that much of writes`);
  if (pa0.archives.some((a) => a.startsWith("http:"))) warnings.push("an http archive origin: ciphertext only, but anyone on the path can drop or replace it");
  if (pa0.recovery.length < 2) warnings.push("one recovery key: losing it makes a whole-group loss unrecoverable even with archives");
  for (const k of Object.keys(pa0.relayEnv)) if (isCredential(k)) refusals.push(`relayEnv.${k} is credential-shaped: it would be published in the bound config (send it in the credentials package)`);
  for (const x of OUTSIDE_STATE) {
    const v = pa0.relayEnv[x.name];
    if (x.always && v !== `${GUEST_DATA}/${x.rel}`) refusals.push(`relayEnv.${x.name} must be ${GUEST_DATA}/${x.rel}: elsewhere that state is neither imported nor replicated`);
    else if (v !== undefined && v.startsWith("/") && !v.startsWith(GUEST_DATA + "/")) refusals.push(`relayEnv.${x.name} points outside the replicated data directory`);
  }
  const unknown = Object.keys(pa0.relayEnv).filter((k) => !PUBLIC_NAMES.includes(k));
  if (unknown.length) warnings.push(`relayEnv names outside the extracted public inventory: ${unknown.join(", ")}`);
  if (relayEnv) {
    for (const [k, v] of Object.entries(relayEnv)) if (pa0.relayEnv[k] !== v) refusals.push(`relayEnv.${k} differs from (or drops) the old API's public value`);
    for (const k of Object.keys(pa0.relayEnv)) if (!(k in relayEnv)) warnings.push(`relayEnv.${k} is new (not in the old API's environment)`);
  }
  return { refusals, warnings, members, majority: Math.floor(pa0.members.length / 2) + 1, groupMembers: pa0.members.length };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const o = args(process.argv.slice(2), { multi: ["direct-config"] });
  if (!o["direct-config"]?.length) die("usage: --direct-config m1.json [--direct-config …] [--relay-env relay-env.json]");
  const r = await checkConfigs(o["direct-config"].map((f) => JSON.parse(fs.readFileSync(f, "utf8"))),
    { relayEnv: o["relay-env"] ? JSON.parse(fs.readFileSync(o["relay-env"], "utf8")) : null });
  console.log(JSON.stringify(r, null, 1));
  if (r.refusals.length) process.exit(2);
}
