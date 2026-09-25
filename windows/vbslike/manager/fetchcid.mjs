/* ============================================================
   Fetching a component by CID, through the platform's own verifier.

   windows/node/fetch-cid.py is the article, and it is NOT a filter: it takes positional arguments
   `<cid> <out> [max bytes] [gateway]`, WRITES the bytes to a file, prints "ok <bytes> <sha256>" and
   exits 0, 1 or 2. The first version of main.mjs called it with `--cid X --stdout` and read stdout,
   which that script has never accepted - it would have exited 2 with a usage line on the first
   deployment, and the manager would have reported "no bytes" for a component that was never
   fetched.

   Why the script and not an HTTP GET: it asks the gateway for a CAR and hashes every block back to
   its CID (wasm/ipfs_fetch.py, the platform's own), so a gateway that tampers or substitutes fails
   there rather than handing this manager somebody else's wasm.
   ============================================================ */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);
/** A bare CIDv0 or CIDv1. A URL or a gateway prefix names a way to fetch, not the content. */
export const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,120}|z[1-9A-HJ-NP-Za-km-z]{40,120})$/;

/**
 * @param script   path to fetch-cid.py (ipfs_fetch.py must sit beside it: the script adds its own
 *                 directory to sys.path and imports it)
 * @param python   the interpreter
 * @param run      injected for tests; defaults to execFile
 * @param timeoutMs bounds the CHILD as well: the script's own network timeout is 180s per attempt,
 *                 so a manager that did not bound it could wait far longer than a spawn deadline.
 */
export function cidFetcher({ script, python = "python", maxBytes = 128 << 20, timeoutMs = 240_000,
                             gateway = "", run = null, tmpDir = null } = {}) {
  const exec = run || ((file, args, opts) => execFileP(file, args, opts));
  return async function fetchComponent(cid) {
    const id = String(cid ?? "");
    if (!CID_RE.test(id)) throw new Error(`refusing to fetch ${JSON.stringify(id)}: not a bare CID`);
    const dir = await fs.mkdtemp(path.join(tmpDir || os.tmpdir(), "enclave-cid-"));
    const out = path.join(dir, "component.wasm");
    try {
      const args = [script, id, out, String(maxBytes), ...(gateway ? [gateway] : [])];
      let stdout = "";
      try {
        const r = await exec(python, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20 });
        stdout = String((r && r.stdout) || "");
      } catch (e) {
        // exit 2 is the usage line, which is what a wrong call site looks like; say so rather than
        // reporting an empty fetch.
        const code = e && (e.code ?? e.status);
        const why = String((e && (e.stderr || e.message)) || "").trim().split("\n")[0] || `exit ${code}`;
        if (e && e.killed) throw new Error(`fetch-cid timed out after ${timeoutMs}ms for ${id}`);
        throw new Error(code === 2 ? `fetch-cid refused the call (${why}) - check the argument form`
                                   : `fetch-cid failed for ${id}: ${why}`);
      }
      const bytes = await fs.readFile(out).catch(() => { throw new Error(`fetch-cid wrote nothing for ${id}`); });
      if (!bytes.length) throw new Error(`fetch-cid wrote an empty file for ${id}`);
      // The script prints what it verified; hold it to that as well as trusting its exit code.
      const m = /^ok (\d+) ([0-9a-f]{64})$/m.exec(stdout.trim());
      if (m) {
        if (Number(m[1]) !== bytes.length) throw new Error(`fetch-cid said ${m[1]} bytes and wrote ${bytes.length}`);
        const got = crypto.createHash("sha256").update(bytes).digest("hex");
        if (got !== m[2]) throw new Error(`the bytes on disk hash to ${got}, not the ${m[2]} fetch-cid reported`);
      }
      return bytes;
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
}
