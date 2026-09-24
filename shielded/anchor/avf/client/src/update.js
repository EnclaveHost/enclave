// update.js -- staging a verified code update (client/DESIGN.md "Updates", "State"; LAB). The bytes are verified against
// the signed, countersigned manifest, written beside the client under THEIR OWN version's name (unique temp + fsync +
// rename: two stagers of different versions never write the same file), and then committed as the staged version through
// the durable store -- re-verified against the NEWEST state (keys may have rotated meanwhile) and only if newer than
// anything staged or running. Release-key rotation lands in the same commit as the staging, so a concurrent policy commit
// can never lose it (or be lost by it). The running client never imports what it stages.
//   stageUpdate(store, env, bytes, { dir, currentVersion, hold }) -> { ok, version, file, gen } | { ok: false, reason }
// `hold` is for tests only (an in-process barrier between reading the state and committing); the CLI never passes it.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { verifyUpdate, semverCmp, CLIENT_VERSION } from "./trust.js";

export async function stageUpdate(store, env, bytes, { dir, currentVersion = CLIENT_VERSION, hold = null } = {}) {
  const cur = store.latest();
  if (!cur) return { ok: false, reason: "no client installed" };
  const first = await verifyUpdate(env, bytes, { state: cur.state, currentVersion, artifact: "pvm-client.mjs" });
  if (!first.ok) return { ok: false, reason: first.reasons[0] };
  const file = path.join(dir, `pvm-client-${first.manifest.version}.mjs`), tmp = `${file}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o644); try { fs.writeSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) { fs.rmSync(tmp, { force: true }); return { ok: false, reason: `could not write the verified artifact (${e.code || e.message}): nothing staged` }; }
  let r;
  try {
    r = await store.update(async (state) => {
      if (hold) await hold(state);
      const u = await verifyUpdate(env, bytes, { state, currentVersion, artifact: "pvm-client.mjs" });
      if (!u.ok) return { refuse: u.reasons[0] };
      if (state.staged && semverCmp(state.staged.version, u.manifest.version) >= 0) return { refuse: `update ${state.staged.version} is already staged: ${u.manifest.version} cannot replace it` };
      return { state: { ...u.state, staged: { version: u.manifest.version, sha256: u.manifest.artifactSha256, file: path.basename(file), sourceCommit: u.manifest.sourceCommit } } };
    });
  } catch (e) { return { ok: false, reason: `could not record the staged update durably (${e.message}): nothing staged` }; }
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, version: r.state.staged.version, file, gen: r.gen };
}
