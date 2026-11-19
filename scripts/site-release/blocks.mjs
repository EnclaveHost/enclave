#!/usr/bin/env node
// The blocks of a site release, one file per CID, for a gateway that answers `/ipfs/<cid>?format=raw` from a directory
// (the edges' /opt/enclave-site-blocks/ipfs). An IPFS node that resolves the site's name fetches the tree block by
// block: a gateway that has the root block, the whole CAR and the files by path, and not each block, serves the root and
// nothing under it (enclavehost.eth through eth.limo, 2026-11-19: "content unreachable").
//
//   node blocks.mjs <site.car> <root-cid> <blocks-dir>
//
// The CAR is verified first (readCar: the root, every block against its CID, nothing unreachable). A block already in
// the directory is kept when its bytes are the same and is an error when they are not.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readCar } from "./car.mjs";

export function writeBlocks(carBytes, root, dir) {
  const { blocks } = readCar(carBytes, { expectRoot: root });
  fs.mkdirSync(dir, { recursive: true });
  let written = 0, kept = 0;
  for (const [cid, data] of blocks) {
    if (!/^baf[ky][a-z2-7]{55}$/.test(cid)) throw new Error(`unexpected CID form: ${cid}`);
    const file = path.join(dir, cid);
    if (fs.existsSync(file)) {
      if (!fs.readFileSync(file).equals(data)) throw new Error(`${file} exists with other bytes`);
      kept++; continue;
    }
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, data, { mode: 0o644 }); fs.renameSync(tmp, file); written++;
  }
  return { root, blocks: blocks.size, written, kept };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [car, root, dir] = process.argv.slice(2);
  if (!car || !root || !dir) { console.error("usage: blocks.mjs <site.car> <root-cid> <blocks-dir>"); process.exit(2); }
  console.log(JSON.stringify(writeBlocks(fs.readFileSync(car), root, dir)));
}
