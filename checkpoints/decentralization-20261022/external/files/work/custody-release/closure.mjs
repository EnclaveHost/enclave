// READ-ONLY closure of the two release images, derived from the builders themselves against a source root (default: main's
// working tree). Nothing is written to that root (esbuild runs with write:false).
//   1. image inputs: the EXACT esbuild calls of scripts/build-custodian-v2.mjs (daemon + cvm-gsup) and
//      scripts/build-custody-rewrap.mjs (rewrap-guest + rewrap-gsup), same bundleOptions/measuredModule/measured config,
//      split by build-config.mjs bundleSources into repository files and node_modules packages;
//   2. build-time inputs: every repository module each builder SCRIPT loads (esbuild metafile of the script, packages external);
//   3. each builder's sourceCheck static list (build-config STATIC_IMAGE_SOURCES; the rewrap builder's own), expanded to files;
//   4. the Go helper the custodian image embeds (isolation/m2/cmd/snpkey + go.mod/go.sum) and the npm lock.
// Every file gets sha256 and a "kind"; anything that is not source-shaped (binary, key-like, env, generated) is flagged.
//   node closure.mjs <root> <host-policy.json> <out.json>
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const [ROOT, HPF, OUT] = process.argv.slice(2).map((p) => path.resolve(p));
const { build } = await import(path.join(ROOT, "node_modules/esbuild/lib/main.js"));
const B = await import(path.join(ROOT, "custody/v2/build-config.mjs"));
const hp = JSON.parse(fs.readFileSync(HPF, "utf8"));
const VAULT = "0xe48699b8401564aace7a814ae4569b67a3f7eef5", BOOK = "0xab214342d5a490150a4a977063a2f88e21f80907", OWN = "0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7";
const sha = (f) => createHash("sha256").update(fs.readFileSync(path.join(ROOT, f))).digest("hex");

// (1) the custodian image: exactly scripts/build-custodian-v2.mjs's measured config and esbuild calls
const { measured: CM } = B.custodianMeasured({ vault: VAULT, hostOwnership: OWN, transport: "direct", book: BOOK, hostPolicy: hp });
const copt = B.bundleOptions(B.measuredModule(CM), { root: ROOT });
const cd = await build({ ...copt, entryPoints: [path.join(ROOT, "custody/v2/daemon.mjs")] });
const cg = await build({ ...copt, entryPoints: [path.join(ROOT, "custody/v2/cvm-gsup.mjs")] });
const custodianInputs = B.bundleSources([cd.metafile, cg.metafile], { root: ROOT });
// the rewrap image: exactly scripts/build-custody-rewrap.mjs's measured config and esbuild calls
const { validateMirrors } = await import(path.join(ROOT, "network/host-policy-mirrors.mjs"));
const RM = { role: "enclave-custody-rewrap", chainId: 8453, vault: VAULT, book: BOOK, rpcs: [...B.MEASURED_RPCS], minAgree: Math.floor(B.MEASURED_RPCS.length / 2) + 1,
             confirmations: 2, maxAgeSec: 120, hostPolicy: { book: hp.book, hostOwnership: hp.hostOwnership, mirrors: validateMirrors(hp.mirrors) } };
const ropt = B.bundleOptions(B.measuredModule(RM), { root: ROOT });
const rg = await build({ ...ropt, entryPoints: [path.join(ROOT, "custody/v2/rewrap-guest.mjs")] });
const rs = await build({ ...ropt, entryPoints: [path.join(ROOT, "custody/v2/rewrap-gsup.mjs")] });
const rewrapInputs = B.bundleSources([rg.metafile, rs.metafile], { root: ROOT });

// (2) what each builder script itself loads (node-run), packages external
const scriptInputs = async (entry) => {
  const r = await build({ absWorkingDir: ROOT, entryPoints: [path.join(ROOT, entry)], bundle: true, platform: "node", format: "esm", target: "node22", write: false,
                          metafile: true, packages: "external", logLevel: "silent" });
  return Object.keys(r.metafile.inputs).map((f) => path.relative(ROOT, path.resolve(ROOT, f))).filter((f) => !f.startsWith("..")).sort();
};
const custodianScript = await scriptInputs("scripts/build-custodian-v2.mjs");
const rewrapScript = await scriptInputs("scripts/build-custody-rewrap.mjs");

// (3)+(4) the builders' static source lists, expanded to files (no node_modules, no build outputs)
const walk = (rel) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [rel];
  return fs.readdirSync(abs).flatMap((n) => (["node_modules", "target", ".git"].includes(n) ? [] : walk(path.join(rel, n))));
};
const custodianStatic = B.STATIC_IMAGE_SOURCES;
const rewrapStatic = ["scripts/build-custody-rewrap.mjs", "package.json", "package-lock.json"];
// the custodian builder needs from the static list only what it READS (go build of ./cmd/snpkey in isolation/m2, the lock):
const goHelper = ["isolation/m2/go.mod", "isolation/m2/go.sum", ...walk("isolation/m2/cmd/snpkey")];

const required = new Set([...custodianInputs.repo, ...rewrapInputs.repo, ...custodianScript, ...rewrapScript, ...goHelper, "package.json", "package-lock.json",
                          "scripts/build-custodian-v2.mjs", "scripts/build-custody-rewrap.mjs"]);
const SOURCE_EXT = /\.(mjs|js|cjs|json|go|mod|sum|sol)$/;
const files = [...required].sort().map((f) => {
  const st = fs.statSync(path.join(ROOT, f));
  const flags = [];
  if (!SOURCE_EXT.test(f) && !/(^|\/)go\.(mod|sum)$/.test(f)) flags.push("not-source-extension");
  if (/(key|secret|\.env|wallet|seed|mnemonic|private)/i.test(path.basename(f)) && !/(keys?\.mjs|wallet\.mjs)$/.test(f)) flags.push("name-looks-sensitive");
  if (st.size > 2 << 20) flags.push("large");
  return { path: f, sha256: sha(f), bytes: st.size,
           in: [custodianInputs.repo.includes(f) && "custodian-image", rewrapInputs.repo.includes(f) && "rewrap-image", custodianScript.includes(f) && "custodian-builder",
                rewrapScript.includes(f) && "rewrap-builder", goHelper.includes(f) && "go-helper"].filter(Boolean), ...(flags.length ? { flags } : {}) };
});
const out = { root: ROOT, hostPolicy: hp, custodianMeasured: CM, rewrapMeasured: RM,
  images: { custodian: { repo: custodianInputs.repo, packages: custodianInputs.packages }, rewrap: { repo: rewrapInputs.repo, packages: rewrapInputs.packages } },
  builders: { custodian: custodianScript, rewrap: rewrapScript }, sourceCheckStatic: { custodian: custodianStatic, rewrap: rewrapStatic }, goHelper,
  files, flagged: files.filter((f) => f.flags) };
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ files: files.length, custodianImageRepo: custodianInputs.repo.length, rewrapImageRepo: rewrapInputs.repo.length, custodianBuilder: custodianScript.length,
  rewrapBuilder: rewrapScript.length, packages: [...new Set([...custodianInputs.packages, ...rewrapInputs.packages])], flagged: out.flagged.map((f) => [f.path, f.flags]) }, null, 1));
