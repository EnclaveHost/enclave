/* ============================================================
   Wallet release, step 1 for PRODUCTION custody: the owner's explicit,
   content-bound Promote of the UNCHANGED current (appRef, configCid),
   through the ACTUAL SDK ownerOperation({ op: "promote" }) and the same
   guarded signer/relay pattern as the release controller. It never
   releases, never chains a second prompt and never retries; Release is a
   separate reviewed click once the promotion is final on-chain.

   Source (read-only): legacy SessionVault v2 promote 789-802 (typehash
   427-429, Promoted event), SessionVaultLib.promote 284-300 (re-checks
   catalog slug/publisher/label and isPublic on-chain; leaves equal
   ref/config untouched), _ownerAuth 940-946 (ONE ownerNonceUsed mapping
   shared by every owner operation, Promote and Release alike).
   ============================================================ */
import { readSnapshot, readCatalog, promotedHash, isOwnerReview, PINS, ABI, ReleaseBlocked, MAX_SIGN_WINDOW_SEC, SCAN_SPAN, SCAN_CHUNK } from "./wallet-release-chain.js";
import { evaluateRelease, isWalletCensus } from "./wallet-release-census.js";
import { promoteKey, PROMOTE_KIND, JOURNAL_SCHEMA, PRE_DISPATCH, IN_FLIGHT, RESOLVED } from "./wallet-release-store.js";
import { ReleaseError } from "./wallet-release-controller.js";
import { keccak256Hex, keccak256Utf8 } from "./keccak.js";

export const PROMOTE_TYPE = Object.freeze([{ name: "deployment", type: "bytes32" }, { name: "app", type: "string" }, { name: "publisher", type: "address" },
  { name: "appRef", type: "string" }, { name: "configCid", type: "string" }, { name: "versionLabel", type: "string" }, { name: "isPublic", type: "bool" },
  { name: "opNonce", type: "bytes32" }, { name: "signBefore", type: "uint64" }]);
export const PROMOTE_SIG = "promote(bytes32,string,address,string,string,string,bool,bytes32,uint64,bytes)";
export const PROMOTE_SELECTOR = keccak256Utf8(PROMOTE_SIG).slice(0, 10);
export const TOPIC_PROMOTED = keccak256Utf8("Promoted(bytes32,bytes32,string,string)");
const FIELDS = PROMOTE_TYPE.map((f) => f.name).sort().join();
const CONTENT = ["deployment", "app", "publisher", "appRef", "configCid", "versionLabel", "isPublic"];
/** Release blockers that THIS step resolves; every other release blocker must already be clear before it is offered. */
export const PROMOTABLE = Object.freeze(["unpromoted", "content-drift"]);

const ZERO32 = "0x" + "0".repeat(64);
const DEADLINE_MARGIN_SEC = 30;
const lower = (a) => String(a || "").toLowerCase();
const isHex32 = (h) => /^0x[0-9a-f]{64}$/.test(lower(h));
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const pad32 = (hex) => lower(hex).replace(/^0x/, "").padStart(64, "0");
const utf8Hex = (s) => Array.from(new TextEncoder().encode(String(s)), (x) => x.toString(16).padStart(2, "0")).join("");
const tail = (h) => word(h.length / 2) + (h.length ? h.padEnd(Math.ceil(h.length / 64) * 64, "0") : "");
const short = (e) => String((e && (e.shortMessage || e.message)) || e).slice(0, 200);
const jsonSafe = (v) => JSON.parse(JSON.stringify(v, (_k, x) => typeof x === "bigint" ? x.toString() : x));

