// relay/vbs-tcglog.mjs — Windows measured-boot TCG log: parse, PCR replay, SIPA
// decode, VSM identity-key extraction. Port of windows/vbs/tools/tcglog.py, for
// the relay's Windows-VBS-enclave verifier (vbs-verify.mjs). Names follow the
// Windows SDK's wbcl.h.
//
// THE RULE THIS FILE EXISTS FOR: a field read from the log is only believed
// when the sha256 of its event data equals the digest the log recorded for that
// event. Windows SIPA records (EV_EVENT_TAG on PCR 11-14) and the PCR 7 UEFI
// variable events are measured as SHA-256(event data), so a log whose event
// data was edited while its digests were kept still replays to the quoted PCRs
// — and lies. The Python verifier's tamper test caught exactly that (REPORT.md
// section 3); sipaFields()/vsmKey()/secureBootFromLog() therefore skip any
// event that does not recompute, and unhashedEvents() names them so the
// verifier can refuse the log outright.
//
// Bounded everywhere: the log is capped, event counts are capped, SIPA trees
// have a depth and node budget. These are admission caps for a relay reading
// bytes off a socket, not claims about the format.
import { createHash } from "node:crypto";
import fs from "node:fs";

export const TCG_MAX_LOG_BYTES = 4 * 1024 * 1024;
export const TCG_MAX_EVENTS = 65536;
export const TCG_MAX_ALGS = 16;
export const TCG_SHA256 = 0x000b;
export const SIPA_MAX_DEPTH = 8;
export const SIPA_MAX_NODES = 65536;

export const EV_NO_ACTION = 3, EV_SEPARATOR = 4, EV_EVENT_TAG = 6, EV_EFI_VARIABLE_DRIVER_CONFIG = 0x80000001;
export const EV = { 3: "NO_ACTION", 4: "SEPARATOR", 5: "ACTION", 6: "EVENT_TAG", 8: "S_CRTM_VERSION", 0xc: "COMPACT_HASH",
  0x80000001: "EFI_VARIABLE_DRIVER_CONFIG", 0x80000002: "EFI_VARIABLE_BOOT", 0x80000003: "EFI_BOOT_SERVICES_APPLICATION",
  0x80000004: "EFI_BOOT_SERVICES_DRIVER", 0x80000006: "EFI_GPT_EVENT", 0x80000007: "EFI_ACTION", 0x8000000a: "EFI_PLATFORM_FIRMWARE_BLOB2",
  0x8000000b: "EFI_HANDOFF_TABLES2", 0x800000e0: "EFI_VARIABLE_AUTHORITY" };

