#!/usr/bin/env node
// Bounded production canary driver (root-run). One command = at most ONE step; every step is journaled.
//   node driver/cli.mjs plan     --pins pins.json                       the plan, blockers, budget (no network)
//   node driver/cli.mjs status   --pins pins.json                       journal verification + next ready steps (no network)
//   node driver/cli.mjs read     --pins pins.json --step <read step>    agreed-block public reads
//   node driver/cli.mjs probe    --pins pins.json --step <probe step>   public custodian HTTP (pre-attestation only)
//   node driver/cli.mjs recipient-begin|recipient-collect --pins <pins> --step <release step> --generation <timestamp> --confirm <bundle digest> --window <custodian cursor digest> [--attempt <recipient cursor digest>]   authenticated local observation only
//   node driver/cli.mjs recipient-refusal --pins <pins> --step <refusal step> --step-hash <step hash> --generation <timestamp> --confirm <bundle digest> --window <cursor digest> --attempt <recipient digest>   observe a live failed boot for up to60seconds, then record matching refusal
//   node driver/cli.mjs custodian-window-begin|custodian-window-collect --pins <pins> --step <release/refusal> --generation <timestamp> --confirm <bundle digest> [--window <cursor digest>]   private interval counts only; never a lifecycle pass
//   node driver/cli.mjs recovery-prepare --pins <pins> --step O.timeout|O.restart --generation <timestamp> [--previous-generation <timestamp> --previous-digest <digest>]   no process starts
//   node driver/cli.mjs recovery-start --pins <pins> --step O.timeout|O.restart --generation <timestamp> --confirm <digest>   one bounded successor, no transaction sends
//   node driver/cli.mjs recovery-verify --pins <pins> --step O.restart --generation <timestamp> --confirm <digest>   fresh local/public SNP + original committee; NOT a recipient/lifecycle pass
//   node driver/cli.mjs recovery-inspect|recovery-stopped|recovery-stop --pins <pins> --step O.timeout|O.restart --generation <timestamp> --confirm <digest>   observed process operation, never a lifecycle pass
//   node driver/cli.mjs launch-prepare --pins pins.json --step G.launch   stage isolated capture-only launch files; no VM starts
//   node driver/cli.mjs launch-check --pins pins.json --step G.launch --confirm <package digest>   reverify fresh files only
//   node driver/cli.mjs launch-start --pins pins.json --step G.launch --confirm <package digest>   ONE bounded transient canary unit
//   node driver/cli.mjs launch-inspect --pins pins.json --step G.launch --confirm <package digest>   actual Linux runtime observations; NOT a G.launch pass
//   node driver/cli.mjs launch-verify --pins pins.json --step G.launch --confirm <package digest>   collect runtime + ingress + local/public SNP evidence; journal G.launch only on all checks
//   node driver/cli.mjs ingress-inspect --pins pins.json --step G.launch   live route, process and rejection checks; NOT a G.launch pass
//   node driver/cli.mjs launch-stopped --pins <pins> --step G.launch --confirm <package digest>   live absence and retained ciphertext evidence; NOT an outage pass
//   node driver/cli.mjs launch-stop --pins pins.json --step G.launch --confirm <package digest>   only the recorded unit invocation; state retained
//   node driver/cli.mjs markers  --pins pins.json --step S1.markers     create the marker sets (private/, 0600)
//   node driver/cli.mjs needles  --pins pins.json --set <set>           private/needles-<set>.txt for root's remote search (stdin)
//   node driver/cli.mjs prepare  --pins pins.json --step <mutation>     calldata + priced send plan -> private/, prints the prepared hash
//   node driver/cli.mjs execute  --pins pins.json --step <mutation> --confirm <prepared hash>   ONE owner transaction (sender.mjs)
//   node driver/cli.mjs resume   --pins pins.json --step <mutation> [--rebroadcast]   an unknown outcome; NEVER signs
//   node driver/cli.mjs gate     --pins pins.json --step <spending CLI step>   the aggregate-budget gate before root runs that CLI
//   node driver/cli.mjs simulate --pins pins.json --step <N.sim.*>      eth_call only
//   node driver/cli.mjs relay    --pins pins.json --step <relay step> --confirm <step hash>      owner-signed relay call(s)
//   node driver/cli.mjs record   --pins pins.json --step <operator|hardware step> --obs obs.json --confirm <step hash>
// The owner key is read ONLY from the env var named by pins.owner.keyEnv, ONLY by execute, relay and the migration prepare, and is
// registered with the output guard. Nothing prints marker values, keys, raw sealed state or wallet data.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { sha256hex } from "./canonical.mjs";
import { createGuard, encodingsOf } from "./guard.mjs";
import { buildPlan, ORIGINAL_VAULT_V2, OLD_COMMITTEE_4774, PROTECTED_POLICY_4E62, OLD_CUSTODIAN_ENDPOINT, KNOWN_LACKING_CONTROL_MANIFESTS } from "./plan.mjs";
import { readJournal, readyToRun, makeEntry, appendEntry } from "./journal.mjs";
import { createMarkerSet, loadMarkerSet, guardPrivateDir, commitmentOf } from "./markers.mjs";
import { loadClient, prepareMutation, prepareSimulation, writePrivate } from "./prepare.mjs";
import { checkTxAgainstStep, simulateRefusal } from "./tx.mjs";
import { createSender, receiptCosts, ORACLE } from "./sender.mjs";
import { gate as budgetGate, allowanceOf, spentOf } from "./budget.mjs";
import { createRelay, evalLegacyCheck, evalRelayRefusals, evalClearProof } from "./relay.mjs";
import { probeNonce, probeStale } from "./probe.mjs";
import {probeOldCommittee} from "./probe-old-committee.mjs";
import * as A from "./assert.mjs";
import {beginRecipientAttempt,collectRecipientAttempt,saveRecipientAttempt,loadRecipientAttempt} from "./recipient-observer.mjs";
import {loadRecipientClient} from "./recipient-client.mjs";
import {loadRecipientAttestor,verifyLiveRecipient} from "./recipient-attestation.mjs";
import {proveLiveRecipient} from "./recipient-proof.mjs";
import {observeFailedRecipient} from "./recipient-failure.mjs";
import {beginCustodianWindow,collectCustodianWindow,saveCustodianWindow,loadCustodianWindow} from "./custodian-window.mjs";
import { proveConsumption } from "./proof.mjs";
import {readHostStep,readGenesisStep,readRecoveryGenesis} from "./read-steps.mjs";
import {loadR2Attestor} from "./r2-attestor.mjs";
import {compileCapturedGenesis,requireFreshQuote} from "./genesis-submit.mjs";
import {startCanaryRuntime,inspectCanaryRuntime,stopCanaryRuntime,inspectStoppedCanaryRuntime} from './launch-runtime.mjs';
import {generationOptions,prepareCanaryRecovery,startCanaryRecovery,verifyRecoveredCanary} from './recovery-runtime.mjs';
import {inspectIngress} from './launch-ingress.mjs';
import {verifyLaunch} from './launch-verify.mjs';
import {stageLaunchBundle,verifyLaunchBundle} from "./launch-bundle.mjs";
import { evalCliPins, checkCliTargets, parsePins, REVIEWED, BOOK } from "./clipins.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const MARKER_SETS = { "c1-rev1": ["CANARY_A", "CANARY_B"], "c1-rev2": ["CANARY_A", "CANARY_B"], "c2-legacy": ["CANARY_A", "CANARY_B"], "c2-rev2": ["CANARY_A", "CANARY_B"], "c3-rev1": ["CANARY_A", "CANARY_B"] };

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const guard = createGuard();
const out = (v) => { guard.check(v, "stdout"); process.stdout.write(JSON.stringify(v, (k, x) => typeof x === "bigint" ? String(x) : x, 1) + "\n"); };

