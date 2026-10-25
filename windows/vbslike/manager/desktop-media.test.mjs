import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateDesktopMedia, desktopMediaScript, checkDesktopMedia, validateWindowsPath,
  MEDIA_ROLES, PAYLOAD_OFFSET, MAX_MEDIA_BYTES,
} from "./desktop-media.mjs";

const GiB = 1024 * 1024 * 1024;
const VM = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
const NAME = "enclave-desk-test";
const NOTES = "enclave-desk-test-notes";
// sizes as in the context candidate; pins and paths are test-local
const config = () => [
  { role: "root", path: "C:\\media\\desk\\root.iso", sha256: "1a".repeat(32), bytes: 564977664, payloadBytes: 564912128, payloadSha256: "de".repeat(32), payloadOffset: 65536 },
  { role: "hashes", path: "C:\\media\\desk\\hashes.iso", sha256: "c1".repeat(32), bytes: 4521984, payloadBytes: 4456448, payloadSha256: "2d".repeat(32), payloadOffset: 65536 },
  { role: "models", path: "C:\\media\\desk\\models.iso", sha256: "dd".repeat(32), bytes: 2566148096, payloadBytes: 2566082560, payloadSha256: "a5".repeat(32), payloadOffset: 65536 },
];
const args = (over = {}) => ({ vmId: VM, name: NAME, notes: NOTES, media: config(), ...over });
const withMedia = (f) => { const c = config(); f(c); return c; };
const result = () => ({
  vmId: VM, name: NAME, notes: NOTES, state: "Off", controllers: 1, hardDisks: 0, nics: 0, bootEntries: 0,
  media: config().map((m, i) => ({ role: m.role, path: m.path, sha256: m.sha256, bytes: m.bytes, controller: 0, location: i, controllerType: "SCSI" })),
});
const withResult = (f) => { const r = result(); f(r); return r; };
const REJECT = /^Error: desktop media:|desktop media:/;

/** Replace every PowerShell single-quoted literal by '' (inside one, '' is the only escape). */
function skeleton(s) {
  let out = "", i = 0;
  while (i < s.length) {
    if (s[i] !== "'") { out += s[i++]; continue; }
    let j = i + 1;
    for (;;) {
      if (j >= s.length) throw new Error("unterminated literal");
      if (s[j] === "'") { if (s[j + 1] === "'") { j += 2; continue; } break; }
      j++;
    }
    out += "''"; i = j + 1;
  }
  return out;
}

