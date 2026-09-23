// The TCB half of SNP verification: product-line layouts, the KDS lookup, the VCEK <-> report match,
// and the CALLER's minimum-TCB policy.
//
// The TCB_VERSION bytes mean different things per product line (Turin: FMC, BL, TEE, SNP, ...;
// Milan/Genoa: BL, TEE, reserved, SNP, ...), and Turin's KDS hardware ID is the first 8 bytes of
// CHIP_ID. Both verifiers read every report as Milan and sent all 64 bytes, so a Turin box's VCEK was
// never found and the chip was recorded as "no VCEK at KDS" (warden-host, EPYC 9115). The first case
// below pins the lookup that KDS answers for that very chip.
//
// Policy rules under test: nothing here picks a firmware floor; an omitted policy leaves the TCB
// unjudged and says so; a supplied policy must be complete and well formed and must be evaluable, or
// the quote fails.
//
//   run: node --test test/snp-tcb-policy.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { decodeTcb, snpProductHint, kdsVcekUrl, vcekMatchesReport, checkMinTcb, parseSnpReport, verifyQuote }
  from "../relay/snp-verify.mjs";

// the TCB_VERSION and CHIP_ID warden-host's EPYC 9115 reports (Turin: fmc 1, bl 3, tee 2, snp 5, ucode 0x75)
const TURIN_TCB = Buffer.from("0103020500000075", "hex");
const TURIN_HWID = Buffer.from("fa11afcf54ae9c53", "hex");
const MEAS = "22".repeat(48), SPKI = randomBytes(91), NONCE = randomBytes(32);

function report({ tcb = TURIN_TCB, fam = 0x1a, mod = 0x02, version = 5, chip = Buffer.concat([TURIN_HWID, Buffer.alloc(56)]) } = {}) {
  const r = Buffer.alloc(0x4a0);
  r.writeUInt32LE(version, 0x00);
  r.writeBigUInt64LE(0x30000n, 0x08);
  createHash("sha256").update(Buffer.concat([SPKI, NONCE])).digest().copy(r, 0x50);
  Buffer.from(MEAS, "hex").copy(r, 0x90);
  tcb.copy(r, 0x180);
  r[0x188] = fam; r[0x189] = mod; r[0x18a] = 1;
  chip.copy(r, 0x1a0);
  return r;
}
const TURIN_FLOOR = { fmc: 1, bootloader: 3, tee: 2, snp: 5, microcode: 117 };

// Self-signed certs carrying chosen AMD extensions, the way KDS encodes them: each SPL an INTEGER in the
// extnValue, the hardware ID raw bytes.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
function cert(exts) {
  const f = `${tmp}/c${n++}`;
  const args = ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:secp384r1", "-nodes",
    "-keyout", `${f}.key`, "-out", `${f}.pem`, "-days", "1", "-subj", "/CN=SEV-VCEK", "-outform", "PEM"];
  for (const [oid, der] of Object.entries(exts)) args.push("-addext", `${oid}=DER:${der.toString("hex").match(/../g).join(":")}`);
  execFileSync("openssl", args, { stdio: "ignore" });
  return Buffer.from(fs.readFileSync(`${f}.pem`, "utf8").replace(/-----[^-]+-----|\s/g, ""), "base64");
}
const AMD = "1.3.6.1.4.1.3704.1";
const int = (v) => Buffer.from([0x02, 0x01, v]);
const turinExts = (over = {}) => ({ [`${AMD}.3.9`]: int(1), [`${AMD}.3.1`]: int(3), [`${AMD}.3.2`]: int(2), [`${AMD}.3.3`]: int(5),
  [`${AMD}.3.8`]: int(0x75), [`${AMD}.4`]: TURIN_HWID, ...over });

test("TCB bytes decode by product line, and the report's CPUID names the line", () => {
  assert.deepEqual(decodeTcb("Turin", TURIN_TCB), TURIN_FLOOR);
  assert.deepEqual(decodeTcb("Milan", TURIN_TCB), { bootloader: 1, tee: 3, snp: 0, microcode: 117 },
    "the same bytes read as Milan: the misreading both verifiers made");
  const p = (fam, mod, version = 5) => parseSnpReport(report({ fam, mod, version }));
  assert.equal(snpProductHint(p(0x1a, 0x02)), "Turin");
  assert.equal(snpProductHint(p(0x19, 0x01)), "Milan");
  assert.equal(snpProductHint(p(0x19, 0x11)), "Genoa");
  assert.equal(snpProductHint(p(0x19, 0xa0)), "Genoa");
  assert.equal(snpProductHint(p(0x17, 0x31)), null);
  assert.equal(snpProductHint(p(0x1a, 0x02, 2)), null, "version 2 reports carry no CPUID fields");
});

test("the KDS lookup: Turin uses an 8-byte hardware ID and five SPLs, Milan/Genoa 64 bytes and four", () => {
  const p = parseSnpReport(report());
  assert.equal(kdsVcekUrl("Turin", p),
    "https://kdsintf.amd.com/vcek/v1/Turin/fa11afcf54ae9c53?fmcSPL=01&blSPL=03&teeSPL=02&snpSPL=05&ucodeSPL=117");
  const m = parseSnpReport(report({ tcb: Buffer.from("0300000000000873", "hex"), fam: 0x19, mod: 0x01, chip: Buffer.alloc(64, 0xab) }));
  assert.equal(kdsVcekUrl("Milan", m), `https://kdsintf.amd.com/vcek/v1/Milan/${"ab".repeat(64)}?blSPL=3&teeSPL=0&snpSPL=8&ucodeSPL=115`);
});

