// Canary secret values: fresh high-entropy markers, never real credentials, never reused. They are created once per
// marker set in the 0700 private dir (O_EXCL file, 0600) and leave it only inside an encrypted bundle or the relay's
// legacy set. Journals and output carry only a commitment: sha256 over a domain tag, the run, the set, the name and
// the value. The commitment is a hash of 32 random bytes, so it reveals nothing about the value.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { sha256hex } from "./canonical.mjs";

const NAME = /^CANARY_[A-Z0-9_]{1,40}$/;
const RUN = /^[0-9]{8}T[0-9]{6}Z$/;
const SET = /^[a-z0-9-]{1,32}$/;

export function commitmentOf({ run, set, name, value }) {
  return sha256hex(`enclave-custody-canary-marker-v1\n${run}\n${set}\n${name}\n${value}`);
}

export function guardPrivateDir(dir) {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir}: not a real directory`);
  if ((st.mode & 0o777) !== 0o700) throw new Error(`${dir}: mode must be 0700`);
  if (st.uid !== process.getuid()) throw new Error(`${dir}: not owned by this user`);
  if (fs.realpathSync(dir) !== path.resolve(dir)) throw new Error(`${dir}: path has a symlink component`);
}

// -> { file, commitments: {name: hex}, values (in memory only; register them with the guard, never print them) }
export function createMarkerSet({ dir, run, set, names, rng = randomBytes }) {
  if (!RUN.test(run) || !SET.test(set)) throw new Error("markers: bad run or set label");
  if (!names.length || names.some((n) => !NAME.test(n)) || new Set(names).size !== names.length) throw new Error("markers: names must be unique CANARY_* identifiers");
  guardPrivateDir(dir);
  const file = path.join(dir, `markers-${set}.json`);
  const values = Object.fromEntries(names.map((n) => [n, `CANARY_${run}_${set}_${rng(32).toString("hex")}`]));
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { fs.writeSync(fd, JSON.stringify({ run, set, values })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { file, values, commitments: Object.fromEntries(names.map((n) => [n, commitmentOf({ run, set, name: n, value: values[n] })])) };
}

export function loadMarkerSet({ dir, set }) {
  guardPrivateDir(dir);
  const file = path.join(dir, `markers-${set}.json`);
  const st = fs.lstatSync(file);
  if (!st.isFile() || (st.mode & 0o777) !== 0o600) throw new Error(`${file}: must be a regular 0600 file`);
  const { run, values } = JSON.parse(fs.readFileSync(file, "utf8"));
  return { file, values, commitments: Object.fromEntries(Object.entries(values).map(([n, v]) => [n, commitmentOf({ run, set, name: n, value: v })])) };
}
