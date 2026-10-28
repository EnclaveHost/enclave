#!/usr/bin/env node
// READ-ONLY preparation of the unsigned C9 maintenance plan (root runs it). Never reads a key, signs or sends.
//   node bin/prepare.mjs --quiesce <root quiesce.json>   -> plans/<sha256>.json (public, unsigned), exit 3 on a refusal
import fs from "node:fs";
import path from "node:path";
import { createPreparer, Refusal } from "../lib/maintenance.mjs";
import {requireProtectedInventory} from '../lib/protected-inventory.mjs';
const a = process.argv.slice(2);
if (a.length !== 2 || a[0] !== "--quiesce") { console.error("usage: node bin/prepare.mjs --quiesce <root quiesce.json>"); process.exit(2); }
const quiesce = JSON.parse(fs.readFileSync(a[1], "utf8"));
try {
  requireProtectedInventory(quiesce);
  const out = await createPreparer().prepare({ quiesce });
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "plans");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${out.planHash}.json`), out.text, { flag: "wx", mode: 0o644 });
  console.log(JSON.stringify({ status: out.plan.status, planHash: out.planHash, requests: out.requests, fees: out.plan.fees }, null, 1));
} catch (e) {
  if (e instanceof Refusal) { console.error(`REFUSED ${e.code}: ${e.message}`); process.exit(3); }
  console.error(`FAILED (not retried): ${String(e.message).slice(0, 300)}`); process.exit(1);
}
