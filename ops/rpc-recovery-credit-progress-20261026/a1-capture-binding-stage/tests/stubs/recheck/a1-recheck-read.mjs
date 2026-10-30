// STUB a1-recheck-read.mjs (tests only)
import fs from "node:fs";
import crypto from "node:crypto";
import { tag } from "./test/deps.mjs";
const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const initial = fs.readFileSync(process.argv[3]);
process.stdout.write(JSON.stringify({ verdict: "A1-original-game-recheck-passed", at: new Date().toISOString(), source: "stub-recheck", dep: tag,
  initialSha256: crypto.createHash("sha256").update(initial).digest("hex"), originalGame: cfg.originalGame }));