export const SIPA = { 0x40010001: "TRUSTBOUNDARY", 0x40010002: "LOADEDMODULE_AGGREGATION", 0x40010003: "LOADEDMODULE_AGGREGATION", 0xC0010003: "TRUSTPOINT_AGGREGATION",
  0x20001: "INFORMATION", 0x20002: "BOOTCOUNTER", 0x20003: "TRANSFER_CONTROL", 0x20004: "APPLICATION_RETURN", 0x20005: "BITLOCKER_UNLOCK", 0x20006: "EVENTCOUNTER",
  0x20007: "COUNTERID", 0x20008: "MORBIT_NOT_CANCELABLE", 0x2000b: "MORBIT_API_STATUS", 0x2000c: "IDK_GENERATION_STATUS", 0x40001: "BOOTDEBUGGING",
  0x40002: "BOOTREVOCATIONLIST", 0x50001: "OSKERNELDEBUG", 0x50002: "CODEINTEGRITY", 0x50003: "TESTSIGNING", 0x50004: "DATAEXECUTIONPREVENTION", 0x50005: "SAFEMODE",
  0x50006: "WINPE", 0x50008: "OSDEVICE", 0x50009: "SYSTEMROOT", 0x5000a: "HYPERVISOR_LAUNCH_TYPE", 0x5000b: "HYPERVISOR_PATH", 0x5000c: "HYPERVISOR_IOMMU_POLICY",
  0x5000d: "HYPERVISOR_DEBUG", 0x5000e: "DRIVER_LOAD_POLICY", 0x5000f: "SIPOLICY", 0x50010: "HYPERVISOR_MMIO_NX_POLICY", 0x50011: "HYPERVISOR_MSR_FILTER_POLICY",
  0x50012: "VSM_LAUNCH_TYPE", 0x50013: "OS_REVOCATION_LIST", 0x50014: "SMT_STATUS", 0x50020: "VSM_IDK_INFO", 0x50021: "FLIGHTSIGNING", 0x50022: "PAGEFILE_ENCRYPTION_ENABLED",
  0x50023: "VSM_IDKS_INFO", 0x50024: "HIBERNATION_DISABLED", 0x50025: "DUMPS_DISABLED", 0x50026: "DUMP_ENCRYPTION_ENABLED", 0x50027: "DUMP_ENCRYPTION_KEY_DIGEST",
  0x50028: "LSAISO_CONFIG", 0x50029: "SBCP_INFO", 0x50030: "HYPERVISOR_BOOT_DMA_PROTECTION", 0x50031: "SI_POLICY_SIGNER", 0x50032: "SI_POLICY_UPDATE_SIGNER",
  0x5003a: "VSM_SEALED_SI_POLICY", 0x5003b: "VSM_DRTM_KEYROLL_DETECTED", 0x5003c: "VSM_SRTM_UNSEAL_POLICY", 0x5003d: "VSM_SRTM_ANTI_ROLLBACK_COUNTER", 0x50040: "VTL1_DUMP_CONFIG",
  0x60001: "NOAUTHORITY", 0x60002: "AUTHORITYPUBKEY", 0x70001: "FILEPATH", 0x70002: "IMAGESIZE", 0x70003: "HASHALGORITHMID", 0x70004: "AUTHENTICODEHASH",
  0x70005: "AUTHORITYISSUER", 0x70006: "AUTHORITYSERIAL", 0x70007: "IMAGEBASE", 0x70008: "AUTHORITYPUBLISHER", 0x70009: "AUTHORITYSHA1THUMBPRINT", 0x7000a: "IMAGEVALIDATED",
  0x7000b: "MODULESVN", 0x7000c: "MODULE_PLUTON", 0x7000d: "MODULE_ORIGINAL_FILENAME", 0x7000e: "MODULE_VERSION", 0x7000f: "PUBLISHER_OEMNAME",
  0xa0001: "VBS_VSM_REQUIRED", 0xa0002: "VBS_SECUREBOOT_REQUIRED", 0xa0003: "VBS_IOMMU_REQUIRED", 0xa0004: "VBS_NX_REQUIRED", 0xa0005: "VBS_MSR_FILTERING_REQUIRED",
  0xa0006: "VBS_MANDATORY_ENFORCEMENT", 0xa0007: "VBS_HVCI_POLICY", 0xa0008: "VBS_MICROSOFT_BOOT_CHAIN_REQUIRED", 0xa0009: "VBS_DUMP_USES_AMEROOT", 0xa000a: "VBS_VSM_NOSECRETS_ENFORCED",
  0xc0001: "DRTM_STATE_AUTH", 0xc0002: "DRTM_SMM_LEVEL", 0xc0003: "DRTM_AMD_SMM_HASH", 0xc0004: "DRTM_AMD_SMM_SIGNER_KEY" };
export const SIPA_ID = Object.fromEntries(Object.entries(SIPA).map(([k, v]) => [v, Number(k)]));   // name -> id (first wins is fine: the aggregation ids alias)
export const SIPA_CONTAINERS = new Set([0x40010001, 0x40010002, 0x40010003, 0xC0010003, 0x20001]);
export const SIPA_STRINGS = new Set([0x70001, 0x50009, 0x5000b, 0x70008, 0x70005]);
export const SIPA_VSM_IDK_INFO = 0x50020, SIPA_VSM_IDKS_INFO = 0x50023;

