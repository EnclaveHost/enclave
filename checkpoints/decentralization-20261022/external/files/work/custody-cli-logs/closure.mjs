import { build } from "esbuild";
const r = await build({ entryPoints: ["cli/enclave.mjs", "cli/custody-independent.mjs", "cli/independent.mjs"], bundle: true, platform: "node", format: "esm", write: false,
  metafile: true, packages: "external", logLevel: "silent", outdir: "/nonexistent", absWorkingDir: process.cwd() });
console.log(Object.keys(r.metafile.inputs).filter((p) => !p.includes("node_modules")).join("\n"));
