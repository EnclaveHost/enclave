// Read-only: fetch a site CID's CAR from a public gateway, verify it with site-release's car.mjs (every block, every
// file), and count marker strings across every .js file. Proves what the DEPLOYED site code contains.
import { writeFileSync } from "node:fs";
import { readCar } from "../enclave/scripts/site-release/car.mjs";
const [cid, gateway = "https://ipfs.enclave.host", out] = process.argv.slice(2);
const MARKERS = {
  independentMode: "independent mode", reviewedProfile: "reviewed profile", startupPackage: "startup package size limit",
  ownerNames: "owner names need", passkeyProfile: "enclave_account_profile", apiBase: "https://api.enclave.host/v1",
  addressBook: "0xab214342d5A490150A4A977063A2f88E21F80907", uploadToken: "/apps/upload-token",
  siweAuthorize: "/authorize", domainsMap: "/v1/domains", sessionsRelay: "/v1/sessions",
};
const r = await fetch(`${gateway}/ipfs/${cid}?format=car`, { headers: { accept: "application/vnd.ipld.car" }, signal: AbortSignal.timeout(180_000) });
if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
const car = readCar(Buffer.from(await r.arrayBuffer()), { expectRoot: cid });
const counts = Object.fromEntries(Object.keys(MARKERS).map((k) => [k, { files: 0, hits: [] }]));
const jsFiles = [];
const { walkFiles } = await import("../enclave/scripts/site-release/car.mjs");
walkFiles(car.root, car.blocks, { onFile: (path, parts) => {
  if (!/\.m?js$/.test(path)) return;
  jsFiles.push(path);
  const text = Buffer.concat(parts).toString("utf8");
  for (const [k, m] of Object.entries(MARKERS)) if (text.includes(m)) { counts[k].files++; if (counts[k].hits.length < 6) counts[k].hits.push(path); }
} });
const res = { cid, gateway, verifiedFiles: car.files.length, jsFiles: jsFiles.length, markers: counts, checkedAt: new Date().toISOString() };
if (out) writeFileSync(out, JSON.stringify(res, null, 2) + "\n");
console.log(JSON.stringify(res, null, 2));
