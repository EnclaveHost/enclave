#!/usr/bin/env node
// enclave-metal volumes — build the attested read-only model volumes a metal
// enclave attaches, the self-hosted equivalent of Tinfoil's Modelwrap "mpk"
// images.
//
//   node metal/volumes.mjs build qwen2.5-0.5b-gguf --src ~/Projects/enclave-models/qwen2.5-0.5b-gguf
//   node metal/volumes.mjs list
//   node metal/volumes.mjs inspect qwen2.5-0.5b-gguf
//   node metal/volumes.mjs rm qwen2.5-0.5b-gguf
//
// WHAT A VOLUME IS: one file. An ext4 filesystem image holding the model tree,
// with a dm-verity hash tree appended after it. The guest attaches the file as
// a virtio-blk disk, sets dm-verity up INSIDE the CVM against the root hash,
// and mounts it read-only — so every block a tenant reads is hash-verified on
// the way in, and a host that flips a byte gets an I/O error rather than a
// silently different model. The root hash is the volume's identity, exactly as
// Modelwrap's mpk root hash is; metal/enclave-metal.mjs folds the whole volume
// set's digest into the MEASURED kernel cmdline, so the enclave's launch
// measurement commits to which models it serves (metal/README.md "Model
// volumes").
//
// REPRODUCIBLE ON PURPOSE: same source tree in, same root hash out. mke2fs is
// pinned (fixed fs UUID + hash seed + SOURCE_DATE_EPOCH + root-owned entries)
// and the verity salt is derived from the volume name instead of random, so a
// buyer who has the model files can rebuild the image and check that the root
// hash the enclave attests to is the model they think it is. Nothing here needs
// root: mke2fs -d populates the image without mounting it, and veritysetup
// format only reads and writes plain files.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const CMD = argv[0] || 'help';
function arg(name, dflt) { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; }
function flag(name) { return argv.includes('--' + name); }

// Default store: a data disk, NOT the OS disk. Model volumes are big and the
// launcher only ever opens them read-only.
const STORE = path.resolve(arg('store', process.env.METAL_VOLUME_STORE || '/vm/enclave-volumes'));

const BLOCK = 4096;                    // both the ext4 block size and the verity block size
const die = (m) => { console.error(`[volumes] ${m}`); process.exit(1); };
const log = (...a) => console.log('[volumes]', ...a);

// Deterministic per-volume constants. A random fs UUID or verity salt would
// make every rebuild produce a different image (and a different root hash for
// the salt), which would defeat the "rebuild it yourself and compare" claim.
function uuidFor(name, kind) {
  const h = createHash('sha256').update(`enclave-metal-volume-${kind}|${name}`).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40;         // version 4 shape (it is a hash, not random)
  b[8] = (b[8] & 0x3f) | 0x80;         // RFC 4122 variant
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
const saltFor = (name) => createHash('sha256').update(`enclave-metal-volume-salt|${name}`).digest('hex');

const VOL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;   // same shape the wasm-manager accepts

function treeBytes(dir) {
  let total = 0, files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { total += fs.statSync(p).size; files++; }
    }
  };
  walk(dir);
  return { total, files };
}

function volumeDir(name) { return path.join(STORE, name); }
function readVolume(name) {
  try { return JSON.parse(fs.readFileSync(path.join(volumeDir(name), 'volume.json'), 'utf8')); }
  catch { return null; }
}

