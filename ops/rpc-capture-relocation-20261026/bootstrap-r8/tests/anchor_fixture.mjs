// Test fixture only: seal a synthetic Isthmus header with the pinned module (env AB, K) -> {hash, outputRoot}.
import fs from "node:fs";
const { headerHash, outputRootV0 } = await import(process.env.AB);
const { keccak_256 } = await import(process.env.K);
const h = JSON.parse(fs.readFileSync(0, "utf8"));
const hash = headerHash(h, (b) => keccak_256(b), { requireIsthmus: true });
const outputRoot = outputRootV0({ stateRoot: h.stateRoot, messagePasserStorageRoot: h.withdrawalsRoot, blockHash: hash }, (b) => keccak_256(b));
process.stdout.write(JSON.stringify({ hash, outputRoot }) + "\n");