/* ---- exact calldata (canonical encoding only) ---------------------------------------------------------------------- */
export function promoteCalldata(m, sig){
  const dyn = [utf8Hex(m.app), utf8Hex(m.appRef), utf8Hex(m.configCid), utf8Hex(m.versionLabel), lower(sig).replace(/^0x/, "")].map(tail);
  let off = 320;
  const o = dyn.map((t) => { const x = off; off += t.length / 2; return x; });
  return PROMOTE_SELECTOR + pad32(m.deployment) + word(o[0]) + pad32(m.publisher) + word(o[1]) + word(o[2]) + word(o[3]) +
    word(m.isPublic === true ? 1 : 0) + pad32(m.opNonce) + word(m.signBefore) + word(o[4]) + dyn.join("");
}
export function decodePromoteCalldata(input){
  const h = lower(input);
  if (!h.startsWith(PROMOTE_SELECTOR) || h.length < 10 + 64 * 10) return null;
  const body = h.slice(10), w = (i) => body.slice(64 * i, 64 * (i + 1));
  try {
    const dyn = [1, 3, 4, 5, 9].map((i) => {
      const o = BigInt("0x" + w(i)) * 2n;
      if (o + 64n > BigInt(body.length)) throw new Error("offset");
      const n = BigInt("0x" + body.slice(Number(o), Number(o) + 64));
      if (n > 65536n) throw new Error("length");
      const hex = body.slice(Number(o) + 64, Number(o) + 64 + Number(n) * 2);
      if (hex.length !== Number(n) * 2) throw new Error("short");
      return hex;
    });
    const dec = new TextDecoder("utf-8", { fatal: true });
    const s = (hex) => dec.decode(Uint8Array.from(hex.match(/../g) || [], (x) => parseInt(x, 16)));
    const m = { deployment: "0x" + w(0), app: s(dyn[0]), publisher: "0x" + w(2).slice(24), appRef: s(dyn[1]), configCid: s(dyn[2]), versionLabel: s(dyn[3]),
      isPublic: BigInt("0x" + w(6)) === 1n, opNonce: "0x" + w(7), signBefore: BigInt("0x" + w(8)).toString() };
    const sig = "0x" + dyn[4];
    return h === promoteCalldata(m, sig) ? { ...m, sig } : null;     // rejects dirty words, non-bool, non-canonical offsets
  } catch(e){ return null; }
}

/* ---- the SDK's typed data, before the wallet sees it ---------------------------------------------------------------- */
const sameFields = (a, b) => Array.isArray(a) && a.length === b.length && a.every((f, i) => f && f.name === b[i].name && f.type === b[i].type);
/** Throws unless `td` is exactly a Promote of `expect` (the reviewed, unchanged content) on this vault's domain. */
export function checkPromoteTypedData(td, { chainId, vault, expect }, nowSec = Math.floor(Date.now() / 1000)){
  const bad = (m) => { throw new ReleaseBlocked("typed-data", "Refused to sign: " + m); };
  if (!td || td.primaryType !== "Promote") bad("not a Promote.");
  const d = td.domain || {};
  if (Object.keys(d).some((k) => !["name", "version", "chainId", "verifyingContract", "salt"].includes(k)) || d.salt !== undefined) bad("unexpected domain field.");
  if (d.name !== "Enclave Sessions" || d.version !== "1" || Number(d.chainId) !== chainId || lower(d.verifyingContract) !== lower(vault)) bad("wrong domain.");
  const types = td.types || {};
  if (Object.keys(types).some((k) => k !== "Promote" && k !== "EIP712Domain") || !sameFields(types.Promote, PROMOTE_TYPE)) bad("wrong Promote type.");
  const m = td.message || {};
  if (Object.keys(m).sort().join() !== FIELDS) bad("unexpected message fields.");
  if (lower(m.deployment) !== lower(expect.deployment) || lower(m.publisher) !== lower(expect.publisher)) bad("wrong deployment or publisher.");
  for (const k of ["app", "appRef", "configCid", "versionLabel"]) if (typeof m[k] !== "string" || m[k] !== expect[k]) bad(k + " is not the reviewed value.");
  if (m.isPublic !== expect.isPublic) bad("public flag is not the reviewed value.");
  if (!isHex32(m.opNonce) || lower(m.opNonce) === ZERO32) bad("malformed nonce.");
  let dl; try { dl = BigInt(m.signBefore); } catch(e){ bad("malformed deadline."); }
  if (dl <= BigInt(nowSec) || dl > BigInt(nowSec + MAX_SIGN_WINDOW_SEC)) bad("deadline out of range.");
  return { nonce: lower(m.opNonce), deadline: dl.toString() };
}