export function assertManualLifecycleRecord(step) {
  if (step?.expectOutage || step?.expectRestart) throw new Error('Outage and restart steps require live lifecycle verification; generic release logs cannot prove recovery');
}

export function loadPins(file) {
  const pins = JSON.parse(fs.readFileSync(file, "utf8"));
  return pins;
}

// The pinned client repo: HEAD commit, clean tracked tree, and every listed file's sha256.
export function checkRepo(pins, git = (args) => execFileSync("git", ["-C", pins.repo.path, ...args], { encoding: "utf8", timeout: 30_000 })) {
  const repo = pins.repo.path;
  if (!path.isAbsolute(repo) || fs.realpathSync(repo) !== repo) throw new Error("repo.path: absolute, non-symlinked");
  if (git(["rev-parse", "HEAD"]).trim() !== pins.repo.commit) throw new Error("repo HEAD is not the pinned commit");
  if (git(["status", "--porcelain", "--untracked-files=no"]).trim()) throw new Error("repo has modified tracked files");
  for (const [rel, want] of Object.entries(pins.repo.files)) if (sha256hex(fs.readFileSync(path.join(repo, rel))) !== want) throw new Error(`${rel}: not the pinned file`);
}

function dirs(pins) {
  const run = path.join(ROOT, "runs", pins.runLabel);
  const priv = path.join(ROOT, "private", pins.runLabel);
  for (const d of [path.join(ROOT, "runs"), path.join(ROOT, "private"), run, priv]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { mode: 0o700 });
    fs.chmodSync(d, 0o700);
  }
  guardPrivateDir(priv);
  return { journal: path.join(run, "journal.jsonl"), priv };
}

function state(pins) {
  const { journal, priv } = dirs(pins);
  const planFor = (obs, ids) => buildPlan(pins, obs, ids);
  const j = readJournal(journal, planFor);
  // every marker set that exists is registered with the guard before anything is printed or journaled
  for (const set of Object.keys(MARKER_SETS)) {
    if (!fs.existsSync(path.join(priv, `markers-${set}.json`))) continue;
    for (const v of Object.values(loadMarkerSet({ dir: priv, set }).values)) guard.register(v);
  }
  return { journal, priv, ...j };
}

function stepOrDie(st, id, kinds) {
  const r = readyToRun(st.plan, st.done, id);
  if (!r.ok) throw new Error(r.reason);
  if (kinds && !kinds.includes(r.step.kind)) throw new Error(`${id} is a ${r.step.kind} step, not ${kinds.join("|")}`);
  return r.step;
}
function journalIt(st, step, res) {
  const entry = makeEntry({ plan: st.plan, head: st.head, seq: st.entries.length, step, outcome: res.outcome, evidence: res.evidence });
  appendEntry(st.journal, entry, guard);
  out({ step: step.id, outcome: res.outcome, reasons: res.reasons, entryHash: entry.entryHash });
}

async function signer(pins, client) {
  const key = process.env[pins.owner.keyEnv];
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(key))) throw new Error(`env ${pins.owner.keyEnv} does not hold an owner key`);
  guard.register(key);
  const { privateKeyToAccount } = await import(pathToFileURL(path.join(pins.repo.path, "node_modules/viem/_esm/accounts/index.js")).href);
  const account = privateKeyToAccount(key);
  if (account.address.toLowerCase() !== pins.owner.address.toLowerCase()) throw new Error("the key in that env var is not the pinned canary owner");
  return account;
}

async function senderOf(pins, client, dir) {
  const accounts = await import(pathToFileURL(path.join(pins.repo.path, "node_modules/viem/_esm/accounts/index.js")).href);
  return { accounts, sender: createSender({ viem: client.viem, accounts, rpcs: pins.sendRpcs, dir, vault: ORIGINAL_VAULT_V2, vaultCodeHash: pins.vaultCodeHash }) };
}

async function chainOf(pins, client) {
  const { createChainReaderV2 } = await import(pathToFileURL(path.join(pins.repo.path, "custody/v2/chain.mjs")).href);
  const { custodyVaultKind } = await import(pathToFileURL(path.join(pins.repo.path, "network/custody-vaults.mjs")).href);
  const reader = createChainReaderV2({ rpcs: pins.rpcs, vault: ORIGINAL_VAULT_V2, ...custodyVaultKind(ORIGINAL_VAULT_V2), chainId: 8453,
    minAgree: Math.floor(pins.rpcs.length / 2) + 1, confirmations: 2 });
  const pub = pins.rpcs.map((url) => client.viem.createPublicClient({ transport: client.viem.http(url, { timeout: 10_000, retryCount: 0 }) }));
  // balance/nonce: every RPC must answer the same value at the same block, else refuse (no "best of")
  const agreedScalar = async (fn) => {
    const bn = await pub[0].getBlockNumber() - 2n;
    const vals = await Promise.all(pub.map((c) => fn(c, bn)));
    if (vals.some((v) => v !== vals[0])) throw new Error("RPCs disagree on an owner scalar; retry later");
    return vals[0];
  };
  return { reader, pub, agreedScalar };
}

// the GasPriceOracle bounds at an agreed block (every RPC must answer the same), and the worst current base fee / tip.
// A PRE-CHECK at a pinned reference size only: every update is re-sized from its exact signed maximum at prepare/send.
async function feeFacts(pins, client, plan) {
  const { pub, agreedScalar } = await chainOf(pins, client);
  const ORACLE_ABI = [{ type: "function", name: "getL1FeeUpperBound", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
    { type: "function", name: "isIsthmus", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
    { type: "function", name: "getOperatorFee", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] }];
  const rd = (functionName, args = []) => agreedScalar((c, blockNumber) => c.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName, args, blockNumber }));
  const maxGas = plan.steps.filter((s) => s.mutation).reduce((m, s) => (BigInt(s.mutation.gasCap) > m ? BigInt(s.mutation.gasCap) : m), 0n);
  const referenceSize = BigInt(pins.fees.referenceUnsignedSize);
  const isthmus = await rd("isIsthmus");
  const blocks = await Promise.all(pub.map((c) => c.getBlock({ blockTag: "latest" })));
  const tips = await Promise.all(pub.map((c) => c.request({ method: "eth_maxPriorityFeePerGas" }).then(BigInt)));
  return { referenceSize: String(referenceSize), l1UpperBoundWei: String(await rd("getL1FeeUpperBound", [referenceSize])), isthmus,
    // not Isthmus = the operator fee is UNDETERMINED (no zero claim): fees.bounded then fails
    operatorFeeWei: isthmus === true ? String(await rd("getOperatorFee", [maxGas])) : "undetermined", operatorFeeAtGas: String(maxGas),
    baseFeeWei: String(blocks.map((b) => b.baseFeePerGas).reduce((a, x) => (x > a ? x : a), 0n)), tipWei: String(tips.reduce((a, x) => (x > a ? x : a), 0n)) };
}

const policyFacts = (client, st) => ({ block: String(st.blockNumber ?? ""), owner: st.policy.owner, policyRev: String(st.policy.policyRev), secretRev: String(st.policy.secretRev),
  committeeId: st.policy.committeeId, paused: st.policy.paused, rulesKeccak: client.viem.keccak256(st.policy.rules),
  bundleKeccak: st.bundle.data.length ? client.viem.keccak256(st.bundle.data) : null, bundleBytes: st.bundle.data.length });

