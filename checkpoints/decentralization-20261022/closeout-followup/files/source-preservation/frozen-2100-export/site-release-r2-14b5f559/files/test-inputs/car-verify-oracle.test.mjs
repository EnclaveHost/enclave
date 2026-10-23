// site/js/core/ipfs-car.js vs the runtime it ports: every deterministic local CAR fixture (test/car-fixtures.mjs) is run
// through the browser verifier AND the candidate's own wasm/ipfs_fetch.py verify_car (python3, offline), and the two must
// agree - same accept/refuse, same file bytes - and match the fixture's intent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CID } from "multiformats/cid";
import * as F from "./car-fixtures.mjs";
const { verifyCar, carCap, MAX_DEPTH } = await import("../site/js/core/ipfs-car.js");
const HERE = path.dirname(fileURLToPath(import.meta.url)), WASM = path.join(HERE, "..", "wasm");
const MAX = 1048576;                                                     // CAT_MAX.configMax / the runtime's CONFIG_MAX_BYTES
const str = (cidBytes) => CID.decode(cidBytes).toString();
const hexs = (b) => Buffer.from(F.sha(b)).toString("hex");
const chunks = (data, sizes) => { const out = []; let o = 0, i = 0; while (o < data.length){ const n = sizes[i++ % sizes.length]; out.push(data.subarray(o, o + n)); o += n; } return out; };

function fixtures(){
  const list = [], add = (name, root, carBytes, expect, max = MAX, o = {}) => list.push({ name, root, carBytes, expect, max, pyOk: o.pyOk });
  const cfg = (seed, pad) => F.bytesOf(F.configText(seed, pad));
  // --- legitimate layouts
  { const d = cfg(1, 300), l = F.leaf("v0", d); add("CIDv0 single dag-pb leaf (Kubo v0 default)", l.cid, F.car(l.cid, [[l.cid, l.block]]), d); }
  { const d = cfg(2, 300000), n = F.node(chunks(d, [262144]).map((c) => F.leaf("raw", c)));
    add("CIDv1 raw leaves, 256 KiB chunks (pin profile)", n.cid, F.car(n.cid, F.blocksOf(n)), d); }
  { const d = cfg(3, 200000), n = F.node(chunks(d, [65536]).map((c) => F.leaf("v0", c)), "v0");
    add("CIDv0 root over CIDv0 dag-pb leaves, 64 KiB chunks", n.cid, F.car(n.cid, F.blocksOf(n)), d); }
  { const d = cfg(4, 5000), parts = chunks(d, [1000, 7, 4096]), kinds = ["raw", "v0", "v1pb"];
    const n = F.node(parts.map((c, i) => F.leaf(kinds[i % 3], c)));
    add("mixed raw / v0 dag-pb / v1 dag-pb leaves, uneven chunk boundaries", n.cid, F.car(n.cid, F.blocksOf(n)), d); }
  { const a = F.leaf("raw", F.bytesOf('{"rep":"' + "a".repeat(4000))), b = F.leaf("v0", F.bytesOf("b".repeat(10) + '"}'));
    const n = F.node([a, a, b, a]); const d = F.fileOf(n);
    add("repeated chunk: one block linked 3 times, emitted 3 times", n.cid, F.car(n.cid, F.blocksOf(n)), d); }
  { const d = cfg(6, 90000), leaves = chunks(d, [4096]).map((c) => F.leaf("raw", c));
    const mids = []; for (let i = 0; i < leaves.length; i += 7) mids.push(F.node(leaves.slice(i, i + 7)));
    const n = F.node(mids); add("two-level tree, 4 KiB raw leaves", n.cid, F.car(n.cid, F.blocksOf(n)), d); }
  { const d = cfg(7, 10); let n = F.leaf("raw", d); for (let i = 0; i < 900; i++) n = F.node([n]);
    add("depth-900 single-link chain (MAX_DEPTH: deepest the browser takes; the runtime takes it too)", n.cid, F.car(n.cid, F.blocksOf(n)), d); }
  // --- refusals
  { const d = cfg(8, 3000), n = F.node(chunks(d, [1000]).map((c) => F.leaf("raw", c))); const bl = F.blocksOf(n);
    bl[2] = [bl[2][0], F.bytesOf("X" + new TextDecoder().decode(bl[2][1]).slice(1))];
    add("forged block (bytes changed, CID kept)", n.cid, F.car(n.cid, bl), null); }
  { const d = cfg(9, 3000), n = F.node(chunks(d, [1000]).map((c) => F.leaf("raw", c)));
    add("missing child block", n.cid, F.car(n.cid, F.blocksOf(n).filter((_, i) => i !== 2)), null); }
  { const d = cfg(10, 100), l = F.leaf("v0", d), other = F.leaf("v0", cfg(11, 100));
    add("wrong root (a valid CAR of another file)", l.cid, F.car(other.cid, [[other.cid, other.block]]), null); }
  { const d = cfg(12, 3000), n = F.node(chunks(d, [1000]).map((c) => F.leaf("raw", c))), c = F.car(n.cid, F.blocksOf(n));
    add("truncated CAR (last 10 bytes cut)", n.cid, c.subarray(0, c.length - 10), null);
    add("trailing garbage after the last section", n.cid, F.cat(c, Uint8Array.of(5)), null);
    add("section length past the end", n.cid, F.cat(c, F.vi(1 << 20), Uint8Array.of(1, 0x55)), null);
    add("header length past the end", n.cid, F.cat(F.vi(1 << 30), c), null);
    add("unterminated varint header", n.cid, Uint8Array.from(new Array(12).fill(0xff)), null);
    add("empty CAR", n.cid, new Uint8Array(0), null); }
  { const d = cfg(13, 2000), n = F.node(chunks(d, [512]).map((c) => F.leaf("raw", c)));
    add("output over the cap (max = file size - 1)", n.cid, F.car(n.cid, F.blocksOf(n)), null, d.length - 1);
    add("output exactly at the cap", n.cid, F.car(n.cid, F.blocksOf(n)), d, d.length); }
  { let n = { cid: null, block: F.pbNode([], F.ufsFile({ filesize: 0 })), size: 0 }; n.cid = F.v1(0x70, n.block);
    for (let i = 0; i < 26; i++) { const b = F.pbNode([{ cid: n.cid }, { cid: n.cid }], F.ufsFile({ filesize: 0 })); n = { cid: F.v1(0x70, b), block: b, size: 0, kids: [n, n] }; }
    add("empty-data diamond, depth 26 (2^27 walks, no output)", n.cid, F.car(n.cid, F.blocksOf(n)), null); }
  { const d = cfg(14, 10); let n = F.leaf("raw", d); for (let i = 0; i < 1100; i++) n = F.node([n]);
    add("depth-1100 chain (past both walkers' depth)", n.cid, F.car(n.cid, F.blocksOf(n)), null); }
  { const d = cfg(15, 10); let n = F.leaf("raw", d); for (let i = 0; i < 901; i++) n = F.node([n]);
    add("depth-901 chain: browser refuses (runtime would still take it - the one deliberate divergence)", n.cid, F.car(n.cid, F.blocksOf(n)), null, MAX, { pyOk: true }); }
  { const blk = F.bytesOf("{}"), c512 = F.cat(Uint8Array.of(1, 0x55, 0x13, 0x40), new Uint8Array(64)), l = F.leaf("raw", blk);
    add("a non-sha2-256 block anywhere refuses the CAR", l.cid, F.car(l.cid, [[l.cid, l.block], [c512, blk]]), null); }
  { const cbor = Uint8Array.of(0xa0), cc = F.v1(0x71, cbor), root = F.pbNode([{ cid: cc }], F.ufsFile({ filesize: 1 })), rc = F.v1(0x70, root);
    add("a dag-cbor child is not a file block", rc, F.car(rc, [[rc, root], [cc, cbor]]), null); }
  return list;
}

