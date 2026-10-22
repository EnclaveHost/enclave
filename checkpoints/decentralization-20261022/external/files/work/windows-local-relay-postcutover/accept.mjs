// accept.mjs - the AUTHORITATIVE post-cutover acceptance verdict (read-only; it only reads the JSON files root collected).
// The stage's 20-activate.ps1 prints lost VMs without failing, and 30-verify.ps1 prints status without judging: THIS decides.
//   node accept.mjs --cutover cutover.json --minipc minipc.json --source source.json --chain chain.json [--expectations expectations.json]
// Exit 0 ACCEPTED | 3 PENDING (everything holds, but no lease payment has gone through the moved relay yet) | 1 FAILED.
// Every check, from the pinned expectations:
//   vms         EXACTLY the 9 VM ids of root's fresh 07:37 preflight are running (none lost, none extra);
//   agent       one node agent and one run-node.cmd loop, healthy, app-funded, operator 0x1A01194c...;
//               the loop started after activatedAt (cutover.activateStartedAt when given);
//   control     all 80 plan files: the bundle "after" (d2e363c5) and the 79 unchanged, by hash;
//   settings    lease-gas-config.cmd is the "after" (2324904b), deployment.json the reviewed record, and still called;
//   relay       task \Enclave\Relay Running, one relay process, one listener on 8549, /v1/info is the moved payee for the
//               reviewed chain, reserve and executor;
//   source      the us-west unit is masked and inactive (/dev/null link); no relay process or :8549 listener; nothing
//               (local or the https front) answers as the payee; the stop receipt says masked;
//   chain       audit-chain.mjs: LOCAL_VERIFIED -> pass, NO_EVENTS_YET / FALLBACK_ONLY -> pending, FAILED -> fail;
//   freshness   every collected document is newer than activatedAt; the chain window starts at the cutover block.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const lc = (s) => String(s ?? "").toLowerCase();