test("pure module: no imports, no globals, no side effects on import", async () => {
  const src = readFileSync(new URL("./desktop-media.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^\s*import\b/m);
  assert.doesNotMatch(src, /\brequire\(|\bprocess\.|\bconsole\.|globalThis|Date\.now|Math\.random|setTimeout|\bfetch\(/);
  const a = await import("./desktop-media.mjs?a"), b = await import("./desktop-media.mjs?b");
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  assert.ok(Object.isFrozen(a.MEDIA_ROLES));
  assert.deepEqual([...MEDIA_ROLES], ["root", "hashes", "models"]);
});

test("valid config: owned, deeply frozen, normalized, caller untouched", () => {
  const input = withMedia((c) => { c[0].path = "c:\\media\\desk\\root.iso"; });
  const out = validateDesktopMedia(input);
  assert.ok(Object.isFrozen(out) && out.every(Object.isFrozen));
  assert.notEqual(out, input);
  out.forEach((m, i) => assert.notEqual(m, input[i]));
  assert.equal(out[0].path, "C:\\media\\desk\\root.iso");
  assert.ok(!Object.isFrozen(input) && !Object.isFrozen(input[0]));
  input[1].sha256 = "ff".repeat(32);
  assert.equal(out[1].sha256, "c1".repeat(32));
});

test("structure: exactly three plain records, exact keys, root/hashes/models order", () => {
  const cases = [
    null, {}, "x", config().slice(0, 2), [...config(), config()[0]],
    Object.assign(config(), { extra: 1 }),
    (() => { const c = config(); delete c[1]; return c; })(),
    withMedia((c) => { c[0].extra = 1; }),
    withMedia((c) => { delete c[2].payloadOffset; }),
    withMedia((c) => { c[0][Symbol("s")] = 1; }),
    withMedia((c) => { [c[0], c[1]] = [c[1], c[0]]; }),
    withMedia((c) => { c[1].role = "root"; }),
    withMedia((c) => { c[2].role = "Models"; }),
    withMedia((c) => { c[0] = Object.assign(new (class X {})(), c[0]); }),
    withMedia((c) => { c[0] = Object.create(c[0]); }),
  ];
  for (const c of cases) assert.throws(() => validateDesktopMedia(c), REJECT);
  let reads = 0;
  const g = withMedia((c) => { const v = c[0].sha256; delete c[0].sha256; Object.defineProperty(c[0], "sha256", { enumerable: true, get: () => (reads++, v) }); });
  assert.throws(() => validateDesktopMedia(g), /data property/);
  assert.equal(reads, 0);
});

test("hashes: lowercase, exactly 64 hex, nonzero; no trailing newline or padding", () => {
  for (const bad of ["1A".repeat(32), "1a".repeat(32) + "\n", "\n" + "1a".repeat(31) + "1", " " + "1a".repeat(31) + "1",
    "1a".repeat(31) + "1", "1a".repeat(32) + "0", "0".repeat(64), "g".repeat(64), 1, null, ["1a".repeat(32)]]) {
    assert.throws(() => validateDesktopMedia(withMedia((c) => { c[0].sha256 = bad; })), REJECT);
    assert.throws(() => validateDesktopMedia(withMedia((c) => { c[1].payloadSha256 = bad; })), REJECT);
  }
});

test("sizes: strict integer numbers, fixed offset, alignment, sum, 128 GiB, distinct payloads", () => {
  for (const bad of ["564977664", 564977664n, 564977664.5, NaN, Infinity, -1, 0, true, null, new Number(564977664)])
    assert.throws(() => validateDesktopMedia(withMedia((c) => { c[0].bytes = bad; })), REJECT);
  for (const bad of ["65536", 65536.0001, 4096, 0, null, false])
    assert.throws(() => validateDesktopMedia(withMedia((c) => { c[0].payloadOffset = bad; })), REJECT);
  assert.throws(() => validateDesktopMedia(withMedia((c) => { c[0].payloadBytes += 512; c[0].bytes += 512; })), /multiple of 4096/);
  assert.throws(() => validateDesktopMedia(withMedia((c) => { c[0].bytes += 1; })), /payloadOffset \+ payloadBytes/);
  const edge = withMedia((c) => { c[2].payloadBytes = MAX_MEDIA_BYTES - PAYLOAD_OFFSET; c[2].bytes = MAX_MEDIA_BYTES; });
  assert.equal(validateDesktopMedia(edge)[2].bytes, 128 * GiB);
  assert.throws(() => validateDesktopMedia(withMedia((c) => { c[2].payloadBytes = MAX_MEDIA_BYTES - PAYLOAD_OFFSET + 4096; c[2].bytes = MAX_MEDIA_BYTES + 4096; })), /exceeds/);
  assert.throws(() => validateDesktopMedia(withMedia((c) => { c[2].payloadBytes = MAX_MEDIA_BYTES; c[2].bytes = MAX_MEDIA_BYTES + PAYLOAD_OFFSET; })), /exceeds/);
  assert.throws(() => validateDesktopMedia(withMedia((c) => { c[1].payloadBytes = c[0].payloadBytes; c[1].bytes = c[0].bytes; })), /distinct/);
});

test("paths: local drive-letter only; UNC, device, ADS, wildcards, controls, dots, aliases refused", () => {
  const bads = [
    "\\\\server\\share\\root.iso", "\\\\?\\C:\\media\\root.iso", "\\\\.\\C:\\media\\root.iso", "\\??\\C:\\root.iso",
    "C:root.iso", "media\\root.iso", "C:/media/root.iso", "C:\\media/root.iso",
    "C:\\media\\root.iso:evil", "C:\\media\\root.iso::$DATA", "C:\\media:s\\root.iso",
    "C:\\media\\*.iso", "C:\\media\\ro?t.iso", "C:\\media\\[r]oot.iso", "C:\\media\\`root.iso", "C:\\me\"dia\\root.iso", "C:\\a|b\\root.iso",
    "C:\\media\\ro\x01ot.iso", "C:\\media\\ro\tot.iso", "C:\\media\\root.iso\n", "C:\\media\\ro\x7fot.iso", "C:\\médïa\\root.iso", "C:\\media\\root\u2019.iso",
    "C:\\media.\\root.iso", "C:\\media \\root.iso", "C:\\media\\root.iso.", "C:\\media\\root.iso ", "C:\\ media\\root.iso",
    "C:\\media\\..\\root.iso", "C:\\media\\.\\root.iso", "C:\\media\\\\root.iso", "C:\\media\\", "C:\\",
    "C:\\NUL\\root.iso", "C:\\media\\CON.iso", "C:\\media\\com1.iso", "C:\\media\\ROOT~1.ISO",
    "C:\\media\\root.img", "C:\\" + "a\\".repeat(130) + "r.iso", 7, null,
  ];
  for (const p of bads) {
    assert.throws(() => validateWindowsPath(p), REJECT, JSON.stringify(p));
    assert.throws(() => validateDesktopMedia(withMedia((c) => { c[1].path = p; })), REJECT, JSON.stringify(p));
  }
  assert.equal(validateWindowsPath("d:\\Media Files\\it's (v2)\\root.ISO"), "D:\\Media Files\\it's (v2)\\root.ISO");
});

test("duplicate files are refused, case-insensitively", () => {
  assert.throws(() => validateDesktopMedia(withMedia((c) => { c[1].path = c[0].path; })), /same file/);
  assert.throws(() => validateDesktopMedia(withMedia((c) => { c[2].path = "c:\\MEDIA\\Desk\\ROOT.iso"; })), /same file/);
});

test("script: invalid identity or arguments throw before any script exists", () => {
  for (const over of [
    { vmId: "8d4e9390-13b4-450a-9df6-557b906f386" }, { vmId: "{" + VM + "}" }, { vmId: VM + "\n" }, { vmId: "00000000-0000-0000-0000-000000000000" }, { vmId: 1 },
    { name: "" }, { name: "a\nb" }, { name: "a\rb" }, { name: "x\u0000" }, { name: " lead" }, { name: "trail " }, { name: "n\u2019q" }, { name: "x".repeat(101) }, { name: null },
    { notes: "" }, { notes: "a\tb" }, { notes: "a\u2028b" }, { notes: 5 },
    { media: withMedia((c) => { c[0].path = "\\\\host\\share\\root.iso"; }) },
    { extra: true },
  ]) assert.throws(() => desktopMediaScript(args(over)), REJECT, JSON.stringify(over));
  assert.throws(() => desktopMediaScript({ vmId: VM, name: NAME, notes: NOTES }), REJECT);
});

test("script: quoting holds; injected values never change the code skeleton", () => {
  const base = skeleton(desktopMediaScript(args()));
  const evil = "x'; Hyper-V\\Start-VM -Id $vmId; '$(Remove-Item C:\\)`n";
  const paths = withMedia((c) => { c[0].path = "C:\\it's here\\x'; Start-VM a; '\\root.iso"; });
  const s = desktopMediaScript(args({ name: evil, notes: "n'" + evil, media: paths }));
  assert.equal(skeleton(s), base);
  assert.ok(s.includes("$name = 'x''; Hyper-V\\Start-VM -Id $vmId; ''$(Remove-Item C:\\)`n';"));
  assert.ok(s.includes("path = 'C:\\it''s here\\x''; Start-VM a; ''\\root.iso';"));
  assert.ok(desktopMediaScript(args({ vmId: VM.toUpperCase() })).includes(`$vmId = '${VM}';`));
  assert.match(s, /^[\t\n\x20-\x7e]*$/);
  assert.ok(s.length < 11500, `script is ${s.length} chars; -EncodedCommand must fit 32767`);
});

test("script: every pin is prechecked before Add-VMScsiController, and nothing mutates before it", () => {
  const s = desktopMediaScript(args());
  const k = skeleton(s);
  const add = k.indexOf("Hyper-V\\Add-VMScsiController -VM $vm");
  assert.ok(add > 0);
  assert.equal(k.split("Add-VMScsiController").length, 2, "exactly one Add-VMScsiController");
  const before = k.slice(0, add);
  assert.doesNotMatch(before, /\b(Add|Set|Remove|Start|Stop|Update|Mount|Connect|Rename|Move|Grant)-VM|icacls|Copy-Item|New-Item/i);
  const sAdd = s.indexOf("Hyper-V\\Add-VMScsiController");
  for (const m of config()) for (const pin of [m.sha256, m.payloadSha256, `[int64]${m.bytes}`, `[int64]${m.payloadBytes}`])
    assert.ok(s.indexOf(pin) > -1 && s.indexOf(pin) < sAdd, pin);
  const pre = k.indexOf("foreach ($m in $media) { $null = DmFile $m };");
  assert.ok(pre > -1 && pre < add, "all three files checked before the first mutation");
  assert.ok(k.indexOf("$phase = ''", pre) < add, "phase flips to after-mutation just before the first change");
  const body = k.slice(k.indexOf("function DmFile"), k.indexOf("$phase = ''"));
  for (const want of ["DmSame $pin.sha $m.sha", "DmSame $pin.payloadSha $m.payloadSha", "($pin.length -ne $m.bytes)", "($pin.read -ne $m.bytes)",
    "[System.IO.FileAttributes]::ReparsePoint", "$d = $d.Parent", "[System.IO.DriveType]::Fixed", "DmSameI $fi.FullName $p"])
    assert.ok(body.includes(want), want);
  assert.ok(k.indexOf("$pins.Add((DmFile $m))") > add, "pins are rechecked after attaching");
  assert.ok(k.indexOf("DmBare $vm;") < add && k.lastIndexOf("DmBare $vm;") < add);
});

test("script: narrow scope, exact VM, no incidental output", () => {
  const k = skeleton(desktopMediaScript(args()));
  for (const f of [/Start-VM/, /Stop-VM/, /Remove-/, /Set-VM/, /FirstBootDevice/, /HKLM|Registry|ItemProperty|\breg(\.exe)?\s/i, /master/i,
    /Invoke-Expression|\biex\b|EncodedCommand/i, /-VMName\b|-Name\b/, /Add-VMHardDiskDrive|Add-VMNetworkAdapter/, /Write-Host|Write-Output/, /"/])
    assert.doesNotMatch(k, f, String(f));
  assert.equal(k.match(/Get-VM\b/g).length, k.match(/Hyper-V\\Get-VM -Id \$vmId\)/g).length);
  for (const line of k.split("\n").filter((l) => /\bAdd-VM|icacls \$m/.test(l))) assert.match(line, /\| Out-Null/);
  assert.ok(k.includes("& $icacls $m.path /grant $grant | Out-Null;") && k.includes("if ($LASTEXITCODE -ne 0)"));
  assert.ok(k.includes("[System.Environment]::SystemDirectory"));
  for (let i = 0; i < 3; i++) assert.ok(!k.includes(`-ControllerLocation ${i}`));
  assert.ok(k.includes("-ControllerNumber 0 -ControllerLocation $i -Path $media[$i].path"));
  assert.ok(k.includes("DmSame ([string]$d.ControllerType) ''") && k.includes("DmSame ([string]$v.State) ''"));
  assert.doesNotMatch(k, /\$v\.(Name|Notes) -(i|c)?ne\b/, "identity compares are ordinal, not -ne");
  assert.ok(k.trimEnd().endsWith("\n$json"));
  assert.ok(k.startsWith("$ErrorActionPreference = '';"));
});

test("check: the exact readback passes, from JSON text or object", () => {
  const ok = checkDesktopMedia(JSON.stringify(result()) + "\r\n", args());
  assert.ok(Object.isFrozen(ok) && Object.isFrozen(ok.media) && ok.media.every(Object.isFrozen));
  assert.deepEqual(ok, result());
  const ci = withResult((r) => { r.vmId = VM.toUpperCase(); r.media[1].path = r.media[1].path.toUpperCase(); });
  assert.equal(checkDesktopMedia(ci, args()).vmId, VM);
});

test("check: identity, state, counts and media are compared strictly", () => {
  const notZero = [false, null, "", "0", 0n, [], -1, 1, 0.5];
  const cases = [
    "", "not json", JSON.stringify(result()) + "x", "{}", "[]", "null", JSON.stringify(result()) + "\n{}",
    withResult((r) => { r.extra = 1; }), withResult((r) => { r.hostProtected = true; }), withResult((r) => { delete r.nics; }),
    withResult((r) => { r.vmId = "1f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0"; }), withResult((r) => { r.vmId = "{" + VM + "}"; }),
    withResult((r) => { r.name = NAME.toUpperCase(); }), withResult((r) => { r.name = NAME + " "; }), withResult((r) => { r.notes = NOTES + "x"; }),
    withResult((r) => { r.state = "Running"; }), withResult((r) => { r.state = "off"; }), withResult((r) => { r.state = 3; }),
    ...[2, 0, "1", true, null].map((v) => withResult((r) => { r.controllers = v; })),
    ...["hardDisks", "nics", "bootEntries"].flatMap((k) => notZero.map((v) => withResult((r) => { r[k] = v; }))),
    withResult((r) => { r.media.pop(); }), withResult((r) => { r.media.push(r.media[0]); }), withResult((r) => { r.media = {}; }),
    withResult((r) => { [r.media[0], r.media[1]] = [r.media[1], r.media[0]]; }),
    withResult((r) => { r.media[0].location = 1; r.media[1].location = 0; }),
    withResult((r) => { r.media[2].location = "2"; }), withResult((r) => { r.media[0].location = null; }), withResult((r) => { r.media[0].location = false; }),
    withResult((r) => { r.media[1].controller = 1; }), withResult((r) => { r.media[1].controller = null; }), withResult((r) => { r.media[1].controller = "0"; }),
    withResult((r) => { r.media[0].controllerType = "IDE"; }), withResult((r) => { r.media[0].controllerType = "scsi"; }),
    withResult((r) => { r.media[0].path = "C:\\media\\desk\\hashes.iso"; }), withResult((r) => { r.media[0].path = "C:\\media\\des\u212A\\root.iso"; }),
    withResult((r) => { r.media[0].path = null; }),
    withResult((r) => { r.media[0].sha256 = "1A".repeat(32); }), withResult((r) => { r.media[2].sha256 = "ee".repeat(32); }),
    withResult((r) => { r.media[0].bytes = String(r.media[0].bytes); }), withResult((r) => { r.media[0].bytes += 1; }),
    withResult((r) => { r.media[0].role = "hashes"; }), withResult((r) => { r.media[0].immutable = true; }), withResult((r) => { delete r.media[0].controllerType; }),
  ];
  for (const c of cases) assert.throws(() => checkDesktopMedia(c, args()), REJECT, typeof c === "string" ? c : JSON.stringify(c, (_, v) => typeof v === "bigint" ? String(v) + "n" : v));
  assert.throws(() => checkDesktopMedia(result(), args({ media: config().slice(0, 2) })), REJECT);
  assert.throws(() => checkDesktopMedia(result(), args({ name: "other" })), /name differs/);
});


test("script rejects actual oversized media before hashing and bounds the read", () => {
  const s = desktopMediaScript(args());
  assert.ok(s.indexOf("if ($fi.Length -ne [int64]$m.bytes)") < s.indexOf("$pin = DmPin $m;"));
  assert.ok(s.indexOf("if ($fs.Length -ne [int64]$m.bytes)") < s.indexOf("$whole = [System.Security.Cryptography.SHA256]::Create();"));
  assert.match(s, /while \(\$pos -lt \$len\)/);
  assert.match(s, /\$fs.ReadByte\(\)/);
});