test("a VCEK must name the report's chip and exact reported TCB; anything missing is a mismatch", () => {
  const p = parseSnpReport(report());
  assert.equal(vcekMatchesReport(cert(turinExts()), "Turin", p), null);
  assert.match(vcekMatchesReport(cert(turinExts({ [`${AMD}.3.3`]: int(6) })), "Turin", p), /snp SPL 6 does not match .* 5/);
  const noFmc = turinExts(); delete noFmc[`${AMD}.3.9`];
  assert.match(vcekMatchesReport(cert(noFmc), "Turin", p), /no fmc SPL extension/);
  assert.match(vcekMatchesReport(cert(turinExts({ [`${AMD}.4`]: Buffer.from("0000000000000001", "hex") })), "Turin", p), /hardware ID does not match/);
  const noHw = turinExts(); delete noHw[`${AMD}.4`];
  assert.match(vcekMatchesReport(cert(noHw), "Turin", p), /no hardware-ID extension/);
  // a hardware ID wrapped as a DER OCTET STRING is the same ID
  assert.equal(vcekMatchesReport(cert(turinExts({ [`${AMD}.4`]: Buffer.concat([Buffer.from([0x04, 8]), TURIN_HWID]) })), "Turin", p), null);
  // Milan/Genoa: the full 64-byte chip ID, and no FMC
  const chip = randomBytes(64);
  const m = parseSnpReport(report({ tcb: Buffer.from("0300000000000873", "hex"), fam: 0x19, mod: 0x01, chip }));
  const milan = { [`${AMD}.3.1`]: int(3), [`${AMD}.3.2`]: int(0), [`${AMD}.3.3`]: int(8), [`${AMD}.3.8`]: int(0x73), [`${AMD}.4`]: chip };
  assert.equal(vcekMatchesReport(cert(milan), "Milan", m), null);
  assert.match(vcekMatchesReport(cert({ ...milan, [`${AMD}.4`]: chip.subarray(0, 8) }), "Milan", m), /8 bytes, Milan uses 64/);
});

test("the minimum-TCB policy: omitted = unjudged and said so; supplied = complete, well formed, evaluable", () => {
  const p = parseSnpReport(report());
  let r = checkMinTcb(undefined, "Turin", p);
  assert.equal(r.ok, true); assert.equal(r.checked, false); assert.match(r.reason, /NOT judged/);
  r = checkMinTcb({ Turin: TURIN_FLOOR }, "Turin", p);
  assert.equal(r.ok, true); assert.equal(r.checked, true);
  for (const [k, v] of Object.entries(TURIN_FLOOR)) {
    r = checkMinTcb({ Turin: { ...TURIN_FLOOR, [k]: v + 1 } }, "Turin", p);
    assert.equal(r.ok, false, `${k} one above the report must fail`); assert.match(r.reason, new RegExp(`below policy: Turin ${k}`));
  }
  const malformed = [null, [], "{}", {}, { Rome: {} }, { Turin: { ...TURIN_FLOOR, fmc: undefined } },
    { Turin: { bootloader: 3, tee: 2, snp: 5, microcode: 117 } },                   // incomplete: no floor is filled in
    { Turin: { ...TURIN_FLOOR, snp: 5.5 } }, { Turin: { ...TURIN_FLOOR, snp: 256 } }, { Turin: { ...TURIN_FLOOR, extra: 1 } }];
  for (const m of malformed) {
    r = checkMinTcb(m, "Turin", p);
    assert.equal(r.ok, false, `${JSON.stringify(m)} must be refused`); assert.match(r.reason, /malformed/);
  }
  r = checkMinTcb({ Genoa: { bootloader: 0, tee: 0, snp: 0, microcode: 0 } }, "Turin", p);
  assert.equal(r.ok, false); assert.match(r.reason, /no floor for Turin/);
  r = checkMinTcb({ Turin: TURIN_FLOOR }, null, p);
  assert.equal(r.ok, false); assert.match(r.reason, /product line is unknown/);
});

test("verifyQuote applies the policy even without a VCEK, and never turns missing data into a pass", async () => {
  const realFetch = globalThis.fetch;
  let kds = 0;
  globalThis.fetch = async () => { kds++; return new Response("", { status: 404 }); };
  try {
    const v = (r, minTcb) => verifyQuote(r, { challenge: NONCE, transportKeySpki: SPKI, allowedMeasurements: [MEAS], requireVcek: false, minTcb });
    let res = await v(report(), undefined);
    assert.equal(res.ok, true); assert.equal(res.vcekVerified, false); assert.equal(res.tcb.checked, false);
    assert.match(res.reasons.at(-1), /NOT judged/);
    res = await v(report(), { Turin: TURIN_FLOOR });
    assert.equal(res.ok, true); assert.equal(res.tcb.checked, true); assert.match(res.reasons.at(-1), /unauthenticated: no VCEK/);
    res = await v(report(), { Turin: { ...TURIN_FLOOR, microcode: 118 } });
    assert.equal(res.ok, false); assert.match(res.reasons.at(-1), /below policy: Turin microcode 117 < 118/);
    res = await v(report({ version: 2 }), { Turin: TURIN_FLOOR });
    assert.equal(res.ok, false, "a report that names no product line cannot meet a policy"); assert.match(res.reasons.at(-1), /product line is unknown/);
    res = await v(report(), "not json");
    assert.equal(res.ok, false); assert.match(res.reasons.at(-1), /malformed/);
    // with requireVcek the missing chain still refuses first
    res = await verifyQuote(report(), { challenge: NONCE, transportKeySpki: SPKI, allowedMeasurements: [MEAS], minTcb: { Turin: TURIN_FLOOR } });
    assert.equal(res.ok, false); assert.match(res.reasons.at(-1), /no VCEK available/);
    assert.ok(kds > 0, "the lookup went to (stubbed) KDS");
  } finally { globalThis.fetch = realFetch; }
});
