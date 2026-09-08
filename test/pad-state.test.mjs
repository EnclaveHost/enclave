import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { loadPadState, savePadState } from "../relay/pad-state.mjs";
import { createPadsLedger, signedMessage } from "../relay/pads.mjs";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pad-state-"));
  const transport = generateKeyPairSync("ed25519"), pad = generateKeyPairSync("x25519");
  const spki = transport.publicKey.export({ type: "spki", format: "der" });
  const tunnel = { name: "phone", keyFp: createHash("sha256").update(spki).digest("hex"), spki: spki.toString("base64"),
    padKey: pad.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex") };
  const hub = { info: (name) => name === "phone" ? tunnel : null };
  return { dir, file: path.join(dir, "pads-ledger.json"), hub,
    open: (masterSeed) => createPadsLedger({ dir, hub, log: () => {}, masterSeed }),
    request(kind, fields, body = {}) {
      const nonce = randomBytes(kind === "seed-v2" ? 32 : 16).toString("hex");
      const sig = sign(null, Buffer.from(signedMessage(kind, ["phone", ...fields, nonce])), transport.privateKey).toString("hex");
      return { name: "phone", nonce, sig, ...body };
    },
    close() { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

test("ledger persistence syncs file and directory, and keeps seed material owner-only", () => {
  const f = fixture();
  try {
    const L = f.open(), original = loadPadState(f.file), events = [], fds = new Map();
    const io = { ...fs,
      openSync(file, ...args) { const fd = fs.openSync(file, ...args); fds.set(fd, String(file)); return fd; },
      fsyncSync(fd) { events.push(["sync", fds.get(fd)]); return fs.fsyncSync(fd); },
      renameSync(a,b) { events.push(["rename", b]); return fs.renameSync(a,b); }
    };
    const nested = path.join(f.dir, "new", "nested", "state.json");
    savePadState(nested, original, io);
    assert.deepEqual(events.map(([kind]) => kind), ["sync", "rename", "sync", "sync", "sync"]);
    assert.match(events[0][1], /\.tmp$/);
    assert.deepEqual(events.slice(2).map(([,p]) => p), [path.dirname(nested), path.join(f.dir,"new"), f.dir]);
    assert.equal(fs.statSync(nested).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(nested)).mode & 0o777, 0o700);
    assert.deepEqual(loadPadState(nested), original);
    assert.equal(f.open().key(), L.key());
  } finally { f.close(); }
});

test("failed writes, file sync, rename, or directory sync never acknowledge a state commit", () => {
  const f = fixture();
  try {
    f.open(); const original = loadPadState(f.file);
    for (const phase of ["write", "file-sync", "rename", "directory-sync"]) {
      savePadState(f.file, original);
      const next = { ...original, seeds: { marker: { mark: 64 } } };
      let syncs = 0;
      const fail = () => { throw Object.assign(new Error("injected persistence failure"), { code: "EIO" }); };
      const io = { ...fs,
        writeFileSync(...args) { if (phase === "write") fail(); return fs.writeFileSync(...args); },
        fsyncSync(fd) { syncs++; if ((phase === "file-sync" && syncs === 1) || (phase === "directory-sync" && syncs === 2)) fail(); return fs.fsyncSync(fd); },
        renameSync(...args) { if (phase === "rename") fail(); return fs.renameSync(...args); }
      };
      assert.throws(() => savePadState(f.file, next, io), /injected persistence failure/);
      const recovered = loadPadState(f.file);
      assert.deepEqual(recovered, phase === "directory-sync" ? next : original);
      assert.equal(fs.readdirSync(f.dir).filter(p => p.endsWith(".tmp")).length, 0);
    }
  } finally { f.close(); }
});

test("existing corrupt state and accidental master rotation fail without replacing the ledger", () => {
  const f = fixture();
  try {
    const master = "22".repeat(32), L = f.open(master), good = fs.readFileSync(f.file,"utf8");
    assert.equal(f.open(master.toUpperCase()).key(), L.key());
    for (const bad of ["", "{", "null", "[]", "{}", JSON.stringify({ ...JSON.parse(good), master: "z".repeat(64) }),
      JSON.stringify({ ...JSON.parse(good), seeds: null }), JSON.stringify({ ...JSON.parse(good), ledgerKey: "invalid" })]) {
      fs.writeFileSync(f.file, bad);
      assert.throws(() => f.open(master));
      assert.equal(fs.readFileSync(f.file,"utf8"), bad, "invalid existing state is preserved for recovery");
    }
    fs.writeFileSync(f.file,good);
    assert.throws(() => f.open("33".repeat(32)), /refusing implicit rotation/);
    for (const bad of ["", "z".repeat(64), "22", "22".repeat(32)+"\n"])
      assert.throws(() => f.open(bad), /exactly 32 bytes/);
    assert.equal(fs.readFileSync(f.file,"utf8"),good);
    assert.throws(() => loadPadState(f.file,{readFileSync(){throw Object.assign(new Error("denied"),{code:"EACCES"});}}),/denied/);
  } finally { f.close(); }
});

test("reserve refuses to return a signed window on persistence failure; retry/restart never rewinds", (t) => {
  const f = fixture();
  try {
    let L = f.open();
    const sid = L.seed(f.request("seed",[])).body.seed_id;
    const req = () => f.request("reserve",[sid,8],{seed_id:sid,want:8});
    assert.equal(L.reserve(req()).body.hi,8);
    const realSync = fs.fsyncSync;
    const injected = t.mock.method(fs,"fsyncSync",()=>{throw new Error("disk unavailable");});
    assert.throws(()=>L.reserve(req()),/disk unavailable/);
    injected.mock.restore();
    assert.equal(fs.fsyncSync,realSync);
    // The uncertain range is abandoned in memory. A later commit persists
    // its higher mark; a restart then continues beyond every issued range.
    assert.equal(L.reserve(req()).body.lo,16);
    L=f.open();
    assert.equal(L.reserve(req()).body.lo,24);
    assert.equal(fs.statSync(f.file).mode & 0o777,0o600);
  } finally { f.close(); }
});

test("failed receipt persistence leaves usage and finalization unchanged in memory and permits an exact retry", t => {
  for (const v2 of [false,true]) for (const failAt of [1,2]) {
    const f=fixture();
    try {
      const L=f.open();
      const assets={model_digest:"ab".repeat(32),calib_digest:"cd".repeat(32)};
      const seed=L.seed(v2 ? f.request("seed-v2",Object.values(assets),assets) : f.request("seed",[]));
      assert.equal(seed.status,200);
      const sid=seed.body.seed_id;
      const req=f.request("receipt",[sid,123,17],{seed_id:sid,pads:123,tokens:17});
      const realSync=fs.fsyncSync; let calls=0;
      const fault=t.mock.method(fs,"fsyncSync",fd=>{
        if(++calls===failAt) throw new Error("receipt persistence failure");
        return realSync(fd);
      });
      try {assert.throws(()=>L.receipt(req),/receipt persistence failure/);}
      finally {fault.mock.restore();}
      assert.deepEqual([L.receipts(sid).pads,L.receipts(sid).tokens,L.receipts(sid).runs,L.receipts(sid).last.length],[0,0,0,0]);
      // A directory-sync error can occur after rename. Retrying in the same
      // process replaces that uncertain record with the same single receipt.
      assert.equal(L.receipt(req).status,200);
      const reopened=f.open();
      assert.deepEqual([reopened.receipts(sid).pads,reopened.receipts(sid).tokens,reopened.receipts(sid).runs],[123,17,1]);
      assert.equal(reopened.receipt(req).status,409);
    } finally {f.close();}
  }
});

test("cumulative receipt counters refuse overflow without consuming a nonce or changing persisted totals",()=>{
  for(const counter of ["pads","tokens","runs"]) {
    const f=fixture();
    try {
      let L=f.open();const sid=L.seed(f.request("seed",[])).body.seed_id;
      const state=loadPadState(f.file);
      state.seeds[sid].usage={pads:0,tokens:0,runs:0,last:[],[counter]:Number.MAX_SAFE_INTEGER};
      savePadState(f.file,state);L=f.open();
      const before=fs.readFileSync(f.file,"utf8");
      const req=f.request("receipt",[sid,1,1],{seed_id:sid,pads:1,tokens:1});
      assert.equal(L.receipt(req).body.error,"receipt_overflow");
      assert.equal(L.receipts(sid)[counter],Number.MAX_SAFE_INTEGER);
      assert.equal(fs.readFileSync(f.file,"utf8"),before);
      assert.equal(loadPadState(f.file).seeds[sid].nonces.includes(req.nonce),false);
    } finally {f.close();}
  }
});
