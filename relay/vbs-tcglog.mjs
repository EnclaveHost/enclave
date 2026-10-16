// relay/vbs-tcglog.mjs — Windows measured-boot TCG log: parse, PCR replay, SIPA
// decode, VSM identity-key extraction. Port of windows/vbs/tools/tcglog.py, for
// the relay's Windows-VBS-enclave verifier (vbs-verify.mjs). Names follow the
// Windows SDK's wbcl.h.
//
// THE RULE THIS FILE EXISTS FOR: a field read from the log is only believed
// when the sha256 of its event data equals the digest the log recorded for that
// event. Windows SIPA records (EV_EVENT_TAG on PCR 11-14) and the PCR 7 UEFI
// variable events are measured as SHA-256(event data), so a log whose event
// data was edited while its digests were kept still replays to the quoted PCRs
// — and lies. The Python verifier's tamper test caught exactly that (REPORT.md
// section 3); sipaFields()/vsmKey()/secureBootFromLog() therefore skip any
// event that does not recompute, and unhashedEvents() names them so the
// verifier can refuse the log outright.
//
// Bounded everywhere: the log is capped, event counts are capped, SIPA trees
// have a depth and node budget. These are admission caps for a relay reading
// bytes off a socket, not claims about the format.
//
// The parser and readers are relay/vbs-tcglog-core.mjs (crypto-free, shared with the browser build); this module binds
// them to node:crypto's SHA-256 and keeps the CLI. Every export is unchanged.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { parseTcgLog, tcgLogWith } from "./vbs-tcglog-core.mjs";
export * from "./vbs-tcglog-core.mjs";

const sha256 = (b) => createHash("sha256").update(b).digest();
export const { replayPcrs, digestRecomputes, unhashedEvents, sipaRecords, sipaFields, vsmKey, secureBootFromLog, bootCounterFromLog } = tcgLogWith(sha256);

// ---- CLI: node relay/vbs-tcglog.mjs LOG [--dump] ------------------------------
if (process.argv[1] && /vbs-tcglog\.mjs$/.test(process.argv[1])) {
  const file = process.argv[2];
  if (!file) { console.error("usage: vbs-tcglog.mjs LOG [--dump]"); process.exit(2); }
  const { events } = parseTcgLog(fs.readFileSync(file));
  const bad = unhashedEvents(events);
  console.log(`events: ${events.length}  secure boot (PCR7): ${secureBootFromLog(events)}  boot counter: ${bootCounterFromLog(events)}  unrecomputable: ${bad.length ? JSON.stringify(bad) : "none"}`);
  for (const [p, v] of [...replayPcrs(events)].sort((a, b) => a[0] - b[0])) console.log(`  PCR${String(p).padEnd(2)} ${v.toString("hex")}`);
  const dump = process.argv.includes("--dump");
  for (const pcr of [12, 13, 14]) {
    const f = sipaFields(events, pcr);
    for (const k of [...f.keys()].sort()) {
      const vals = f.get(k);
      const s = Buffer.isBuffer(vals[0]) ? `${vals[0].length} bytes${vals.length > 1 ? ` x${vals.length}` : ""}` : vals.map(String).join(", ");
      if (dump || (pcr === 12 && !/^(AUTHENTICODE|FILEPATH|IMAGE|HASHALG|AUTHORITY|MODULE)/.test(k))) console.log(`  PCR${pcr} ${k.padEnd(36)} ${s}`);
    }
  }
  const k = vsmKey(events, "IDKS");
  console.log(k ? `  IDKS: RSA-${k.bits} modulus sha256=${sha256(k.modulus).toString("hex").slice(0, 16)}` : "  no IDKS record");
}
