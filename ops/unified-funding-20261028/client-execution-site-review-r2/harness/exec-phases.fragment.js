// =====================================================================================================================
// client-execution-site-r2: gas payment recovery through the ACTUAL generated recovery page copy (phases 12-16).
// UNREVIEWED, NOT RUN. Every effect is a click on the page's own buttons. The shell only arms the server's labelled
// one-shot execute reply fault (the execute itself is REALLY processed and mined first), or the existing RPC hold that
// switches the wallet/network, and then reads fixture counters, the real IndexedDB journal and the owned chain.
// =====================================================================================================================
const EXEC = "POST /v1/sessions/funding/execute", QUOTE = "POST /v1/sessions/funding/quote";
const hit = (s, k) => s.hits[k] ?? 0;
const execEntries = async () => (await (await v2()).listJournal()).filter((x) => x.kind === "gas-execute");
const execRow = (id) => q(`#fdExec [data-exec-row="${id}"]`);
const nucSidOf = async (st) => (await planOf(st)).steps["gasOpen:nucbox"].review.sid;
const sessionBal = async (sid) => BigInt((await call(`/test/fixture/gas-session/${sid}`)).balance6);
const secretFree = (e) => { const j = JSON.stringify(e); return !j.includes("privateKey") && !/"(r|s|sig|signature)":/.test(j); };
const nucA = (k) => ({ dep: nucDeps()[k], eth: fx.ethOut, tier: String(fx.feeTier) });

/** The page's "Check status on chain" for one payment, with empty blocks between checks, until the CORE proves it final.
 *  Bounded: at most 8 checks. Elapsed time is never treated as an outcome. */
async function checkUntilFinal(id, what) {
  for (let i = 0; i < 8; i++) {
    await tick(); await tick();
    await fresh();
    const e0 = await (await v2()).getJournal(id);
    if (e0.status === "settled") return e0;
    check(!!execRow(id), `${what}: the page lists the unresolved payment (${e0.status})`);
    const n = toasts.length;
    await clickPage(`#fdExec [data-exec="${id}"]`);
    const t = await waitFor(() => toasts.slice(n)[0], `${what}: the check result`);
    log(`    ${what}: ${t}`);
    await settled();
    const e = await (await v2()).getJournal(id);
    if (e.status === "settled") return e;
    check(["observed", "unknown", "pending", "dispatching"].includes(e.status), `${what}: still reserved as ${e.status} (never cleared by time)`);
  }
  throw new Error(`${what}: not proven final within 8 bounded checks`);
}
async function quoteRefused(A, what) {
  const s0 = await status();
  setInputs(A);
  const n = toasts.length;
  await clickPage("#fdQuote");
  await waitToast(n, /unreconciled_execute/, `${what}: quote refused`);
  await settled();
  check(hit(await status(), QUOTE) === hit(s0, QUOTE), `${what}: no quote request reached the relay`);
}

phase("pExecFinal", "12. After the normal Fund: on-chain-not-final is shown and blocks a quote; page Check status until final", "funded", async () => {
  await fresh();
  const e0 = (await execEntries()).find((x) => x.evidence?.kind === "settlement");
  check(!!e0, "the funded payment is journaled with its chain evidence");
  if (e0.status === "observed") {
    check(!!execRow(e0.id) && text("#fdExec").includes("not final"), "page: the payment is on chain but NOT final, shown as unresolved");
    check(!!q("[data-exec-blocked]"), "the gas section says a payment is unresolved");
    await quoteRefused(nucA(0), "not final");
  } else log(`    note: the fixture had already finalized that block (${e0.status}); the not-final display was not observable in this run`);
  const s0 = await status();
  const done = await checkUntilFinal(e0.id, "normal payment");
  const s1 = await status();
  check(done.evidence.final === true && done.evidence.txHash === e0.evidence.txHash, "the same transaction, proven final");
  check(hit(s1, EXEC) === hit(s0, EXEC) && s1.prompts.length === s0.prompts.length, "checking status sent nothing and signed nothing");
  await fresh();
  check(!execRow(e0.id) && text("#fdExec").includes("No unresolved gas payment"), "no unresolved payment left");
  advance("execFinal", "normal payment shown truthfully until proven final");
});