function finishGenesis(st,step,res,rec) {
  const outcome={verified:"pass",failed:"fail",conflict:"aborted"}[res.status];
  if(!outcome)return out({step:step.id,status:res.status,txHash:res.txHash,note:res.note,next:"resume G.genesis; never sign a replacement intent"});
  return journalIt(st,step,{outcome,evidence:{txHash:res.txHash,nonce:res.nonce,receipt:res.receipt,
    costWei:res.status==="conflict"?"0":res.costWei,preparedHash:rec.sendPlan.preparedHash,captureDigest:rec.captureDigest,
    resolves:{"committee.genesis":{ok:res.status==="verified",stepId:step.id,note:"Bounded creation intent confirmed; fresh quote plus full committee verification is still required in G.verify."}}}});
}

async function main() {
  const cmd = process.argv[2];
  const pins = loadPins(arg("pins"));
  if (!["plan","status","launch-stop","recovery-stop"].includes(cmd)) checkRepo(pins);
  const st = state(pins);
  if (cmd === "plan" || cmd === "status") {
    return out({ pinsHash: st.plan.pinsHash, statement: st.plan.statement, budget: st.plan.budget, disabledCases: st.plan.disabledCases, ids: st.ids, journalHead: st.head,
      steps: st.plan.steps.map((s) => ({ id: s.id, kind: s.kind, status: st.done.has(s.id) ? `recorded:${st.done.get(s.id).outcome}` : s.status === "blocked" ? "blocked" : readyToRun(st.plan, st.done, s.id).ok ? "ready" : "waiting", stepHash: s.stepHash, title: s.title, blockedBy: s.blockedBy })) });
  }
  const id = arg("step");
  if(cmd==="launch-stop"||cmd==="launch-stopped") {
    if(id!=="G.launch")throw Error("canary stop is only for G.launch");
    return out((cmd==="launch-stop"?stopCanaryRuntime:inspectStoppedCanaryRuntime)({pins,bundle:path.join(st.priv,"r2-launch-"+pins.runLabel),digest:arg("confirm"),runtimeDir:path.join(st.priv,"runtime-"+pins.runLabel)}));
  }
  if(["recovery-stop","recovery-inspect","recovery-stopped"].includes(cmd)) {
    if(!["O.timeout","O.restart"].includes(id))throw Error("recovery inspection/stop requires a lifecycle step");
    const options=generationOptions({pins,runLabel:arg("generation"),digest:arg("confirm")});
    if(options.runLabel===pins.runLabel)throw Error("use the original launch commands for its generation");
    return out((cmd==="recovery-stop"?stopCanaryRuntime:cmd==="recovery-stopped"?inspectStoppedCanaryRuntime:inspectCanaryRuntime)(options));
  }
  const client = await loadClient(pins.repo.path);
  const relay = createRelay({ api: pins.relay.api });
  const C = { C1: st.ids.C1, C2: st.ids.C2, C3: st.ids.C3 };

  async function windowArgs(step,runLabel,digest) {
    if((!step.expectRelease&&!step.expectRefusal)||step.custodian==="old")throw Error("log windows require a release/refusal step on the dedicated new custodian");
    const origin=st.done.get("G.launch"),genesis=st.done.get("G.verify");
    if(origin?.outcome!=="pass"||genesis?.outcome!=="pass"||!st.ids.COMMITTEE)throw Error("verified original launch and committee required");
    const options=generationOptions({pins,runLabel:runLabel||pins.runLabel,digest});
    const v=options.verifyBundle({pins,bundle:options.bundle,expectedDigest:options.digest,requireFresh:false});
    const originDigest=origin.evidence.runtime.bundleDigest;
    if(options.runLabel===pins.runLabel?options.digest!==originDigest:(v.recovery?.mode!=="restore"||v.recovery?.originDigest!==originDigest||v.recovery?.committeeId!==st.ids.COMMITTEE))throw Error("log generation is not the verified canary or its normal recovery");
    const {reader}=await chainOf(pins,client),{committee}=await reader.readCommittee({committeeId:st.ids.COMMITTEE});
    if(committee?.machines?.length!==1)throw Error("original single-seat canary committee required");
    const identity={id:C[step.deployment],encKey:committee.machines[0].encKey,stepHash:step.stepHash,measurement:pins.image.measurement,recipientEndpoint:pins.recipient.endpoint};
    const args={dir:path.join(options.bundle,"logs"),identity,inspectRuntime:()=>inspectCanaryRuntime(options)},name=`custodian-window-${step.id}-${options.runLabel}.json`;
    return {args,name};
  }
  async function recipientObservation(step,runLabel,bundleDigest,windowDigest,attemptDigest,begin=false) {
    if((!step.expectRelease&&!step.expectRefusal)||step.custodian==='old')throw Error('recipient observer requires a release/refusal step on the dedicated new committee');
    const {args,name}=await windowArgs(step,runLabel,bundleDigest),w=loadCustodianWindow({dir:st.priv,name,digest:windowDigest});
    // Reconcile the live custodian interval before observing this recipient attempt.
    await collectCustodianWindow({...args,...w});
    const generation=runLabel||pins.runLabel,recipientName=`recipient-${step.id}-${generation}.json`;
    const identity={id:C[step.deployment],stepHash:step.stepHash,appId:pins.image.appId,runtimeId:pins.image.runtimeId,measurement:pins.image.measurement};
    const recipientClient=await loadRecipientClient(pins);
    try {
      const common={identity,client:recipientClient};
      if(begin)return saveRecipientAttempt({dir:st.priv,name:recipientName,attempt:await beginRecipientAttempt({...common,custodianWindowDigest:windowDigest})});
      if(!step.expectRelease)throw Error('use recipient-refusal to observe failed boots live');
      const attempt=loadRecipientAttempt({dir:st.priv,name:recipientName,digest:attemptDigest});
      if(attempt.cursor.custodianWindowDigest!==windowDigest||attempt.cursor.beganAt<w.cursor.beganAt)throw Error('recipient attempt is not bound to this custodian interval');
      return await collectRecipientAttempt({...common,...attempt});
    }finally{recipientClient.close();}
  }
  if(cmd==='recipient-begin'||cmd==='recipient-collect') {
    const step=stepOrDie(st,id,['hardware']);
    return out(await recipientObservation(step,arg('generation'),arg('confirm'),arg('window'),arg('attempt'),cmd==='recipient-begin'));
  }
  if(cmd==='recipient-refusal') {
    const step=stepOrDie(st,id,['hardware']);
    if(!step.expectRefusal||step.custodian==='old'||arg('step-hash')!==step.stepHash)throw Error('dedicated refusal step and exact step hash required');
    const generation=arg('generation')||pins.runLabel,{args,name}=await windowArgs(step,generation,arg('confirm'));
    const w=loadCustodianWindow({dir:st.priv,name,digest:arg('window')});await collectCustodianWindow({...args,...w});
    const attempt=loadRecipientAttempt({dir:st.priv,name:`recipient-${step.id}-${generation}.json`,digest:arg('attempt')});
    if(attempt.cursor.custodianWindowDigest!==w.digest||attempt.cursor.beganAt<w.cursor.beganAt)throw Error('recipient attempt is not bound to the current custodian interval');
    const identity={id:C[step.deployment],stepHash:step.stepHash,appId:pins.image.appId,runtimeId:pins.image.runtimeId,measurement:pins.image.measurement};
    const reader=await loadRecipientClient(pins);let recipient;
    try{recipient=await observeFailedRecipient({identity,...attempt,client:reader});}finally{reader.close();}
    const window=await collectCustodianWindow({...args,...w});
    return journalIt(st,step,A.evalObservedRefusal({id:identity.id,expect:step.expectRefusal,imageMeasurement:pins.image.measurement,
      recipientEndpoint:args.identity.recipientEndpoint,custodianEncKey:args.identity.encKey,window,recipient}));
  }
  if(cmd==="custodian-window-begin"||cmd==="custodian-window-collect") {
    const step=stepOrDie(st,id,["hardware"]),{args,name}=await windowArgs(step,arg("generation"),arg("confirm"));
    if(cmd==="custodian-window-begin")return out(saveCustodianWindow({dir:st.priv,name,window:await beginCustodianWindow(args)}));
    const w=loadCustodianWindow({dir:st.priv,name,digest:arg("window")});
    return out(await collectCustodianWindow({...args,...w}));
  }
  if(cmd==="recovery-verify") {
    if(id!=="O.restart"||st.done.get("G.genesis")?.outcome!=="pass"||!st.ids.COMMITTEE)throw Error("original confirmed committee required for recovery verification");
    const options=generationOptions({pins,runLabel:arg("generation"),digest:arg("confirm")}),v=options.verifyBundle({pins,bundle:options.bundle,expectedDigest:options.digest,requireFresh:false});
    if(v.recovery?.mode!=="restore"||v.recovery?.originDigest!==st.done.get("G.launch")?.evidence?.runtime?.bundleDigest||v.recovery?.committeeId!==st.ids.COMMITTEE)throw Error("verified normal recovery package required");
    const {reader}=await chainOf(pins,client),attestLocal=await loadR2Attestor(pins,{loopback:true}),attestPublic=await loadR2Attestor(pins);
    const {VAULT_V2_ABI:abi}=await import(pathToFileURL(path.join(pins.repo.path,"custody/v2/chain.mjs")).href);
    const clients=pins.sendRpcs.map(url=>client.viem.createPublicClient({transport:client.viem.http(url,{timeout:10000,retryCount:0})}));
    const inspectRuntime=()=>inspectCanaryRuntime(options);
    return out(await verifyRecoveredCanary({committeeId:st.ids.COMMITTEE,digest:options.digest,inspectRuntime,
      verifyLaunch:()=>verifyLaunch({pins,digest:options.digest,inspectRuntime,inspectIngress:()=>inspectIngress({pins}),readHost:()=>readHostStep({reader}),attestLocal,attestPublic}),
      verifyGenesis:()=>readGenesisStep({attest:attestPublic,reader,clients,viem:client.viem,abi,txHash:st.done.get("G.genesis").evidence.txHash,pins})}));
  }
  if(cmd==="recovery-prepare"||cmd==="recovery-start") {
    stepOrDie(st,id,["hardware"]);if(!["O.timeout","O.restart"].includes(id))throw Error("recovery is only for a ready lifecycle step");
    const genesis=st.done.get("G.genesis"),verified=st.done.get("G.verify"),launch=st.done.get("G.launch");
    if([genesis,verified,launch].some(e=>e?.outcome!=="pass")||!st.ids.COMMITTEE)throw Error("confirmed original canary genesis and launch required");
    const {reader}=await chainOf(pins,client),{VAULT_V2_ABI:abi}=await import(pathToFileURL(path.join(pins.repo.path,"custody/v2/chain.mjs")).href);
    const clients=pins.sendRpcs.map(url=>client.viem.createPublicClient({transport:client.viem.http(url,{timeout:10000,retryCount:0})}));
    const readGenesis=()=>readRecoveryGenesis({dir:pins.custodian.captureDir,endpoint:pins.custodian.endpoint,reader,clients,viem:client.viem,abi,txHash:genesis.evidence.txHash,pins,captureDigest:genesis.evidence.captureDigest,committeeId:st.ids.COMMITTEE});
    const mode=id==="O.timeout"?"state-503":"restore",runLabel=arg("generation"),originDigest=launch.evidence.runtime.bundleDigest;
    if(cmd==="recovery-prepare")return out(await prepareCanaryRecovery({pins,originDigest,previousLabel:arg("previous-generation")||pins.runLabel,previousDigest:arg("previous-digest")||originDigest,generation:runLabel,mode,committeeId:st.ids.COMMITTEE,readGenesis}));
    const options=generationOptions({pins,runLabel,digest:arg("confirm")});
    const v=options.verifyBundle({pins,bundle:options.bundle,expectedDigest:options.digest,requireFresh:true});
    if(v.recovery?.mode!==mode||v.recovery?.originDigest!==originDigest||v.recovery?.committeeId!==st.ids.COMMITTEE)throw Error("recovery package does not match this lifecycle step and learned committee");
    return out(await startCanaryRecovery({pins,runLabel,digest:options.digest,readGenesis,readAuthority:()=>readHostStep({reader})}));
  }
  if(cmd==="launch-verify") {
    const step=stepOrDie(st,id,["hardware"]);if(id!=="G.launch")throw Error("launch verification is only for G.launch");
    const options={pins,bundle:path.join(st.priv,"r2-launch-"+pins.runLabel),digest:arg("confirm"),runtimeDir:path.join(st.priv,"runtime-"+pins.runLabel)};
    const {reader}=await chainOf(pins,client),attestLocal=await loadR2Attestor(pins,{loopback:true}),attestPublic=await loadR2Attestor(pins);
    return journalIt(st,step,await verifyLaunch({pins,digest:options.digest,inspectRuntime:()=>inspectCanaryRuntime(options),inspectIngress:()=>inspectIngress({pins}),readHost:()=>readHostStep({reader}),attestLocal,attestPublic}));
  }
  if(cmd==="ingress-inspect") {
    stepOrDie(st,id,["hardware"]);if(id!=="G.launch")throw Error("ingress inspection is only for G.launch");
    return out(await inspectIngress({pins}));
  }
  if(cmd==="launch-start"||cmd==="launch-inspect") {
    stepOrDie(st,id,["hardware"]);if(id!=="G.launch")throw Error("canary runtime is only for G.launch");
    const options={pins,bundle:path.join(st.priv,"r2-launch-"+pins.runLabel),digest:arg("confirm"),runtimeDir:path.join(st.priv,"runtime-"+pins.runLabel)};
    if(cmd==="launch-inspect")return out(inspectCanaryRuntime(options));
    const {reader}=await chainOf(pins,client);
    return out(await startCanaryRuntime({...options,readAuthority:()=>readHostStep({reader})}));
  }
  if (cmd === "launch-prepare" || cmd === "launch-check") {
    stepOrDie(st, id, ["hardware"]);
    if(id!=="G.launch")throw Error("launch packaging is only for G.launch");
    const name="r2-launch-"+pins.runLabel;
    if(cmd==="launch-prepare")return out(stageLaunchBundle({pins,parent:st.priv,name}));
    return out(verifyLaunchBundle({pins,bundle:path.join(st.priv,name),expectedDigest:arg("confirm")}));
  }
  if (cmd === "proof") {
    const step = stepOrDie(st, id, ["proof"]);
    const required = step.proof.sets.map(set => loadMarkerSet({dir:st.priv,set}).values);
    const rejected = (step.proof.notSets || []).map(set => loadMarkerSet({dir:st.priv,set}).values);
    const releaseStep=st.plan.steps.find(s=>step.after.includes(s.id)&&s.expectRelease&&s.deployment===step.deployment);
    if(!releaseStep)throw Error('proof requires its exact release predecessor');
    // The original source-committee path retains its explicitly limited legacy evidence.
    if(releaseStep.custodian==='old')return journalIt(st,step,await proveConsumption({id:C[step.deployment],required,rejected}));
    const release=st.done.get(releaseStep.id),ctx=release?.evidence?.recipientContext;
    if(release?.outcome!=='pass'||!ctx||release.evidence.recipientAttestation?.status!=='recipient-attested')throw Error('fresh attested release predecessor required');
    const observeRecipient=()=>recipientObservation(releaseStep,ctx.generation,ctx.bundleDigest,ctx.windowDigest,ctx.attemptDigest);
    const attest=await loadRecipientAttestor(pins);
    return journalIt(st,step,await proveLiveRecipient({id:C[step.deployment],pins,required,rejected,observeRecipient,attest}));
  }
  if (cmd === "markers") {
    const step = stepOrDie(st, id, ["local"]);
    const commitments = {};
    for (const [set, names] of Object.entries(MARKER_SETS)) {
      const m = createMarkerSet({ dir: st.priv, run: pins.runLabel, set, names });
      for (const v of Object.values(m.values)) guard.register(v);
      commitments[set] = m.commitments;
    }
    return journalIt(st, step, { outcome: "pass", evidence: { commitments } });
  }
  if (cmd === "needles") {
    const set = arg("set");
    const m = loadMarkerSet({ dir: st.priv, set });
    const lines = Object.values(m.values).flatMap((v) => encodingsOf(v));
    const file = writePrivate(st.priv, `needles-${set}-${Date.now()}.txt`, null);
    fs.writeFileSync(file, lines.join("\n") + "\n");
    return out({ set, needlesFile: file, needles: lines.length, use: "ssh <host> 'grep -rcFf /dev/stdin <paths> | grep -v :0$ | wc -l' < needlesFile  (counts only)" });
  }
  if (cmd === "read") {
    const step = stepOrDie(st, id, ["read"]);
    const { reader, agreedScalar } = await chainOf(pins, client);
    if (id === "G.host") return journalIt(st,step,await readHostStep({reader}));
    if (id === "G.verify") {
      const attest=await loadR2Attestor(pins);
      const {VAULT_V2_ABI:abi}=await import(pathToFileURL(path.join(pins.repo.path,"custody/v2/chain.mjs")).href);
      const clients=pins.sendRpcs.map(url=>client.viem.createPublicClient({transport:client.viem.http(url,{timeout:10000,retryCount:0})}));
      return journalIt(st,step,await readGenesisStep({attest,reader,clients,viem:client.viem,abi,txHash:st.done.get("G.genesis")?.evidence?.txHash,pins}));
    }
    if (id === "S0.chain" || id === "Z.final") {
      const [vid, com, prot] = await Promise.all([reader.readVaultIdentity(), reader.readCommittee({ committeeId: OLD_COMMITTEE_4774 }), reader.readRelease({ id: PROTECTED_POLICY_4E62, endpoint: null })]);
      const ownerBalanceWei = String(await agreedScalar((c, blockNumber) => c.getBalance({ address: pins.owner.address, blockNumber })));
      const ownerNonce = await agreedScalar((c, blockNumber) => c.getTransactionCount({ address: pins.owner.address, blockNumber }));
      const facts = { vaultCodeHash: vid.codeHash, committee: com.committee && { epoch: com.committee.epoch, t: com.committee.t, W: com.committee.W,
        machines: com.committee.machines.map((m) => ({ endpoint: m.endpoint, encKey: m.encKey, measurement: m.measurement })) }, pending: !!com.pending,
        protected: { id: PROTECTED_POLICY_4E62, ...policyFacts(client, prot) }, ownerBalanceWei, ownerNonce, fees: await feeFacts(pins, client, st.plan) };
      if (id === "S0.chain") {
        const resolves = A.evalInventory({ facts, pins, budget: st.plan.budget });
        const ok = Object.values(resolves).every((r) => r.ok);
        return journalIt(st, step, { outcome: ok ? "pass" : "fail", evidence: { facts, resolves } });
      }
      const before = st.done.get("S0.chain").evidence.facts;
      const prot2 = A.evalProtectedUnchanged({ before: before.protected, after: facts.protected });
      const sent = st.entries.filter((e) => e.kind === "mutation" && e.evidence?.txHash).length;
      const nonceDelta = facts.ownerNonce - before.ownerNonce;
      const ok = prot2.outcome === "pass" && JSON.stringify(facts.committee) === JSON.stringify(before.committee);
      return journalIt(st, step, { outcome: ok ? "pass" : "fail", evidence: { facts, protectedUnchanged: prot2.evidence, nonceDelta, transactionsThisJournal: sent,
        note: "nonce delta also counts the CLI's own deployment create/stop transactions" } });
    }
    if (id === "S0.clipins") {
      const file = path.join(ROOT, pins.cli.pinsFile);
      if (fs.realpathSync(file) !== file) throw new Error("cli.pinsFile must not be a symlink");
      const pinsText = fs.readFileSync(file, "utf8");
      if (sha256hex(pinsText) !== pins.cli.pinsSha256) throw new Error("the CLI pins file is not the pinned bytes");
      const P = parsePins(pinsText);
      const addrs = [...new Set([...Object.values(P), ...Object.values(REVIEWED).map((r) => r.address)].filter((a) => !/^0x0{40}$/.test(a)))];
      const codeHashes = {};
      for (const a of addrs) codeHashes[a] = await agreedScalar((c, blockNumber) => c.getCode({ address: a, blockNumber }).then((code) => client.viem.keccak256(code || "0x")));
      const BOOK_ABI = [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }];
      const VAULT_BOOK_ABI = [{ type: "function", name: "book", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
      const book = {};
      for (const k of ["deployments", "registry", "appCatalog", "sessionVaultFactory"])
        book[k] = (await agreedScalar((c, blockNumber) => c.readContract({ address: BOOK, abi: BOOK_ABI, functionName: "addr", args: [client.viem.stringToHex(k, { size: 32 })], blockNumber }))).toLowerCase();
      const vaultBook = (await agreedScalar((c, blockNumber) => c.readContract({ address: ORIGINAL_VAULT_V2, abi: VAULT_BOOK_ABI, functionName: "book", blockNumber }))).toLowerCase();
      const r = evalCliPins({ pinsText, facts: { codeHashes, book, vaultBook } });
      return journalIt(st, step, { outcome: r.ok ? "pass" : "fail", reasons: r.reasons, evidence: { pinsSha256: r.pinsSha256, book, vaultBook, codeHashes, reasons: r.reasons,
        resolves: { "cli.pins": { ok: r.ok, note: `pins ${r.pinsSha256}` } } } });
    }
    const which = step.deployment || (id.startsWith("M.") ? "C2" : "C1");
    const dep = C[which];
    const r = await reader.readRelease({ id: dep, endpoint: pins.recipient.endpoint });
    const facts = { id: dep, ...policyFacts(client, r), beneficialOwner: r.beneficialOwner, leaseRunnerIsRecipient: r.lease?.runner === r.endpointId,
      leaseLive: !!r.lease && r.lease.leaseUntil > Math.floor(Date.now() / 1000), relayCustody: (await relay.exists(dep)).custody };
    if (step.resolves?.length) {   // D1.check / D2.check
      const ex = await relay.exists(dep);
      const ok = facts.policyRev === "0" && facts.beneficialOwner === pins.owner.address.toLowerCase() && facts.leaseRunnerIsRecipient && facts.leaseLive && ex.exists === false;
      return journalIt(st, step, { outcome: ok ? "pass" : "fail", evidence: { facts, relayExists: ex.exists, resolves: { [step.resolves[0]]: { ok, note: "owner, policyRev 0, live lease on the recipient, no relay record" } } } });
    }
    const prepStep = step.after[0];
    const prepared = JSON.parse(fs.readFileSync(path.join(st.priv, `prepared-${prepStep}.json`), "utf8")).calldata;
    const expect = { policyRev: String(BigInt(prepared.summary.expectPolicyRev) + 1n), secretRev: prepared.summary.nextSecretRev, custodyFlag: true, committeeId: step.committee === "old" ? OLD_COMMITTEE_4774 : st.ids.COMMITTEE };
    return journalIt(st, step, A.evalPolicyCheck({ facts, expect, ownerAddress: pins.owner.address, prepared }));
  }
  if (cmd === "probe") {
    const step = stepOrDie(st, id, ["probe"]);
    if (id === "S0.custodian" || id === "S0.oldcustodian") {
      const origin = id === "S0.oldcustodian" ? OLD_CUSTODIAN_ENDPOINT : pins.custodian.endpoint;
      const cid = id === "S0.oldcustodian" ? OLD_COMMITTEE_4774 : st.ids.COMMITTEE;
      const r = await fetch(`${origin}/v2/custody/info`, { redirect: "error", signal: AbortSignal.timeout(20_000) });
      const info = await r.json();
      const { reader } = await chainOf(pins, client);
      const { committee } = await reader.readCommittee({ committeeId: cid });
      const resolves = A.evalCustodianInfo({ info, committee });
      if (r.status !== 200) resolves["custodian.info"].ok = false;
      const ok = resolves["custodian.info"].ok;
      if (id === "S0.oldcustodian") {resolves["oldcustodian.info"] = {...resolves["custodian.info"],stepId:id};delete resolves["custodian.info"]; }
      return journalIt(st, step, { outcome: ok ? "pass" : "fail",
        evidence: { status: r.status, encKey: info?.encKey ?? null, vault: info?.vault ?? null, resolves } });
    }
    const { reader } = await chainOf(pins, client);
    if(id==="X.old.refuses")return journalIt(st,step,await probeOldCommittee({id:C.C3,newCommittee:st.ids.COMMITTEE,reader}));
    if(!["N.probe.nonce","N.probe.stale"].includes(id))throw Error("unimplemented probe step");
    const r = await reader.readRelease({ id: C.C1, endpoint: pins.recipient.endpoint });
    const cur = { id: C.C1, endpoint: pins.recipient.endpoint, committeeId: st.ids.COMMITTEE, epoch: r.committee.epoch, policyRev: r.policy.policyRev, secretRev: r.policy.secretRev };
    const res = id === "N.probe.nonce" ? await probeNonce({ base: pins.custodian.endpoint, cur }) : await probeStale({ base: pins.custodian.endpoint, cur });
    return journalIt(st, step, res);
  }
  if (cmd === "simulate") {
    const step = stepOrDie(st, id, ["simulate"]);
    const { reader, pub } = await chainOf(pins, client);
    const r = await reader.readRelease({ id: step.simulate.id, endpoint: null });
    const sim = prepareSimulation({ client, pins, step, chain: { policy: r.policy } });
    const res = await simulateRefusal({ client: { call: (a) => pub[0].call({ account: a.from, to: a.to, data: a.data }) }, ...sim });
    return journalIt(st, step, res);
  }
  if (["prepare","execute","resume"].includes(cmd) && id === "G.genesis") {
    const step=stepOrDie(st,id,["operator"]);
    const {sender}=await senderOf(pins,client,st.priv);
    const caps={gas:pins.genesis.gasCap,maxFeePerGas:pins.fees.maxFeePerGasWei,l1FeeWei:pins.fees.l1FeeWei,operatorFeeWei:pins.fees.operatorFeeWei};
    const budgetNow=()=>{
      const g=budgetGate({steps:st.plan.steps,pins,entries:st.entries,done:st.done,step});
      if(!g.ok)throw Error("genesis aggregate budget refuses this step");
      return {remainingWei:String(BigInt(g.remainingWei)<BigInt(g.allowanceWei)?BigInt(g.remainingWei):BigInt(g.allowanceWei)),reserveWei:g.cleanupOwedWei};
    };
    const file=path.join(st.priv,"prepared-G.genesis.json");
    if(cmd==="resume") {
      const rec=JSON.parse(fs.readFileSync(file,"utf8"));
      if(rec.sendPlan.stepHash!==step.stepHash||rec.sendPlan.stepId!==id||sha256hex(Buffer.from(rec.data.slice(2),"hex"))!==rec.sendPlan.dataSha256)throw Error("genesis prepared record differs from plan");
      const res=await sender.resume({stepId:id,data:rec.data,rebroadcast:process.argv.includes("--rebroadcast")});
      return finishGenesis(st,step,res,rec);
    }
    const {reader}=await chainOf(pins,client),attest=await loadR2Attestor(pins);
    const digests=await import(pathToFileURL(path.join(pins.repo.path,"custody/v2/digests.mjs")).href);
    const {VAULT_V2_ABI:abi}=await import(pathToFileURL(path.join(pins.repo.path,"custody/v2/chain.mjs")).href);
    const compiled=await compileCapturedGenesis({dir:pins.custodian.captureDir,endpoint:pins.custodian.endpoint,reader,attest,digests,viem:client.viem,abi});
    if(cmd==="prepare") {
      const sendPlan=await sender.prepare({stepId:id,stepHash:step.stepHash,from:pins.owner.address,data:compiled.data,caps,budget:budgetNow()});
      requireFreshQuote(compiled.quote);
      if(fs.existsSync(file))fs.renameSync(file,`${file}.superseded-${Date.now()}`);
      writePrivate(st.priv,path.basename(file),{data:compiled.data,captureDigest:compiled.captureDigest,summary:compiled.summary,sendPlan});
      return out({step:id,preparedHash:sendPlan.preparedHash,worstCaseWei:sendPlan.observed.totalAtBlockWei,summary:compiled.summary});
    }
    const rec=JSON.parse(fs.readFileSync(file,"utf8"));
    if(rec.sendPlan.stepHash!==step.stepHash||rec.sendPlan.stepId!==id||rec.data!==compiled.data||rec.captureDigest!==compiled.captureDigest)throw Error("genesis captured intent changed since preparation");
    const readKey=async()=>{
      await readHostStep({reader});requireFreshQuote(compiled.quote);
      const key=process.env[pins.owner.keyEnv];if(!/^0x[0-9a-fA-F]{64}$/.test(String(key)))throw Error("no canary owner key");guard.register(key);return key;
    };
    const res=await sender.send({prepared:rec.sendPlan,data:compiled.data,confirm:arg("confirm"),readKey,caps,budget:budgetNow()});
    return finishGenesis(st,step,res,rec);
  }
  if (cmd === "prepare" || cmd === "execute" || cmd === "resume") {
    const step = cmd === "resume" ? st.plan.steps.find((s) => s.id === id && s.mutation) : stepOrDie(st, id, ["mutation"]);
    if (!step) throw new Error(`${id}: not a mutation step`);
    if (cmd === "resume" && st.done.has(id)) throw new Error(`${id} is already journaled`);
    const { accounts, sender } = await senderOf(pins, client, st.priv);
    const caps = { gas: step.mutation.gasCap, maxFeePerGas: step.mutation.maxFeePerGasWei, l1FeeWei: pins.fees.l1FeeWei, operatorFeeWei: pins.fees.operatorFeeWei };
    const budgetNow = () => {
      const g = budgetGate({ steps: st.plan.steps, pins, entries: st.entries, done: st.done, step });
      if (!g.ok) throw new Error(`aggregate budget: ${g.reasons.join("; ")}`);
      return { remainingWei: g.remainingWei, reserveWei: g.cleanupOwedWei, gate: g };
    };
    const file = path.join(st.priv, `prepared-${step.id}.json`);
    if (cmd === "prepare") {
      const { reader } = await chainOf(pins, client);
      const dep = step.mutation.ids[0];
      const r = await reader.readRelease({ id: dep, endpoint: pins.recipient.endpoint });
      const { committee } = await reader.readCommittee({ committeeId: step.mutation.committee });
      const configText = client.protocol.configTextFromEnvelope(r.lease ? r.lease.envelope : "");
      let env = null;
      if (step.mutation.bundle?.startsWith("relay:")) {     // migration: the relay's values, proven equal to the local markers first
        const account = await signer(pins, client);
        const set = step.mutation.bundle.slice(6), m = loadMarkerSet({ dir: st.priv, set });
        const got = await relay.getValuesForMigration(dep, account);
        const same = Object.keys(got.env).length === Object.keys(m.values).length && Object.entries(got.env).every(([k, v]) => m.values[k] !== undefined
          && commitmentOf({ run: pins.runLabel, set, name: k, value: v }) === m.commitments[k]);
        if (!same) throw new Error("the relay's values are not the c2-legacy markers: nothing prepared");
        env = got.env;
      } else if (step.mutation.bundle) env = loadMarkerSet({ dir: st.priv, set: step.mutation.bundle }).values;
      const { prepared, tx } = prepareMutation({ client, pins, step, chain: { block: { number: String(r.blockNumber ?? "") }, policy: r.policy, committee, configText }, env });
      checkTxAgainstStep(tx, step, prepared, prepared.selector);
      const b = budgetNow();
      const sendPlan = await sender.prepare({ stepId: step.id, stepHash: step.stepHash, from: tx.from, data: tx.data, caps, budget: b });
      if (fs.existsSync(file)) fs.renameSync(file, `${file}.superseded-${Date.now()}`);   // only unsigned plans are ever superseded
      writePrivate(st.priv, path.basename(file), { calldata: prepared, data: tx.data, sendPlan });
      return out({ step: step.id, preparedHash: sendPlan.preparedHash, summary: prepared.summary, tx: sendPlan.tx, worstCaseWei: sendPlan.observed.totalAtBlockWei,
        l1FeeUpperBoundWei: sendPlan.observed.l1FeeUpperBoundWei, operatorFeeBoundWei: sendPlan.observed.operatorFeeBoundWei, budget: b.gate,
        next: `node driver/cli.mjs execute --pins <pins> --step ${step.id} --confirm ${sendPlan.preparedHash}` });
    }
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    checkTxAgainstStep({ chainId: 8453, from: rec.sendPlan.tx.from, to: rec.sendPlan.tx.to, data: rec.data, value: 0n }, step, rec.calldata, rec.calldata.selector);
    let res;
    if (cmd === "execute") {
      const readKey = async () => { const k = process.env[pins.owner.keyEnv]; if (!/^0x[0-9a-fA-F]{64}$/.test(String(k))) throw new Error("no key"); guard.register(k); return k; };
      res = await sender.send({ prepared: rec.sendPlan, data: rec.data, confirm: arg("confirm"), readKey, caps, budget: budgetNow() });
    } else res = await sender.resume({ stepId: step.id, data: rec.data, rebroadcast: process.argv.includes("--rebroadcast") });
    const outcome = { verified: "pass", failed: "fail", conflict: "aborted" }[res.status];
    if (!outcome) return out({ step: step.id, status: res.status, txHash: res.txHash, note: res.note, next: `node driver/cli.mjs resume --pins <pins> --step ${step.id} [--rebroadcast]` });
    return journalIt(st, step, { outcome, evidence: { txHash: res.txHash, nonce: res.nonce, receipt: res.receipt, costWei: res.status === "conflict" ? "0" : res.costWei,
      preparedHash: rec.sendPlan.preparedHash, summary: rec.calldata.summary, broadcasts: res.broadcasts, note: res.note } });
  }
  if (cmd === "gate") {
    if(id==="G.launch")throw Error("launch must use live launch-verify, not manual record");
    if(id==="G.genesis")throw Error("genesis must use bounded prepare, not an external CLI transaction");
    const step = stepOrDie(st, id, ["operator"]);
    if (!step.spend) throw new Error(`${id} spends nothing`);
    const { agreedScalar } = await chainOf(pins, client);
    const balanceWei = await agreedScalar((c, blockNumber) => c.getBalance({ address: pins.owner.address, blockNumber }));
    const g = budgetGate({ steps: st.plan.steps, pins, entries: st.entries, done: st.done, step, balanceWei });
    return out({ step: id, ...g, note: g.ok ? "within budget: root may run this step's CLI transactions; record checks the receipts against the allowance" : "REFUSED: do not run this step's CLI" });
  }
  if (cmd === "relay") {
    const step = stepOrDie(st, id, ["relay"]);
    if (arg("confirm") !== step.stepHash) throw new Error(`--confirm must equal ${step.stepHash}`);
    const account = await signer(pins, client);
    if (id === "N.relay") {
      const { generatePrivateKey, privateKeyToAccount } = await import(pathToFileURL(path.join(pins.repo.path, "node_modules/viem/_esm/accounts/index.js")).href);
      const throwaway = generatePrivateKey(); guard.register(throwaway);
      const heldSet = await relay.put(C.C1, account, { set: { CANARY_REFUSED: "refused-" + sha256hex(throwaway).slice(0, 32) } });
      const strangerGet = await relay.getMeta(C.C1, privateKeyToAccount(throwaway));
      return journalIt(st, step, evalRelayRefusals({ heldSet, strangerGet, exists: await relay.exists(C.C1) }));
    }
    if (id === "M.legacy.set") {
      const m = loadMarkerSet({ dir: st.priv, set: "c2-legacy" });
      const r = await relay.put(C.C2, account, { set: m.values });
      return journalIt(st, step, { outcome: r.status === 200 ? "pass" : "fail", evidence: { status: r.status, error: r.error, names: Object.keys(m.values).sort(), commitments: m.commitments } });
    }
    if (id === "M.legacy.check") {
      const m = loadMarkerSet({ dir: st.priv, set: "c2-legacy" });
      const meta = await relay.getMeta(C.C2, account, { run: pins.runLabel, set: "c2-legacy", values: m.values });
      return journalIt(st, step, evalLegacyCheck({ meta, exists: await relay.exists(C.C2), markerNames: Object.keys(m.values) }));
    }
    if (id === "M.clear") {
      const ex = await relay.exists(C.C2);
      if (!ex.custody) return journalIt(st, step, { outcome: "fail", evidence: { exists: ex, note: "relay does not report custody:true; nothing cleared (re-run is impossible: a new plan step is needed)" } });
      const r = await relay.put(C.C2, account, { clear: true });
      const after = await relay.getMeta(C.C2, account);
      return journalIt(st, step, { outcome: r.status === 200 ? "pass" : "fail", evidence: { status: r.status, error: r.error, ownerGetAfter: { status: after.status, names: after.names, rev: after.rev } } });
    }
    throw new Error(`no relay handler for ${id}`);
  }
  if (cmd === "record") {
    if(id==="G.launch")throw Error("launch must use live launch-verify, not manual record");
    if(id==="G.genesis")throw Error("genesis must use the bounded prepare/execute/resume path, not manual record");
    const step = stepOrDie(st, id, ["operator", "hardware"]);
    assertManualLifecycleRecord(step);
    if (arg("confirm") !== step.stepHash) throw new Error(`--confirm must equal ${step.stepHash}`);
    const obs = JSON.parse(fs.readFileSync(arg("obs"), "utf8"));
    guard.check(obs, "observation");
    let res;
    if (step.spend) {   // root ran the EXISTING CLI: its receipts decide the cost; over the allowance or the aggregate = fail
      const costs = await receiptCosts({ rpcs: pins.sendRpcs, txHashes: obs.txHashes, from: pins.owner.address, operatorFeeWei: pins.fees.operatorFeeWei });
      const allowance = allowanceOf(step, pins);
      const usdc = BigInt(obs.usdcUnits ?? 0);
      const reasons = [];
      if (BigInt(costs.costWei) > allowance) reasons.push(`cost ${costs.costWei} > allowance ${allowance}`);
      if (costs.txs.length > 4) reasons.push(`${costs.txs.length} transactions for one CLI operation: more than this step allows`);
      // the CLI must have run with the reconciled pins file, and every transaction must target the step's own contract
      if (obs.cliPinsSha256 !== pins.cli.pinsSha256) reasons.push("obs.cliPinsSha256 is not the reconciled CLI pins file (S0.clipins)");
      reasons.push(...checkCliTargets({ stepId: id, txs: costs.txs, pins: parsePins(fs.readFileSync(path.join(ROOT, pins.cli.pinsFile), "utf8")) }));
      if (costs.txs.some((t) => t.status !== "success")) reasons.push("a CLI transaction reverted");
      if (usdc > (step.spend.usdc ? BigInt(pins.budget.usdcFundUnits) : 0n)) reasons.push(`USDC ${usdc} over the per-deployment allowance`);
      const spentAfter = spentOf(st.entries, st.plan.steps, pins) + BigInt(costs.costWei);
      if (spentAfter > BigInt(pins.budget.totalWei)) reasons.push(`aggregate spent ${spentAfter} > budget ${pins.budget.totalWei}`);
      let extra = {};
      if (step.learns) {
        const okId = /^0x[0-9a-f]{64}$/.test(String(obs.deploymentId)) && obs.deploymentId !== PROTECTED_POLICY_4E62 && !Object.values(C).includes(obs.deploymentId);
        if (!okId) reasons.push("deploymentId missing, protected or reused");
        extra = { deploymentId: obs.deploymentId };
      }
      res = { outcome: reasons.length ? "fail" : "pass", reasons, evidence: { ...extra, costWei: costs.costWei, txs: costs.txs, usdcUnits: String(usdc), allowanceWei: String(allowance), command: step.command } };
    } else if (id === "S0.root") {
      const ok = (k) => ({ ok: obs[k]?.ok === true, note: String(obs[k]?.note || "").slice(0, 300) });
      const rr = obs.recipientRunner || {};
      // the measured control image must sign v2 custody auth for 0xE486: a known-lacking image never resolves it
      const runnerOk = rr.ok === true && rr.endpoint === pins.recipient.endpoint && String(rr.custodyVaultV2).toLowerCase() === ORIGINAL_VAULT_V2
        && /^[0-9a-f]{64}$/.test(String(rr.controlManifestSha256)) && !KNOWN_LACKING_CONTROL_MANIFESTS.includes(rr.controlManifestSha256) && typeof rr.evidenceRef === "string" && rr.evidenceRef.length > 0;
      res = { outcome: "pass", evidence: { resolves: { "recipient.runner": { ok: runnerOk, note: `control manifest ${rr.controlManifestSha256}; CUSTODY_VAULT_V2 ${rr.custodyVaultV2}; ${String(rr.evidenceRef || "").slice(0, 200)}` },
        "recipient.billing": ok("billing"), "relay.v2aware": ok("relay"), "hw.oneGuest": ok("oneGuest") } } };
      if (!Object.values(res.evidence.resolves).every((r) => r.ok)) res.outcome = "fail";
    } else if (step.expectRelease || step.expectRefusal) {
      const dep = C[step.deployment];
      const {reader} = await chainOf(pins, client);
      const {committee} = await reader.readCommittee({committeeId:step.custodian === 'old' ? OLD_COMMITTEE_4774 : st.ids.COMMITTEE});
      const identity = {recipientEndpoint:pins.recipient.endpoint,custodianEncKey:committee?.machines?.[0]?.encKey};
      if(step.expectRefusal&&step.custodian!=='old')throw Error('new-committee refusals require recipient-refusal live observation');
      const frontLog=step.custodian==='old'?fs.readFileSync(obs.frontLog,"utf8"):'';
      if(step.custodian==='old') {
        const lines=A.filterLines({frontLog,custodianLog:fs.readFileSync(obs.custodianLog,"utf8"),id:dep});
        res=step.expectRelease?A.evalRelease({id:dep,obs:{...obs,lines},expect:step.expectRelease,imageMeasurement:pins.image.measurement,...identity}):A.evalRefusal({id:dep,obs:{...obs,lines},expect:step.expectRefusal,...identity});
      } else {
        const {args,name}=await windowArgs(step,obs.custodianGeneration,obs.custodianDigest);
        const cursor=loadCustodianWindow({dir:st.priv,name,digest:obs.custodianWindowDigest});
        const window=await collectCustodianWindow({...args,...cursor});
        if(step.expectRelease) {
          const observeRecipient=()=>recipientObservation(step,obs.custodianGeneration,obs.custodianDigest,obs.custodianWindowDigest,obs.recipientAttemptDigest);
          const verified=await verifyLiveRecipient({id:dep,pins,observeRecipient,attest:await loadRecipientAttestor(pins)});
          const recipient=verified.observation;
          // Recollect after recipient observation so its logs cannot be combined with an earlier custodian generation.
          const currentWindow=await collectCustodianWindow({...args,...cursor});
          res=A.evalObservedRelease({id:dep,expect:step.expectRelease,imageMeasurement:pins.image.measurement,...identity,window:currentWindow,recipient,appAnswered:obs.appAnswered});
          res.evidence.recipientAttestation=verified.attestation;
          res.evidence.recipientContext={generation:obs.custodianGeneration||pins.runLabel,bundleDigest:obs.custodianDigest,windowDigest:obs.custodianWindowDigest,attemptDigest:obs.recipientAttemptDigest};
          res.evidence.scope='Fresh local boot, custodian interval and independent transport-bound recipient SNP verification. Public response is operator supplied; a separate transport-pinned HMAC proof remains mandatory.';
        } else {
          const lines=A.filterLines({frontLog,custodianLog:'',id:dep});
          res=A.evalCollectedRelease({id:dep,obs:{...obs,lines},expect:step.expectRefusal,refusal:true,imageMeasurement:pins.image.measurement,...identity,window});
        }
      }
    } else if (step.limitation === "rollback") {
      res = A.evalRollback({obs});
    } else if (step.markerSets && id !== "M.clear.proof") {
      res = A.evalMarkerSearch({ sets: step.markerSets, counts: obs.counts, control: obs.control, locations: obs.locations });
    } else if (id === "M.clear.proof") {
      const markerSearch = A.evalMarkerSearch({ sets: step.markerSets, counts: obs.counts, control: obs.control, locations: obs.locations });
      res = evalClearProof({ ownerGet: st.done.get("M.clear").evidence.ownerGetAfter, hasIdOnRelayHost: obs.hasIdOnRelayHost, markerSearch, retentionListed: obs.retentionListed });
    } else throw new Error(`${id}: no recorder (blocked or not an operator step)`);
    return journalIt(st, step, res);
  }
  throw new Error(`unknown command ${cmd}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { try { guard.check(e.message, "error"); console.error(`REFUSED: ${e.message}`); } catch { console.error("REFUSED: (message withheld: it contained guarded material)"); } process.exit(1); });