/* ---- read-only outcome verification ----------------------------------------------------------------------------- */
/** Exact nonce + calldata + receipt + Promoted event + held commitment + unchanged content. Another owner's later
 *  promotion of the same content is NOT this operation's outcome (matched by nonce and sigHash only). */
export async function verifyPromoteOutcome(reader, rec){
  const I = rec.identity, M = rec.typed.message, R = [];
  if (await reader.chainId() !== I.chainId) return { status: "unresolved", reasons: ["read endpoint is on another chain"] };
  let txHash = rec.txHash && isHex32(rec.txHash) ? lower(rec.txHash) : null;
  if (!txHash){
    const latest = await reader.latestBlock();
    const from = BigInt(rec.startBlock), end = from + SCAN_SPAN < latest.number ? from + SCAN_SPAN : latest.number;
    const found = new Set();
    for (let lo = from; lo <= end; lo += SCAN_CHUNK){
      const hi = lo + SCAN_CHUNK - 1n < end ? lo + SCAN_CHUNK - 1n : end;
      for (const l of await reader.logs({ address: I.vault, topics: [TOPIC_PROMOTED, lower(I.deployment)], fromBlock: lo, toBlock: hi }) || []) found.add(lower(l.transactionHash));
    }
    const mine = [];
    for (const h of found){ const t = await reader.tx(h); const c = t && decodePromoteCalldata(t.input); if (c && c.opNonce === rec.nonce) mine.push(h); }
    if (mine.length > 1) return { status: "conflict", reasons: ["more than one transaction carries this nonce"] };
    if (!mine.length){
      const used = await reader.read(I.vault, ABI.vault, "ownerNonceUsed", [rec.nonce], latest.number).catch(() => null);
      if (used === true) return { status: "conflict", reasons: ["nonce is used on-chain but no matching Promoted transaction was found in the scanned range"] };
      return { status: "unresolved", reasons: ["no promotion with this nonce found in blocks " + from + "-" + end +
        (BigInt(latest.timestamp) > BigInt(rec.deadline) ? " (deadline passed; this is NOT permission to sign again)" : "")] };
    }
    txHash = mine[0];
  }
  const [tx, rc] = await Promise.all([reader.tx(txHash), reader.receipt(txHash)]);
  if (!tx || !rc) return { status: "pending", txHash, reasons: ["no receipt yet (or reorged out)"] };
  const c = decodePromoteCalldata(tx.input);
  if (lower(tx.to) !== I.vault || !c) R.push("transaction is not a promote call to your vault");
  else {
    for (const k of CONTENT) if (String(k === "deployment" || k === "publisher" ? lower(c[k]) : c[k]) !== String(k === "deployment" || k === "publisher" ? lower(M[k]) : M[k])) R.push("calldata " + k + " differs from the signed promotion");
    if (c.opNonce !== rec.nonce || c.signBefore !== rec.deadline) R.push("calldata nonce/deadline differ from the signed promotion");
    if (rec.sigHash && keccak256Hex(c.sig) !== rec.sigHash) R.push("calldata signature differs from the one this browser obtained");
  }
  const ok = rc.status === "success" || rc.status === 1 || rc.status === "0x1";
  if (!ok) R.push("receipt status is failure");
  const canonB = await reader.blockByNumber(rc.blockNumber);
  if (!canonB) return { status: "pending", txHash, reasons: ["receipt block not readable yet"] };
  if (canonB.hash !== lower(rc.blockHash)) return { status: "pending", txHash, reasons: ["receipt block is no longer canonical (reorg)"] };
  const commit = promotedHash(M.appRef, M.configCid), ta = tail(utf8Hex(M.appRef));
  const data = "0x" + pad32(commit) + word(96) + word(96 + ta.length / 2) + ta + tail(utf8Hex(M.configCid));
  const ev = (rc.logs || []).filter((l) => lower(l.address) === I.vault && lower((l.topics || [])[0]) === TOPIC_PROMOTED && lower((l.topics || [])[1]) === I.deployment);
  if (ev.length !== 1 || lower(ev[0].data) !== data) R.push("no exact vault Promoted(id, commitment, appRef, configCid) event");
  if (R.length) return { status: "conflict", txHash, reasons: R };
  const at = BigInt(rc.blockNumber);
  const [used, held, row] = await Promise.all([reader.read(I.vault, ABI.vault, "ownerNonceUsed", [rec.nonce], at),
    reader.read(I.vault, ABI.vault, "held", [I.deployment], at), reader.read(I.ledger, ABI.ledger, "get", [I.deployment], at)]);
  const h = Array.isArray(held) ? held : [held[0], held[1], held[2]];
  if (used !== true) R.push("ownerNonceUsed(nonce) is not set");
  if (Number(h[0]) !== 2 || lower(h[1]) !== commit) R.push("the vault does not hold this exact PRODUCTION commitment");
  if (lower(row.owner) !== I.vault || String(row.appRef) !== M.appRef || String(row.configCid) !== M.configCid || Boolean(row.isPublic) !== M.isPublic)
    R.push("the ledger record's owner or content is not the promoted, unchanged content");
  if (R.length) return { status: "conflict", txHash, block: at.toString(), reasons: R };
  const fin = await reader.blockByNumber("finalized").catch(() => null);
  const final = fin && fin.number >= at;
  return { status: final ? "finalized" : "included", txHash, block: at.toString(), blockHash: lower(rc.blockHash),
    reasons: [final ? "promotion included and at or below the finalized block" : "promotion included; not finalized yet (a reorg could still remove it)"] };
}

