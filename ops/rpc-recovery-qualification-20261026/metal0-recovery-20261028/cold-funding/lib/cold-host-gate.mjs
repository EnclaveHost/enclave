// The metal0 COLD HOST gate: what root's runtime must see on THIS host, immediately before any key access, for the cold
// C9 maintenance (lib/maintenance.mjs COLD). PURE + INJECTED: this module never runs a command, reads a file or a key; the
// caller injects every read (`io`). It never stops, freezes or suspends anything.
//   1. the plan's quiesce.cold binds the exact preservation receipt sha256 and stop second below;
//   2. the stop receipt (cold-stop-observation.json) hashes to the sha256 root states, and records exactly the stopped units;
//   3. the private preservation receipt hashes to the reviewed sha256;
//   4. NOW: both units are still in exactly the recorded stop state (same InactiveEnterTimestampMonotonic: never restarted),
//      not running in the other systemd scope either, no m2-gd* unit active in either scope, no guestd-root/*/instance.json;
//   5. the metal unit has been stopped >= COLD.minStoppedSec on the monotonic clock, and stoppedAtSec is not earlier than that stop;
//   6. key access additionally needs an injected SPONSOR QUIESCENCE guard: the sponsor's key is in use by the live
//      enclave-custodian-v2.service (which also parents a live QEMU). No such guard exists yet, so no live run passes.
import { createHash } from "node:crypto";
import { Refusal } from "../vendor/publish.mjs";
import { COLD, PRODUCTION } from "./maintenance.mjs";

const refuse = (code, message) => { throw new Refusal(code, message); };
const lc = (x) => String(x ?? "").toLowerCase();
const sha256hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const COLD_HOST = Object.freeze({
  marker: "metal0-cold-host-gate/v1",
  stopReceipt: "../metal0-recovery-20261028/cold-stop-observation.json",               // relative to this package's root
  preservationReceipt: "/home/steven/enclave-prod/metal0-recovery-20261028/receipt.json",   // private; only hashed, never printed
  preservationReceiptSha256: "e98390ab7f10f4df83593b177e9bcc1d8b9fc1f17065664165e420627ee4cc90",
  stoppedAtSec: 1793157303,                                                            // 2026-10-28T03:15:03Z
  unitScope: "user",                                                                   // as the reviewed root-send.mjs queried them
  metalUnit: "enclave-metal.service",
  units: Object.freeze({
    "enclave-metal.service": Object.freeze({ ActiveState: "inactive", MainPID: "0", InactiveEnterTimestampMonotonic: "1462417550708" }),
    "enclave-custody-protected-leases-20261023.service": Object.freeze({ ActiveState: "inactive", MainPID: "0", InactiveEnterTimestampMonotonic: "0" }),
  }),
  guestUnitGlob: "m2-gd*",
  guestRecord: "instance.json",
  stopClockSlackSec: 60,                                                               // monotonic vs wall clock drift allowance
  sponsorHost: "enclave-custodian-v2.service",
});
export const FACT_KEYS = Object.freeze(["ActiveState", "MainPID", "InactiveEnterTimestampMonotonic"]);
export const SHOW_PROPERTIES = Object.freeze(["LoadState", ...FACT_KEYS]);
const NAME_KEYS = ["unit", "Unit", "name", "Name", "Id", "id"];
const otherScope = (s) => (s === "user" ? "system" : "user");
const pick = (o) => Object.fromEntries(FACT_KEYS.map((k) => [k, String(o[k])]));
const same = (a, b) => FACT_KEYS.every((k) => a[k] === b[k]);
const show = (f) => FACT_KEYS.map((k) => `${k}=${f[k]}`).join(" ");

/** `systemctl show -p ...` output -> { Key: "value" }; a repeated key or a non Key=Value line refuses. */
export function parseShow(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    if (line === "") continue;
    const i = line.indexOf("=");
    if (i <= 0) refuse("host_parse", "unexpected systemctl show line");
    const k = line.slice(0, i);
    if (Object.hasOwn(out, k)) refuse("host_parse", `systemctl show repeated ${k}`);
    out[k] = line.slice(i + 1);
  }
  return out;
}