const sha256 = (b) => createHash("sha256").update(b).digest();
const toBuf = (d) => Buffer.isBuffer(d) ? d : Buffer.from(d);

// ---- parse ------------------------------------------------------------------
// The crypto-agile (TCG PC Client "EFI_TCG2_EVENT_LOG_FORMAT_TCG_2") layout:
// one legacy-format TCG_PCClientPCREvent carrying the "Spec ID Event03" header
// (which lists the digest algorithms and their sizes), then TCG_PCR_EVENT2
// records: pcr u32, type u32, count u32, count x (alg u16, digest[size]),
// eventSize u32, event[eventSize]. All little-endian.
export function parseTcgLog(data, { maxBytes = TCG_MAX_LOG_BYTES, maxEvents = TCG_MAX_EVENTS } = {}) {
  const b = toBuf(data);
  if (b.length > maxBytes) throw new Error(`TCG log exceeds ${maxBytes} bytes`);
  const need = (off, n) => { if (!Number.isSafeInteger(off) || off < 0 || n < 0 || off + n > b.length) throw new Error("TCG log truncated"); };
  let off = 0;
  need(off, 8 + 20 + 4);
  const pcr0 = b.readUInt32LE(off), type0 = b.readUInt32LE(off + 4); off += 8 + 20;
  const hsz = b.readUInt32LE(off); off += 4;
  need(off, hsz);
  const hdr = b.subarray(off, off + hsz); off += hsz;
  if (pcr0 !== 0 || type0 !== EV_NO_ACTION || hsz < 32 || hdr.subarray(0, 16).toString("latin1") !== "Spec ID Event03\0")
    throw new Error("not a TCG 2.0 crypto-agile log (no Spec ID Event03 header)");
  const nalg = hdr.readUInt32LE(24);
  if (!nalg || nalg > TCG_MAX_ALGS || 28 + 4 * nalg > hdr.length) throw new Error("TCG log header lists an implausible algorithm count");
  const algs = new Map();
  for (let i = 0; i < nalg; i++) {
    const id = hdr.readUInt16LE(28 + 4 * i), size = hdr.readUInt16LE(30 + 4 * i);
    if (!size || size > 64 || algs.has(id)) throw new Error("TCG log header algorithm entry malformed");
    algs.set(id, size);
  }
  const events = [];
  while (off < b.length) {
    if (events.length >= maxEvents) throw new Error(`TCG log exceeds ${maxEvents} events`);
    need(off, 12);
    const pcr = b.readUInt32LE(off), type = b.readUInt32LE(off + 4), count = b.readUInt32LE(off + 8); off += 12;
    if (count > algs.size) throw new Error("TCG event lists more digests than the header's algorithms");
    const digests = new Map();
    for (let i = 0; i < count; i++) {
      need(off, 2);
      const alg = b.readUInt16LE(off); off += 2;
      const size = algs.get(alg);
      if (!size || digests.has(alg)) throw new Error("TCG event digest algorithm not in the header");
      need(off, size);
      digests.set(alg, b.subarray(off, off + size)); off += size;
    }
    need(off, 4);
    const esz = b.readUInt32LE(off); off += 4;
    need(off, esz);
    events.push({ index: events.length, pcr, type, digests, data: b.subarray(off, off + esz) });
    off += esz;
  }
  return { algs, events };
}

// ---- replay -------------------------------------------------------------------
// PCR[n] = H(PCR[n] || digest) over the recorded digests, in log order. This is
// the value the TPM holds if — and only if — the log is what was measured; the
// quote is what proves that. It says nothing about the event DATA, which is why
// the field readers below insist on recomputing.
export function replayPcrs(events, alg = TCG_SHA256, { maxPcr = 32 } = {}) {
  const pcrs = new Map();
  for (const e of events) {
    const d = e.digests.get(alg);
    if (!d || e.pcr >= maxPcr) continue;
    const prev = pcrs.get(e.pcr) || Buffer.alloc(d.length, 0);
    pcrs.set(e.pcr, createHash("sha256").update(prev).update(d).digest());
  }
  return pcrs;
}

