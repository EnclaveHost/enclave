/* ============================================================
   enclave-catalog-bundle/1, on the Windows side.

   The shared rule lives in isolation/contract/catalog/derive.go, with an independent Python
   reference beside it and derive_vectors.json as the arbiter. This is a third implementation, in
   the language the Windows manager is written in, and it is only allowed to exist because the
   vectors can refuse it: windows/vbslike/manager/derive.test.mjs reproduces every ok and refused
   case from that file. A backend that derived a DIFFERENT AppID from the same catalog version
   would name the same app something else, which is the one thing the contract exists to prevent.
   ============================================================ */
import crypto from "node:crypto";

export const DERIVATION = "enclave-catalog-bundle/1";
/* A COMMAND that serves HTTP on its own socket, rather than a wasi:http proxy the runtime serves.
   Same rule as /1 except the world is "wasi:cli" and the manifest carries the one port the version
   declares. In the canonical manifest `http` sits between `artifact` and `policy` - keys sorted, so
   that is not a choice, but it is worth stating because a wrong order is a different AppID. */
export const DERIVATION_V2 = "enclave-catalog-bundle/2";
export const DERIVATIONS = [DERIVATION, DERIVATION_V2];
const MAX_PORT = 49999;
export const ABI = "enclave-domain-abi/1";
export const BUNDLE_MAGIC = "ENCLAVE-BUNDLE/1\n";
export const KIND = "wasm-component";
export const MAX_MANIFEST_BYTES = 64 << 10;
/** A component, not a core module: the app contract carries components only. */
export const COMPONENT_PREAMBLE = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]);

/** Compact JSON with keys sorted at every level - the one byte form a manifest has. */
export function canonical(v) {
  const walk = (x) => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const out = {};
      for (const k of Object.keys(x).sort()) out[k] = walk(x[k]);
      return out;
    }
    return x;
  };
  return Buffer.from(JSON.stringify(walk(v)), "utf8");
}

export function sha256Hex(b) { return crypto.createHash("sha256").update(b).digest("hex"); }

/** Build(Manifest{abi, world, artifact, policy}, component). The label is empty, so it is omitted. */
export function buildBundle({ world, policy, component, http = 0 }) {
  const manifest = {
    abi: ABI,
    artifact: { kind: KIND, sha256: sha256Hex(component) },
    ...(http ? { http } : {}),          // omitted when zero, as the Go tag's omitempty does
    policy: { cpuPercent: policy.cpuPercent, memMiB: policy.memMiB, vcpus: policy.vcpus },
    ...(world ? { world } : {}),
  };
  const mb = canonical(manifest);
  if (mb.length > MAX_MANIFEST_BYTES) throw new Error(`manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  const head = Buffer.from(BUNDLE_MAGIC, "utf8");
  const mlen = Buffer.alloc(4); mlen.writeUInt32LE(mb.length);
  const alen = Buffer.alloc(4); alen.writeUInt32LE(component.length);
  return Buffer.concat([head, mlen, mb, alen, component]);
}

const HEX32 = /^0x[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** The shared rule's own expression (derive.go cidRE): a bare CIDv0 or CIDv1, never a URL or a
 *  gateway prefix - "ipfs://bafk..." names a way to fetch it, not the content. */
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,120}|z[1-9A-HJ-NP-Za-km-z]{40,120})$/;

/**
 * Derive the mapping a domain is started from. Every input is explicit and none has a default:
 * a missing field is a refusal, not a filled-in blank.
 */
export function derive({ record, component }) {
  const r = record || {};
  if (!DERIVATIONS.includes(r.derivation)) throw new Error(`unknown derivation ${JSON.stringify(r.derivation ?? null)}`);
  const v2 = r.derivation === DERIVATION_V2;
  // A version that declares a port is /2, and only /2. The two rules are not interchangeable: the
  // same component under each gives a different world, a different manifest and a different AppID.
  const port = r.http;
  if (v2) {
    if (!Number.isInteger(port) || port < 1 || port > MAX_PORT)
      throw new Error(`enclave-catalog-bundle/2 needs http in 1..${MAX_PORT}, got ${JSON.stringify(port ?? null)}`);
  } else if (port !== undefined && port !== null && Number(port) !== 0) {
    throw new Error("enclave-catalog-bundle/1 carries no http: a version that declares a port is /2");
  }
  const cat = r.catalog || {};
  if (!HEX32.test(String(cat.app ?? ""))) throw new Error("catalog.app must be 0x + 64 lowercase hex");
  if (!Number.isInteger(cat.version) || cat.version < 0) throw new Error("catalog.version must be a non-negative integer");
  if (typeof r.cid !== "string" || !CID_RE.test(r.cid))
    throw new Error("cid is not a CIDv0 (Qm...) or a base32/base58 CIDv1");
  if (!HEX64.test(String(r.runtimeId ?? ""))) throw new Error("runtimeId must be 64 lowercase hex");
  const p = r.policy || {};
  for (const k of ["cpuPercent", "memMiB", "vcpus"]) {
    if (!Number.isInteger(p[k]) || p[k] <= 0) throw new Error(`policy.${k} must be a positive integer`);
  }
  if (!Buffer.isBuffer(component) || component.length === 0) throw new Error("component bytes are required");
  if (!component.subarray(0, 8).equals(COMPONENT_PREAMBLE))
    throw new Error("artifact is not a wasm component (a core module is refused)");

  const bundle = buildBundle({ world: v2 ? "wasi:cli" : "wasi:http", policy: p, component, http: v2 ? port : 0 });
  const rec = { catalog: { app: cat.app, version: cat.version }, cid: r.cid,
                derivation: r.derivation, ...(v2 ? { http: port } : {}),
                policy: { cpuPercent: p.cpuPercent, memMiB: p.memMiB, vcpus: p.vcpus },
                runtimeId: r.runtimeId };
  return {
    record: rec,
    // INFORMATIONAL on the Windows path (enclave-d1, READINESS.md M1): the manager stores it and the node's client passes
    // it through, and nothing compares it. appId (the bundle: world, policy, component, http) is what every report binds;
    // the record adds catalog.app/version, cid, derivation and runtimeId, which no report carries (runtimeId is judged
    // separately, as expectRuntime). The one place it COULD be compared is the node, against its own derivation of the
    // record it asked for, as supervisor.js does for guestd (derivationDigest); no such consumer exists here yet.
    recordSha256: sha256Hex(canonical(rec)),
    componentSha256: sha256Hex(component),
    componentBytes: component.length,
    appId: sha256Hex(bundle),
    bundleBytes: bundle.length,
    bundle,
  };
}
