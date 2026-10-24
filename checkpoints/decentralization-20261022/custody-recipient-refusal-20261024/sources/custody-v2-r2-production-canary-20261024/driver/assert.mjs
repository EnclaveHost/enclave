// Pure evaluators: recorded observations -> { outcome, evidence }. Hardware steps are judged ONLY from lines the real
// guest front and the real custodian print (isolation/m2/front/custody.go 290, main.go 681, custody/v2client.go 198/282;
// custodian.mjs release log), filtered to the canary id. A SYNTHETIC-roots release line is never accepted.
import { ORIGINAL_VAULT_V2, OLD_COMMITTEE_4774, OLD_CUSTODIAN_ENDPOINT, OLD_CUSTODIAN_MEASUREMENT_SHA, PROTECTED_POLICY_4E62 } from "./plan.mjs";

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
export function evalRelease({ id, obs, expect, imageMeasurement, recipientEndpoint, custodianEncKey }) {
  const fronts = obs.lines.front.map((l) => FRONT_OK.exec(l)).filter(Boolean);
  const oks = obs.lines.custodian.map((l) => CUST_OK.exec(l)).filter(Boolean);
  const refusals = obs.lines.custodian.map((l) => CUST_NO.exec(l)).filter(Boolean);
  const reasons = [];
  const bound = /^0x[0-9a-f]{64}$/.test(String(id)) && /^0x[0-9a-f]{64}$/.test(String(custodianEncKey))
    && /^https:\/\//.test(String(recipientEndpoint)) && /^[0-9a-f]{96}$/.test(String(imageMeasurement));
  if (!bound) reasons.push("release identity pins missing");
  if (fronts.some(m => m[1] !== id?.slice(2, 10))) reasons.push("front log names another deployment");
  if (oks.some(m => m[2] !== id || m[3] !== recipientEndpoint || m[1] !== custodianEncKey?.slice(2, 14))) reasons.push("custodian log identity or recipient differs");
  if (!fronts.some((m) => Number(m[2]) === expect.secretRev && m[3] === "1" && m[4] === "1")) reasons.push(`no front line 'secrets revision ${expect.secretRev} from a v2 threshold of 1 over 1'`);
  if (fronts.some((m) => Number(m[2]) !== expect.secretRev)) reasons.push("a front line names another secrets revision");
  if (!oks.length) reasons.push("no custodian 'release <id> ... OK' line for this id");
  if (oks.some((m) => m[6])) reasons.push("a release came from SYNTHETIC roots: never hardware evidence");
  if (oks.some((m) => m[5] !== imageMeasurement.slice(0, 16))) reasons.push("the released guest's measurement is not the pinned recipient image");
  if (refusals.length) reasons.push(`custodian refusals in the window: ${refusals.map((m) => m[4]).join(",")}`);
  if (obs.lines.front.some((l) => FRONT_ERR.test(l) || QUORUM.test(l))) reasons.push("a front custody error in the window");
  if (obs.appAnswered !== true) reasons.push("the app did not answer");
  return { outcome: reasons.length ? "fail" : "pass", reasons,
    evidence: { id, secretRev: expect.secretRev, frontLineCount: obs.lines.front.length, custodianLineCount: obs.lines.custodian.length, appAnswered: obs.appAnswered,
      scope: "Pinned log identities and revision only; require separate fresh SNP quote, log collection provenance and HMAC consumption proof before an end-to-end claim" } };
}

