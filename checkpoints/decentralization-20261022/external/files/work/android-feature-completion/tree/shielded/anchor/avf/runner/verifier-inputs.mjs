#!/usr/bin/env node
// verifier-inputs.mjs -- the pVM tier's verifier inputs (independent.mjs VERIFIER_INPUTS_FORMAT) as EXACT bytes and their
// sha256: what an owner pins in files/agent/independent.json (verifierInputs.sha256) and what any number of independently
// chosen hosts serve (verifierInputs.sources). The bytes are canonical (compact JSON, keys sorted), so two reviewers who
// compute them from the same reviewed inputs get the same hash; a source serving anything else is refused by the hash.
//   node verifier-inputs.mjs --apk <reviewed release APK>... --build <standalone/build.json> [--code-hash <64 hex>]... --out <file>
// --apk computes each APK's code hash (apk-code-hash.mjs, the v4 Merkle root the VM attests); --code-hash adds one reviewed
// elsewhere. The authority hashes, runtime ids and Google root pins come from the reviewed build.json (the same pins the relay
// tier uses today). Nothing is fetched; nothing is signed: WHO approves a build is still the platform's governance (the admin
// reviews and publishes the digest; owners pin it), and a new release means a new document and a new digest.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { apkCodeHash } from "./apk-code-hash.mjs";
import { verifierInputsBytes, VERIFIER_INPUTS_FORMAT } from "./independent.mjs";

export async function buildVerifierInputs({ apks = [], codeHashes = [], build }) {
  const hashes = [...codeHashes];
  for (const apk of apks) hashes.push(await apkCodeHash(apk));
  const doc = { format: VERIFIER_INPUTS_FORMAT, tier: "pvm-cpu", codeHashes: [...new Set(hashes)].sort(), authorityHashes: [...build.authorityHashes],
                runtimeIds: [...build.runtimeIds], rootPins: [...build.rootPins] };
  const bytes = verifierInputsBytes(doc);
  return { doc, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const a = process.argv.slice(2), all = (k) => a.flatMap((x, i) => (x === k ? [a[i + 1]] : []));
  const out = all("--out")[0], build = all("--build")[0];
  if (!out || !build) { console.error("usage: verifier-inputs.mjs --apk <apk>... [--code-hash <hex>]... --build <build.json> --out <file>"); process.exit(2); }
  const r = await buildVerifierInputs({ apks: all("--apk"), codeHashes: all("--code-hash"), build: JSON.parse(fs.readFileSync(build, "utf8")) });
  fs.writeFileSync(out, r.bytes);
  console.log(JSON.stringify({ out, sha256: r.sha256, codeHashes: r.doc.codeHashes, bytes: r.bytes.length }));
}