/** The plan (already checkExecutablePlan(..., "cold")) must carry exactly these host facts in quiesce.cold. */
export function checkPlanBinding(plan, H = COLD_HOST) {
  const q = plan?.quiesce, c = q?.cold;
  if (q?.mode !== "cold" || c?.profile !== COLD.marker) refuse("plan_cold_binding", "the plan is not a cold plan");
  if (c.preservationReceiptSha256 !== "0x" + H.preservationReceiptSha256) refuse("plan_cold_binding", "the plan's preservationReceiptSha256 is not the reviewed preservation receipt");
  if (c.stoppedAtSec !== H.stoppedAtSec) refuse("plan_cold_binding", `the plan's stoppedAtSec ${c.stoppedAtSec} is not the recorded stop ${H.stoppedAtSec}`);
  if (c.noGuestUnits !== true || c.noGuestRecords !== true) refuse("plan_cold_binding", "the plan does not assert no guest units and no guest records");
}

// every fact tuple at or below `node` (objects carrying all FACT_KEYS, or systemctl-show text)
function factSets(node, out = []) {
  if (typeof node === "string") {
    if (/^ActiveState=/m.test(node)) {
      const p = {};
      for (const line of node.split("\n")) { const i = line.indexOf("="); if (i > 0) { const k = line.slice(0, i); if (Object.hasOwn(p, k) && p[k] !== line.slice(i + 1)) return out.push(null), out; p[k] = line.slice(i + 1); } }
      if (FACT_KEYS.every((k) => Object.hasOwn(p, k))) out.push(pick(p));
    }
    return out;
  }
  if (!node || typeof node !== "object") return out;
  if (!Array.isArray(node) && FACT_KEYS.every((k) => Object.hasOwn(node, k))) out.push(pick(node));
  for (const v of Object.values(node)) factSets(v, out);
  return out;
}

