/* ============================================================
   The wallet's deployments from the ledger alone, bounded and resumable
   (independent mode; no indexer, no API).

   EnclaveDeployments keeps every record id in an append-only array, and
   a record's owner changes only at create/import (a new index) or through
   transferDeployment, which emits DeploymentTransferred. So this keeps a
   per-tab index of (id, owner) built from count()/getPage() a few pages at
   a time, each call at a FRESH agreed block, and before scanning further
   applies every DeploymentTransferred event since the block the index was
   last synchronized to. Pages and events are read with RPC agreement
   (js/core/quorum.js).

   Rows are never taken from the index: every candidate (an index entry
   owned by the wallet or its vault, or an id the user asked to watch) is
   re-read with get(id) at the current agreed block. The result says
   whether the scan is complete; an incomplete scan is labeled as such and
   continues on the next call. If the RPCs will not serve event history,
   completeness needs a full pass inside ONE snapshot; otherwise the list
   stays marked unverified rather than being presented as complete.

   The index lives in sessionStorage (dies with the tab) and only nominates
   candidates; a planted entry cannot add a row the chain does not confirm.
   ============================================================ */
import { DEPLOYMENTS_ADDRESS, INDEPENDENT } from "./config.js";
import { keccak256Utf8 } from "./keccak.js";
import { DEP_SCHEMA, DEP_SCHEMA_V1, decodeStructArray, decodeStruct, pad32 } from "./chain.js";

const PAGE = 100;
/* Per-call bounds of one listing step (wall time, pages of PAGE records). Page-local; tests lower them to force a
   multi-call scan. Raising them only makes a step longer: completeness never depends on them. */
export const LIST_LIMITS = { budgetMs: 8000, maxPages: 40 };
const LOG_SPAN = 2000;                       // blocks per eth_getLogs request (public RPCs cap ranges)
const MAX_LOG_CHUNKS = 60;                   // beyond this a re-scan is cheaper than catching up on events
export const TRANSFER_TOPIC = keccak256Utf8("DeploymentTransferred(bytes32,address,address)");
const sel = (sig) => keccak256Utf8(sig).slice(2, 10);
const word = (hex, i = 0) => BigInt("0x" + (String(hex).replace(/^0x/, "").slice(i * 64, i * 64 + 64) || "0"));
const ID = /^0x[0-9a-f]{64}$/, ADDR = /^0x[0-9a-f]{40}$/;

const keyOf = () => "enclave_ind_index:v1:" + INDEPENDENT.profile.chainId + ":" + String(DEPLOYMENTS_ADDRESS).toLowerCase();
const WATCH_KEY = "enclave_ind_watch";
function tab(){ try { return globalThis.sessionStorage || null; } catch { return null; } }

function loadState(store){
  try {
    const s = JSON.parse(store.getItem(keyOf()) || "null");
    if (!s || s.v !== 1 || !Array.isArray(s.ids) || !Array.isArray(s.owners) || s.ids.length !== s.owners.length
      || !Number.isSafeInteger(s.next) || s.next < 0 || s.next > s.ids.length || !Number.isSafeInteger(s.synced) || s.synced < 0
      || !s.ids.every((x) => ID.test(x)) || !s.owners.every((x) => ADDR.test(x))) return null;
    return s;
  } catch { return null; }
}
function saveState(store, s){ try { store.setItem(keyOf(), JSON.stringify(s)); } catch { /* quota: keep the in-memory copy */ } }

export function watchedIds(store = tab()){
  try { const l = JSON.parse((store && store.getItem(WATCH_KEY)) || "[]"); return Array.isArray(l) ? l.filter((x) => ID.test(x)).slice(0, 50) : []; }
  catch { return []; }
}
/* Track a deployment by its full id (the explicit lookup that needs no scan at all). */
export function watchId(id, store = tab()){
  const v = String(id || "").trim().toLowerCase();
  if (!ID.test(v)) throw new Error("enter a full deployment id (0x and 64 hex characters)");
  const l = watchedIds(store); if (!l.includes(v)) l.push(v);
  if (store) store.setItem(WATCH_KEY, JSON.stringify(l.slice(-50)));
  return v;
}

/* One bounded step. owners: wallet and vault addresses. Returns { snap, rev, rows, complete, scanned, total, mode,
   reason }. rows are re-read at snap; complete is true only when every index entry is current at snap. */
