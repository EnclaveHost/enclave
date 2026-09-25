#!/usr/bin/env node
// lab-next.mjs -- a LAB next-version test artifact of the installed client, derived deterministically from a built base
// artifact (client/DESIGN.md "Activation"; NOT a release). Exactly two things change: the first line, which must be the
// base's version marker, and the version constant, which must occur exactly once:
//   the first line (the version marker)   -> /*! enclave-pvm-client <version> (LAB NEXT-VERSION TEST ARTIFACT, not
//                                            production: derived by client/tools/lab-next.mjs from pvm-client.mjs
//                                            <base version> sha256 <base sha256>) -- <the base's first line, after its "--">
//   var CLIENT_VERSION = "<base version>"; -> var CLIENT_VERSION = "<version>";
// Everything else stays byte for byte, so the result is reproducible by anyone holding the base bytes, and it runs the
// base's code while reporting the new version -- what an activation test on a device needs. It is signed with LAB keys
// (tools/lab-sign.mjs update), never a release key.
//   node lab-next.mjs --base FILE --version X.Y.Z --out FILE   -> prints { version, sha256, size, base: { version, sha256 } }
import fs from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const MARKER = "/*! enclave-pvm-client ";
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const once = (t, s) => t.split(s).length - 1 === 1;

export function deriveLabNext(baseBytes, version) {
  if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) throw new Error(`not a version: ${version}`);
  const base = Buffer.from(baseBytes).toString("utf8"), nl = base.indexOf("\n"), first = base.slice(0, nl);
  const m = /^\/\*! enclave-pvm-client (\d+\.\d+\.\d+) \(([^)]*)\)( -- .*)?$/.exec(first);
  if (!m) throw new Error("the base's first line is not a client version marker");
  const baseVersion = m[1], constant = `var CLIENT_VERSION = "${baseVersion}";`;
  if (!once(base, constant)) throw new Error(`the base must hold exactly one ${constant}`);
  if (version === baseVersion) throw new Error("the next version must differ from the base's");
  const label = `${MARKER}${version} (LAB NEXT-VERSION TEST ARTIFACT, not production: derived by client/tools/lab-next.mjs from pvm-client.mjs ${baseVersion} sha256 ${sha256(baseBytes)})${m[3] || ""}`;
  const out = Buffer.from(label + base.slice(nl).replace(constant, `var CLIENT_VERSION = "${version}";`));
  return { bytes: out, version, sha256: sha256(out), size: out.length, base: { version: baseVersion, sha256: sha256(baseBytes) } };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  if (!arg("--base") || !arg("--version") || !arg("--out")) { console.error("--base FILE --version X.Y.Z --out FILE"); process.exit(2); }
  const r = deriveLabNext(fs.readFileSync(arg("--base")), arg("--version"));
  fs.writeFileSync(arg("--out"), r.bytes, { flag: "wx" });
  console.log(JSON.stringify({ version: r.version, sha256: r.sha256, size: r.size, base: r.base, lab: "LAB NEXT-VERSION TEST ARTIFACT, not production" }));
}