async function lostReplyFund(mode, k) {
  const st = H.load();
  await fresh();
  const sid = await nucSidOf(st);
  const A = nucA(k);
  const digest = await quoteThroughPage(A);
  const bal0 = await sessionBal(sid), vault0 = await usdcOf(fx, fx.vault), s0 = await status();
  await call("/test/fixture/execute-fault", { mode });
  const n = toasts.length;
  await clickPage("#fdFund");
  const t = await waitFor(() => toasts.slice(n)[0], "the fund result");
  check(!/^Funded:/.test(t), `the page does not claim success (${t})`);
  await settled();
  const s1 = await status();
  check(hit(s1, EXEC) - hit(s0, EXEC) === 1 && s1.executeFaults.at(-1) === mode,
    `exactly one execute POST; its reply ${mode === "body" ? "body was truncated after headers" : "was replaced by a 502"} AFTER real processing`);
  check(s1.prompts.length === s0.prompts.length, "no owner prompt");
  const e = (await execEntries()).find((x) => lower(x.call?.digest) === digest);
  check(e?.status === "unknown", "journal (real IndexedDB): UNKNOWN, never refused");
  check(e.schema === "enclave-funding-gas-execute-r2" && e.call.nonce === e.nonce && /^0x[0-9a-f]+$/.test(e.call.args) && !!e.anchor?.hash
    && lower(e.sid) === lower(sid) && lower(e.deployment) === A.dep && e.relay === origin, "the exact public intent is persisted: call, nonce, anchor, sid, deployment, relay");
  check(secretFree(e), "no key or signature in the journal");
  check(execRow(e.id)?.dataset.execStatus === "unknown", "page: the payment is listed as unknown with a read-only Check button");
  await waitFor(async () => (await sessionBal(sid)) < bal0, "the really processed execute to be mined", 30_000);
  const drop = bal0 - await sessionBal(sid);
  await quoteRefused(A, `${mode}: unknown`);
  return { id: e.id, sid, bal0: bal0.toString(), vault0: vault0.toString(), drop: drop.toString(), exec: hit(s1, EXEC), prompts: s1.prompts.length };
}
async function provenOnce(L, what) {
  const done = await checkUntilFinal(L.id, what);
  const s = await status();
  check(hit(s, EXEC) === L.exec, `${what}: no execute resent`);
  check(s.prompts.length === L.prompts, `${what}: no signature`);
  const debit = BigInt(done.evidence.actual.totalDebit6);
  check(debit === BigInt(L.drop) && BigInt(L.bal0) - await sessionBal(L.sid) === debit, `${what}: the proven debit is the single on-chain balance drop`);
  check(BigInt(L.vault0) - await usdcOf(fx, fx.vault) === debit, `${what}: successor vault USDC down exactly that debit`);
  check(done.evidence.final === true && /^0x[0-9a-f]{64}$/.test(done.evidence.txHash), `${what}: exact canonical settlement, proven final`);
  return done;
}

phase("pExecLost", "13. Page Fund with the reply body LOST after headers: persisted UNKNOWN with the exact intent (then Reload)", "execFinal", async () => {
  const L = await lostReplyFund("body", 1);
  H.save({ ...H.load(), lostBody: L });
  advance("execUnknown", "UNKNOWN persisted; click Reload page, then phase 14");
});

phase("pExecReload", "14. After reload: the UNKNOWN row is still there; page Check status proves it once, read-only", "execUnknown", async () => {
  const L = H.load().lostBody;
  check(performance.getEntriesByType("navigation")[0]?.type === "reload", "this document was loaded by a reload");
  await fresh();
  check(!!execRow(L.id), "after reload the recovery row is still listed (real IndexedDB)");
  check((await (await v2()).getJournal(L.id)).status === "unknown", "still UNKNOWN after reload");
  await stage("store-level, NOT page: two concurrent IndexedDB compare-and-set creates of one id - exactly one commits", async () => {
    const id = `harness-cas-probe:${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
    const mk = (who) => (cur) => { if (cur) throw Object.assign(new Error("exists"), { code: "exists" }); return { id, kind: "harness-cas-probe", who }; };
    const r = await Promise.allSettled([v2().casJournal(id, mk("a")), v2().casJournal(id, mk("b"))]);
    check(r.filter((x) => x.status === "fulfilled").length === 1 && r.filter((x) => x.status === "rejected").length === 1, "exactly one create committed");
  });
  await provenOnce(L, "lost-body payment");
  advance("execRecovered", "lost-body payment recovered read-only after reload");
});

phase("pExec502", "15. Page Fund answered by a gateway 502 AFTER real processing: UNKNOWN, then page Check status proves it once", "execRecovered", async () => {
  const L = await lostReplyFund("gateway502", 2);
  await provenOnce(L, "502 payment");
  advance("exec502Done", "gateway-502 payment recovered read-only");
});

phase("pExecSwitch", "16. Page Fund with an ACCOUNT switch, then a CHAIN switch, at the payment's first chain read: nothing admitted or sent", "exec502Done", async () => {
  const sid = await nucSidOf(H.load());
  for (const [what, to] of [["account", () => walletState(OTHER, 8453)], ["chain", () => walletState(fx.owner, 1)]]) {
    await fresh();
    await quoteThroughPage(nucA(3));
    const s0 = await status(), n0 = (await execEntries()).length, bal0 = await sessionBal(sid);
    H.armRpc(async () => { log(`    (hold) ${what} switch at the payment's first chain read`); to(); });
    const n = toasts.length;
    await clickPage("#fdFund");
    await waitToast(n, /context_changed/, `${what} switch cancelled the payment`);
    await settled();
    await sleep(1500);
    check(hit(await status(), EXEC) === hit(s0, EXEC), `${what}: no execute POST`);
    check((await execEntries()).length === n0, `${what}: no execution admitted (the guarded store refused the new entry)`);
    check(await sessionBal(sid) === bal0, `${what}: no debit`);
  }
  await fresh();
  advance("execDone", "account and chain switches cannot dispatch a payment");
});