// Event kinds whose digest MUST be the hash of their event data. EV_EVENT_TAG
// carries the SIPA records; EV_EFI_VARIABLE_DRIVER_CONFIG on PCR 7 carries the
// Secure Boot variables (measured over the whole UEFI_VARIABLE_DATA).
export function recomputable(e) {
  return e.type === EV_EVENT_TAG || (e.type === EV_EFI_VARIABLE_DRIVER_CONFIG && e.pcr === 7);
}
export function digestRecomputes(e, alg = TCG_SHA256) {
  const d = e.digests.get(alg);
  return !!d && d.length === 32 && sha256(e.data).equals(d);
}
// Every recomputable event whose recorded digest is NOT the hash of its data.
export function unhashedEvents(events, alg = TCG_SHA256) {
  return events.filter((e) => recomputable(e) && !digestRecomputes(e, alg)).map((e) => ({ index: e.index, pcr: e.pcr, type: e.type }));
}
export function countRecomputable(events) { return events.filter(recomputable).length; }

// ---- SIPA ---------------------------------------------------------------------
// Windows measures TLV trees: id u32, size u32, value[size]; container ids nest.
export function sipaWalk(buf, { maxDepth = SIPA_MAX_DEPTH, maxNodes = SIPA_MAX_NODES } = {}) {
  const out = [];
  const walk = (b, depth) => {
    let off = 0;
    while (off + 8 <= b.length) {
      if (out.length >= maxNodes) throw new Error("SIPA tree exceeds the node budget");
      const id = b.readUInt32LE(off), size = b.readUInt32LE(off + 4); off += 8;
      if (size > b.length - off) throw new Error("SIPA record overruns its container");
      const value = b.subarray(off, off + size); off += size;
      out.push({ depth, id, name: SIPA[id] || `UNKNOWN_${id.toString(16).padStart(8, "0")}`, value });
      if (SIPA_CONTAINERS.has(id)) {
        if (depth + 1 > maxDepth) throw new Error("SIPA tree too deep");
        walk(value, depth + 1);
      }
    }
    if (off !== b.length) throw new Error("SIPA record truncated");
  };
  walk(toBuf(buf), 0);
  return out;
}

// All SIPA records measured into `pcr`, from events whose digest recomputes ONLY.
export function sipaRecords(events, pcr = 12, alg = TCG_SHA256) {
  const out = [];
  for (const e of events) {
    if (e.type !== EV_EVENT_TAG || e.pcr !== pcr || !digestRecomputes(e, alg)) continue;
    for (const r of sipaWalk(e.data)) out.push({ ...r, event: e.index });
  }
  return out;
}
const scalar = (v) => v.length === 1 ? v[0] : v.length === 2 ? v.readUInt16LE(0) : v.length === 4 ? v.readUInt32LE(0)
                    : (() => { const x = v.readBigUInt64LE(0); return x <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(x) : x; })();
const utf16 = (v) => v.toString("utf16le").replace(/\0+$/, "");
// {name: [values...]} — a field can appear more than once (boot manager and
// winload both measure CODEINTEGRITY, for instance); the verifier requires
// EVERY occurrence to hold the policy value.
export function sipaFields(events, pcr = 12, alg = TCG_SHA256) {
  const fields = new Map();
  for (const r of sipaRecords(events, pcr, alg)) {
    if (SIPA_CONTAINERS.has(r.id)) continue;
    const v = r.value;
    const val = [1, 2, 4, 8].includes(v.length) ? scalar(v) : SIPA_STRINGS.has(r.id) ? utf16(v) : v;
    if (!fields.has(r.name)) fields.set(r.name, []);
    fields.get(r.name).push(val);
  }
  return fields;
}

