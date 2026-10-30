// STUB a1-read.mjs (tests only): proves which bytes ran - prints its own tag, the dependency's tag and the config it was given
import fs from "node:fs";
import { tag } from "./test/deps.mjs";
const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(JSON.stringify({ verdict: "A1-authenticated", at: cfg.stubAt ?? new Date().toISOString(), N: cfg.stubN ?? "1",
  game: "0x" + "12".repeat(20), outputRoot: "0x" + "34".repeat(32), source: "stub-initial", dep: tag, asr: cfg.asr }));
process.exit(cfg.stubExit ?? 0);