/** The ONE fact tuple the receipt records for `unit` (keyed by the unit name, or an object naming it). None, or two that disagree, refuses. */
export function receiptUnitFacts(obs, unit) {
  const scopes = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (!Array.isArray(node)) {
      if (NAME_KEYS.some((k) => node[k] === unit)) scopes.push(node);
      if (Object.hasOwn(node, unit)) scopes.push(node[unit]);
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(obs);
  const sets = scopes.flatMap((s) => factSets(s));
  if (!sets.length) refuse("stop_receipt", `the stop receipt records no ${FACT_KEYS.join("/")} for ${unit}`);
  if (sets.some((s) => !s || !same(s, sets[0]))) refuse("stop_receipt", `the stop receipt records conflicting states for ${unit}`);
  return sets[0];
}

// the stop second appears in the receipt as a number, a decimal string, "@<sec>" or an ISO-8601 time of exactly that second
function receiptHasStopSec(obs, sec) {
  const hit = (v) => (typeof v === "number" && v === sec) || (typeof v === "string" && (v === String(sec) || v === `@${sec}` ||
    (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(v) && Math.floor(Date.parse(v) / 1000) === sec)));
  const walk = (n) => hit(n) || (n && typeof n === "object" && Object.values(n).some(walk));
  return walk(obs);
}

/** The stop receipt: exactly the bytes root reviewed (stated sha256), recording exactly the stopped units and the stop second. */
export function checkStopReceipt(bytes, statedSha256, H = COLD_HOST) {
  const want = lc(statedSha256).replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(want)) refuse("stop_receipt", "root must state the stop receipt's sha256");
  if (sha256hex(bytes) !== want) refuse("stop_receipt", "the stop receipt's sha256 is not the one root stated");
  let obs; try { obs = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { refuse("stop_receipt", "the stop receipt is not JSON"); }
  for (const [unit, expected] of Object.entries(H.units)) {
    const got = receiptUnitFacts(obs, unit);
    if (!same(got, expected)) refuse("stop_receipt", `the stop receipt records ${unit} as ${show(got)}, not ${show(expected)}`);
  }
  if (!receiptHasStopSec(obs, H.stoppedAtSec)) refuse("stop_receipt", `the stop receipt does not record the stop second ${H.stoppedAtSec}`);
}

export function checkPreservationReceipt(bytes, H = COLD_HOST) {
  if (sha256hex(bytes) !== H.preservationReceiptSha256) refuse("preservation_receipt", "the private preservation receipt is not the reviewed one (sha256 differs)");
}

/** NOW, in the units' scope: loaded and exactly the recorded stop state (an unchanged inactive-enter stamp = never restarted). */
export function checkUnitNow(unit, showText, H = COLD_HOST) {
  const p = parseShow(showText);
  if (p.LoadState !== "loaded" && !(unit === "enclave-custody-protected-leases-20261023.service" && p.LoadState === "not-found" && H.units[unit].InactiveEnterTimestampMonotonic === "0")) refuse("unit_state", `${unit} is not a loaded ${H.unitScope} unit (LoadState ${p.LoadState}): wrong scope or unit`);
  if (!FACT_KEYS.every((k) => Object.hasOwn(p, k))) refuse("unit_state", `${unit}: systemctl show omitted a property`);
  if (!same(pick(p), H.units[unit])) refuse("unit_state", `${unit} is ${show(pick(p))}, not the recorded stop ${show(H.units[unit])}: it was restarted or is running`);
}

/** NOW, in the other scope: the same unit name is not running there either (a missing unit reads inactive/0). */
export function checkUnitOtherScope(unit, showText) {
  const p = parseShow(showText);
  if (p.ActiveState !== "inactive" || p.MainPID !== "0") refuse("unit_state", `${unit} is ${p.ActiveState}/MainPID ${p.MainPID} in the other systemd scope`);
}

/** `systemctl list-units --all --plain --no-legend --full m2-gd*`: every listed unit must be inactive or failed. */
export function checkGuestUnits(listText, scope) {
  const active = [];
  for (const raw of String(listText).split("\n")) {
    const line = raw.replace(/^[\s●*]+/, "").trim();
    if (!line) continue;
    const [unit, load, state] = line.split(/\s+/);
    if (!/^m2-gd/.test(unit) || !load || !state) refuse("guest_units", `unexpected list-units line in the ${scope} scope`);
    if (!["inactive", "failed"].includes(state)) active.push(`${unit} ${state}`);
  }
  if (active.length) refuse("guest_units", `m2-gd* units are not stopped in the ${scope} scope: ${active.join(", ")}`);
}

export function checkGuestRecords(found) {
  if (!Array.isArray(found)) refuse("guest_records", "the guest record listing is unavailable");
  if (found.length) refuse("guest_records", `guest instance records exist: ${found.length} guestd-root/*/instance.json`);
}

/** The metal stop is >= COLD.minStoppedSec old on CLOCK_MONOTONIC (same boot), and stoppedAtSec does not predate it (beyond slack). */
export function checkStopAge(monotonicUsec, nowSec, H = COLD_HOST) {
  const stamp = BigInt(H.units[H.metalUnit].InactiveEnterTimestampMonotonic), now = BigInt(monotonicUsec);
  if (now <= stamp) refuse("stop_age", "the monotonic clock is before the recorded stop: another boot");
  const elapsedSec = Number(now - stamp) / 1e6;
  if (elapsedSec < COLD.minStoppedSec) refuse("stop_age", `the metal unit stopped ${Math.floor(elapsedSec)} s ago, under ${COLD.minStoppedSec} s`);
  const derivedStopSec = nowSec - elapsedSec;
  if (H.stoppedAtSec < derivedStopSec - H.stopClockSlackSec) refuse("stop_age", `stoppedAtSec ${H.stoppedAtSec} predates the actual stop (~${Math.round(derivedStopSec)}): the stop window would be overstated`);
  return { elapsedSec: Math.floor(elapsedSec), derivedStopSec: Math.round(derivedStopSec) };
}

/**
 * Evaluate every host gate; collects all findings (never stops at the first). `io` (all may be async):
 *   readStopReceipt() -> bytes, readPreservationReceipt() -> bytes, showUnit(scope, unit) -> systemctl show text,
 *   listGuestUnits(scope) -> list-units text, guestRecords() -> [paths], monotonicUsec() -> bigint, nowSec() -> number.
 * `expect` is for tests only (a non-production value marks the result `fixture`, which authorizeKeyAccess refuses).
 */
export async function evaluateColdHost({ plan, stopReceiptSha256, io, expect = COLD_HOST }) {
  const H = expect, findings = [], facts = {};
  const step = async (name, fn) => {
    try { const r = await fn(); if (r !== undefined) facts[name] = r; }
    catch (e) { findings.push({ code: e instanceof Refusal ? e.code : "host_io", message: e instanceof Refusal ? e.message : `${name}: ${String(e?.message ?? e).slice(0, 200)}` }); }
  };
  await step("plan", () => checkPlanBinding(plan, H));
  await step("stopReceipt", async () => checkStopReceipt(await io.readStopReceipt(), stopReceiptSha256, H));
  await step("preservationReceipt", async () => checkPreservationReceipt(await io.readPreservationReceipt(), H));
  for (const unit of Object.keys(H.units)) {
    await step(`unit ${unit}`, async () => checkUnitNow(unit, await io.showUnit(H.unitScope, unit), H));
    await step(`unit ${unit} (${otherScope(H.unitScope)})`, async () => checkUnitOtherScope(unit, await io.showUnit(otherScope(H.unitScope), unit)));
  }
  for (const scope of ["user", "system"]) await step(`guestUnits ${scope}`, async () => checkGuestUnits(await io.listGuestUnits(scope), scope));
  await step("guestRecords", async () => checkGuestRecords(await io.guestRecords()));
  await step("stopAge", async () => checkStopAge(await io.monotonicUsec(), await io.nowSec(), H));
  return Object.freeze({ marker: COLD_HOST.marker, ok: findings.length === 0, fixture: H !== COLD_HOST, findings, facts });
}

/**
 * The sponsor's key is held by the LIVE enclave-custodian-v2.service, which may submit sponsor transactions at any time.
 * An injected guard { id, check(ctx) } must confirm that the custodian has stopped submitting sponsor transactions (without
 * stopping the service, its cgroup or its VM), that the sponsor's pending nonce is settled at ctx.sponsorNonce, and that it holds
 * until the sender reports `verified` (or root resolves the recovery). Exact answer: { quiesced: true, sponsor, sponsorNonce, holdUntil: "verified" }.
 */
export async function requireSponsorQuiescence(guard, ctx) {
  if (!guard || typeof guard.check !== "function" || typeof guard.id !== "string" || !guard.id)
    refuse("sponsor_quiescence", `no sponsor quiescence guard: ${COLD_HOST.sponsorHost} uses the sponsor concurrently; refusing (no freeze or suspension is implemented here)`);
  const r = await guard.check({ ...ctx });
  if (r?.quiesced !== true || lc(r.sponsor) !== lc(ctx.sponsor) || String(r.sponsorNonce) !== String(ctx.sponsorNonce) || r.holdUntil !== "verified")
    refuse("sponsor_quiescence", `the sponsor quiescence guard ${guard.id} did not confirm the sponsor is quiesced at nonce ${ctx.sponsorNonce} until verified`);
  return { id: guard.id, sponsor: lc(ctx.sponsor), sponsorNonce: String(ctx.sponsorNonce) };
}

/** The ONLY door to key access: a production (non-fixture) passing host evaluation AND a confirming sponsor guard. */
export async function authorizeKeyAccess({ host, sponsorQuiescence, plan, planHash }) {
  if (!host || host.marker !== COLD_HOST.marker || host.fixture !== false || host.ok !== true || host.findings?.length)
    refuse("cold_host", "the cold host gate has not passed on this host: no key access");
  const ctx = { sponsor: PRODUCTION.sponsor, sponsorNonce: String(plan?.observed?.sponsorNonce ?? ""), planHash };
  if (!/^\d+$/.test(ctx.sponsorNonce)) refuse("plan", "the plan carries no sponsor nonce");
  return { sponsor: await requireSponsorQuiescence(sponsorQuiescence, ctx) };
}
