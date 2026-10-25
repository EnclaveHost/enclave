// Build the shared lease runtime for installed Windows hosts, whose npm packages live under windows/node.
import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "windows/node/lease-gas-runtime.bundle.mjs");
const args = process.argv.slice(2);
if (args.length && !(args.length === 1 && args[0] === "--check")) throw new Error("usage: build-windows-lease-runtime.mjs [--check]");
const result = await build({
  absWorkingDir: root, entryPoints: ["network/lease-gas-runtime.mjs"], outfile: output,
  platform: "node", format: "esm", target: "node20", bundle: true, minify: true,
  write: false, metafile: true,
  banner: { js: "// Generated from shared network/lease-gas-runtime.mjs; do not edit." },
  // Match the reviewed development bundle's canonical implementation path without requiring a Git symlink.
  plugins: [{ name: "canonical-lease-client", setup(b) {
    b.onResolve({ filter: /^\.\/lease-executor-client\.mjs$/ }, args =>
      args.resolveDir === path.join(root, "network") ? { path: path.join(root, "client/lease-executor-client.mjs") } : undefined);
  } }],
});
const bytes = Buffer.from(result.outputFiles[0].contents);
const sha = b => createHash("sha256").update(b).digest("hex");
if (args.includes("--check")) {
  if (!bytes.equals(await fs.readFile(output))) throw new Error("Windows shared lease bundle is stale");
} else {
  await fs.writeFile(output, bytes);
  const inputs = {};
  for (const rel of Object.keys(result.metafile.inputs).sort()) {
    const normalized = rel.includes("node_modules/") ? "node_modules/" + rel.split("node_modules/").pop() : rel;
    const digest = sha(await fs.readFile(path.resolve(root, rel)));
    if (inputs[normalized] && inputs[normalized] !== digest) throw new Error(`ambiguous bundle input ${normalized}`);
    inputs[normalized] = digest;
  }
  await fs.writeFile(output + ".manifest.json", JSON.stringify({ bundle: "windows/node/lease-gas-runtime.bundle.mjs", sha256: sha(bytes), bytes: bytes.length, inputs }, null, 2) + "\n");
}
console.log(`Windows shared lease bundle: ${bytes.length} bytes, sha256:${sha(bytes)}${args.includes("--check") ? " (verified)" : ""}`);
