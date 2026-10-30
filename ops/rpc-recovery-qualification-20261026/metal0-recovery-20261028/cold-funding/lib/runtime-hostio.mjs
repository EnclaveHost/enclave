import fs from "node:fs";import path from "node:path";import {fileURLToPath} from "node:url";import {execFileSync} from "node:child_process";import {COLD_HOST,SHOW_PROPERTIES} from "./cold-host-gate.mjs";
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const systemctl = (scope, args) => execFileSync("systemctl", [...(scope === "user" ? ["--user"] : []), "--no-pager", ...args], { encoding: "utf8", timeout: 10_000 });
function guestRecords(root) {
  const st = fs.lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error("--guestd-root is not a real directory");
  const found = [];
  for (const entry of fs.readdirSync(root)) {
    let s;
    try { s = fs.lstatSync(path.join(root, entry, COLD_HOST.guestRecord), { throwIfNoEntry: false }); }
    catch (e) { if (e.code === "ENOTDIR") continue; throw e; }                     // a plain file entry holds no record
    if (s) found.push(path.join(entry, COLD_HOST.guestRecord));
  }
  return found;
}
export const hostIo = (guestdRoot) => ({
  readStopReceipt: () => fs.readFileSync(path.resolve(ROOT, COLD_HOST.stopReceipt)),
  readPreservationReceipt: () => fs.readFileSync(COLD_HOST.preservationReceipt),
  showUnit: (scope, unit) => systemctl(scope, ["show", unit, `--property=${SHOW_PROPERTIES.join(",")}`]),
  listGuestUnits: (scope) => systemctl(scope, ["list-units", "--all", "--plain", "--no-legend", "--full", COLD_HOST.guestUnitGlob]),
  guestRecords: () => guestRecords(guestdRoot),
  monotonicUsec: () => process.hrtime.bigint() / 1000n,                             // CLOCK_MONOTONIC, as systemd's *Monotonic stamps
  nowSec: () => Date.now() / 1000,
});
