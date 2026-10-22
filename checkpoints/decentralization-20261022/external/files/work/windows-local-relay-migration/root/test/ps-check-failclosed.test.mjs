// ps-readonly-checks.sh FAILS CLOSED: exit 0 only for a complete, error-free parse of exactly the files sent. The host is a
// mock ssh (test/mockssh) answering as the PowerShell parse block would; the real check is root's run on minipc.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const run = (mode) => spawnSync("bash", [path.join(HERE, "../ps-readonly-checks.sh"), "minipc"], { encoding: "utf8",
  env: { PATH: `${path.join(HERE, "mockssh")}:${process.env.PATH}`, MOCK_SSH_MODE: mode } });
test("all files parse: exit 0", () => { const r = run("ok"); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /OK: all \d+ PowerShell sources parse/); });
test("one parse error: exit 1, with file:line:column and the parser's message", () => {
  const r = run("error"); assert.equal(r.status, 1); assert.match(r.stdout, /PARSE-ERROR stage\/[^:]+:22:41: Variable reference is not valid/); assert.match(r.stdout, /FAIL: 1 parse error/);
});
test("no result line (ssh or PowerShell failed): exit 1", () => { const r = run("silent"); assert.equal(r.status, 1); assert.match(r.stdout, /no PARSE-RESULT/); });
test("the host parsed a different set of files: exit 1", () => { const r = run("short"); assert.equal(r.status, 1); assert.match(r.stdout, /not the \d+ sent/); });