/* ---- the promotion controller ------------------------------------------------------------------------------------- */
/** deps: as createReleaseController. One deployment, one owner click on a rendered review, one signature, at most one POST. */
export function createPromotionController(deps){
  const { sdk, provider, relay, reader, journal, census } = deps;
  const wallet = lower(deps.wallet), vault = lower(deps.vault), id = lower(deps.deployment);
  const ownerAddress = deps.ownerAddress || deps.wallet;
  const chainId = PINS.chainId;
  const nowSec = deps.nowSec || (() => Math.floor(Date.now() / 1000));
  const writer = deps.writer || keccak256Hex("0x" + Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join(""));
  const identity = { chainId, ledger: PINS.ledger, vault, wallet, deployment: id, owner: wallet };
  const key = promoteKey(identity);
  let live = true, busy = false;
  const assertLive = () => { if (!live) throw new ReleaseError("gone", "The page, wallet account or chain changed; nothing was sent."); };

  async function providerGate(){
    if (!provider || typeof provider.request !== "function") throw new ReleaseError("provider", "No wallet connected.");
    const [cid, accts] = await Promise.all([provider.request({ method: "eth_chainId" }), provider.request({ method: "eth_accounts" })]);
    if (Number(cid) !== chainId) throw new ReleaseError("provider-chain", "Your wallet is on chain " + Number(cid) + ", not Base.");
    if (!Array.isArray(accts) || lower(accts[0]) !== wallet) throw new ReleaseError("provider-account", "Your wallet's active account is not " + wallet + ".");
  }
  /** Fresh snapshot + census + catalog at one block; promotion is offered only when every OTHER release gate is clear. */
  async function gate(extend){
    if (!isWalletCensus(census) || census.wallet !== wallet || census.vault !== vault)
      throw new ReleaseError("census", "No authority census for this wallet and vault is attached; nothing can move.");
    const snap = await readSnapshot(reader, { wallet, vault, id }, nowSec()).catch((e) => { throw e instanceof ReleaseBlocked ? new ReleaseError(e.code, e.message) : e; });
    const catalog = await readCatalog(reader, snap);
    const ev = evaluateRelease(snap, await census.qualify(snap, { extend }), { nowSec: nowSec(), catalog });
    const blockers = ev.blockers.filter((b) => !PROMOTABLE.includes(b.code));
    if (snap.held.env !== 2) blockers.push({ code: "not-prod", text: "Promotion is offered only for PRODUCTION custody; a STAGING app moves through the unchanged release path." });
    else if (!ev.blockers.some((b) => PROMOTABLE.includes(b.code))) blockers.push({ code: "already-promoted", text: "Its current version/config is already the promoted one; no promotion is needed. Review the release step instead." });
    if (!catalog.ok) blockers.push({ code: "catalog", text: catalog.reason });
    if (!ev.review.ownerReviewHash) blockers.push({ code: "review", text: "This state cannot be bound to a review." });
    const row = snap.pre.row;
    const content = catalog.ok ? { deployment: id, app: catalog.app, publisher: catalog.publisher, appRef: row.appRef, configCid: row.configCid,
      versionLabel: catalog.versionLabel, isPublic: row.isPublic } : null;
    const review = { ...ev.review, step: "promote", content, commitment: promotedHash(row.appRef, row.configCid),
      signature: "One EIP-712 \"Promote\" signature on your vault's domain naming exactly this deployment, catalog app, publisher, version label, appRef, configCid and public flag, plus a one-time nonce and deadline. It does NOT move the app; releasing it is a separate step you review and sign later." };
    return { snap, ev, blockers, review };
  }
  async function fence(){
    if (typeof journal.vaultRecords !== "function") return [];
    return (await journal.vaultRecords(identity)).filter((r) => r.key !== key && !RESOLVED.has(r.state)).map((r) => ({ code: r.kind === PROMOTE_KIND ? "promotion-pending" : "release-pending",
      text: "An owner operation of your wallet (" + (r.kind || "release") + " of " + r.identity.deployment.slice(0, 10) + "…, " + r.state + ") is not settled on-chain; no promotion starts until it is." }));
  }

  async function check(){
    let record;
    try { record = await journal.get(key); }
    catch(e){ return { kind: "blocked", blockers: [{ code: "storage", text: "The release journal (browser storage) is unavailable: " + short(e) }] }; }
    const blockers = [];
    let review = null;
    try { const g = await gate(true); blockers.push(...g.blockers); review = g.review; }
    catch(e){ blockers.push({ code: e instanceof ReleaseError ? e.code : "read", text: e instanceof ReleaseError ? e.message : "Could not read the chain: " + short(e) }); }
    try { blockers.push(...await fence()); } catch(e){ blockers.push({ code: "storage", text: "The release journal (browser storage) is unavailable: " + short(e) }); }
    try { await providerGate(); } catch(e){ blockers.push({ code: e.code || "provider", text: e.message }); }
    if (record && !RESOLVED.has(record.state)) return { kind: "journal", record, blockers, review };
    return { kind: blockers.length ? "blocked" : "eligible", record, blockers, review };
  }

  /** The owner's click on the rendered promotion review. Never releases. Code "uncertain" means it MAY have been sent. */
  async function promote(election){
    if (busy) throw new ReleaseError("busy", "A promotion is already in progress here.");
    busy = true;
    const ctx = { rec: null, sig: null };
    const cancel = async (why) => {
      if (!ctx.rec || !PRE_DISPATCH.has(ctx.rec.state)) return;
      try { ctx.rec = await journal.cas(key, { state: ctx.rec.state, rev: ctx.rec.rev, writer }, { state: "cancelled", note: why.slice(0, 300) }); } catch(e){ /* recovery cancels after the deadline */ }
    };
    const settle = async (patch) => { try { ctx.rec = await journal.cas(key, { state: ctx.rec.state, rev: ctx.rec.rev, writer }, patch); } catch(e){ /* stays dispatching = uncertain */ } };
    const same = (g, why) => {
      if (g.blockers.length) return "No longer eligible: " + g.blockers.map((b) => b.text).join(" ");
      if (g.review.ownerReviewHash !== election.reviewHash) return "The content, catalog, custody, balance, sessions or delegations changed since your review" + (why ? " " + why : "");
      return null;
    };
    try {
      assertLive();
      if (!isOwnerReview(election, "promote", identity)) throw new ReleaseError("review", "No owner review of this promotion was given on this page; nothing was signed.");
      await providerGate();
      const existing = await journal.get(key);
      if (existing && !RESOLVED.has(existing.state)) throw new ReleaseError("exists", "A promotion of this deployment is already recorded (" + existing.state + ").");
      const f = await fence();
      if (f.length) throw new ReleaseError("fence", f[0].text);
      const g0 = await gate(true);
      const w0 = same(g0);
      if (w0) throw new ReleaseError("changed", w0 + ". Review again; nothing was signed.");
      const expect = g0.review.content;
      assertLive();
      const real = sdk.ownerFromProvider(provider, ownerAddress);

      const signer = {
        address: ownerAddress,
        async signTypedData(td){
          assertLive();
          if (ctx.rec) throw new ReleaseError("twice", "Only one signature per promotion.");
          const t = checkPromoteTypedData(td, { chainId, vault, expect }, nowSec());
          await providerGate();
          assertLive();
          const pre = await gate(false);
          const w = same(pre);
          if (w) throw new ReleaseError("changed", w + ". Nothing was signed.");
          assertLive();
          const now = Date.now();
          ctx.rec = await journal.putIfAbsent({
            schema: JOURNAL_SCHEMA, kind: PROMOTE_KIND, key, identity, state: "intent", rev: 0, writer, createdAt: now, updatedAt: now,
            typed: jsonSafe({ domain: td.domain, primaryType: td.primaryType, types: { Promote: td.types.Promote }, message: td.message }),
            nonce: t.nonce, deadline: t.deadline, prestateHash: g0.ev.prestateHash, ownerReview: election.reviewHash,
            content: { appRef: expect.appRef, configCid: expect.configCid, commitment: g0.review.commitment }, catalog: jsonSafe(g0.review.catalog),
            census: { policyHash: g0.ev.censusPolicy, block: pre.snap.block.number, blockHash: pre.snap.block.hash },
            startBlock: g0.snap.block.number, startBlockHash: g0.snap.block.hash, sigHash: null, txHash: null, note: "",
          }, { replaceRev: existing ? existing.rev : undefined }).catch((e) => { throw e && e.code === "fence" ? new ReleaseError("fence", e.message) : e; });
          assertLive();
          const sig = await real.signTypedData(td);
          let why = null;
          if (!live) why = "The page, wallet account or chain changed while your wallet was open";
          else if (!/^0x[0-9a-fA-F]{130,}$/.test(String(sig))) why = "The wallet returned a malformed signature";
          else { try { await providerGate(); } catch(e){ why = e.message; } }
          if (!why && !live) why = "The page, wallet account or chain changed while your wallet was open";
          if (why){ await cancel(why); throw new ReleaseError("after-sign", why + "; nothing was sent."); }
          ctx.rec = await journal.cas(key, { state: "intent", rev: ctx.rec.rev, writer }, { state: "signed", sigHash: keccak256Hex(sig) });
          ctx.sig = sig;
          return sig;
        },
      };

      const guardedRelay = {
        async request(method, path, body){
          if (method !== "POST" || path !== "/owner") throw new ReleaseError("relay-shape", "Refused an unexpected relay request.");
          if (!ctx.rec || ctx.rec.state !== "signed" || !ctx.sig) throw new ReleaseError("relay-order", "No durable signed promotion to send.");
          const m = ctx.rec.typed.message, a = body && body.args;
          const exact = body && Object.keys(body).sort().join() === "args,op,owner,sig,vault" && body.op === "promote" &&
            lower(body.owner) === wallet && lower(body.vault) === vault && body.sig === ctx.sig && keccak256Hex(body.sig) === ctx.rec.sigHash &&
            a && Object.keys(a).sort().join() === FIELDS && lower(a.deployment) === lower(m.deployment) && lower(a.publisher) === lower(m.publisher) &&
            ["app", "appRef", "configCid", "versionLabel"].every((k) => a[k] === m[k]) && a.isPublic === m.isPublic &&
            lower(a.opNonce) === ctx.rec.nonce && String(a.signBefore) === ctx.rec.deadline;
          if (!exact){ await cancel("relay body did not match the signed promotion"); throw new ReleaseError("relay-shape", "The promotion to send did not match what you signed; nothing was sent."); }
          let why = null;
          try {
            assertLive();
            await providerGate();
            const g2 = await gate(false);           // content, catalog, promotion, census and economics re-read after the signature
            why = same(g2, "while you were signing");
            if (!why && g2.ev.prestateHash !== ctx.rec.prestateHash) why = "The deployment, escrow or reserve state changed while you were signing";
            if (!why && g2.ev.censusPolicy !== ctx.rec.census.policyHash) why = "Your sessions or delegations changed while you were signing";
            if (!why && BigInt(ctx.rec.deadline) <= BigInt(nowSec() + DEADLINE_MARGIN_SEC)) why = "The signature is too close to its deadline";
            if (!why && typeof reader.simulate === "function"){
              try { await reader.simulate(vault, promoteCalldata({ ...m, signBefore: ctx.rec.deadline, opNonce: ctx.rec.nonce }, ctx.sig), BigInt(g2.snap.block.number)); }
              catch(e){ why = "A simulation of the exact signed promotion reverted (" + short(e) + ")"; }
            }
            assertLive();
          } catch(e){ why = why || e.message; }
          if (why){ await cancel(why); throw new ReleaseError("revalidate", why + ". Nothing was sent."); }
          ctx.rec = await journal.cas(key, { state: "signed", rev: ctx.rec.rev, writer }, { state: "dispatching", dispatchedAt: Date.now() });
          assertLive();                               // synchronous: no await between this and the request
          let res;
          try { res = await relay.request("POST", "/owner", body); }
          catch(e){
            await settle({ state: "uncertain", note: ("relay error after dispatch: " + short(e)).slice(0, 300) });
            throw new ReleaseError("uncertain", "The relay did not confirm (" + short(e) + "). It may still have been sent: this promotion is now checked on-chain only and will not be signed or sent again; no release is offered until it is settled.");
          }
          const tx = res && /^0x[0-9a-fA-F]{64}$/.test(String(res.txHash)) ? lower(res.txHash) : null;
          await settle(tx ? { state: "submitted", txHash: tx } : { state: "uncertain", note: "relay answered without a transaction hash" });
          return res;
        },
      };

      try {
        return await sdk.ownerOperation({ relay: guardedRelay, owner: signer, chainId, vault: deps.vault, op: { op: "promote", ...expect } });
      } catch(e){
        if (e instanceof ReleaseError || e instanceof ReleaseBlocked) throw e;
        await cancel("wallet or SDK error before dispatch: " + short(e));
        const m = short(e);
        if ((e && e.code === 4001) || /reject|denied|declin|cancel/i.test(m)) throw new ReleaseError("rejected", "Signature rejected; nothing was sent.");
        throw new ReleaseError(ctx.rec && IN_FLIGHT.has(ctx.rec.state) ? "uncertain" : "failed", m);
      }
    } finally {
      ctx.sig = null;
      busy = false;
    }
  }

  /** Read-only reconciliation: never signs, posts or releases. */
  async function recover(){
    const rec = await journal.get(key);
    if (!rec) return { record: null, outcome: null };
    if (PRE_DISPATCH.has(rec.state)){
      const b = await reader.latestBlock();
      if (b && BigInt(b.timestamp) > BigInt(rec.deadline))
        return { record: await journal.cas(key, { state: rec.state, rev: rec.rev }, { state: "cancelled", note: "expired on-chain before dispatch; this browser never sent it" }), outcome: null };
      return { record: rec, outcome: { status: "pre-dispatch", reasons: ["started but not sent; resolves after its deadline"] } };
    }
    if (!IN_FLIGHT.has(rec.state)) return { record: rec, outcome: null };
    const v = await verifyPromoteOutcome(reader, rec);
    let patch = null;
    if (v.status === "finalized" || v.status === "conflict") patch = { state: v.status, txHash: v.txHash || rec.txHash, block: v.block || null, note: v.reasons.join("; ").slice(0, 300) };
    else if (v.status === "included" && rec.state !== "included") patch = { state: "included", txHash: v.txHash, block: v.block, note: v.reasons.join("; ").slice(0, 300) };
    else if (v.status === "pending" && v.txHash && rec.state !== "submitted") patch = { state: "submitted", txHash: v.txHash, note: v.reasons.join("; ").slice(0, 300) };
    if (!patch) return { record: rec, outcome: v };
    return { record: await journal.cas(key, { state: rec.state, rev: rec.rev }, patch), outcome: v };
  }

  return { key, identity, check, promote, recover, get busy(){ return busy; }, dispose(){ live = false; } };
}