// The VSM identity public key from the boot log: IDKS signs enclave reports,
// IDK decrypts. Record layout (VSM_IDK_INFO / VSM_IDKS_INFO): alg u32, bits u32,
// exponentSize u32, modulusSize u32, exponent[], modulus[] (big-endian).
export function vsmKey(events, which = "IDKS", alg = TCG_SHA256) {
  const id = which === "IDKS" ? SIPA_VSM_IDKS_INFO : SIPA_VSM_IDK_INFO;
  for (const r of sipaRecords(events, 12, alg)) {
    if (r.id !== id) continue;
    const v = r.value;
    if (v.length < 16) throw new Error(`${SIPA[id]} record truncated`);
    const keyAlg = v.readUInt32LE(0), bits = v.readUInt32LE(4), esz = v.readUInt32LE(8), msz = v.readUInt32LE(12);
    if (!esz || esz > 8 || !msz || msz > 1024 || 16 + esz + msz > v.length) throw new Error(`${SIPA[id]} record malformed`);
    return { alg: keyAlg, bits, exponent: v.subarray(16, 16 + esz), modulus: v.subarray(16 + esz, 16 + esz + msz), event: r.event };
  }
  return null;
}

// PCR 7's EFI_VARIABLE_DRIVER_CONFIG "SecureBoot" variable: 1 = on. Read only
// from an event whose digest recomputes. UEFI_VARIABLE_DATA: guid[16],
// nameLength u64, dataLength u64, name utf16[nameLength], data[dataLength].
export function secureBootFromLog(events, alg = TCG_SHA256) {
  for (const e of events) {
    if (e.pcr !== 7 || e.type !== EV_EFI_VARIABLE_DRIVER_CONFIG || !digestRecomputes(e, alg)) continue;
    const v = e.data;
    if (v.length < 32) continue;
    const nl = v.readBigUInt64LE(16), dl = v.readBigUInt64LE(24);
    if (nl > 256n || dl > BigInt(v.length)) continue;
    const nlen = Number(nl), dlen = Number(dl);
    if (32 + 2 * nlen + dlen > v.length) continue;
    const name = v.subarray(32, 32 + 2 * nlen).toString("utf16le");
    if (name === "SecureBoot") return dlen >= 1 ? v[32 + 2 * nlen] : null;
  }
  return null;
}
export function bootCounterFromLog(events, alg = TCG_SHA256) {
  const v = sipaFields(events, 12, alg).get("BOOTCOUNTER");
  return v && v.length ? v[0] : null;
}

// ---- CLI: node relay/vbs-tcglog.mjs LOG [--dump] ------------------------------
if (process.argv[1] && /vbs-tcglog\.mjs$/.test(process.argv[1])) {
  const file = process.argv[2];
  if (!file) { console.error("usage: vbs-tcglog.mjs LOG [--dump]"); process.exit(2); }
  const { events } = parseTcgLog(fs.readFileSync(file));
  const bad = unhashedEvents(events);
  console.log(`events: ${events.length}  secure boot (PCR7): ${secureBootFromLog(events)}  boot counter: ${bootCounterFromLog(events)}  unrecomputable: ${bad.length ? JSON.stringify(bad) : "none"}`);
  for (const [p, v] of [...replayPcrs(events)].sort((a, b) => a[0] - b[0])) console.log(`  PCR${String(p).padEnd(2)} ${v.toString("hex")}`);
  const dump = process.argv.includes("--dump");
  for (const pcr of [12, 13, 14]) {
    const f = sipaFields(events, pcr);
    for (const k of [...f.keys()].sort()) {
      const vals = f.get(k);
      const s = Buffer.isBuffer(vals[0]) ? `${vals[0].length} bytes${vals.length > 1 ? ` x${vals.length}` : ""}` : vals.map(String).join(", ");
      if (dump || (pcr === 12 && !/^(AUTHENTICODE|FILEPATH|IMAGE|HASHALG|AUTHORITY|MODULE)/.test(k))) console.log(`  PCR${pcr} ${k.padEnd(36)} ${s}`);
    }
  }
  const k = vsmKey(events, "IDKS");
  console.log(k ? `  IDKS: RSA-${k.bits} modulus sha256=${sha256(k.modulus).toString("hex").slice(0, 16)}` : "  no IDKS record");
}
