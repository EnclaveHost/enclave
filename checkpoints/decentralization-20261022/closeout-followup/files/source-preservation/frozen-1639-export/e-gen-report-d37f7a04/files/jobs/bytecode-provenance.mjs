// Provenance of the two stale deploy bytecodes in site/js/gen/contract-artifacts.js (EnclaveRegistry, EnclaveProofOfTime).
// Compiles, with exactly scripts/build-contract-artifacts.mjs's solc input (solc-js from the tree's lockfile; optimizer
// runs 200; viaIR for EnclaveProofOfTime), (a) the CURRENT source at the reviewed head and (b) the OLD-HISTORY source blob
// whose provider-name rewrite equals the current source byte for byte. Then:
//   - which compile reproduces the committed (old) artifact bytecode, and which the fresh build's (new) artifact;
//   - every byte at which old and new differ lies inside the trailing CBOR metadata (ipfs + solc fields), whose length the
//     last two bytes give; with that section removed the executable bytecode is identical; the deployed (runtime) code too;
//   - the metadata JSON differs only in the source's keccak256 and content URLs, i.e. not in compiler version or settings;
//   - ABI identical (old compile, new compile, committed artifact, new artifact); the owner/admin/migration surface listed.
// Also: every OTHER contract entry of the committed artifact equals the fresh build's entry.
// Prints hashes and classifications only, never source text.
//   node bytecode-provenance.mjs <repo> <old-src-dir> <committed-artifacts.js> <fresh-artifacts.js>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const [REPO, OLD, COMMITTED, FRESH] = process.argv.slice(2).map((p) => path.resolve(p));
const req = createRequire(path.join(REPO, "package.json"));
const solc = req("solc");
const { keccak256, toHex, toFunctionSelector, toEventSelector } = req("viem");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const DEFS = [{ name: "EnclaveRegistry", viaIR: false }, { name: "EnclaveProofOfTime", viaIR: true }];
let failures = 0;
const check = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) failures++; };

