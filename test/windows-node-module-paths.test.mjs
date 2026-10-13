// The Windows host installs to C:\Program Files\Enclave: a module URL's .pathname keeps the space as %20, so a path built
// from it names no file (2026-10-12: every app with a config failed "configuration could not be verified" because
// fetch-cid.py was run as C:\Program%20Files\...). Every module path must come from fileURLToPath.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs = ["windows/node", "windows/vbslike/manager", "windows/vbslike/datapath"];

test("no Windows module builds a file path from import.meta.url's undecoded pathname", () => {
  const bad = [];
  for (const d of dirs) for (const f of fs.readdirSync(path.join(root, d)).filter((n) => /\.m?js$/.test(n))) {
    const src = fs.readFileSync(path.join(root, d, f), "utf8");
    if (/URL\(\s*import\.meta\.url\s*\)\.pathname/.test(src)) bad.push(`${d}/${f}`);
  }
  assert.deepEqual(bad, []);
});

test("fileURLToPath decodes the space a .pathname keeps", () => {
  const url = pathToFileURL(path.join(root, "dir with space", "fetch-cid.py")).href;
  assert.match(new URL(url).pathname, /%20/);
  assert.ok(fileURLToPath(url).includes("dir with space"));
});
