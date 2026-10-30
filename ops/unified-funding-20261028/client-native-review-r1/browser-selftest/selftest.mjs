// client-native-r1 browser self-test (UNREVIEWED, NOT RUN). Bundled by root to dist/selftest.js (see README).
// Exercises the REVIEWED client-repair-r3 v2-store (unchanged) in a REAL browser:
//   1. structured clone of a NON-extractable WebCrypto P-256 CryptoKey through IndexedDbV2Store (save -> load -> sign);
//   2. two independent contexts (this page + a same-origin iframe, each with its own IndexedDB connections) racing
//      casJournal on the same entry: exactly ONE admission per round;
//   3. durability across a page reload (Run, reload, Resume);
//   4. an "old" legacy-shaped TEST database seeded once and verified untouched afterwards.
// It only ever opens databases named PREFIX + random hex (refused otherwise), never "enclave-sessions" or
// "enclave-funding-v2", never enumerates databases, makes no network request (the server's CSP sets connect-src 'none'),
// never touches a wallet provider, and never exports key bytes. No timer writes anything after a test finished.
import {
  IndexedDbV2Store, LEGACY_DB, V2_DB, newGasKey, newGasRecord, signerFor, validateGasRecord,
} from "../../client-repair-r3/lib/v2-store.mjs";

