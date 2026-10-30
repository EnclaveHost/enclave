// bind_anchor.mjs (historical-origin-segments-stage): stdin {header, rootClaim, l2BlockNumber} -> stdout ONE JSON line.
// Uses ONLY the pinned vendor/anchor-bootstrap.mjs (env AB, sha-checked by the caller) and @noble/hashes keccak_256 (env K, sha-checked).
// authenticateAnchor recomputes keccak(RLP(Isthmus header)) (a claimed `hash` must match) and OutputRootV0 and requires == rootClaim.
import fs from "node:fs";
const out = (o, rc) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exitCode = rc; };
try {
  const { authenticateAnchor } = await import(process.env.AB);
  const { keccak_256 } = await import(process.env.K);
  const i = JSON.parse(fs.readFileSync(0, "utf8"));
  const a = authenticateAnchor({ rootClaim: String(i.rootClaim).toLowerCase(), l2BlockNumber: i.l2BlockNumber }, i.header, (b) => keccak_256(b));
  out({ ok: true, anchor: { number: a.number, blockHash: a.blockHash, stateRoot: a.stateRoot, messagePasserStorageRoot: a.messagePasserStorageRoot } }, 0);
} catch (e) {
  out({ ok: false, code: e?.code || "error", error: String(e?.message || e).slice(0, 300) }, 3);
}
