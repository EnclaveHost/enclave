// Step 7 of the recovery release: the dashboard wording delta shipped, and the old wording is unreachable.
//   - CURRENT files (every release file that is not a retained chunk of an earlier build, release.json retention.kept)
//     never carry " - retrying automatically";
//   - at least one current chunk carries the new form ('fleet: ' + esc(reason) + "</span>");
//   - no current file names any file that carries the old wording, so a fresh page load can never reach it.
// The release tool RETAINS earlier builds' hashed chunks for retainHours (release.mjs) so pages already open keep
// loading; those retained chunks are the only carriers of the old text, exactly as in the prior release.
import fs from "node:fs";
import path from "node:path";

const rel = process.argv[2];
const m = JSON.parse(fs.readFileSync(path.join(rel, "release.json"), "utf8"));
const kept = new Set(m.retention.kept.map((k) => k.path));
const all = m.files.map((f) => f.path);
const read = (p) => fs.readFileSync(path.join(rel, "site", p));
const OLD = " - retrying automatically";
const NEW = /fleet: '\+[A-Za-z_$]+\([A-Za-z_$]+\.reason\)\+"<\/span>"/;
const carriers = all.filter((p) => read(p).includes(OLD));
const current = all.filter((p) => !kept.has(p) && !kept.has(p.replace(/\.map$/, "")));
const bad = carriers.filter((p) => current.includes(p));
if (bad.length) throw Error("a current file carries the old wording: " + bad.join(", "));
const fresh = current.filter((p) => p.endsWith(".js") && NEW.test(read(p).toString("utf8")));
if (!fresh.length) throw Error("no current chunk carries the new fleet-reason wording");
const names = carriers.map((p) => path.posix.basename(p));
// the release ledger itself lists the retained chunks (that is what retention is); no page loads it as code
const LEDGER = ".well-known/enclave-site-release.json";
const refs = current.filter((p) => /\.(js|html|css|json|webmanifest)$/.test(p) && !p.endsWith(".map") && p !== LEDGER)
  .flatMap((p) => { const s = read(p).toString("utf8"); return names.filter((n) => s.includes(n)).map((n) => `${p} -> ${n}`); });
if (refs.length) throw Error("a current file references an old-wording chunk: " + refs.slice(0, 5).join("; "));
console.log(JSON.stringify({ files: all.length, retained: kept.size, oldWordingOnlyInRetained: carriers, newWordingIn: fresh, currentReferencesToThem: 0 }, null, 1));
console.log("DELTA-CHECK-OK");
