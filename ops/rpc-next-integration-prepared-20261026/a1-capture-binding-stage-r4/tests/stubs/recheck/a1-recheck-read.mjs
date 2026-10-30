// STUB a1-recheck-read.mjs (tests only): echoes the binding it was given (original game/N/root, initial sha it actually read)
import fs from "node:fs";
import crypto from "node:crypto";
import { tag } from "./test/deps.mjs";
const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const initial = fs.readFileSync(process.argv[3]);
process.stdout.write(JSON.stringify({ verdict: "A1-original-game-recheck-passed", at: new Date().toISOString(), source: "stub-recheck", dep: tag,
  initialSha256: crypto.createHash("sha256").update(initial).digest("hex"), configInitialSha256: cfg.initialEvidenceSha256,
  originalGame: cfg.originalGame, originalN: cfg.originalN, originalOutputRoot: cfg.originalOutputRoot }));