export function evaluate({ expect, cutover, minipc, source, chain }) {
  const checks = [];
  const add = (id, state, detail) => checks.push({ id, state, detail });
  const ok = (id, cond, detail) => add(id, cond ? "pass" : "fail", detail);
  const t0 = Date.parse(cutover?.activatedAt ?? "");
  ok("cutover-marker", Number.isSafeInteger(cutover?.cutoverBlock) && !Number.isNaN(t0), `block ${cutover?.cutoverBlock}, activatedAt ${cutover?.activatedAt}`);
  for (const [name, doc] of [["minipc", minipc], ["source", source], ["chain", chain]])
    ok(`fresh-${name}`, doc && Date.parse(doc.at) > t0, `${name} collected ${doc?.at}`);
  // vms: exactly the expected set, all running
  const running = (minipc?.vms || []).filter((v) => v.status === "running").map((v) => v.id).sort();
  const want = [...expect.vms].sort();
  const lost = want.filter((v) => !running.includes(v)), extra = running.filter((v) => !want.includes(v));
  ok("vms", minipc?.vms && lost.length === 0 && extra.length === 0, `${running.length} running; lost [${lost.join(",")}] extra [${extra.join(",")}]`);
  // agent
  const agents = minipc?.agents || [], loops = minipc?.loops || [];
  ok("agent-single", agents.length === 1 && loops.length === 1, `${agents.length} agent(s), ${loops.length} loop(s)`);
  ok("agent-healthy", minipc?.healthy === true, `healthy ${minipc?.healthy}`);
  ok("agent-app-funded", minipc?.leaseMode === "app-funded" && lc(minipc?.operator) === lc(expect.operator), `lease mode ${minipc?.leaseMode}, operator ${minipc?.operator}`);
  const since = Date.parse(cutover?.activateStartedAt ?? cutover?.activatedAt ?? "");
  if (cutover?.activateStartedAt) ok("loop-restarted", loops.length === 1 && Date.parse(loops[0].created) >= since, `loop started ${loops[0]?.created}`);
  // control
  const ctl = minipc?.control || {};
  const bad = Object.entries(expect.control).filter(([p, h]) => lc(ctl[p]) !== lc(h)).map(([p]) => p);
  ok("control", Object.keys(ctl).length === Object.keys(expect.control).length && bad.length === 0, `${Object.keys(expect.control).length - bad.length}/${Object.keys(expect.control).length} match${bad.length ? `; differ: ${bad.join(", ")}` : ""}`);
  // settings
  const st = minipc?.settings || {};
  ok("settings", lc(st["lease-gas-config.cmd"]) === expect.settings["lease-gas-config.cmd"] && lc(st["deployment.json"]) === expect.settings["deployment.json"] && minipc?.settingsCalled === true,
    `lease-gas-config.cmd ${st["lease-gas-config.cmd"]}, deployment.json ${st["deployment.json"]}, called ${minipc?.settingsCalled}`);
  // relay
  const ri = minipc?.relayInfo;
  ok("relay-task", minipc?.tasks?.Relay === "Running", `task ${minipc?.tasks?.Relay}`);
  ok("relay-process", minipc?.relayProcesses === 1 && minipc?.relayListeners >= 1, `${minipc?.relayProcesses} process(es), ${minipc?.relayListeners} listener(s) on 8549`);
  ok("relay-identity", ri && lc(ri.payee) === lc(expect.relay.payee) && Number(ri.chainId) === expect.relay.chainId && lc(ri.reserve) === lc(expect.relay.reserve) && lc(ri.executor) === lc(expect.relay.executor),
    ri ? `payee ${ri.payee} chain ${ri.chainId} reserve ${ri.reserve} executor ${ri.executor}` : "no /v1/info answer");
  // source
  ok("source-masked", source?.loadState === "masked" && source?.unitFileState === "masked" && source?.activeState !== "active" && source?.unitPathLink === "/dev/null",
    `ActiveState ${source?.activeState} LoadState ${source?.loadState} UnitFileState ${source?.unitFileState} link ${source?.unitPathLink}`);
  ok("source-silent", source?.relayProcesses === 0 && source?.listeners8549 === 0 && source?.localAnswersAsPayee === false && source?.frontAnswersAsPayee === false,
    `processes ${source?.relayProcesses}, listeners ${source?.listeners8549}, local answers ${source?.localAnswersAsPayee}, front answers ${source?.frontAnswersAsPayee}`);
  ok("source-receipt", source?.stopReceipt?.masked === true && source?.stopReceipt?.keyMoved === false, `stop receipt ${source?.stopReceipt ? `masked ${source.stopReceipt.masked}, at ${source.stopReceipt.stoppedAt}` : "absent"}`);
  // chain
  const cs = chain?.status;
  const windowOk = chain && String(chain.window?.fromBlock) === String(cutover?.cutoverBlock);
  if (!windowOk) add("chain", "fail", `the chain audit window starts at ${chain?.window?.fromBlock}, not the cutover block ${cutover?.cutoverBlock}`);
  else if (cs === "LOCAL_VERIFIED") add("chain", "pass", `${chain.counts.moved} payment(s) via the moved relay, verified and in minipc's relay log; ${chain.counts.fallback} via eu-central`);
  else if (cs === "PARTIAL") add("chain", "pending", `${chain.counts.moved} moved payment(s) verified and in minipc's relay log, but ${chain.counts.unverified} payment(s) not yet verified by the quorum (proof not observed, not a failure): re-run`);
  else if (cs === "UNVERIFIED_ONLY") add("chain", "pending", `${chain.counts.unverified} payment(s) found but not verified by the quorum yet (proof not observed): re-run`);
  else if (cs === "NO_EVENTS_YET") add("chain", "pending", "no lease payment for the nine apps in the window yet (not a failure; absence is not proven)");
  else if (cs === "FALLBACK_ONLY") add("chain", "pending", `${chain.counts.fallback} payment(s) via eu-central only: the moved relay has not been used yet`);
  else add("chain", "fail", `chain audit ${cs}: ${(chain?.failures || []).slice(0, 3).map((f) => f.error).join(" | ")}`);
  const status = checks.some((c) => c.state === "fail") ? "FAILED" : checks.some((c) => c.state === "pending") ? "PENDING" : "ACCEPTED";
  return { status, checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2), opt = {}; for (let i = 0; i < a.length; i += 2) opt[a[i].replace(/^--/, "")] = a[i + 1];
  for (const k of ["cutover", "minipc", "source", "chain"]) if (!opt[k]) { console.error(`refused: --${k} is required`); process.exit(2); }
  const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
  const r = evaluate({ expect: read(opt.expectations || path.join(HERE, "expectations.json")), cutover: read(opt.cutover), minipc: read(opt.minipc), source: read(opt.source), chain: read(opt.chain) });
  for (const c of r.checks) console.log(`${c.state.toUpperCase().padEnd(7)} ${c.id}: ${c.detail}`);
  console.log(`== ${r.status}`);
  process.exitCode = r.status === "ACCEPTED" ? 0 : r.status === "PENDING" ? 3 : 1;
}