test("the browser CAR verifier and the runtime's ipfs_fetch.verify_car agree on every fixture", async () => {
  const list = fixtures(), dir = mkdtempSync(path.join(HERE, ".car-oracle-"));
  try {
    const manifest = list.map((f, i) => { const file = path.join(dir, i + ".car"); writeFileSync(file, f.carBytes); return { cid: str(f.root), file, max: f.max }; });
    writeFileSync(path.join(dir, "m.json"), JSON.stringify(manifest));
    const py = JSON.parse(execFileSync("python3", ["-c", `
import sys, json, hashlib
sys.path.insert(0, ${JSON.stringify(WASM)}); sys.setrecursionlimit(1000)
import ipfs_fetch
out = []
for m in json.load(open(${JSON.stringify(path.join(dir, "m.json"))})):
    try:
        b = ipfs_fetch.verify_car(m["cid"], open(m["file"], "rb").read(), m["max"])
        out.append({"ok": True, "sha": hashlib.sha256(b).hexdigest()})
    except Exception as e:
        out.append({"ok": False, "err": type(e).__name__ + ": " + str(e)[:80]})
print(json.dumps(out))`], { encoding: "utf8", maxBuffer: 1 << 24 }));
    const rows = [];
    for (const [i, f] of list.entries()){
      let js; try { const b = await verifyCar(f.root, f.carBytes, f.max); js = { ok: true, sha: hexs(b) }; } catch(e){ js = { ok: false, err: e.message }; }
      rows.push({ name: f.name, js, py: py[i] });
      assert.equal(js.ok, f.expect !== null, f.name + " (browser): " + JSON.stringify(js));
      assert.equal(py[i].ok, f.pyOk ?? (f.expect !== null), f.name + " (runtime): " + JSON.stringify(py[i]));
      if (f.expect) { assert.equal(js.sha, hexs(f.expect), f.name); assert.equal(py[i].sha, js.sha, f.name + ": same bytes"); }
    }
    console.log("# oracle rows " + JSON.stringify(rows));
    assert.equal(list.length, 23);
    assert.ok(list.every((f, i) => !rows[i].js.ok || rows[i].py.ok), "nothing the browser accepts is refused by the runtime");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("limits are the runtime's: CAR transfer cap and the depth guard; the profile fixture is the pin profile's own root", async () => {
  assert.equal(carCap(MAX), MAX + MAX / 2 + 1048576);
  assert.equal(MAX_DEPTH, 900);
  const { artifactIdentity } = await import("../site/js/core/unixfs.js");
  const d = F.bytesOf(F.configText(2, 300000)), leaves = []; for (let o = 0; o < d.length; o += 262144) leaves.push(F.leaf("raw", d.subarray(o, o + 262144)));
  assert.equal(CID.decode(F.node(leaves).cid).toString(), (await artifactIdentity(d)).cid, "fixture builder == unixfs.js profile (== Kubo --cid-version=1)");
});