export async function listOwned(owners, { reader, ledgerRev, budgetMs = LIST_LIMITS.budgetMs, maxPages = LIST_LIMITS.maxPages, store = tab(), now = () => Date.now() } = {}){
  const want = new Set(owners.filter(Boolean).map((a) => String(a).toLowerCase()));
  if (!want.size) throw new Error("connect a wallet to list its deployments");
  const started = now();
  const snap = await reader.snapshot();
  const rev = await ledgerRev(reader, snap);
  const schema = rev >= 2 ? DEP_SCHEMA : DEP_SCHEMA_V1;
  const total = Number(word(await reader.call(snap, DEPLOYMENTS_ADDRESS, "0x" + sel("count()"))));
  if (!Number.isSafeInteger(total) || total < 0 || total > 1e6) throw new Error("implausible deployment count");
  let s = (store && loadState(store)) || { v: 1, ids: [], owners: [], next: 0, synced: snap.number };
  let mode = "events", reason = "";
  if (s.ids.length > total){ s = { v: 1, ids: [], owners: [], next: 0, synced: snap.number }; reason = "the ledger reports fewer records than this tab saw; started over"; }

  // 1) owner changes since the index was last synchronized, from the ledger's own events
  if (s.synced < snap.number && s.next > 0){
    const chunks = Math.ceil((snap.number - s.synced) / LOG_SPAN);
    let ok = chunks <= MAX_LOG_CHUNKS;
    if (ok){
      try {
        const pos = new Map(s.ids.map((id, i) => [id, i]));
        for (let from = s.synced + 1; from <= snap.number; from += LOG_SPAN){
          const to = Math.min(snap.number, from + LOG_SPAN - 1);
          for (const l of await reader.logs(snap, { address: DEPLOYMENTS_ADDRESS, topics: [TRANSFER_TOPIC], fromBlock: from, toBlock: to })){
            const i = pos.get(l.topics[1]);
            if (i !== undefined) s.owners[i] = "0x" + String(l.topics[3]).slice(26);
          }
        }
      } catch (e){ ok = false; reason = "transfer history unavailable from the chain endpoints (" + String(e.message || e).slice(0, 120) + ")"; }
    } else reason = "too many blocks since the last scan to catch up on transfers";
    if (!ok){ mode = "rescan"; s.next = 0; }        // re-read every owner instead; the earlier owners are not trusted
  }
  s.synced = snap.number;

  // 2) more records, a few pages per call. Entries [0, next) are current at `synced`; entries past `next` are never
  // candidates. Without event history a re-scan starts over at 0 and gets a larger budget, because it can only become
  // complete if it reaches the end before the next call needs events again.
  const pageBudget = mode === "rescan" ? Math.max(maxPages, 200) : maxPages;
  const timeBudget = mode === "rescan" ? Math.max(budgetMs, 30000) : budgetMs;
  let pages = 0;
  while (s.next < total && pages < pageBudget && now() - started < timeBudget){
    const n = Math.min(PAGE, total - s.next);
    const page = decodeStructArray(await reader.call(snap, DEPLOYMENTS_ADDRESS, "0x" + sel("getPage(uint256,uint256)") + pad32(s.next.toString(16)) + pad32(n.toString(16))), schema);
    if (page.length !== n) throw new Error("deployment page did not match the count");
    page.forEach((d, k) => { s.ids[s.next + k] = String(d.id).toLowerCase(); s.owners[s.next + k] = String(d.owner).toLowerCase(); });
    s.next += n; pages++;
  }
  if (store) saveState(store, s);
  const complete = s.next === total;

  // 3) candidates, re-read at this block: the index nominates, the chain decides
  const watched = watchedIds(store);
  const candidates = new Set(watched);
  s.ids.forEach((id, i) => { if (i < s.next && want.has(s.owners[i])) candidates.add(id); });
  const rows = [], notMine = [];
  const ids = [...candidates];
  for (let i = 0; i < ids.length; i += 8){
    const got = await Promise.all(ids.slice(i, i + 8).map(async (id) => {
      const d = decodeStruct(await reader.call(snap, DEPLOYMENTS_ADDRESS, "0x" + sel("get(bytes32)") + pad32(id.slice(2))), schema);
      return d && Number(d.createdAt) ? d : null;
    }));
    got.forEach((d, k) => {
      if (d && want.has(String(d.owner).toLowerCase())) rows.push(d);
      else if (watched.includes(ids[i + k])) notMine.push(ids[i + k]);
    });
  }
  return { snap, rev, rows, complete, scanned: s.next, total, mode, reason, notMine };
}
