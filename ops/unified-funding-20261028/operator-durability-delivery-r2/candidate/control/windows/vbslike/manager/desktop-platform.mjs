/* ============================================================
   NATIVE DESKTOP PLATFORM: the operator-pinned platform, and a V8 mapping checked against it.

   Pure: no files, no commands, no awaits. Every check runs synchronously on an owned snapshot.

   validateDesktopPlatform mirrors desktop/profile.go ParseProfile + Validate on the profile text and
   binds the three media payloads (desktop-media.mjs) to the profile's verity images.
   validateDesktopMapping re-derives the whole bundle from its record and artifact and binds it to
   that platform: runtime, profile identity, controller, CPU fit and public-web egress.

   WHAT IT DOES NOT CLAIM. runtimeId and the IGVM pin are operator-trusted configuration; nothing
   here proves cryptographically that an image produces this profile. Host media hashes are
   attach-time readbacks. The guest repeats the profile check against its measured verity roots.
   Passing here does not authorize a launch, wallet or secret release, or physical capacity.
   ============================================================ */
import { TextDecoder } from "node:util";
import { BUNDLE_MAGIC, MAX_MANIFEST_BYTES, sha256Hex } from "./derive.mjs";
import { DESKTOP_PROFILE, deriveDesktop } from "./desktop-derive.mjs";
import { validateDesktopMedia } from "./desktop-media.mjs";

export const PROFILE_SCHEMA = "enclave-native-desktop-profile/1";
export const KERNEL_RELEASE = "6.6.87.2-enclave-kvm-box";
export const MAX_PROFILE_BYTES = 16384;
export const BLOCK_BYTES = 4096;
export const MAX_ROOT_BLOCKS = (8 * 1024 ** 3) / BLOCK_BYTES;
export const MAX_MODEL_BLOCKS = (128 * 1024 ** 3) / BLOCK_BYTES;
// Same ceiling as the production media builder: all three payloads together.
export const MAX_TOTAL_PAYLOAD_BYTES = 128 * 1024 ** 3;
export const MAX_COMPONENT_BYTES = 64 << 20;
export const DESKTOP_EGRESS = "public-web";
export const PLATFORM_CONFIG_KEYS = Object.freeze(["igvmSha256", "runtimeId", "profileText", "profileSha256", "media"]);
export const PLATFORM_KEYS = Object.freeze([...PLATFORM_CONFIG_KEYS, "profile", "controllerSha256"]);
export const MAPPING_KEYS = Object.freeze(["record", "recordSha256", "componentSha256", "componentBytes", "appId", "bundleBytes", "bundle"]);

const MAGIC = Buffer.from(BUNDLE_MAGIC, "utf8");
const MAX_BUNDLE_BYTES = MAGIC.length + 4 + MAX_MANIFEST_BYTES + 4 + MAX_COMPONENT_BYTES;
const HASH = /^[0-9a-f]{64}$/;

function bad(msg) { throw new Error(`desktop platform: ${msg}`); }

/** Own data properties only, exactly `keys`, read once each (no getters run, no inherited fields). */
function exactData(v, keys, what) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) bad(`${what} must be an object`);
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) bad(`${what} must be a plain object`);
  const own = Reflect.ownKeys(v);
  if (own.length !== keys.length || !keys.every((k) => own.includes(k)))
    bad(`${what} must have exactly the keys ${keys.join(", ")}`);
  const out = {};
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !("value" in d)) bad(`${what}.${k} must be a data property`);
    out[k] = d.value;
  }
  return out;
}

function hash(v, what) {
  if (typeof v !== "string" || !HASH.test(v) || v === "0".repeat(64)) bad(`${what} must be 64 lowercase hex digits, not all zero`);
  return v;
}
function str(v, what) {
  if (typeof v !== "string") bad(`${what} must be a string`);
  return v;
}
// Go decodes these into uint64; JS can only hold them exactly as safe integers.
function count(v, what) {
  if (!Number.isSafeInteger(v) || v < 0) bad(`${what} must be a non-negative safe integer`);
  return v;
}

function deepFreeze(v) {
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) deepFreeze(v[k]);
    Object.freeze(v);
  }
  return v;
}

/** dm-verity hash tree size for SHA256, 4096-byte blocks, format 1 (profile.go hashTreeBytes). */
export function hashTreeBytes(blocks) {
  let result = 0;
  while (blocks > 1) {
    blocks = Math.ceil(blocks / 128);
    result += blocks * BLOCK_BYTES;
  }
  return result;
}

