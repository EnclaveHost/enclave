// Fund the TUNA wallets open-market Windows hosts asked for: the relay's queue (relay/tuna-funding.mjs) -> top-up targets.
//
//   node tuna-funding-sync.mjs --remote nan:/var/lib/enclave-relay/tuna-funding.json --targets FILE --topup FILE
//                              [--max-new 20] [--dry-run]
//
// Run by a timer on the machine that holds the funding wallet (beside enclave-tuna-topup). It reads the relay's queue
// over SSH (the relay serves it to no one), checks every entry's shape again - this machine trusts the relay's checks of
// WHO asked, never the shape of what it is about to pay - and writes one top-up line per label, `<label> <nkn> <addr>...`,
// replacing a label's line when its wallets changed (a deployment that moved host, a TPM's renewed control wallets). Lines
// it did not write (labels outside ctl-/sh-) are never touched. At most --max-new new or changed labels per run, so a
// flood the relay let through still drains slowly; then the top-up job runs (it pays only wallets below its watermark,
// at most its own -max-total per run).
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const log = (m) => console.log(`[tuna-funding-sync] ${m}`);

// what the relay may ask this machine to pay (relay/tuna-funding.mjs FUNDING): the shape is checked here again
const SHAPES = { control: { re: /^ctl-[0-9a-f]{16}$/, wallets: 2, nkn: "0.05" }, app: { re: /^sh-[0-9a-f]{12}$/, wallets: 6, nkn: "0.25" } };
const NKN_ADDR = /^NKN[1-9A-HJ-NP-Za-km-z]{33}$/, OURS = /^(ctl-|sh-)/;

export function plan(queue, lines, max) {
  const out = [...lines], index = new Map(out.map((l, i) => [l.split(" ")[0], i]));
  const refused = [], changed = [];
  for (const [label, e] of Object.entries(queue?.targets || {})) {
    const s = SHAPES[e?.purpose];
    if (!s || !Object.hasOwn(SHAPES, e.purpose) || !s.re.test(label) || e.nkn !== s.nkn || !Array.isArray(e.addresses) ||
        e.addresses.length !== s.wallets || e.addresses.some((a) => !NKN_ADDR.test(a)) || new Set(e.addresses).size !== e.addresses.length) {
      refused.push(label); continue;
    }
    const line = [label, e.nkn, ...e.addresses].join(" ");
    const at = index.get(label);
    if (at !== undefined && out[at] === line) continue;
    if (changed.length >= max) continue;
    if (at !== undefined) out[at] = line; else { index.set(label, out.length); out.push(line); }
    changed.push(label);
  }
  // an address already funded under ANOTHER label is not paid twice: the second line is dropped from this plan
  const owner = new Map();
  for (const l of out) for (const a of l.split(" ").slice(2)) if (!owner.has(a)) owner.set(a, l.split(" ")[0]);
  const final = out.filter((l) => { const [label, , ...a] = l.split(" ");
    if (!OURS.test(label) || a.every((x) => owner.get(x) === label)) return true;
    refused.push(label); return false; });
  const kept = new Set(final.map((l) => l.split(" ")[0]));
  return { lines: final, changed: changed.filter((l) => kept.has(l)), refused };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const DRY = process.argv.includes("--dry-run");
  const remote = arg("--remote"), targetsFile = arg("--targets"), topup = arg("--topup"), maxNew = Number(arg("--max-new", "20"));
  if (!/^[A-Za-z0-9._-]+:\/[A-Za-z0-9._/-]+\.json$/.test(remote || "") || !targetsFile || !topup || !(maxNew >= 0))
    throw new Error("usage: --remote HOST:/path/queue.json --targets FILE --topup FILE [--max-new N] [--dry-run]");
  const [host, file] = [remote.slice(0, remote.indexOf(":")), remote.slice(remote.indexOf(":") + 1)];
  const { stdout } = await run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", host, "sudo", "-n", "cat", file], { timeout: 60000, maxBuffer: 16 << 20 })
    .catch((e) => { if (/No such file/.test(String(e.stderr))) return { stdout: '{"version":1,"targets":{}}' }; throw e; });
  const queue = JSON.parse(stdout);
  if (queue?.version !== 1) throw new Error("the relay's queue is not version 1");
  const lines = (await fs.readFile(targetsFile, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const p = plan(queue, lines, maxNew);
  for (const l of p.refused) log(`REFUSED ${l}: not a well-formed funding entry, or its wallets are funded under another label`);
  if (!p.changed.length) { log(`${Object.keys(queue.targets || {}).length} queued; nothing new`); process.exit(0); }
  log(`${p.changed.length} new or changed: ${p.changed.join(", ")}${DRY ? " (dry run)" : ""}`);
  if (DRY) process.exit(0);
  const tmp = `${targetsFile}.tmp-${process.pid}`;
  await fs.writeFile(tmp, p.lines.join("\n") + "\n", { mode: 0o644 }); await fs.rename(tmp, targetsFile);
  await run(topup, [], { timeout: 900000 }).then(() => log("top-up ran")).catch((e) => log(`top-up: ${String(e.stderr || e.message).split("\n").slice(-3).join(" ")}`));
}
