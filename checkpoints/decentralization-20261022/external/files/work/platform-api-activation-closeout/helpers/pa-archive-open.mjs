#!/usr/bin/env node
// pa-archive-open.mjs -- OFFLINE: open the group's archives with a recovery key and materialize the newest state as a plain
// data directory. It is the rollback path AFTER the DNS switch (back to the old API) and the inspection step before a
// `platform-api-admin.mjs recover`. ROOT/the admin runs it on an offline machine holding a recovery private key; not run by the
// worker. It prints heads, times, counts and the opaque tree digest only.
//
//   node pa-archive-open.mjs --member-config m1.json --envelope recovery.json --recovery-key FILE --archive A1 [--archive A2 …]
//        [--materialize-to <new 0700 dir>]
//
// - every archive must open under the group key (any tampering, other key or other group refuses that copy);
// - the NEWEST head (epoch, seq) wins: an archive sink that serves an older authentic copy cannot roll the state back
//   unless EVERY copy given is older, so fetch `latest` from EVERY sink in platformApi.archives;
// - platform-credentials.json (the role's own file) is not materialized: the old API takes its credentials from its env;
// - the materialized tree digest uses the pa-export-check.mjs algorithm, so it compares directly with the cutover manifest
//   (EQUAL = nothing was written on the new group since genesis).
import fs from "node:fs";
import path from "node:path";
import { args, die, load, mkdirNew, walk, treeManifest, ROLE_FILE, SAFE_REL } from "./common.mjs";

export async function openNewest({ platformApi, envelope, recoveryPrivateKey, archives }) {
  const R = await load("metal/guest/platform-api-role.mjs"), S = await load("relay/state-replica.mjs");
  const key = R.openRecovery(envelope, { groupId: R.groupIdOf(platformApi), privateKey: recoveryPrivateKey });
  const opened = [], refused = [];
  archives.forEach((buf, i) => {
    try {
      const o = S.openArchive(key, buf);
      if (o.group !== undefined && o.group !== R.groupIdOf(platformApi)) throw new Error("another group's archive");
      opened.push({ i, o });
    } catch (e) { refused.push({ i, reason: e.message }); }
  });
  if (!opened.length) throw new Error(`no archive opened under this group's key (${refused.length} refused)`);
  opened.sort((a, b) => S.cmpHead(b.o.head, a.o.head));
  const newest = opened[0];
  return { newest: newest.o, from: newest.i, heads: opened.map((x) => ({ i: x.i, head: x.o.head, at: x.o.at })), refused };
}
export function materialize(dir, files) {
  mkdirNew(dir);
  let n = 0;
  for (const [rel, b64] of Object.entries(files)) {
    if (rel === ROLE_FILE) continue;
    if (!SAFE_REL.test(rel)) throw new Error("unsafe path in archive");
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, Buffer.from(b64, "base64"), { mode: 0o600, flag: "wx" });
    n++;
  }
  const m = treeManifest(walk(dir).files);
  return { files: n, bytes: m.bytes, treeSha256: m.treeSha256 };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const o = args(process.argv.slice(2), { multi: ["archive"] });
  if (!o["member-config"] || !o.envelope || !o["recovery-key"] || !o.archive?.length) die("usage: --member-config m.json --envelope E --recovery-key FILE --archive A [--archive …] [--materialize-to D]");
  const MC = await load("metal/guest/measured-control.mjs");
  const platformApi = MC.canonicalDirectConfig(JSON.parse(fs.readFileSync(o["member-config"], "utf8"))).platformApi;
  const priv = Buffer.from(fs.readFileSync(o["recovery-key"], "utf8").trim(), "hex");
  const r = await openNewest({ platformApi, envelope: JSON.parse(fs.readFileSync(o.envelope, "utf8")), recoveryPrivateKey: priv, archives: o.archive.map((f) => fs.readFileSync(f)) });
  const summary = { newestHead: r.newest.head, newestAt: r.newest.at, fromArchive: r.from, heads: r.heads, refused: r.refused,
    files: Object.keys(r.newest.files).filter((k) => k !== ROLE_FILE).length, credentialsHeld: Object.hasOwn(r.newest.files, ROLE_FILE) };
  if (o["materialize-to"]) summary.materialized = materialize(o["materialize-to"], r.newest.files);
  console.log(JSON.stringify(summary, null, 1));
}
