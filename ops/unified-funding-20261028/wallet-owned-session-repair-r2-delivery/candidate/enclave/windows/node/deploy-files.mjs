// windows/node/deploy-files.mjs - the files a Windows node needs, DERIVED from its import graph rather than listed by hand.
//
//   node windows/node/deploy-files.mjs      prints repo-relative paths, one per line; exits 1 naming what is missing
//
// sync.sh used to scp a hand-written list, and the list went stale: it lacked hvnode-evidence.mjs, isolation-client.mjs,
// isolation-lifecycle.mjs and windows/vbslike/, all imported by the agent - the same trap as the relay's named-file deploy
// that crash-looped production on 2026-09-25 (coordinator enclave-87). This walks every static import, `export ... from`,
// dynamic import("...") and require("...") with a literal specifier, starting at agent.mjs, and FAILS on:
//   - a relative import whose file does not exist;
//   - a bare (npm) import that windows/node/package.json does not declare;
//   - a bare import from a file OUTSIDE windows/node, unless ALLOW_OUTSIDE names it: npm installs into the node's own
//     directory, so such a file cannot resolve its packages on the box.
// Tests and evidence are never imported, so they are never shipped.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "../..");
export const ENTRY = "windows/node/agent.mjs";
// Files the node runs that are not imported: the CID fetcher it spawns, its npm manifest and lockfile, its installer.
export const EXTRA = ["windows/node/fetch-cid.py", "windows/node/package.json", "windows/node/package-lock.json", "windows/node/install-node.cmd"];
// A bare import outside windows/node that is known never to execute on the node, with the reason. Anything else fails.
export const ALLOW_OUTSIDE = {
  "isolation/m4/guestd/supervisor-splice.mjs ws": "dynamic, in the WebSocket half only; the node's spliceStream never loads it (28a728f8)",
};

const SPEC = [
  /\bfrom\s*["']([^"']+)["']/g,                       // import x from "y", export { x } from "y"
  /\bimport\s*["']([^"']+)["']/g,                     // import "y"
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,           // import("y")
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,          // require("y")
  /\bcreateRequire\([^)]*\)\s*\(\s*["']([^"']+)["']\s*\)/g,   // createRequire(import.meta.url)("y")
];
const BUILTIN = new Set(builtinModules);
const isBuiltin = (s) => s.startsWith("node:") || BUILTIN.has(s) || BUILTIN.has(s.split("/")[0]);
const pkgName = (s) => (s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]);

/** closure({ root, entry }) -> { files: [repo-relative, sorted], problems: [string] } */
export function closure({ root = REPO, entry = ENTRY, extra = EXTRA, allowOutside = ALLOW_OUTSIDE } = {}) {
  const problems = [];
  const deps = (() => {
    try { return new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(root, "windows/node/package.json"), "utf8")).dependencies || {})); }
    catch { problems.push("windows/node/package.json is unreadable"); return new Set(); }
  })();
  const seen = new Set(), queue = [entry];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.join(root, rel);
    let src;
    try { src = fs.readFileSync(abs, "utf8"); } catch { problems.push(`${rel}: missing`); continue; }
    // comments out first: prose like `separately from "expired"` reads as an import. A `//` comment is one that starts a
    // line or follows whitespace, so the `//` of a URL inside a string ("https://...") is kept.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    const specs = new Set();
    for (const re of SPEC) for (const m of code.matchAll(re)) specs.add(m[1]);
    for (const s of specs) {
      if (isBuiltin(s)) continue;
      if (s.startsWith("./") || s.startsWith("../")) {
        const target = path.relative(root, path.resolve(path.dirname(abs), s)).split(path.sep).join("/");
        if (target.startsWith("..")) { problems.push(`${rel} imports ${s}, outside the repository`); continue; }
        if (!fs.existsSync(path.join(root, target))) { problems.push(`${rel} imports ${s}: ${target} is missing`); continue; }
        queue.push(target);
        continue;
      }
      if (/^[a-z@]/i.test(s)) {
        if (!deps.has(pkgName(s))) problems.push(`${rel} imports package ${s}, which windows/node/package.json does not declare`);
        if (!rel.startsWith("windows/node/") && !allowOutside[`${rel} ${pkgName(s)}`])
          problems.push(`${rel} imports package ${s} from outside windows/node, where the box has no node_modules`);
      }
    }
  }
  for (const e of extra) if (!fs.existsSync(path.join(root, e))) problems.push(`${e}: missing`);
  return { files: [...new Set([...seen, ...extra])].sort(), problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { files, problems } = closure();
  if (problems.length) {
    for (const p of problems) console.error(`deploy-files: ${p}`);
    console.error(`deploy-files: REFUSED - ${problems.length} problem(s); nothing may be shipped from this tree`);
    process.exit(1);
  }
  for (const f of files) console.log(f);
}
