// The frozen compiled artifacts the setup requests are built from, checked the way root's preflight read.mjs checks
// them and then some: the main-repo source has the accepted sha256; the app-lease-gas copy and the forge/src copy are
// byte-identical to it; EVERY source in the artifact's compiler metadata (its compilation closure) is present under
// forge/ with the keccak256 the metadata records; the artifact file, its creation code and compiler/settings equal
// the provenance recorded in production-funding-preflight.json. Any difference throws: nothing is prepared.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { keccak256 } from "../enclave/node_modules/viem/_esm/index.js";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const ROOT = "/home/steven/Documents/Codex/2026-10-18/wo";
export const DEFAULT_PATHS = Object.freeze({
  main: `${ROOT}/work/enclave/contracts`,
  copy: `${ROOT}/work/app-lease-gas/contracts`,
  forge: `${ROOT}/work/app-lease-gas/forge`,
  preflight: `${ROOT}/outputs/app-lease-gas-review/production-funding-preflight.json`,
});

/** -> { EnclaveLeaseGasReserve: {abi, bytecode, deployedBytecode, provenance}, EnclaveLeaseExecutor: {...} } or throws. */
export function verifiedArtifacts({ trust, paths = DEFAULT_PATHS } = {}) {
  const pre = JSON.parse(fs.readFileSync(paths.preflight, "utf8"));
  const out = {};
  for (const name of ["EnclaveLeaseGasReserve", "EnclaveLeaseExecutor"]) {
    const main = fs.readFileSync(path.join(paths.main, `${name}.sol`));
    if (sha(main) !== trust.acceptedSources[name]) throw new Error(`${name}: main source is not the accepted source`);
    for (const p of [path.join(paths.copy, `${name}.sol`), path.join(paths.forge, "src", `${name}.sol`)])
      if (!fs.existsSync(p) || !fs.readFileSync(p).equals(main)) throw new Error(`${name}: ${p} is missing or differs from the accepted main source`);
    const raw = fs.readFileSync(path.join(paths.forge, "out", `${name}.sol`, `${name}.json`));
    const a = JSON.parse(raw);
    const meta = typeof a.metadata === "string" ? JSON.parse(a.metadata) : a.metadata;
    const closure = Object.keys(meta.sources || {});
    if (!closure.includes(`src/${name}.sol`)) throw new Error(`${name}: the artifact was not compiled from src/${name}.sol`);
    for (const src of closure) {
      const file = path.join(paths.forge, src);
      if (!fs.existsSync(file)) throw new Error(`${name}: compiler input ${src} is missing`);
      if (keccak256(fs.readFileSync(file)) !== meta.sources[src].keccak256) throw new Error(`${name}: compiler input ${src} differs from the compiled one`);
    }
    if (meta.settings?.compilationTarget?.[`src/${name}.sol`] !== name) throw new Error(`${name}: wrong compilation target`);
    const prov = pre.provenance?.[name];
    if (!prov) throw new Error(`${name}: no provenance in the preflight`);
    const creation = sha(Buffer.from(a.bytecode.object.slice(2), "hex"));
    if (sha(raw) !== prov.artifactSha256 || creation !== prov.creationCodeSha256 || prov.sourceSha256 !== trust.acceptedSources[name])
      throw new Error(`${name}: artifact differs from the preflight provenance`);
    if (JSON.stringify(meta.compiler) !== JSON.stringify(prov.compiler) || JSON.stringify(meta.settings) !== JSON.stringify(prov.settings))
      throw new Error(`${name}: compiler or settings differ from the preflight provenance`);
    if (Object.keys(a.bytecode.linkReferences || {}).length) throw new Error(`${name}: unlinked libraries`);
    out[name] = { abi: a.abi, bytecode: a.bytecode.object, deployedBytecode: a.deployedBytecode.object,
      immutableReferences: a.deployedBytecode.immutableReferences || {},
      provenance: { sourceSha256: prov.sourceSha256, artifactSha256: prov.artifactSha256, creationCodeSha256: creation, compiler: meta.compiler.version, closure } };
  }
  return out;
}

/**
 * The exact runtime an EnclaveLeaseExecutor deployed at `self` for `reserve` (whose ledger is `ledger`) must have:
 * the compiled runtime with its three immutables filled in. The artifact carries no AST, so the immutable ids are
 * mapped by declaration order (ascending ids) and confirmed by their use counts (reserve 3, ledger 4, SELF 2); the
 * mapping is also cross-checked against a real deployment by the Anvil tests.
 */
export function executorRuntime(art, { reserve, ledger, self }) {
  const refs = Object.entries(art.immutableReferences).sort((a, b) => Number(a[0]) - Number(b[0]));
  if (refs.length !== 3 || refs[0][1].length !== 3 || refs[1][1].length !== 4 || refs[2][1].length !== 2)
    throw new Error("EnclaveLeaseExecutor: unexpected immutable layout");
  let code = art.deployedBytecode.slice(2).toLowerCase();
  const word = (a) => a.slice(2).toLowerCase().padStart(64, "0");
  for (const [[, places], value] of refs.map((r, i) => [r, [reserve, ledger, self][i]]))
    for (const { start, length } of places) {
      if (length !== 32) throw new Error("EnclaveLeaseExecutor: unexpected immutable width");
      code = code.slice(0, start * 2) + word(value) + code.slice((start + length) * 2);
    }
  return "0x" + code;
}
