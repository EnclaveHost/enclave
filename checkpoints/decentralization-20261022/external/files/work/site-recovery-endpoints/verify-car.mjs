import fs from "node:fs";
import { createHash } from "node:crypto";
import { readCar } from "../enclave/scripts/site-release/car.mjs";

const [file, cid, expected] = process.argv.slice(2);
const bytes = fs.readFileSync(file);
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (sha256 !== expected) throw new Error("CAR differs from the reviewed release");
const car = readCar(bytes, { expectRoot: cid });
console.log(JSON.stringify({ cid: car.root, sha256, bytes: bytes.length,
  blocks: car.blocks.size, files: car.files.length, completeDag: true }));
