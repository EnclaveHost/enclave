// dockerfile-closure.mjs <tree>: EVERY supervisor.js relative static import the Dockerfile does not ship at its runtime path,
// with the exact rules of test/supervisor-image-closure.test.mjs test 1 (which stops at the first one). Read-only.
import fs from "node:fs"; import path from "node:path";
const root = path.resolve(process.argv[2]);
const files = new Map();
for (const line of fs.readFileSync(path.join(root, "Dockerfile"), "utf8").split("\n")) {
  const match = /^COPY\s+(.+)\s+(\S+)\s*$/.exec(line.trim());
  if (!match || match[1].startsWith("--")) continue;
  for (const source of match[1].split(/\s+/)) {
    if (!fs.statSync(path.join(root, source)).isFile()) continue;
    files.set(path.normalize(source), path.normalize(path.join(match[2], path.basename(source))));
  }
}
const seen = new Set(), remaining = ["supervisor.js"];
while (remaining.length) {
  const name = remaining.pop(); if (seen.has(name)) continue; seen.add(name);
  const text = fs.readFileSync(path.join(root, name), "utf8");
  for (const pattern of [/^\s*(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/gm, /^\s*import\s+["'](\.{1,2}\/[^"']+)["']/gm])
    for (const m of text.matchAll(pattern)) remaining.push(path.normalize(path.join(path.dirname(name), m[1])));
}
const missing = [...seen].filter((n) => files.get(n) !== n).sort();
console.log(JSON.stringify({ tree: root, closure: seen.size, missing, attestationPathsShipped: files.get("relay/attestation-paths.mjs") ?? null }));
