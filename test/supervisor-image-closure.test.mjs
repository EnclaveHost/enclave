import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
function shipped() {
  const files = new Map();
  for (const line of fs.readFileSync(path.join(root, "Dockerfile"), "utf8").split("\n")) {
    const match = /^COPY\s+(.+)\s+(\S+)\s*$/.exec(line.trim());
    if (!match || match[1].startsWith("--")) continue;
    const sources = match[1].split(/\s+/), dest = match[2];
    for (const source of sources) {
      if (!fs.statSync(path.join(root, source)).isFile()) continue;
      files.set(path.normalize(source), path.normalize(path.join(dest, path.basename(source))));
    }
  }
  return files;
}
function imports(entry) {
  const seen = new Set(), remaining = [entry];
  while (remaining.length) {
    const name = remaining.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const text = fs.readFileSync(path.join(root, name), "utf8");
    for (const pattern of [
      /^\s*(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/gm,
      /^\s*import\s+["'](\.{1,2}\/[^"']+)["']/gm,
    ]) for (const match of text.matchAll(pattern))
      remaining.push(path.normalize(path.join(path.dirname(name), match[1])));
  }
  return seen;
}

test("the Linux image contains the supervisor's transitive relative static imports at their runtime paths", () => {
  const files = shipped();
  for (const name of imports("supervisor.js"))
    assert.equal(files.get(name), name, `image omits or relocates ${name}`);
});

test("startup storage loads with only Dockerfile-shipped source and the installed locked dependencies", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-image-storage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [source, dest] of shipped()) {
    const target = path.join(dir, dest);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, source), target);
  }
  fs.symlinkSync(fs.realpathSync(path.join(root, "node_modules")), path.join(dir, "node_modules"));
  // The storage module's browser-shared upload-auth implementation must also be present;
  // running from the repository would conceal a missing COPY instruction.
  const out = execFileSync(process.execPath, ["--input-type=module", "-e",
    'const s = await import("./sdk/bootstrap/storage.mjs"); if (typeof s.validateStoragePlan !== "function") throw Error("missing storage API"); console.log("storage imports complete");'],
  { cwd: dir, encoding: "utf8", timeout: 20000, env: { PATH: process.env.PATH } });
  assert.match(out, /storage imports complete/);
});
