// Bundle the SAME shared runtime for Windows: its node_modules live under windows/node, so raw network imports
// cannot resolve viem on an installed host. No package-resolution exception or extra operator-paid implementation.
import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "shadow-win/windows/node/lease-gas-runtime.bundle.mjs");
const result = await build({
  absWorkingDir: root, entryPoints: ["network/lease-gas-runtime.mjs"], outfile: file,
  platform: "node", format: "esm", target: "node20", bundle: true, minify: true,
  write: false, metafile: true, banner: { js: "// Generated from shared network/lease-gas-runtime.mjs; do not edit." },
});
const bytes = result.outputFiles[0].contents;
if (process.argv.includes("--check")) {
  if (!Buffer.from(bytes).equals(await fs.readFile(file))) throw new Error("Windows lease runtime bundle is stale");
} else await fs.writeFile(file, bytes);
const inventory = {};
for (const rel of Object.keys(result.metafile.inputs).sort())
  inventory[rel] = createHash("sha256").update(await fs.readFile(path.resolve(root, rel))).digest("hex");
await fs.writeFile(path.join(root, "root-relay-fix/windows-bundle-inputs.json"),
  JSON.stringify({ bundle: file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, inputs: inventory }, null, 2) + "\n");
console.log("Windows shared lease runtime:", bytes.length, "bytes;", Object.keys(inventory).length, "inputs");