/** ParseProfile: bounded, decoded with exact fields, byte-equal to its canonical form, then Validate. */
function parseProfile(text) {
  str(text, "profileText");
  const n = Buffer.byteLength(text, "utf8");
  if (n === 0 || n > MAX_PROFILE_BYTES) bad(`profileText must be 1..${MAX_PROFILE_BYTES} UTF-8 bytes`);
  if (Buffer.from(text, "utf8").toString("utf8") !== text) bad("profileText is not well-formed UTF-16 text");
  let raw;
  try { raw = JSON.parse(text); } catch { bad("profileText is not JSON"); }
  const top = exactData(raw, ["controllerSha256", "kernel", "models", "profile", "root", "schema"], "profile");
  const k = exactData(top.kernel, ["bootSha256", "elfSha256", "release"], "profile.kernel");
  const m = exactData(top.models, ["dataBlocks", "hashStartBlock", "imageBytes", "imageSha256", "rootHash", "salt"], "profile.models");
  const r = exactData(top.root, ["dataBlocks", "hashBytes", "hashSha256", "imageBytes", "imageSha256", "rootHash", "salt"], "profile.root");
  // Literal order is the Go struct order, which is lexical.
  const p = {
    controllerSha256: str(top.controllerSha256, "profile.controllerSha256"),
    kernel: { bootSha256: str(k.bootSha256, "profile.kernel.bootSha256"), elfSha256: str(k.elfSha256, "profile.kernel.elfSha256"),
      release: str(k.release, "profile.kernel.release") },
    models: { dataBlocks: count(m.dataBlocks, "profile.models.dataBlocks"), hashStartBlock: count(m.hashStartBlock, "profile.models.hashStartBlock"),
      imageBytes: count(m.imageBytes, "profile.models.imageBytes"), imageSha256: str(m.imageSha256, "profile.models.imageSha256"),
      rootHash: str(m.rootHash, "profile.models.rootHash"), salt: str(m.salt, "profile.models.salt") },
    profile: str(top.profile, "profile.profile"),
    root: { dataBlocks: count(r.dataBlocks, "profile.root.dataBlocks"), hashBytes: count(r.hashBytes, "profile.root.hashBytes"),
      hashSha256: str(r.hashSha256, "profile.root.hashSha256"), imageBytes: count(r.imageBytes, "profile.root.imageBytes"),
      imageSha256: str(r.imageSha256, "profile.root.imageSha256"), rootHash: str(r.rootHash, "profile.root.rootHash"),
      salt: str(r.salt, "profile.root.salt") },
    schema: str(top.schema, "profile.schema"),
  };
  // json.Marshal + LF. Accepted strings are fixed ASCII constants or hex, so Go's HTML escaping
  // cannot make the two encoders disagree on anything that also passes Validate.
  if (JSON.stringify(p) + "\n" !== text)
    bad("profileText is not canonical (duplicate, reordered or trailing data, alternate spelling, or not exactly one LF)");

  if (p.schema !== PROFILE_SCHEMA || p.profile !== DESKTOP_PROFILE || p.kernel.release !== KERNEL_RELEASE) bad("unsupported desktop profile");
  for (const [v, what] of [[p.controllerSha256, "controllerSha256"], [p.kernel.bootSha256, "kernel.bootSha256"],
    [p.kernel.elfSha256, "kernel.elfSha256"], [p.root.hashSha256, "root.hashSha256"], [p.root.imageSha256, "root.imageSha256"],
    [p.root.rootHash, "root.rootHash"], [p.root.salt, "root.salt"], [p.models.imageSha256, "models.imageSha256"],
    [p.models.rootHash, "models.rootHash"], [p.models.salt, "models.salt"]]) {
    if (typeof v !== "string" || !HASH.test(v) || v === "0".repeat(64)) bad(`invalid desktop digest (${what})`);
  }
  // Bound before multiplying, as Validate does.
  const pr = p.root, pm = p.models;
  if (pr.dataBlocks < 2 || pr.dataBlocks > MAX_ROOT_BLOCKS || pr.imageBytes !== pr.dataBlocks * BLOCK_BYTES || pr.hashBytes !== hashTreeBytes(pr.dataBlocks))
    bad("invalid root geometry");
  if (pm.dataBlocks < 2 || pm.dataBlocks > MAX_MODEL_BLOCKS || pm.hashStartBlock !== pm.dataBlocks + 1 ||
      pm.imageBytes !== pm.hashStartBlock * BLOCK_BYTES + hashTreeBytes(pm.dataBlocks))
    bad("invalid model geometry");
  return deepFreeze(p);
}

/**
 * -> a deeply frozen, owned platform: the five config fields plus the parsed profile and its
 * controllerSha256 (public metadata). Throws on anything outside the contract.
 */
export function validateDesktopPlatform(config) {
  const c = exactData(config, PLATFORM_CONFIG_KEYS, "config");
  const igvmSha256 = hash(c.igvmSha256, "igvmSha256");
  const runtimeId = hash(c.runtimeId, "runtimeId");
  const profileSha256 = hash(c.profileSha256, "profileSha256");
  const profile = parseProfile(c.profileText);
  if (sha256Hex(Buffer.from(c.profileText, "utf8")) !== profileSha256) bad("profileSha256 is not the sha256 of profileText");
  const media = validateDesktopMedia(c.media);
  const [root, hashes, models] = media;
  if (root.payloadBytes !== profile.root.imageBytes || root.payloadSha256 !== profile.root.imageSha256)
    bad("root medium payload is not the profile's root image");
  if (hashes.payloadBytes !== profile.root.hashBytes || hashes.payloadSha256 !== profile.root.hashSha256)
    bad("hashes medium payload is not the profile's root hash tree");
  if (models.payloadBytes !== profile.models.imageBytes || models.payloadSha256 !== profile.models.imageSha256)
    bad("models medium payload is not the profile's models image");
  if (root.payloadBytes + hashes.payloadBytes + models.payloadBytes > MAX_TOTAL_PAYLOAD_BYTES)
    bad(`total media payload exceeds ${MAX_TOTAL_PAYLOAD_BYTES} bytes`);
  return Object.freeze({ igvmSha256, runtimeId, profileText: c.profileText, profileSha256, media, profile,
    controllerSha256: profile.controllerSha256 });
}

