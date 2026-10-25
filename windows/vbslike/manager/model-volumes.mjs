// model-volumes.mjs - the model volumes this Windows host can attach to a partition (isolation/m3/monitor/modelvol.go).
//
// What a volume IS comes from the partition image's measured table (the same rt/model-volumes.table the image was built
// with, sdk/storage/model-volumes.mjs tableText): its dm-verity root, geometry and size. What this host HAS is its store
// (metal/volumes.mjs layout, <store>/<name>/{volume.json, volume.vhd}: fetched cold from replicas with `volumes.mjs
// fetch`, then `volumes.mjs vhd`). A volume is offered only when the store's record states exactly the table's root and
// geometry and its VHD is a fixed VHD of exactly the table's size: the guest verifies every block against the pinned
// root anyway, so this only keeps a host from advertising - and a lease from being claimed for - a volume whose
// partition would refuse to start. The same rule as guestd's storeVolumes on the SNP tier.
import fs from "node:fs";
import path from "node:path";
import { parseTable, readVhdFooter, VHD_FOOTER_BYTES } from "../../../sdk/storage/model-volumes.mjs";

export const MODEL_VOLUMES_MAX = 8;   // modelspec.Max

/** -> { table, have: Map(name -> {entry, vhd}), missing: {name: why} } */
export function loadModelVolumes({ table: tablePath, store }) {
  const table = parseTable(fs.readFileSync(tablePath, "utf8"));
  const have = new Map(), missing = {};
  for (const [name, e] of table) {
    const dir = path.join(store, name);
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, "volume.json"), "utf8")); }
    catch { missing[name] = "not in this host's store"; continue; }
    const v = rec?.verity || {};
    if (rec.name !== name || v.root !== e.verity.root || v.salt !== e.verity.salt || v.dataBlockSize !== 4096 || v.hashBlockSize !== 4096
        || v.dataBlocks !== e.verity.dataBlocks || v.hashStartBlock !== e.verity.hashStartBlock || rec.imageBytes !== e.imageBytes) {
      missing[name] = "the store's record is not the pinned volume"; continue;
    }
    const vhd = path.join(dir, "volume.vhd");
    try {
      const st = fs.lstatSync(vhd);
      if (!st.isFile() || st.size !== e.imageBytes + VHD_FOOTER_BYTES) throw new Error("size");
      const fd = fs.openSync(vhd, "r");
      const f = Buffer.alloc(VHD_FOOTER_BYTES);
      try { fs.readSync(fd, f, 0, VHD_FOOTER_BYTES, e.imageBytes); } finally { fs.closeSync(fd); }
      if (readVhdFooter(f).size !== e.imageBytes) throw new Error("footer");
    } catch { missing[name] = "the store has no fixed VHD of the pinned size (volumes.mjs vhd)"; continue; }
    have.set(name, { entry: e, vhd });
  }
  return { table, have, missing };
}

/** The config's "volumes" as the shared runtime reads them (wasm_manager.py; isolation/m2/modelspec ConfigVolumes). */
export function configVolumes(config) {
  let doc;
  try { doc = JSON.parse(String(config || "")); } catch { return []; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.volumes)) return [];
  const out = [];
  for (const v of doc.volumes) {
    const s = (typeof v === "string" ? v : JSON.stringify(v)).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}
