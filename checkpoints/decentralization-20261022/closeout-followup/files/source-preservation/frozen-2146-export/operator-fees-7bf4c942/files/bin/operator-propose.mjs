#!/usr/bin/env node
// metal0 operator: EnclaveHostOwnership.proposeOwner(metal0, Enclave wallet), lib/proposer.mjs. ROOT runs this.
//   node bin/operator-propose.mjs [--prepare]                                      (default; reads chain only, no key)
//   node bin/operator-propose.mjs --send --plan-hash 0x<current> --broadcast-propose-owner
//   node bin/operator-propose.mjs --resume --plan-hash 0x<h> [--rebroadcast]       (never signs; same bytes only)
//   node bin/operator-propose.mjs --status --plan-hash 0x<h>                       (journal, public fields only)
// Output is public JSON: plan hash, tx hash, receipt summary. The key and the signed bytes are never printed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProposer, PRODUCTION, Refusal } from "../lib/proposer.mjs";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAN_FILE = path.resolve(HERE, "../custody-v2-live-20261023/evidence/metal0-enrollment-unsigned-20261023.json");
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const KNOWN = new Set(["--prepare", "--send", "--resume", "--status", "--plan-hash", "--broadcast-propose-owner", "--rebroadcast", "--plan-file", "--dir"]);
for (let i = 0; i < argv.length; i++) {
  if (!KNOWN.has(argv[i])) { console.error(JSON.stringify({ refused: "usage", message: `unknown argument ${argv[i]}` })); process.exit(64); }
  if (["--plan-hash", "--plan-file", "--dir"].includes(argv[i])) i++;
}
const modes = ["--send", "--resume", "--status"].filter(flag);
if (modes.length > 1) { console.error(JSON.stringify({ refused: "usage", message: "one mode at a time" })); process.exit(64); }
const dir = path.resolve(val("--dir") || HERE);
// the operator key: read ONLY by --send, after every fresh check, immediately before signing
const readKey = async () => JSON.parse(fs.readFileSync(PRODUCTION.keyFile, "utf8")).registryKey;
const p = createProposer({ dir, readKey });
const planText = () => fs.readFileSync(path.resolve(val("--plan-file") || PLAN_FILE), "utf8");
try {
  let out;
  if (flag("--send")) out = await p.send({ planHash: val("--plan-hash"), confirm: flag("--broadcast-propose-owner"), planText: planText() });
  else if (flag("--resume")) out = await p.resume({ planHash: val("--plan-hash"), rebroadcast: flag("--rebroadcast") });
  else if (flag("--status")) out = p.status(val("--plan-hash"));
  else out = await p.prepare({ planText: planText() });
  console.log(JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
  process.exit(["prepared", "verified", "accepted", "proposed", "signed", "broadcast"].includes(out.status) || flag("--status") ? 0 : 3);
} catch (e) {
  console.error(JSON.stringify(e instanceof Refusal ? { refused: e.code, message: e.message } : { error: String(e.message).slice(0, 300) }));
  process.exit(e instanceof Refusal ? 2 : 1);
}
