// deps.mjs: the tests' ONLY external imports, resolved by package name (no relative or absolute install paths).
//   default:            Node resolution from this file (a source checkout: <repo>/node_modules)
//   ANCHOR_DEPS_ROOT=D:  resolve from directory D (must hold package.json + node_modules, e.g. a source checkout)
// The resolved packages must be EXACTLY the versions the source package-lock.json pins; anything else throws (no skip).
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

export const PINNED = Object.freeze({ "@noble/hashes": "1.8.0", viem: "2.53.1" });   // source/package-lock.json
const root = process.env.ANCHOR_DEPS_ROOT;
if (root !== undefined && !fs.existsSync(path.join(path.resolve(root), "package.json"))) throw new Error(`ANCHOR_DEPS_ROOT=${root} has no package.json`);
const req = createRequire(root !== undefined ? path.join(path.resolve(root), "package.json") : import.meta.url);

function packageOf(file, name) {
  for (let d = path.dirname(file); d !== path.dirname(d); d = path.dirname(d)) {
    const p = path.join(d, "package.json");
    if (fs.existsSync(p)) { const j = JSON.parse(fs.readFileSync(p, "utf8")); if (j.name === name) return { dir: d, version: j.version }; }
  }
  throw new Error(`no package.json named ${name} above ${file}`);
}
export const resolved = {};
async function load(spec, name) {
  let file;
  try { file = req.resolve(spec); } catch (e) { throw new Error(`cannot resolve ${spec} (set ANCHOR_DEPS_ROOT to a source checkout with node_modules): ${e.message}`); }
  const pkg = packageOf(file, name);
  if (pkg.version !== PINNED[name]) throw new Error(`${name} ${pkg.version} at ${pkg.dir} is not the pinned ${PINNED[name]}`);
  const nm = (req.resolve.paths(name) || []).find((d) => fs.existsSync(path.join(d, ...name.split("/"))));
  resolved[name] = { ...pkg, nodeModules: nm ? fs.realpathSync(nm) : null, realDir: fs.realpathSync(pkg.dir) };
  return import(pathToFileURL(file).href);
}
export const { keccak_256 } = await load("@noble/hashes/sha3.js", "@noble/hashes");
export const { toRlp } = await load("viem", "viem");
