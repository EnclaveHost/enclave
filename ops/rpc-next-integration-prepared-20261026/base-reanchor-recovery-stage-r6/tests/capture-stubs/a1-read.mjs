// TEST STUB a1-read.mjs (re-anchor r3 tests only): the INITIAL A1 read. Prints the harness fixture receipt for the newer anchor
// (template path from the derived config's `fixtureReceipt`), stamped NOW so it lies inside the capture window.
import fs from "node:fs";
import { tag } from "./test/deps.mjs";
const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const e = JSON.parse(fs.readFileSync(cfg.fixtureReceipt, "utf8"));
const now = new Date();
e.at = now.toISOString(); e.l1 = { ...e.l1, timestamp: Math.floor(now.getTime() / 1000) - 1000, ageSec: 952 };
void tag;
process.stdout.write(JSON.stringify(e));
