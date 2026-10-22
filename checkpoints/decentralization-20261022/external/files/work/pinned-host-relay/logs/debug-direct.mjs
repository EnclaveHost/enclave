// DEBUG: why the direct path refuses a pinned transit (prints the refusal reason)
import fs from "node:fs"; import { createHash } from "node:crypto";
const T = process.argv[2];
const LG = await import(T + "/network/lease-gas-conduit.mjs"), B = await import(T + "/metal/guest/lease-gas-conduit.bundle.mjs"), MC = await import(T + "/metal/guest/measured-control.mjs");
const RECORD = fs.readFileSync(T + "/../src/test/fixtures/pinned-relay/absent-golden.json") && Buffer.from(JSON.parse(fs.readFileSync(T + "/test/fixtures/pinned-relay/absent-golden.json")).transit.record, "base64");
const f = "/tmp/dbg-rec.json"; fs.writeFileSync(f, RECORD);
const t = JSON.parse(JSON.stringify(LG.leaseGasTransit({ recordFile: f, digest: "sha256:" + createHash("sha256").update(RECORD).digest("hex"), rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
  pinnedRelays: [{ origin: "http://10.0.2.2:8549", payee: "0xC5D88d2D1c898fCACDCe965Cbe2f1C3cD38Bb26a", operator: "0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB" }] }, { readFile: (x) => fs.readFileSync(x) })));
console.log("source published:", JSON.stringify(LG.leaseGasGuest(t, { published: true }).reason));
console.log("bundle published:", JSON.stringify(B.leaseGasGuest(t, { published: true }).reason));
console.log("bundle legacy:", JSON.stringify(B.leaseGasGuest(t).reason));
fs.rmSync(f);
