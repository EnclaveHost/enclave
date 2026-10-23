// Pure evaluators: recorded observations -> { outcome, evidence }. Hardware steps are judged ONLY from lines the real
// guest front and the real custodian print (isolation/m2/front/custody.go 290, main.go 681, custody/v2client.go 198/282;
// custodian.mjs release log), filtered to the canary id. A SYNTHETIC-roots release line is never accepted.
import { ORIGINAL_VAULT_V2, COMMITTEE_4774, CUSTODIAN_ENDPOINT, PROTECTED_POLICY_4E62 } from "./plan.mjs";

const FRONT_OK = /DOM custody: deployment 0x([0-9a-f]{8})\.\.\. secrets revision (\d+) from a v2 threshold of (\d+) over (\d+) custodian machines, (\d+) name/;
const FRONT_ERR = /DOM ERROR front: (?:.*?)custody(?::|\b)(.*)$/;
const QUORUM = /insufficient custodian quorum/;
const CUST_OK = /\[custodian-v2 ([0-9a-f]{12})\] release (0x[0-9a-f]{64}) to (\S+): OK \(indices ([0-9,]+), measurement ([0-9a-f]{16})\.\.\.(, SYNTHETIC roots)?\)/;
const CUST_NO = /\[custodian-v2 ([0-9a-f]{12})\] release (0x[0-9a-f]{64}) to (\S+): REFUSED ([a-z_]+): (.*)$/;

// Keep only the lines that concern this deployment (no other app's lines enter the journal).
export function filterLines({ frontLog, custodianLog, id }) {
  const short = id.slice(2, 10);
  const front = String(frontLog || "").split("\n").filter((l) => (FRONT_OK.test(l) && FRONT_OK.exec(l)[1] === short) || FRONT_ERR.test(l) || QUORUM.test(l));
  const cust = String(custodianLog || "").split("\n").filter((l) => { const m = CUST_OK.exec(l) || CUST_NO.exec(l); return m && m[2] === id; });
  return { front: front.map((l) => l.slice(0, 400)), custodian: cust.map((l) => l.slice(0, 400)) };
}

// obs: { lines: filterLines(...), appAnswered: bool (root: the app's own URL answered), window: {from,to} }
export function evalRelease({ id, obs, expect, imageMeasurement }) {
  const fronts = obs.lines.front.map((l) => FRONT_OK.exec(l)).filter(Boolean);
  const oks = obs.lines.custodian.map((l) => CUST_OK.exec(l)).filter(Boolean);
  const refusals = obs.lines.custodian.map((l) => CUST_NO.exec(l)).filter(Boolean);
  const reasons = [];
  if (!fronts.some((m) => Number(m[2]) === expect.secretRev && m[3] === "1" && m[4] === "1")) reasons.push(`no front line 'secrets revision ${expect.secretRev} from a v2 threshold of 1 over 1'`);
  if (fronts.some((m) => Number(m[2]) !== expect.secretRev)) reasons.push("a front line names another secrets revision");
  if (!oks.length) reasons.push("no custodian 'release <id> ... OK' line for this id");
  if (oks.some((m) => m[6])) reasons.push("a release came from SYNTHETIC roots: never hardware evidence");
  if (oks.some((m) => m[5] !== imageMeasurement.slice(0, 16))) reasons.push("the released guest's measurement is not the pinned recipient image");
  if (refusals.length) reasons.push(`custodian refusals in the window: ${refusals.map((m) => m[4]).join(",")}`);
  if (obs.lines.front.some((l) => FRONT_ERR.test(l) || QUORUM.test(l))) reasons.push("a front custody error in the window");
  if (obs.appAnswered !== true) reasons.push("the app did not answer");
  return { outcome: reasons.length ? "fail" : "pass", reasons,
    evidence: { id, secretRev: expect.secretRev, frontLines: obs.lines.front, custodianLines: obs.lines.custodian, appAnswered: obs.appAnswered,
      scope: "real SNP recipient + live custodian; plaintext equality is indirect (revision, name count, configSha256 binding)" } };
}

export function evalRefusal({ id, obs, expect }) {
  const oks = obs.lines.custodian.filter((l) => CUST_OK.test(l));
  const refusals = obs.lines.custodian.map((l) => CUST_NO.exec(l)).filter(Boolean);
  const matching = refusals.filter((m) => expect.codes.includes(m[4]) && (!expect.message || m[5].includes(expect.message)));
  const reasons = [];
  if (oks.length) reasons.push("a release was GRANTED for this id in the window");
  if (!matching.length) reasons.push(`no custodian refusal with ${expect.codes.join("|")}${expect.message ? ` mentioning '${expect.message}'` : ""}`);
  if (obs.lines.front.some((l) => FRONT_OK.test(l))) reasons.push("the front reported released secrets");
  if (!obs.lines.front.some((l) => FRONT_ERR.test(l) || QUORUM.test(l))) reasons.push("no front custody error line");
  if (obs.appAnswered !== false) reasons.push("the app answered (it must not start without its secrets)");
  return { outcome: reasons.length ? "fail" : "pass", reasons, evidence: { id, expected: expect.codes, refusalCodes: refusals.map((m) => m[4]),
    frontLines: obs.lines.front, custodianLines: obs.lines.custodian, appAnswered: obs.appAnswered } };
}