/** magic | u32le manifest length | manifest | u32le artifact length | artifact, exactly. -> artifact view. */
function splitBundle(b) {
  let at = MAGIC.length;
  if (b.length < at + 4 || !b.subarray(0, at).equals(MAGIC)) bad("mapping.bundle does not start with the bundle magic");
  const mlen = b.readUInt32LE(at);
  at += 4;
  // Compare lengths before slicing; nothing is allocated from a declared length.
  if (mlen === 0 || mlen > MAX_MANIFEST_BYTES) bad(`mapping.bundle manifest length outside 1..${MAX_MANIFEST_BYTES}`);
  if (b.length - at < mlen + 4) bad("mapping.bundle is truncated in its manifest");
  at += mlen;
  const alen = b.readUInt32LE(at);
  at += 4;
  if (alen === 0 || alen > MAX_COMPONENT_BYTES) bad(`mapping.bundle artifact length outside 1..${MAX_COMPONENT_BYTES}`);
  if (b.length - at < alen) bad("mapping.bundle is truncated in its artifact");
  if (b.length - at > alen) bad("mapping.bundle has trailing bytes after its artifact");
  return b.subarray(at);
}

/** Match shieldconfig.PublicWebMode: a map lookup of the exact top-level key. */
function requirePublicWeb(configBase64) {
  // deriveDesktop already proved canonical base64 of a UTF-8 JSON object.
  const cfg = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(configBase64, "base64")));
  if (cfg.egress !== DESKTOP_EGRESS)
    bad(`desktop public configuration requires top-level egress exactly ${JSON.stringify(DESKTOP_EGRESS)}`);
}

/**
 * -> a fresh deriveDesktop mapping for `mapping`, after rederiving the whole bundle and binding it to
 * `platform` (a validateDesktopPlatform result, revalidated here from its config fields).
 * The record is deeply frozen; the bundle is a new Buffer on its own memory. Nothing aliases the caller.
 */
export function validateDesktopMapping(mapping, platform) {
  const pin = exactData(platform, PLATFORM_KEYS, "platform");
  const plat = validateDesktopPlatform({ igvmSha256: pin.igvmSha256, runtimeId: pin.runtimeId,
    profileText: pin.profileText, profileSha256: pin.profileSha256, media: pin.media });
  if (pin.controllerSha256 !== plat.controllerSha256) bad("platform.controllerSha256 is not its profile's controller");

  const m = exactData(mapping, MAPPING_KEYS, "mapping");
  if (!Buffer.isBuffer(m.bundle)) bad("mapping.bundle must be a Buffer");
  if (m.bundle.length > MAX_BUNDLE_BYTES) bad(`mapping.bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
  // Snapshot both before any check, so later caller writes cannot reach what was checked.
  const bundle = Buffer.from(m.bundle);
  let record;
  try { record = structuredClone(m.record); } catch { bad("mapping.record must be plain data"); }

  const derived = deriveDesktop({ record, component: splitBundle(bundle) });
  if (!derived.bundle.equals(bundle)) bad("mapping.bundle is not the derivation of its record and artifact");
  for (const k of ["recordSha256", "componentSha256", "componentBytes", "appId", "bundleBytes"])
    if (m[k] !== derived[k]) bad(`mapping.${k} differs from the rederived ${k}`);

  const r = derived.record;
  if (r.runtimeId !== plat.runtimeId) bad("record.runtimeId is not the platform runtimeId");
  if (r.desktop.profileSha256 !== plat.profileSha256) bad("record.desktop.profileSha256 is not the platform profileSha256");
  if (derived.componentSha256 !== plat.controllerSha256) bad("the mapping's component is not the profile's controller");
  // profile.go Limits: the guest refuses more CPU than its vCPUs can run.
  if (r.policy.cpuPercent > r.policy.vcpus * 100) bad("policy.cpuPercent exceeds vcpus * 100");
  requirePublicWeb(r.configBase64);

  // Buffer.alloc never uses the shared pool, so the result owns its whole ArrayBuffer.
  const out = Buffer.alloc(derived.bundle.length);
  derived.bundle.copy(out);
  return { record: deepFreeze(r), recordSha256: derived.recordSha256, componentSha256: derived.componentSha256,
    componentBytes: derived.componentBytes, appId: derived.appId, bundleBytes: derived.bundleBytes, bundle: out };
}