function compile(dir, name, viaIR){
  const file = name + ".sol";
  const source = fs.readFileSync(path.join(dir, file), "utf8");
  const input = { language: "Solidity", sources: { [file]: { content: source } }, settings: {
    optimizer: { enabled: true, runs: 200 }, ...(viaIR ? { viaIR: true } : {}),
    outputSelection: { "*": { "*": ["abi", "metadata", "evm.bytecode.object", "evm.bytecode.linkReferences", "evm.deployedBytecode.object"] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: () => ({ error: "no imports expected" }) }));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(name + ": " + errs.map((e) => e.message).join("; "));
  const c = out.contracts[file][name];
  return { source, abi: c.abi, metadata: JSON.parse(c.metadata), bytecode: c.evm.bytecode.object, runtime: c.evm.deployedBytecode.object };
}
/** the trailing CBOR metadata: its length is the last two bytes; it must be {ipfs: bytes34, solc: bytes3} */
function cbor(hex){
  const len = parseInt(hex.slice(-4), 16), start = hex.length - 4 - len * 2;
  const body = hex.slice(start, -4);
  const m = /^a264697066735822([0-9a-f]{68})64736f6c6343([0-9a-f]{6})$/.exec(body);
  if (!m) throw new Error("unexpected metadata layout");
  return { start, ipfs: m[1], solc: [0, 1, 2].map((i) => parseInt(m[2].slice(i * 2, i * 2 + 2), 16)).join(".") };
}
const diffPositions = (a, b) => { const d = []; for (let i = 0; i < Math.max(a.length, b.length); i += 2) if (a.slice(i, i + 2) !== b.slice(i, i + 2)) d.push(i / 2); return d; };
const loadArtifacts = async (file) => {
  const tmp = path.join(path.dirname(OLD), path.basename(file) + "." + sha(fs.readFileSync(file)).slice(0, 12) + ".mjs");
  fs.copyFileSync(file, tmp);
  return (await import(pathToFileURL(tmp).href)).CONTRACTS;
};

console.log("solc-js", solc.version());
const committed = await loadArtifacts(COMMITTED), fresh = await loadArtifacts(FRESH);
console.log("committed artifacts sha256", sha(fs.readFileSync(COMMITTED)), "| fresh artifacts sha256", sha(fs.readFileSync(FRESH)));
for (const { name, viaIR } of DEFS){
  console.log("\n== " + name + (viaIR ? " (viaIR, runs 200)" : " (legacy codegen, runs 200)"));
  const cur = compile(path.join(REPO, "contracts"), name, viaIR), old = compile(OLD, name, viaIR);
  const T = (s) => s.replaceAll("Tin" + "foil", "Cloud Provider").replaceAll("tin" + "foil", "Cloud Provider");
  console.log("current source sha256", sha(cur.source), "| old-history source sha256", sha(old.source));
  check(T(old.source) === cur.source, "the old-history source becomes the current source under the authorized rewrite, byte for byte");
  const curLines = cur.source.split("\n"), oldLines = old.source.split("\n");
  const changed = curLines.map((l, i) => l !== oldLines[i] ? i + 1 : 0).filter(Boolean);
  const commentOnly = changed.every((n) => { const l = curLines[n - 1], o = oldLines[n - 1]; const codeOf = (x) => x.replace(/\/\/.*$/, "").trim();
    // a changed line is comment text: a // comment's tail, a /// NatSpec line, or a line inside a /* */ block
    if (/^\s*(\/\/\/?|\*|\/\*)/.test(l)) return true; if (codeOf(l) === codeOf(o) && l.includes("//")) return true;
    const before = cur.source.split("\n").slice(0, n - 1).join("\n"); return (before.match(/\/\*/g) || []).length > (before.match(/\*\//g) || []).length; });
  console.log("changed lines:", changed.length, changed.join(","));
  check(commentOnly && oldLines.length === curLines.length, "every changed line is comment text (line count equal)");
  const cb = committed[name].bytecode.replace(/^0x/, ""), nb = fresh[name].bytecode.replace(/^0x/, "");
  check(old.bytecode === cb, "old-history source compiles to the COMMITTED artifact bytecode exactly (" + cb.length / 2 + " bytes)");
  check(cur.bytecode === nb, "current source compiles to the FRESH build's artifact bytecode exactly (" + nb.length / 2 + " bytes)");
  const mo = cbor(cb), mn = cbor(nb), ro = cbor(old.runtime), rn = cbor(cur.runtime);
  console.log("metadata: committed solc " + mo.solc + " ipfs-multihash " + mo.ipfs.slice(0, 16) + "… | fresh solc " + mn.solc + " ipfs-multihash " + mn.ipfs.slice(0, 16) + "…");
  check(mo.solc === mn.solc && mo.solc === solc.version().split("+")[0], "the same compiler version is embedded in both");
  const d = diffPositions(cb, nb);
  check(cb.length === nb.length && d.length > 0 && d.every((p) => p * 2 >= mo.start), "creation bytecode: " + d.length + " differing bytes, all inside the trailing metadata (from byte " + mo.start / 2 + ")");
  check(cb.slice(0, mo.start) === nb.slice(0, mn.start), "creation bytecode with the metadata removed: identical");
  check(old.runtime.slice(0, ro.start) === cur.runtime.slice(0, rn.start) && old.runtime.length === cur.runtime.length, "deployed (runtime) code with the metadata removed: identical (" + cur.runtime.length / 2 + " bytes)");
  check(committed[name].runtimeBytes === fresh[name].runtimeBytes && fresh[name].runtimeBytes === cur.runtime.length / 2, "runtimeBytes field unchanged");
  // metadata JSON: everything but the source's hash/URLs is identical
  // NatSpec (/// and /** */) text is copied into the metadata's output.devdoc/userdoc: compare it under the rewrite
  const strip = (m) => { const c = structuredClone(m); for (const s of Object.values(c.sources)) { delete s.keccak256; delete s.urls; delete s.license; } delete c.output.devdoc; delete c.output.userdoc; return JSON.stringify(c); };
  check(strip(old.metadata) === strip(cur.metadata), "metadata JSON identical except the source keccak256/URLs and the NatSpec text (compiler, settings, optimizer, evmVersion, viaIR, ABI)");
  const doc = (m) => JSON.stringify([m.output.devdoc, m.output.userdoc]);
  console.log("NatSpec in metadata: " + (doc(old.metadata) === doc(cur.metadata) ? "unchanged" : "differs"));
  check(T(doc(old.metadata)) === doc(cur.metadata), "the NatSpec text in the metadata differs only by the same rewrite");
  check(old.metadata.sources[name + ".sol"].keccak256 === keccak256(toHex(old.source)) && cur.metadata.sources[name + ".sol"].keccak256 === keccak256(toHex(cur.source)),
    "each metadata names the keccak256 of its own source text");
  console.log("settings:", JSON.stringify({ compiler: cur.metadata.compiler.version, ...cur.metadata.settings, compilationTarget: undefined, remappings: undefined, libraries: undefined }));
  const j = (x) => JSON.stringify(x);
  // the artifact carries no ABI, only what is derived from it (sel, evt, ctor); the ABI itself is the tracked contracts/<Name>.abi.json
  const tracked = JSON.parse(fs.readFileSync(path.join(REPO, "contracts", name + ".abi.json"), "utf8"));
  check(j(old.abi) === j(cur.abi) && j(tracked) === j(cur.abi), "ABI identical: old compile, current compile, tracked contracts/" + name + ".abi.json (" + cur.abi.length + " entries)");
  const sel = {}; for (const f of cur.abi) if (f.type === "function") sel[f.name] = toFunctionSelector(f).slice(2);
  const evt = {}; for (const e of cur.abi) if (e.type === "event") evt[e.name] = toEventSelector(e);
  const ctor = (cur.abi.find((f) => f.type === "constructor")?.inputs || []).map((i) => ({ name: i.name.replace(/^_/, ""), type: i.type }));
  check(j(committed[name].sel) === j(sel) && j(fresh[name].sel) === j(sel) && j(committed[name].evt) === j(evt) && j(fresh[name].evt) === j(evt) && j(committed[name].ctor) === j(ctor),
    "the artifact's function selectors, event topics and constructor inputs are exactly those of the compiled ABI (" + Object.keys(sel).length + " fns, " + Object.keys(evt).length + " events)");
  check(committed[name].bookKey === fresh[name].bookKey, "address-book key unchanged: " + fresh[name].bookKey);
  const otherFields = (a) => { const { bytecode, ...rest } = a; return j(rest); };
  check(otherFields(committed[name]) === otherFields(fresh[name]), "every other artifact field (selectors, events, constructor, book key, schema, link refs) identical");
  const admin = cur.abi.filter((e) => e.type === "function" && /owner|admin|transfer|migrat|seal|import|set[A-Z]|pause|ban|delist|retire|withdraw|prover|accept/i.test(e.name) && !["view", "pure"].includes(e.stateMutability))
    .map((e) => e.name + "(" + e.inputs.map((i) => i.type).join(",") + ") " + toFunctionSelector(e).slice(0, 10));
  console.log("owner/admin/migration functions (state-changing), identical in all four:", admin.length, admin.join("; "));
}
console.log("\n== every other contract entry");
const names = Object.keys(fresh);
check(JSON.stringify(Object.keys(committed)) === JSON.stringify(names), "the same contract names, in the same order: " + names.join(", "));
for (const n of names) if (!DEFS.some((d) => d.name === n)) check(JSON.stringify(committed[n]) === JSON.stringify(fresh[n]), n + " unchanged");
console.log(failures ? "\nRESULT: " + failures + " FAILED" : "\nRESULT: all checks passed");
process.exit(failures ? 1 : 0);