export function evalRefusal({ id, obs, expect, recipientEndpoint, custodianEncKey }) {
  const oks = obs.lines.custodian.filter((l) => CUST_OK.test(l));
  const refusals = obs.lines.custodian.map((l) => CUST_NO.exec(l)).filter(Boolean);
  const matching = refusals.filter((m) => m[2] === id && m[3] === recipientEndpoint && m[1] === custodianEncKey?.slice(2, 14) && expect.codes.includes(m[4]) && (!expect.message || m[5].includes(expect.message)));
  const reasons = [];
  if (!/^0x[0-9a-f]{64}$/.test(String(id)) || !/^0x[0-9a-f]{64}$/.test(String(custodianEncKey)) || !/^https:\/\//.test(String(recipientEndpoint))) reasons.push("refusal identity pins missing");
  if (oks.length) reasons.push("a release was GRANTED for this id in the window");
  if (!matching.length) reasons.push(`no custodian refusal with ${expect.codes.join("|")}${expect.message ? ` mentioning '${expect.message}'` : ""}`);
  if (obs.lines.front.some((l) => FRONT_OK.test(l))) reasons.push("the front reported released secrets");
  if (!obs.lines.front.some((l) => FRONT_ERR.test(l) || QUORUM.test(l))) reasons.push("no front custody error line");
  if (obs.appAnswered !== false) reasons.push("the app answered (it must not start without its secrets)");
  return { outcome: reasons.length ? "fail" : "pass", reasons, evidence: { id, expected: expect.codes, refusalCodes: refusals.map((m) => m[4]),
    frontLineCount: obs.lines.front.length, custodianLineCount: obs.lines.custodian.length, appAnswered: obs.appAnswered } };
}

// counts: { "<set>@<location>": number } from root's search (needles piped over stdin, counts only);
// control: { "<location>": number } hits for the deployment id itself in the same locations.
export function evalMarkerSearch({ sets, counts, control, locations }) {
  const reasons = [];
  if (!Array.isArray(sets) || !sets.length || new Set(sets).size !== sets.length) reasons.push("nonempty distinct marker sets required");
  if (!Array.isArray(locations) || !locations.length || new Set(locations).size !== locations.length) reasons.push("nonempty distinct search locations required");
  if (reasons.length) return { outcome: "fail", reasons, evidence: { scope: "search coverage missing" } };
  for (const loc of locations) {
    if (!Number.isSafeInteger(control?.[loc]) || control[loc] <= 0) reasons.push(`control (the id) not found at ${loc}: the search is not shown to work there`);
    for (const s of sets) {
      const n = counts?.[`${s}@${loc}`];
      if (!Number.isSafeInteger(n) || n < 0) reasons.push(`no count for ${s} at ${loc}`);
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
  if (!/^0x[0-9a-f]{64}$/.test(String(expect.committeeId)) || /^0x0{64}$/.test(expect.committeeId)
    || facts.committeeId !== expect.committeeId) reasons.push("policy committee is not the expected committee");
  if (!prepared?.summary || prepared.summary.committeeId !== expect.committeeId) reasons.push("prepared committee differs");
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
  set("read.old4774", !!c && c.epoch === 1 && c.t === 1 && c.W === 1 && c.machines?.length === 1 && c.machines[0].endpoint === OLD_CUSTODIAN_ENDPOINT
    && c.machines[0].measurement === OLD_CUSTODIAN_MEASUREMENT_SHA, "epoch 1, t 1, W 1, one machine at custody-metal0 with the live measurement");
  set("read.protected4e62", facts.protected?.id === PROTECTED_POLICY_4E62 && /^0x[0-9a-f]{64}$/.test(String(facts.protected?.bundleKeccak)), "0x4e62 snapshot recorded");
  set("read.owner", BigInt(facts.ownerBalanceWei) >= BigInt(pins.budget.totalWei) && Number.isInteger(facts.ownerNonce),
    `balance ${facts.ownerBalanceWei} must back the whole aggregate budget ${pins.budget.totalWei} (plan worst case ${budget.worstCaseWei})`);
  const f = facts.fees || {};
  const feeOk = /^[0-9]+$/.test(String(f.l1UpperBoundWei)) && BigInt(f.l1UpperBoundWei) <= BigInt(pins.fees.l1FeeWei)
    && f.isthmus === true && /^[0-9]+$/.test(String(f.operatorFeeWei)) && BigInt(f.operatorFeeWei) <= BigInt(pins.fees.operatorFeeWei)
    && /^[0-9]+$/.test(String(f.baseFeeWei)) && /^[0-9]+$/.test(String(f.tipWei)) && 2n * BigInt(f.baseFeeWei) + BigInt(f.tipWei) <= BigInt(pins.fees.maxFeePerGasWei);
  set("fees.bounded", feeOk, `L1 bound ${f.l1UpperBoundWei} (size ${f.referenceSize}) <= ${pins.fees.l1FeeWei}; operator fee ${f.operatorFeeWei} (isthmus ${f.isthmus}) <= ${pins.fees.operatorFeeWei}; 2*base ${f.baseFeeWei} + tip ${f.tipWei} <= ${pins.fees.maxFeePerGasWei}`);
  return obs;
}

export function evalCustodianInfo({ info, committee }) {
  const m = committee?.machines?.[0];
  const ok = committee?.machines?.length === 1 && /^0x[0-9a-f]{64}$/.test(String(m?.encKey)) && /^0x[0-9a-fA-F]{64}$/.test(String(info?.encKey)) && String(info?.encKey).toLowerCase() === String(m.encKey).toLowerCase() && String(info?.vault).toLowerCase() === ORIGINAL_VAULT_V2;
  return { "custodian.info": { ok, stepId: "S0.custodian", note: "public /v2/custody/info encKey and vault = the chain machine record" } };
}

export function evalProtectedUnchanged({ before, after }) {
  const keys = ["owner", "policyRev", "secretRev", "paused", "bundleKeccak", "committeeId", "rulesKeccak"];
  const changed = keys.filter((k) => before?.[k] === undefined || after?.[k] === undefined || before[k] === null || after[k] === null || String(before[k]) !== String(after[k]));
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
  if (obs.olderBlobOpened !== true || obs.sameIdentity !== true || typeof obs.custodianRefusedOldState !== "boolean")
    return { outcome: "fail", evidence: { ...evidence, note: "missing observed older-state reopening under the same identity; no production rollback conclusion" } };
  if (detected) return { outcome: "fail", evidence: { ...evidence, note: "a detection was reported where the design has no anchor: re-examine before believing it" } };
  return { outcome: "expected-fail", evidence: { ...evidence, limitation: "no monotonic anchor: an older valid sealed blob is accepted (spec 176-181, host keeps 20 blobs)" } };
}

// Used only with a live collector result; never synthesize log lines from these counts.
export function evalCollectedRelease({id,obs,expect,refusal=false,imageMeasurement,recipientEndpoint,custodianEncKey,window}) {
  const reasons=[],c=window?.counts,fronts=obs.lines.front.map(l=>FRONT_OK.exec(l)).filter(Boolean);
  const fields=['matchingReleases','matchingRefusals','measurementRefusals','wrongIdentity','syntheticReleases','malformedOrError'];
  const valid=window?.status==='custodian-window-collected'&&window.identity?.id===id&&window.identity?.encKey===custodianEncKey
    &&window.identity?.recipientEndpoint===recipientEndpoint&&window.identity?.measurement===imageMeasurement
    &&fields.every(k=>Number.isSafeInteger(c?.[k])&&c[k]>=0)&&c.refusalCodes&&typeof c.refusalCodes==='object';
  if(!valid)return {outcome:'fail',reasons:['live custodian interval or identity missing'],evidence:{id}};
  if(c.wrongIdentity||c.syntheticReleases||c.malformedOrError)reasons.push('custodian interval contains mismatched, synthetic or malformed release evidence');
  if(fronts.some(m=>m[1]!==id.slice(2,10)))reasons.push('front names another deployment');
  const frontError=obs.lines.front.some(l=>FRONT_ERR.test(l)||QUORUM.test(l));
  if(refusal){
    if(c.matchingReleases||fronts.length)reasons.push('release occurred during a refusal test');
    if(!expect.codes.some(code=>Number.isSafeInteger(c.refusalCodes[code])&&c.refusalCodes[code]>0))reasons.push('expected refusal missing from current interval');
    if(expect.message&&(expect.message!=='measurement'||c.measurementRefusals<1))reasons.push('expected refusal detail missing');
    if(!frontError||obs.appAnswered!==false)reasons.push('front refusal and non-serving app required');
  }else{
    if(c.matchingReleases<1||c.matchingRefusals)reasons.push('current custodian release missing or refusal present');
    if(!fronts.some(m=>Number(m[2])===expect.secretRev&&m[3]==='1'&&m[4]==='1')||fronts.some(m=>Number(m[2])!==expect.secretRev))reasons.push('front revision or threshold differs');
    if(frontError||obs.appAnswered!==true)reasons.push('front failed or app did not answer');
  }
  return {outcome:reasons.length?'fail':'pass',reasons,evidence:{id,frontLineCount:obs.lines.front.length,appAnswered:obs.appAnswered,custodianWindow:window,
    scope:'Live custodian log interval plus operator-supplied front observation only. Recipient generation, fresh SNP and HMAC consumption remain separate mandatory gates; this is not a completed lifecycle test.'}};
}


export function evalObservedRelease({id,expect,imageMeasurement,recipientEndpoint,custodianEncKey,window,recipient,appAnswered}) {
  const reasons=[],c=window?.counts,f=recipient?.front;
  const bound=window?.status==='custodian-window-collected'&&recipient?.status==='recipient-observed'&&window.identity?.id===id&&recipient.identity?.id===id
    &&window.identity?.stepHash===recipient.identity?.stepHash&&window.identity?.measurement===imageMeasurement&&recipient.identity?.measurement===imageMeasurement
    &&window.identity?.encKey===custodianEncKey&&window.identity?.recipientEndpoint===recipientEndpoint
    &&window.windowDigest===recipient.custodianWindowDigest&&Number.isSafeInteger(recipient.at)&&window.to>=recipient.at;
  if(!bound)return {outcome:'fail',reasons:['live recipient and custodian identities differ'],evidence:{id}};
  if(!Number.isSafeInteger(c?.matchingReleases)||c.matchingReleases<1||['matchingRefusals','wrongIdentity','syntheticReleases','malformedOrError'].some(k=>c[k]!==0))reasons.push('current custodian release missing, refused or inconsistent');
  if(!Array.isArray(f?.releases)||!f.releases.length||f.releases.some(r=>r.secretRev!==expect.secretRev||r.threshold!==1||r.seats!==1||!Number.isSafeInteger(r.names)||r.names<1))reasons.push('fresh recipient revision or threshold differs');
  if(['custodyErrors','quorumErrors','otherDeployment'].some(k=>f?.[k]!==0)||!Number.isSafeInteger(f?.serving)||f.serving<1)reasons.push('fresh recipient did not serve cleanly');
  if(appAnswered!==true)reasons.push('public app response not observed');
  return {outcome:reasons.length?'fail':'pass',reasons,evidence:{id,secretRev:expect.secretRev,recipient,custodianWindow:window,appAnswered,
    scope:'Fresh local recipient boot and custodian interval observations; public response is operator supplied. Independent recipient SNP verification and fresh HMAC proof remain mandatory before an end-to-end security claim.'}};
}

export function evalObservedRefusal({id,expect,imageMeasurement,recipientEndpoint,custodianEncKey,window,recipient}) {
  const c=window?.counts,f=recipient?.front,reasons=[];
  const bound=window?.status==='custodian-window-collected'&&recipient?.status==='recipient-failure-observed'
    &&window.identity?.id===id&&recipient.identity?.id===id&&window.identity?.stepHash===recipient.identity?.stepHash
    &&window.identity?.measurement===imageMeasurement&&recipient.identity?.measurement===imageMeasurement
    &&window.identity?.encKey===custodianEncKey&&window.identity?.recipientEndpoint===recipientEndpoint
    &&window.windowDigest===recipient.custodianWindowDigest&&Number.isSafeInteger(recipient.at)&&window.to>=recipient.at
    &&recipient.log?.retainedDescriptor===true;
  if(!bound)return {outcome:'fail',reasons:['fresh failed recipient and custodian interval differ'],evidence:{id}};
  if(!Number.isSafeInteger(c?.matchingRefusals)||c.matchingRefusals<1||['matchingReleases','wrongIdentity','syntheticReleases','malformedOrError'].some(k=>c[k]!==0))reasons.push('custodian refusal absent or inconsistent');
  if(!Array.isArray(expect?.codes)||!expect.codes.some(code=>Number.isSafeInteger(c?.refusalCodes?.[code])&&c.refusalCodes[code]>0))reasons.push('expected refusal code absent');
  if(expect.message&&(expect.message!=='measurement'||!Number.isSafeInteger(c?.measurementRefusals)||c.measurementRefusals<1))reasons.push('expected refusal detail absent');
  if(!Array.isArray(f?.releases)||f.releases.length||f.serving!==0||f.otherDeployment!==0)reasons.push('recipient released, served or named another deployment');
  if(!Number.isSafeInteger(f?.custodyErrors)||!Number.isSafeInteger(f?.quorumErrors)||f.custodyErrors+f.quorumErrors<1)reasons.push('complete recipient custody failure absent');
  return {outcome:reasons.length?'fail':'pass',reasons,evidence:{id,recipient,custodianWindow:window,
    scope:'Observed failed canary boot and matched custodian refusal. Does not establish public endpoint unavailability, independent SNP attestation of a failed guest, or completed outage/recovery testing.'}};
}