// ---- build ------------------------------------------------------------------
function build(name) {
  if (!VOL_NAME_RE.test(name)) die(`bad volume name ${JSON.stringify(name)} (letters, digits, . _ -)`);
  const src = path.resolve(arg('src', '') || die('--src <dir> is required'));
  if (!fs.statSync(src, { throwIfNoEntry: false })?.isDirectory()) die(`--src ${src} is not a directory`);
  const dir = volumeDir(name);
  const img = path.join(dir, 'volume.img');
  if (fs.existsSync(img) && !flag('force')) die(`${img} exists (use --force to rebuild)`);
  fs.mkdirSync(dir, { recursive: true });
  // Start from nothing on a rebuild: mke2fs writes a filesystem INTO an existing
  // file without truncating it, so a leftover image would keep its old (larger)
  // size and leave the previous hash tree in the tail.
  fs.rmSync(img, { force: true });

  const { total, files } = treeBytes(src);
  if (!files) die(`${src} has no files`);
  // Size the filesystem: content + ext4 metadata. 3% + 32 MiB is comfortable for
  // a handful of huge files (the model case) and still fine for many small ones.
  const dataBytes = Math.ceil((total * 1.03 + 32 * 1024 * 1024) / BLOCK) * BLOCK;
  const dataBlocks = dataBytes / BLOCK;
  log(`building ${name}: ${files} files, ${(total / 1e9).toFixed(2)} GB content → ${(dataBytes / 1e9).toFixed(2)} GB image`);

  // 1. the filesystem, populated WITHOUT mounting (mke2fs -d) so this needs no
  //    root. Determinism: fixed UUID + directory hash seed + SOURCE_DATE_EPOCH,
  //    and every entry owned by root (the guest mounts it read-only as root).
  //    No journal: the image is immutable, and a journal would only be replay
  //    state a read-only mount has to skip.
  const fsUuid = uuidFor(name, 'fs');
  try {
    execFileSync('mkfs.ext4', [
      '-q', '-F', '-b', String(BLOCK), '-m', '0', '-O', '^has_journal',
      '-U', fsUuid, '-E', `hash_seed=${uuidFor(name, 'hashseed')},root_owner=0:0`,
      '-L', name.slice(0, 16), '-d', src, img, String(dataBlocks),
    ], { env: { ...process.env, SOURCE_DATE_EPOCH: '0' }, stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (e) { die(`mkfs.ext4 failed: ${e.message}`); }
  // mke2fs's lost+found stays, and shows up in the volume's advertised file
  // list. Removing it (debugfs -R "rmdir /lost+found") leaves a consistent
  // filesystem — e2fsck is happy — but debugfs stamps the current time into the
  // root inode and superblock, so two builds of the same tree stop being
  // byte-identical. Reproducibility is the load-bearing property here (it is
  // what lets a buyer rebuild a model volume and compare root hashes); a stray
  // empty directory is cosmetic.

  // 2. the dm-verity hash tree, APPENDED to the same file (one file per volume =
  //    one virtio-blk device per volume). The hash superblock lands at the
  //    offset, so the tree itself starts one hash block later — that is the
  //    hash_start_block the guest's dm table needs.
  const hashOffset = dataBytes;
  const salt = saltFor(name);
  const out = spawnSync('veritysetup', [
    'format', '--hash', 'sha256', '--data-block-size', String(BLOCK), '--hash-block-size', String(BLOCK),
    // --data-blocks is not optional here: data and hash share one file, so
    // without it veritysetup measures the data area as the WHOLE file and
    // refuses ("Data area overlaps with hash area").
    '--data-blocks', String(dataBlocks),
    '--uuid', uuidFor(name, 'verity'), '--salt', salt, '--hash-offset', String(hashOffset),
    img, img,
  ], { encoding: 'utf8' });
  if (out.status !== 0) die(`veritysetup format failed: ${out.stderr || out.stdout}`);
  const field = (label) => (out.stdout.match(new RegExp(`^${label}:\\s*(.+)$`, 'm')) || [])[1]?.trim();
  const root = field('Root hash');
  const blocksFormatted = parseInt(field('Data blocks') || '0', 10);
  if (!/^[0-9a-f]{64}$/.test(root || '')) die(`could not read the root hash from veritysetup:\n${out.stdout}`);
  if (blocksFormatted !== dataBlocks) die(`veritysetup hashed ${blocksFormatted} blocks, expected ${dataBlocks}`);

  // 3. the record. This is what the launcher reads to build the guest's dm-verity
  //    table and the measured volume-set digest.
  const top = fs.readdirSync(src).sort().slice(0, 64);
  const gguf = arg('gguf', '') || null;             // explicit pick out of a multi-quant tree
  if (gguf && !fs.existsSync(path.join(src, gguf))) die(`--gguf ${gguf} is not in ${src}`);
  const vol = {
    name, source: src, fs: 'ext4', builtBy: 'metal/volumes.mjs',
    bytes: total, files: top, fileCount: files,
    gguf, sd: flag('sd'),
    image: 'volume.img', imageBytes: fs.statSync(img).size,
    verity: {
      alg: 'sha256', root, salt,
      dataBlockSize: BLOCK, hashBlockSize: BLOCK, dataBlocks,
      hashOffset, hashStartBlock: hashOffset / BLOCK + 1,
    },
    note: 'Rebuild with: node metal/volumes.mjs build ' + name + ' --src <same tree> --force  → the '
        + 'same root hash. The enclave attests to this root hash; nothing else about this file is trusted.',
  };
  fs.writeFileSync(path.join(dir, 'volume.json'), JSON.stringify(vol, null, 2) + '\n');
  log(`${name}: root ${root}`);
  log(`${name}: ${(vol.imageBytes / 1e9).toFixed(2)} GB at ${img}`);
  return vol;
}

// ---- list / inspect / rm ----------------------------------------------------
function list() {
  if (!fs.existsSync(STORE)) die(`no volume store at ${STORE} (create it, or pass --store)`);
  const names = fs.readdirSync(STORE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))   // dot-dirs are staging (model source trees), not volumes
    .map((e) => e.name).sort();
  if (!names.length) { log(`no volumes in ${STORE}`); return; }
  console.log(`\n  ${'VOLUME'.padEnd(28)} ${'CONTENT'.padStart(9)}  ${'IMAGE'.padStart(9)}  ROOT HASH`);
  for (const n of names) {
    const v = readVolume(n);
    if (!v) { console.log(`  ${n.padEnd(28)} ${'?'.padStart(9)}  ${'?'.padStart(9)}  (no volume.json)`); continue; }
    console.log(`  ${n.padEnd(28)} ${(v.bytes / 1e9).toFixed(2).padStart(7)} GB  ${(v.imageBytes / 1e9).toFixed(2).padStart(7)} GB  ${v.verity.root.slice(0, 32)}…`);
  }
  console.log(`\n  store: ${STORE}\n  attach with  "volumes": [${names.map((n) => `"${n}"`).join(', ')}]  (or "*") in metal/config.json\n`);
}

function inspect(name) {
  const v = readVolume(name) || die(`no volume ${name} in ${STORE}`);
  console.log(JSON.stringify(v, null, 2));
}

function rm(name) {
  const dir = volumeDir(name);
  if (!fs.existsSync(dir)) die(`no volume ${name} in ${STORE}`);
  if (!flag('yes')) die(`refusing to delete ${dir} without --yes`);
  fs.rmSync(dir, { recursive: true, force: true });
  log(`removed ${name}`);
}

// ---- main -------------------------------------------------------------------
switch (CMD) {
  case 'build': {
    const name = argv[1];
    if (!name || name.startsWith('--')) die('usage: volumes.mjs build <name> --src <dir> [--gguf <file>] [--sd] [--force]');
    for (const tool of ['mkfs.ext4', 'veritysetup']) {
      if (spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).status !== 0)
        die(`${tool} not found (pacman -S e2fsprogs cryptsetup)`);
    }
    if (!fs.existsSync(STORE)) die(`no volume store at ${STORE}\n  create it once:  sudo mkdir -p ${STORE} && sudo chown $USER ${STORE}`);
    build(name);
    break;
  }
  case 'list': list(); break;
  case 'inspect': inspect(argv[1] || die('usage: volumes.mjs inspect <name>')); break;
  case 'rm': rm(argv[1] || die('usage: volumes.mjs rm <name> --yes')); break;
  default:
    console.log(`enclave-metal volumes — attested read-only model volumes

  node metal/volumes.mjs build <name> --src <dir> [--gguf <file>] [--sd] [--force]
  node metal/volumes.mjs list
  node metal/volumes.mjs inspect <name>
  node metal/volumes.mjs rm <name> --yes

  --store <dir>   volume store (default ${STORE}, or METAL_VOLUME_STORE)
  --gguf <file>   pick ONE gguf out of a multi-quant tree (the MODEL_VOLUMES third field)
  --sd            this volume preloads through the stable-diffusion.cpp backend, not ggml

Attach volumes to the enclave with "volumes": ["name", …] (or "*") in
metal/config.json, then restart it. The volume set's digest goes on the MEASURED
kernel cmdline, so attaching or changing a volume changes the launch measurement
— that is the point: the attestation says which models this enclave serves.`);
}