const PREFIX = "client-native-r1-selftest-";
const REAL = new Set([LEGACY_DB, V2_DB]);
const SS_KEY = "client-native-r1-selftest";          // sessionStorage: only the TEST db names and public ids
const ROUNDS = 25;
const TEST_ADDR = "0x000000000000000000000000000000000000dEaD";
const role = new URLSearchParams(location.search).get("role") === "child" ? "child" : "parent";

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const randomName = (kind) => `${PREFIX}${kind}-${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
function guardName(n) {
  if (typeof n !== "string" || !n.startsWith(PREFIX) || REAL.has(n)) throw new Error(`refusing to open database ${n}`);
  return n;
}
const failCode = (code, message) => Object.assign(new Error(message), { code });

/** The CAS mutation both contexts race: planned -> admitted, exactly once. (No key named r / s / sig: journals are public.) */
function admitOnce(cur, tag) {
  if (!cur) throw failCode("plan_missing", "no entry");
  const st = cur.steps.step1;
  if (st.status !== "planned") throw failCode("step_not_planned", `already ${st.status} by ${st.by}`);
  st.status = "admitted";
  st.by = tag;
  cur.rev = Number(cur.rev) + 1;
  return cur;
}

// =====================================================================================================================
// child context: answers "cas" messages from its parent (same origin only), with its OWN store/connections
// =====================================================================================================================
if (role === "child") {
  window.addEventListener("message", async (ev) => {
    if (ev.origin !== location.origin || ev.source !== window.parent) return;
    const { cmd, db, id } = ev.data || {};
    if (cmd !== "cas") return;
    let out;
    try {
      await new IndexedDbV2Store(guardName(db)).casJournal(id, (cur) => admitOnce(cur, "child"));
      out = { ok: true };
    } catch (e) { out = { ok: false, code: e.code ?? e.name, message: String(e.message) }; }
    window.parent.postMessage({ cmd: "cas-result", id, ...out }, location.origin);
  });
  window.parent.postMessage({ cmd: "child-ready" }, location.origin);
}

// =====================================================================================================================
// parent page
// =====================================================================================================================
if (role === "parent") {
  const $ = (id) => document.getElementById(id);
  const logEl = $("log"), statusEl = $("status");
  const log = (m) => { logEl.textContent += `${m}\n`; };
  const setStatus = (r, m) => { statusEl.dataset.result = r; statusEl.textContent = `${r}${m ? `: ${m}` : ""}`; };
  const check = (cond, what) => { if (!cond) throw new Error(`check failed: ${what}`); log(`  ok  ${what}`); };
  let busy = false;
  const button = (id, fn) => $(id).addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    for (const b of ["run", "resume", "cleanup"]) $(b).disabled = true;
    logEl.textContent = "";
    setStatus("RUNNING");
    try { await fn(); } catch (e) { log(`FAIL ${e?.message ?? e}`); setStatus("FAIL", e?.message ?? String(e)); }
    finally { busy = false; for (const b of ["run", "resume", "cleanup"]) $(b).disabled = false; }
  });

  async function verifyKey(privateKey, x, y, what) {
    check(privateKey instanceof CryptoKey, `${what}: is a CryptoKey`);
    check(privateKey.type === "private" && privateKey.extractable === false, `${what}: private and NON-extractable`);
    check(privateKey.usages.includes("sign"), `${what}: usable for sign`);
    let exported = false;
    try { await crypto.subtle.exportKey("pkcs8", privateKey); exported = true; } catch { /* refused, as required */ }
    check(!exported, `${what}: pkcs8 export refused`);
    const digest = `0x${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
    const { r, s } = await signerFor(privateKey, BigInt(x), BigInt(y)).signDigest(digest);
    const xy = (v) => BigInt(v).toString(16).padStart(64, "0");
    const raw = Uint8Array.from((`04${xy(x)}${xy(y)}`).match(/../g), (b) => parseInt(b, 16));
    const pub = await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const sig = Uint8Array.from((r.slice(2) + s.slice(2)).match(/../g), (b) => parseInt(b, 16));
    const msg = Uint8Array.from(digest.slice(2).match(/../g), (b) => parseInt(b, 16));
    check(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, msg), `${what}: signs; public key verifies`);
  }

  // ---- the "old" legacy-shaped TEST database (SDK store shape: one "keys" store), never written after seeding ------
  function rawOpen(name, create) {
    return new Promise((ok, bad) => {
      const r = indexedDB.open(guardName(name), 1);
      r.onupgradeneeded = () => {
        if (!create) { r.transaction.abort(); return; }
        r.result.createObjectStore("keys", { keyPath: "id" });
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => bad(r.error ?? new Error(`cannot open ${name}`));
    });
  }
  const rawReq = (db, mode, f) => new Promise((ok, bad) => {
    const t = db.transaction("keys", mode);
    const q = f(t.objectStore("keys"));
    t.oncomplete = () => ok(q.result);
    t.onerror = () => bad(t.error);
  });
  async function seedOld(name) {
    const k = await newGasKey();
    const db = await rawOpen(name, true);
    await rawReq(db, "readwrite", (s) => s.put({ id: "old-1", privateKey: k.privateKey, x: k.x.toString(), y: k.y.toString(), keyHash: k.keyHash }));
    db.close();
    return k.keyHash;
  }
  async function checkOld(name, keyHash) {
    const db = await rawOpen(name, false);
    check(db.version === 1 && [...db.objectStoreNames].join() === "keys", "old test DB: version 1, only its own store");
    const all = await rawReq(db, "readonly", (s) => s.getAll());
    db.close();
    check(all.length === 1 && all[0].id === "old-1" && all[0].keyHash === keyHash, "old test DB: exactly its one record, unchanged");
    await verifyKey(all[0].privateKey, all[0].x, all[0].y, "old test DB key");
  }

  // ---- the second context ---------------------------------------------------------------------------------------
  function openChild() {
    return new Promise((ok, bad) => {
      const f = document.createElement("iframe");
      f.hidden = true;
      f.src = "/child.html?role=child";
      const timer = setTimeout(() => { window.removeEventListener("message", ready); bad(new Error("child context did not start")); }, 10_000);
      function ready(ev) {
        if (ev.origin !== location.origin || ev.source !== f.contentWindow || ev.data?.cmd !== "child-ready") return;
        clearTimeout(timer);
        window.removeEventListener("message", ready);
        ok(f);
      }
      window.addEventListener("message", ready);
      document.body.appendChild(f);
    });
  }
  const childCas = (frame, db, id) => new Promise((ok) => {
    function onMsg(ev) {
      if (ev.origin !== location.origin || ev.source !== frame.contentWindow || ev.data?.cmd !== "cas-result" || ev.data.id !== id) return;
      window.removeEventListener("message", onMsg);
      ok(ev.data);
    }
    window.addEventListener("message", onMsg);
    frame.contentWindow.postMessage({ cmd: "cas", db, id }, location.origin);
  });

  // ---- Run --------------------------------------------------------------------------------------------------------
  button("run", async () => {
    const v2Name = randomName("v2"), oldName = randomName("old");
    sessionStorage.setItem(SS_KEY, JSON.stringify({ v2Name, oldName, phase: "started" }));
    log(`test databases: ${v2Name}, ${oldName} (fresh random names; real databases are never opened)`);
    const oldKeyHash = await seedOld(oldName);

    log("1. structured clone of a non-extractable CryptoKey through IndexedDbV2Store");
    const store = new IndexedDbV2Store(v2Name);
    const key = await newGasKey();
    const rec = newGasRecord({ key, chainId: 8453, relay: "http://127.0.0.1", owner: TEST_ADDR, vault: TEST_ADDR, factory: TEST_ADDR,
      implementation: TEST_ADDR, label: "client-native-r1 selftest (TEST key)", now: Math.floor(Date.now() / 1000) });
    await store.saveKey(rec);
    const back = await store.loadKey(rec.id);
    check(back && back.privateKey !== key.privateKey, "loaded record is a structured clone (a new CryptoKey object)");
    validateGasRecord(back);
    log("  ok  validateGasRecord accepts the loaded record");
    await verifyKey(back.privateKey, back.x, back.y, "loaded gas key");

    log(`2. two contexts race casJournal, ${ROUNDS} rounds: exactly one admission each`);
    const frame = await openChild();
    const wins = { parent: 0, child: 0 };
    for (let i = 1; i <= ROUNDS; i++) {
      const id = `cas-${i}`;
      await store.putJournal({ id, kind: "selftest-cas", rev: 0, steps: { step1: { status: "planned" } } });
      const c = childCas(frame, v2Name, id);
      const p = store.casJournal(id, (cur) => admitOnce(cur, "parent")).then(() => ({ ok: true }), (e) => ({ ok: false, code: e.code }));
      const [pr, cr] = await Promise.all([p, c]);
      if (pr.ok === cr.ok) throw new Error(`round ${i}: parent ok=${pr.ok}, child ok=${cr.ok} (exactly one must win)`);
      const loser = pr.ok ? cr : pr;
      if (loser.code !== "step_not_planned") throw new Error(`round ${i}: the loser failed with ${loser.code}, not step_not_planned`);
      const fin = await store.getJournal(id);
      const winner = pr.ok ? "parent" : "child";
      if (fin.steps.step1.status !== "admitted" || fin.steps.step1.by !== winner || fin.rev !== 1) throw new Error(`round ${i}: final entry ${JSON.stringify(fin)}`);
      wins[winner]++;
    }
    log(`  ok  ${ROUNDS} rounds, one admission each (parent won ${wins.parent}, child won ${wins.child})`);
    frame.remove();

    log("3. durable marker for the reload check");
    await store.putJournal({ id: "durable-1", kind: "selftest-durable", rev: 1, steps: { step1: { status: "admitted", by: "parent" } } });
    log("4. the old test database is untouched");
    await checkOld(oldName, oldKeyHash);
    sessionStorage.setItem(SS_KEY, JSON.stringify({ v2Name, oldName, phase: "ran", recId: rec.id, keyHash: rec.keyHash, oldKeyHash, rounds: ROUNDS }));
    setStatus("PASS", "run complete - now RELOAD the page and click Resume");
  });

  // ---- Resume (after a reload) ---------------------------------------------------------------------------------------
  button("resume", async () => {
    const s = JSON.parse(sessionStorage.getItem(SS_KEY) || "null");
    if (!s || s.phase !== "ran") throw new Error("click Run first (and pass it)");
    const nav = performance.getEntriesByType("navigation")[0];
    check(nav?.type === "reload", "this document was loaded by a reload");
    const store = new IndexedDbV2Store(guardName(s.v2Name));
    const rec = await store.loadKey(s.recId);
    check(rec && rec.keyHash === s.keyHash, "the gas key record survived the reload");
    validateGasRecord(rec);
    await verifyKey(rec.privateKey, rec.x, rec.y, "reloaded gas key");
    const d = await store.getJournal("durable-1");
    check(d?.steps?.step1?.status === "admitted" && d.steps.step1.by === "parent", "the durable journal entry survived the reload");
    for (let i = 1; i <= s.rounds; i++) {
      const e = await store.getJournal(`cas-${i}`);
      if (e?.steps?.step1?.status !== "admitted" || e.rev !== 1) throw new Error(`cas-${i} lost or changed across the reload`);
    }
    log(`  ok  all ${s.rounds} CAS outcomes survived the reload unchanged`);
    await checkOld(guardName(s.oldName), s.oldKeyHash);
    sessionStorage.setItem(SS_KEY, JSON.stringify({ ...s, phase: "resumed" }));
    setStatus("PASS", "resume complete (reload durability + old test DB untouched)");
  });

  // ---- Cleanup: deletes ONLY the two owned test databases -----------------------------------------------------------
  button("cleanup", async () => {
    const s = JSON.parse(sessionStorage.getItem(SS_KEY) || "null");
    if (!s) { setStatus("PASS", "nothing to clean"); return; }
    for (const n of [s.v2Name, s.oldName]) {
      await new Promise((ok, bad) => { const r = indexedDB.deleteDatabase(guardName(n)); r.onsuccess = ok; r.onerror = () => bad(r.error); r.onblocked = () => bad(new Error("owned test database deletion is blocked")); });
      log(`deleted ${n}`);
    }
    sessionStorage.removeItem(SS_KEY);
    setStatus("PASS", "owned test databases deleted");
  });

  setStatus("IDLE", "click Run");
}
