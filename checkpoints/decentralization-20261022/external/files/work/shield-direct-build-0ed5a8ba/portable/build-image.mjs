import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
const [NEW, NEWSHA, ROOT] = process.argv.slice(2);
if (!NEW || !/^[0-9a-f]{64}$/.test(NEWSHA || "") || !ROOT) { console.error("usage: build-candidate.mjs <initrd> <sha256> <out root>"); process.exit(2); }
const V = new URL("./inputs/recipe.json", import.meta.url).pathname;
const m = JSON.parse(fs.readFileSync(V, "utf8"));
const home = (p) => path.resolve(path.dirname(V), p);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const inp = (name) => { const i = m.inputs.find((x) => x.name === name); if (!i?.from?.file) throw new Error(`no file input ${name}`);
  const b = fs.readFileSync(home(i.from.file)); if (sha(b) !== i.sha256) throw new Error(`${name} does not hash to its pin`); return b; };
const g = fs.readFileSync(NEW); if (sha(g) !== NEWSHA) throw new Error(`the initrd does not hash to ${NEWSHA}`);
const digest = (b) => JSON.parse(String(b)).series[0].reference.vbs_boot_digest;
const u = m.rebuild.vbsLinux1539, ud = m.rebuild.vbsLinux1539Debug;
const CUR = m.files.find((f) => f.path === u.output.slice(5)).sha256;
const CURDIG = digest(fs.readFileSync(home(m.inputs.find((x) => x.name === u.vbsJson).from.file)));
const d = fs.mkdtempSync(path.join(path.dirname(path.resolve(ROOT)), "igvm-"));
const out = {};
try {
  const igp = path.join(d, "igvmfilegen"); fs.writeFileSync(igp, inp(u.igvmfilegen)); fs.chmodSync(igp, 0o755);
  const build = (tag, manBuf, res, args = [], over = {}) => {
    console.error("building " + tag); global.gc?.();
    const rmap = {};
    for (const [t, n] of Object.entries(res)) { const p = path.join(d, `${tag}-${t}`); fs.writeFileSync(p, over[t] ?? inp(n)); rmap[t] = p; }
    const rp = path.join(d, `${tag}-resources.json`); fs.writeFileSync(rp, JSON.stringify({ resources: rmap }));
    const o = path.join(d, `${tag}.bin`), vj = path.join(d, `${tag}-vbs.json`), mp = path.join(d, `${tag}-manifest.json`);
    fs.writeFileSync(mp, manBuf);
    const r = spawnSync(igp, ["manifest", "-m", mp, "-r", rp, "-o", o, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${tag}: igvmfilegen exit ${r.status}: ${(r.stderr || "").trim().split("\n").at(-1)}`);
    const bin = fs.readFileSync(o), vbs = fs.readFileSync(vj);
    return { bytes: bin.length, markers: Object.fromEntries([...m.rebuild.g4probe.mustContain, ...m.rebuild.g4probe.mustNotContain, ...ud.mustContain].map(s => [s, bin.includes(Buffer.from(s))])), binSha: sha(bin), vbsSha: sha(vbs), digest: digest(vbs), path: o, vbsPath: vj };
  };
  const man = inp(u.manifest);
  // 0. the procedure reproduces the current candidate b7ba7731 (initrd 1539d5b2) and the twin proof
  const cur = build("repro-current", man, u.resources);
  out.reproduceCurrent = { binSha: cur.binSha, digest: cur.digest, ok: cur.binSha === CUR && cur.digest === CURDIG };
  const tw = build("twin", inp(u.twin.manifest), u.twin.resources);
  out.twinProof = { digest: tw.digest, ok: tw.digest === digest(inp(u.twin.expectVbsJson)) };
  if (!out.reproduceCurrent.ok || !out.twinProof.ok) throw new Error(`procedure not proven: ${JSON.stringify(out)}`);
  // 1. the new candidate, twice (determinism)
  const kernel = fs.readFileSync(process.argv[5]);
  const underhill = fs.readFileSync(process.argv[6]);
  if (sha(kernel) !== "6bbd7340f7505cffb4d00cfa84604052b394f2d6467918e24d4c44935783e0c0") throw Error("kernel pin mismatch");
  if (sha(underhill) !== "71a91101f8f9b870199946076db2b220c68167e029539d4619a6b7600432124e") throw Error("patched OpenHCL pin mismatch");
  const over = { linux_initrd: g, linux_kernel: kernel, underhill_initrd: underhill };
  const c1 = build("cand", man, u.resources, [], over), c2 = build("cand-again", man, u.resources, [], over);
  out.candidate = { binSha: c1.binSha, bytes: c1.bytes, vbsSha: c1.vbsSha, digest: c1.digest,
    deterministic: c1.binSha === c2.binSha && c1.vbsSha === c2.vbsSha, sameAsCurrent: c1.binSha === CUR };
  const has = (b, s) => b.includes(Buffer.from(s, "utf8"));
  out.candidate.strings = { mustContain: m.rebuild.g4probe.mustContain.map((s) => [s, c1.markers[s]]),
                            mustNotContain: m.rebuild.g4probe.mustNotContain.map((s) => [s, c1.markers[s]]) };
  // 2. its debug twin (a named rejection)
  const dbg = build("debug", man, ud.resources, ud.args, over);
  out.debugTwin = { binSha: dbg.binSha, bytes: dbg.bytes, digest: dbg.digest, strings: ud.mustContain.map((s) => [s, dbg.markers[s]]) };
  // 3. every pinned mutation, against the NEW baseline: each must move the digest
  const elfLoadMid = (b) => { const ph = Number(b.readBigUInt64LE(0x20)), sz = b.readUInt16LE(0x36), n = b.readUInt16LE(0x38);
    for (let i = 0; i < n; i++) { const o = ph + i * sz; if (b.readUInt32LE(o) === 1) { const fz = b.readBigUInt64LE(o + 0x20); if (fz > 0n) return Number(b.readBigUInt64LE(o + 8) + fz / 2n); } } return -1; };
  out.mutations = [];
  for (const mu of [...u.mutations, { name: "one byte of patched OpenHCL initrd", kind: "resourceByte", resource: "underhill_initrd", at: "middle" }]) {
    const ov = { ...over }; let mb = Buffer.from(man);
    if (mu.kind === "resourceByte") {
      const b = Buffer.from(over[mu.resource] ?? inp(u.resources[mu.resource]));
      const off = mu.at === "elfFirstLoadMiddle" ? elfLoadMid(b) : Math.floor(b.length / 2); if (off < 0 || off >= b.length) throw Error("mutation offset invalid"); b[off] ^= 1; ov[mu.resource] = b;
    } else if (mu.kind === "manifestEdit") {
      const j = JSON.parse(String(mb)); let o = j; for (const k of mu.path.slice(0, -1)) o = o[k];
      const last = mu.path.at(-1); if ("append" in mu) o[last] = String(o[last]) + mu.append; else o[last] = mu.set; mb = Buffer.from(JSON.stringify(j));
    }
    const x = build(`mut-${out.mutations.length}`, mb, u.resources, [], ov);
    out.mutations.push({ name: mu.name, digest: x.digest, changed: x.digest !== c1.digest, sameAsPinnedMutation: x.digest === mu.expectVbsBootDigest });
  }
  if (!out.candidate.deterministic) throw Error("nonrepeatable image assembly");
  if (out.debugTwin.digest === out.candidate.digest || out.debugTwin.strings.some(([,v])=>!v)) throw Error("debug twin guard failed");
  if (out.candidate.strings.mustContain.some(([,v])=>!v) || out.candidate.strings.mustNotContain.some(([,v])=>v)) throw Error("candidate command-line guard failed");
  if (out.mutations.some(x=>!x.changed)) throw Error("unmeasured image mutation");
  // 4. keep the outputs, read-only, in this lane's own directory
  const dir = path.join(ROOT, `vbs-linux-${c1.binSha.slice(0, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [src, name] of [[c1.path, "vbs-linux-candidate.bin"], [c1.vbsPath, "vbs-linux-candidate-vbs.json"],
                             [dbg.path, "vbs-linux-candidate-DEBUG-TRUSTS-HOST.bin"], [dbg.vbsPath, "vbs-linux-candidate-DEBUG-TRUSTS-HOST-vbs.json"]]) {
    const t = path.join(dir, name); if (!fs.existsSync(t)) { fs.copyFileSync(src, t); fs.chmodSync(t, 0o444); } }
  out.kept = dir;
  out.inputs = { linux_initrd: NEWSHA, linux_kernel: sha(kernel), underhill_initrd: sha(underhill), recipeManifest: sha(fs.readFileSync(V)), sourceRecipeManifest: m.sourceRecipeSha256, sourceCommit: "0ed5a8ba", manifest: sha(man), igvmfilegen: sha(inp(u.igvmfilegen)) };
  const bj = path.join(dir, "BUILD.json");
  if (!fs.existsSync(bj)) fs.writeFileSync(bj, JSON.stringify({ by: "Shield-direct candidate preparation; source0ed5a8ba; unactivated", at: new Date().toISOString(),
    recipe: "Pinned v41 rebuild.vbsLinux1539 manifest/resources with committed Shield-direct initrd, pinned TPM kernel and volatile-input patched OpenHCL initrd", ...out }, null, 1));
} finally { fs.rmSync(d, { recursive: true, force: true }); }
console.log(JSON.stringify(out, null, 1));