// counts: { "<set>@<location>": number } from root's search (needles piped over stdin, counts only);
// control: { "<location>": number } hits for the deployment id itself in the same locations.
export function evalMarkerSearch({ sets, counts, control, locations }) {
  const reasons = [];
  for (const loc of locations) {
    if (!(control?.[loc] > 0)) reasons.push(`control (the id) not found at ${loc}: the search is not shown to work there`);
    for (const s of sets) {
      const n = counts?.[`${s}@${loc}`];
      if (n === undefined) reasons.push(`no count for ${s} at ${loc}`);
      else if (n !== 0) reasons.push(`${s} found ${n}x at ${loc}`);
    }
  }
  return { outcome: reasons.length ? "fail" : "pass", reasons, evidence: { sets, locations, counts, control,
    limitation: "these locations and encodings only; not process memory, swap, other hosts or backups" } };
}

// chain facts at an agreed block (reader output, reduced to public scalars)
export function evalPolicyCheck({ facts, expect, ownerAddress, prepared }) {
  const reasons = [];
  if (String(facts.policyRev) !== String(expect.policyRev)) reasons.push(`policyRev ${facts.policyRev} != ${expect.policyRev}`);
  if (String(facts.secretRev) !== String(expect.secretRev)) reasons.push(`secretRev ${facts.secretRev} != ${expect.secretRev}`);
  if (facts.owner !== ownerAddress.toLowerCase()) reasons.push("policy owner is not the canary owner");
  if (facts.committeeId !== COMMITTEE_4774) reasons.push("policy committee is not 0x4774");
  if (prepared?.summary?.bundleKeccak && facts.bundleKeccak !== prepared.summary.bundleKeccak) reasons.push("bundle on chain is not the prepared bundle");
  if (prepared?.summary?.rulesKeccak && facts.rulesKeccak !== prepared.summary.rulesKeccak) reasons.push("rules on chain are not the prepared rules");
  if (expect.custodyFlag !== undefined && facts.relayCustody !== expect.custodyFlag) reasons.push(`relay /exists custody is ${facts.relayCustody}`);
  return { outcome: reasons.length ? "fail" : "pass", reasons, evidence: { ...facts, block: facts.block } };
}

// S0: inventory facts -> prerequisite observations. Each check names what it compared.
export function evalInventory({ facts, pins, budget }) {
  const obs = {};
  const set = (k, ok, note) => { obs[k] = { ok, stepId: "S0.chain", note }; };
  set("read.vault", facts.vaultCodeHash === pins.vaultCodeHash, `code hash ${facts.vaultCodeHash} vs pinned ${pins.vaultCodeHash}`);
  const c = facts.committee;
  set("read.committee", !!c && c.epoch === 1 && c.t === 1 && c.W === 1 && c.machines?.length === 1 && c.machines[0].endpoint === CUSTODIAN_ENDPOINT
    && c.machines[0].measurement === pins.custodian.measurementSha256, "epoch 1, t 1, W 1, one machine at custody-metal0 with the live measurement");
  set("read.protected4e62", facts.protected?.id === PROTECTED_POLICY_4E62 && /^0x[0-9a-f]{64}$/.test(String(facts.protected?.bundleKeccak)), "0x4e62 snapshot recorded");
  set("read.owner", BigInt(facts.ownerBalanceWei) >= BigInt(budget.largestStepWei) && Number.isInteger(facts.ownerNonce),
    `balance ${facts.ownerBalanceWei} vs largest step cap ${budget.largestStepWei}; plan worst case ${budget.worstCaseWei}`);
  return obs;
}

export function evalCustodianInfo({ info, committee }) {
  const m = committee?.machines?.[0];
  const ok = !!m && String(info?.encKey).toLowerCase() === String(m.encKey).toLowerCase() && String(info?.vault).toLowerCase() === ORIGINAL_VAULT_V2;
  return { "custodian.info": { ok, stepId: "S0.custodian", note: "public /v2/custody/info encKey and vault = the chain machine record" } };
}

export function evalProtectedUnchanged({ before, after }) {
  const keys = ["owner", "policyRev", "secretRev", "paused", "bundleKeccak", "committeeId", "rulesKeccak"];
  const changed = keys.filter((k) => String(before?.[k]) !== String(after?.[k]));
  return { outcome: changed.length ? "fail" : "pass", evidence: { id: PROTECTED_POLICY_4E62, changed } };
}

// The rollback limitation. With no monotonic anchor an OLDER valid sealed blob opens under the same identity. That is
// recorded as EXPECTED-FAIL, never pass. A later refusal of an OLD secret revision is the chain's revision check
// (stale_revision / chain freshness), and must never be relabelled as sealed-state anti-replay.
export function evalRollback({ obs }) {
  const detected = obs.custodianRefusedOldState === true;
  const evidence = { olderBlobOpened: obs.olderBlobOpened === true, sameIdentity: obs.sameIdentity === true, rollbackDetected: detected,
    oldSecretRevisionRefused: obs.oldSecretRevisionRefused === true,
    label: obs.oldSecretRevisionRefused ? "old secret refused by the CHAIN revision check only; NOT sealed-state anti-replay" : "no old-secret refusal recorded" };
  if (detected) return { outcome: "fail", evidence: { ...evidence, note: "a detection was reported where the design has no anchor: re-examine before believing it" } };
  return { outcome: "expected-fail", evidence: { ...evidence, limitation: "no monotonic anchor: an older valid sealed blob is accepted (spec 176-181, host keeps 20 blobs)" } };
}
