#!/usr/bin/env node
// pa-preflight.mjs -- READ-ONLY gate over the booted members, before genesis and again before the DNS switch. ROOT RUNS IT
// once the member guests exist; not run by the worker. It sends nothing sealed and changes nothing.
//
//   node pa-preflight.mjs --target-config m1.json --target-config m2.json --target-config m3.json [--expect-measurement <96 hex>]
//
// For every member (controlUrl from its own config):
//   1. productionVerifier (metal/guest/platform-api-verify.mjs, the same check the admin tool and every handoff run):
//      AMD chain + TCB floor, measurement in platformApi.measurements, HOST_DATA = this config, attested TLS key, supervisor
//      holding the minted keys, and the ORIGINAL EnclaveRegistry (through the config's RPC quorum) naming the operator as
//      active with THIS boot's proof key. PENDING (not registered / proof key not republished) is a refusal here.
//   2. the SEV-SNP CHIP_ID of that boot, from its report re-read over the TLS key pinned in step 1. Two members on one chip
//      are ONE physical host: refused. The group needs >= 3 distinct chips; this is the only gate that proves physical
//      distinctness (URLs, IPs and operator addresses do not).
//   3. GET /platform-api/status (public: role, epoch, head, leader, haveKey).
// Exit 0 only if every member verified, chips are pairwise distinct and >= 3, and (after genesis) a majority holds the key
// and agrees on one leader.
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { args, die, load } from "./common.mjs";

export async function preflight(cfgRaws, { expectMeasurement = null, verifierFor = null, tlsGet = null, readStatus = null, parseStatement = null, afterGenesis = false } = {}) {
  const MC = await load("metal/guest/measured-control.mjs");
  const PV = await load("metal/guest/platform-api-verify.mjs");
  const SNP = await load("verifier/snp.mjs");
  const MV = await load("metal/measured-control-verify.mjs");
  const get = tlsGet || MV.tlsGet;
  const out = [], refusals = [];
  for (const raw of cfgRaws) {
    const config = MC.canonicalDirectConfig(raw), pa = config.platformApi;
    const me = pa.members.find((m) => m.operator === config.identity.operator);
    const row = { operator: config.identity.operator, controlUrl: me?.controlUrl ?? null };
    out.push(row);
    if (!me) { refusals.push(`${row.operator}: not a member of its own platformApi`); continue; }
    const v = await (verifierFor ? verifierFor(config) : PV.productionVerifier({ config }))({ url: me.controlUrl, config, measurements: pa.measurements, minTcb: pa.minTcb });
    if (!v.ok) { row.verified = false; row.reason = v.reason; refusals.push(`${row.operator}: did not verify (${v.reason})`); continue; }
    row.verified = true; row.bootId = v.identity.bootId; row.measurement = v.identity.measurement;
    if (expectMeasurement && v.identity.measurement !== expectMeasurement) refusals.push(`${row.operator}: measurement ${v.identity.measurement} is not the expected image`);
    const got = await get(me.controlUrl, `${MC.EVIDENCE_PATH}?nonce=${randomBytes(32).toString("hex")}`, { pinSha256: v.identity.controlTlsSpkiSha256 });
    let ev = null; try { ev = JSON.parse(got.body.toString("utf8")); } catch {}
    if (got.status !== 200 || !ev || typeof ev.report !== "string") { refusals.push(`${row.operator}: report re-read failed`); continue; }
    const st = (parseStatement || MC.parseStatement)(ev.statement);
    if (st.bootId !== row.bootId) { refusals.push(`${row.operator}: rebooted during preflight`); continue; }
    const p = SNP.parseReportStrict(Buffer.from(ev.report, "base64"));
    row.chipId = Buffer.from(p.chipId).toString("hex");
    const s = readStatus ? await readStatus(me.controlUrl) : await get(me.controlUrl, "/platform-api/status", { pinSha256: v.identity.controlTlsSpkiSha256 })
      .then((r) => JSON.parse(r.body.toString("utf8"))).catch(() => null);
    row.status = s ? { haveKey: !!s.haveKey, role: s.role ?? null, epoch: s.epoch ?? null, head: s.head ?? null, leader: s.leader ?? null } : null;
  }
  const chips = out.filter((r) => r.chipId).map((r) => r.chipId);
  const distinct = new Set(chips).size;
  if (distinct !== chips.length) refusals.push(`${chips.length - distinct} member(s) share an SEV-SNP chip with another: one physical host is one failure, not two`);
  if (distinct < 3) refusals.push(`${distinct} distinct physical SEV-SNP host(s): the role needs >= 3 (a majority must survive one loss)`);
  const keyed = out.filter((r) => r.status?.haveKey), leaders = new Set(keyed.map((r) => r.status.leader).filter(Boolean));
  const majority = Math.floor(cfgRaws.length / 2) + 1;
  if (afterGenesis) {
    if (keyed.length < majority) refusals.push(`${keyed.length} of ${cfgRaws.length} members hold the group key; a majority (${majority}) must`);
    if (leaders.size !== 1) refusals.push(`members report ${leaders.size} leaders; exactly one is required`);
  }
  return { members: out, distinctChips: distinct, majority, keyed: keyed.length, refusals };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const o = args(process.argv.slice(2), { multi: ["target-config"] });
  if (!o["target-config"]?.length) die("usage: --target-config m1.json --target-config … [--expect-measurement HEX] [--after-genesis]");
  const r = await preflight(o["target-config"].map((f) => JSON.parse(fs.readFileSync(f, "utf8"))),
    { expectMeasurement: o["expect-measurement"] || null, afterGenesis: !!o["after-genesis"] });
  console.log(JSON.stringify(r, null, 1));
  if (r.refusals.length) process.exit(2);
}
