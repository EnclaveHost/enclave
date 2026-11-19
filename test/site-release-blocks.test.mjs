// scripts/site-release/blocks.mjs: a release CAR becomes one verified file per block, for block-by-block retrieval.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { importDirectory, cidParse } from "../scripts/site-release/unixfs.mjs";
import { writeCar } from "../scripts/site-release/car.mjs";
import { writeBlocks } from "../scripts/site-release/blocks.mjs";

test("every block of the tree is written under its CID, a repeat keeps them, tampering is refused", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-blocks-"));
  try {
    const site = path.join(tmp, "site"); fs.mkdirSync(path.join(site, "js"), { recursive: true });
    fs.writeFileSync(path.join(site, "index.html"), "<!doctype html>hello\n");
    fs.writeFileSync(path.join(site, "js", "big.js"), Buffer.alloc(700000, 7));   // three chunks and a file node
    const { cid: root, blocks } = importDirectory(site), car = path.join(tmp, "site.car"), out = path.join(tmp, "blocks");
    writeCar(car, root, blocks);
    const first = writeBlocks(fs.readFileSync(car), root, out);
    assert.deepEqual(first, { root, blocks: blocks.size, written: blocks.size, kept: 0 });
    assert.ok(blocks.size >= 6);
    for (const name of fs.readdirSync(out))
      assert.ok(createHash("sha256").update(fs.readFileSync(path.join(out, name))).digest().equals(cidParse(name).subarray(4)), name);
    assert.ok(fs.existsSync(path.join(out, root)));
    assert.deepEqual(writeBlocks(fs.readFileSync(car), root, out), { root, blocks: blocks.size, written: 0, kept: blocks.size });
    // another root is refused before anything is written
    assert.throws(() => writeBlocks(fs.readFileSync(car), "bafybeihvox7sjpnt5uuaqa6we4zuigwl5ohdx4jjvnxyiccx76a2nx7pbe", path.join(tmp, "other")), /root/);
    assert.equal(fs.existsSync(path.join(tmp, "other")), false);
    // a store that holds other bytes under a CID is an error, not overwritten
    fs.writeFileSync(path.join(out, root), "not the block");
    assert.throws(() => writeBlocks(fs.readFileSync(car), root, out), /other bytes/);
    // a CAR with a flipped byte is refused
    const bad = Buffer.from(fs.readFileSync(car)); bad[bad.length - 1] ^= 1;
    assert.throws(() => writeBlocks(bad, root, path.join(tmp, "bad")), /does not hash/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
