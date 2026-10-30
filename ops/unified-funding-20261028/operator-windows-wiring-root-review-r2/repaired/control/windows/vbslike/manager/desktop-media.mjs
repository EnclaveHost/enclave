/* ============================================================
   NATIVE DESKTOP MEDIA: the three-ISO attachment contract, extracted from the qualified attach.ps1.

   A desktop partition boots from the pinned IGVM and reads three ISOs on SCSI controller 0:
   root (slot 0), hashes (slot 1), models (slot 2). Each ISO carries a 64 KiB header and then a
   4096-aligned payload. The guest tells the three apart BY PAYLOAD SIZE, so the sizes must differ.

   This module is pure: it validates a config, generates ONE PowerShell script and checks that
   script's JSON readback. It executes nothing, reads no files and imports nothing.

   WHAT IT DOES NOT CLAIM. Host-side hashes are attach-time readbacks. They are not host
   protection, and the files are not immutable: the host can change them after the check. The
   measured guest verity (dm-verity roots in the profile) is what decides what the guest trusts.

   FAILURE AND TEARDOWN. The script changes nothing until every check has passed: VM identity,
   Off state, no devices, and all three files (regular, not reparse points, lengths, sha256 and
   payload sha256). After its first change it does not undo anything. Any failure message starts
   with "desktop-media after-mutation", and from then on THE CALLER OWNS TEARDOWN, BY THE EXACT VM ID.
   It never deletes, starts the VM, sets the boot order, or touches the registry or the guest-state master.
   ============================================================ */

export const MEDIA_ROLES = Object.freeze(["root", "hashes", "models"]);
export const PAYLOAD_OFFSET = 65536;
export const PAYLOAD_ALIGN = 4096;
export const MAX_MEDIA_BYTES = 128 * 1024 * 1024 * 1024;
export const MEDIA_KEYS = Object.freeze(["role", "path", "sha256", "bytes", "payloadBytes", "payloadSha256", "payloadOffset"]);
export const RESULT_KEYS = Object.freeze(["vmId", "name", "notes", "state", "controllers", "hardDisks", "nics", "bootEntries", "media"]);
export const RESULT_MEDIA_KEYS = Object.freeze(["role", "path", "sha256", "bytes", "controller", "location", "controllerType"]);
const ARG_KEYS = ["vmId", "name", "notes", "media"];

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{64}$/;
const PRINTABLE = /^[\x20-\x7e]+$/;
// \ : / are separators or streams; * ? [ ] ` are wildcards (Win32 or PowerShell); " < > | are invalid in Win32 names
const PATH_FORBIDDEN = /[\/:*?"<>|\[\]`]/;
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$|clock\$)(\..*)?$/i;
const MAX_PATH = 259;
const MAX_NAME = 100;
const MAX_NOTES = 4096;

function bad(msg) { throw new Error(`desktop media: ${msg}`); }

/** Own data properties only, exactly `keys`, read once each (no getters run, no inherited fields). */
function exactRecord(v, keys, what) {
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

function exactArray(v, n, what) {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) bad(`${what} must be a plain array`);
  const want = [...Array.from({ length: n }, (_, i) => String(i)), "length"];
  const own = Reflect.ownKeys(v);
  if (own.length !== want.length || !want.every((k) => own.includes(k)))
    bad(`${what} must be an array of exactly ${n} entries, with no holes or extra properties`);
  return want.slice(0, n).map((k) => {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !("value" in d)) bad(`${what}[${k}] must be a data element`);
    return d.value;
  });
}

function sha(v, what) {
  if (typeof v !== "string" || v.length !== 64 || !SHA_RE.test(v) || /^0+$/.test(v))
    bad(`${what} must be 64 lowercase hex digits, not all zero`);
  return v;
}

function posInt(v, what) {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) bad(`${what} must be a positive integer number`);
  return v;
}

function exactNumber(v, want, what) {
  if (typeof v !== "number" || !Object.is(v, want)) bad(`${what} must read back as the number ${want}`);
}

/**
 * A fully qualified path on a local drive letter, in one canonical spelling, so that a
 * case-insensitive comparison of two accepted paths is an exact identity test.
 * Printable ASCII only: no Unicode case folding and no smart quotes (PowerShell treats U+2018/2019 as quotes).
 * The drive letter is uppercased. Locality (fixed drive) and reparse points are checked by the script on the host.
 */
export function validateWindowsPath(p, what = "path") {
  if (typeof p !== "string" || p.length < 4 || p.length > MAX_PATH) bad(`${what} must be a string of 4..${MAX_PATH} characters`);
  if (!PRINTABLE.test(p)) bad(`${what} must be printable ASCII (no control or non-ASCII characters)`);
  if (!/^[A-Za-z]:\\/.test(p)) bad(`${what} must be a fully qualified drive-letter path such as C:\\dir\\file.iso (no UNC, device or relative path)`);
  const rest = p.slice(3);
  if (PATH_FORBIDDEN.test(rest)) bad(`${what} has a forward slash, colon (alternate data stream), wildcard or reserved character`);
  const segs = rest.split("\\");
  for (const s of segs) {
    if (s === "" ) bad(`${what} has an empty segment (doubled or trailing backslash)`);
    if (s === "." || s === "..") bad(`${what} has a dot segment`);
    if (/[. ]$/.test(s) || /^ /.test(s)) bad(`${what} has a segment with a leading space or a trailing dot or space`);
    if (DEVICE_NAME.test(s)) bad(`${what} names a reserved device (${s})`);
    if (/~[0-9]/.test(s)) bad(`${what} looks like an 8.3 short name (${s}), which can alias another file`);
  }
  if (!/\.iso$/i.test(segs[segs.length - 1])) bad(`${what} must name an .iso file`);
  return p[0].toUpperCase() + p.slice(1);
}

function text(v, what, max) {
  if (typeof v !== "string" || v.length === 0 || v.length > max) bad(`${what} must be a non-empty string of at most ${max} characters`);
  if (!PRINTABLE.test(v)) bad(`${what} must be printable ASCII (no control characters)`);
  if (v.trim() !== v) bad(`${what} must not start or end with whitespace`);
  return v;
}

function vmGuid(v) {
  if (typeof v !== "string" || !GUID_RE.test(v)) bad("vmId must be a canonical GUID (8-4-4-4-12 hex)");
  const id = v.toLowerCase();
  if (/^[0-]+$/.test(id)) bad("vmId must not be the nil GUID");
  return id;
}

/**
 * -> an owned, deeply frozen copy of the three-media config. Shares no objects with the caller.
 * Throws on anything outside the contract; nothing is coerced.
 */
export function validateDesktopMedia(config) {
  const items = exactArray(config, MEDIA_ROLES.length, "config");
  const seen = new Set();
  const out = items.map((raw, i) => {
    const e = exactRecord(raw, MEDIA_KEYS, `config[${i}]`);
    const role = MEDIA_ROLES[i];
    if (e.role !== role) bad(`config[${i}].role must be ${JSON.stringify(role)} (the order is ${MEDIA_ROLES.join(", ")})`);
    const path = validateWindowsPath(e.path, `config[${i}].path`);
    const key = path.toLowerCase();
    if (seen.has(key)) bad(`config[${i}].path names the same file as another medium (paths compare case-insensitively)`);
    seen.add(key);
    const sha256 = sha(e.sha256, `config[${i}].sha256`);
    const payloadSha256 = sha(e.payloadSha256, `config[${i}].payloadSha256`);
    const bytes = posInt(e.bytes, `config[${i}].bytes`);
    const payloadBytes = posInt(e.payloadBytes, `config[${i}].payloadBytes`);
    const payloadOffset = posInt(e.payloadOffset, `config[${i}].payloadOffset`);
    if (payloadOffset !== PAYLOAD_OFFSET) bad(`config[${i}].payloadOffset must be ${PAYLOAD_OFFSET}`);
    if (payloadBytes % PAYLOAD_ALIGN !== 0) bad(`config[${i}].payloadBytes must be a multiple of ${PAYLOAD_ALIGN}`);
    if (payloadBytes > MAX_MEDIA_BYTES || bytes > MAX_MEDIA_BYTES) bad(`config[${i}] exceeds ${MAX_MEDIA_BYTES} bytes`);
    if (bytes !== payloadOffset + payloadBytes) bad(`config[${i}].bytes must equal payloadOffset + payloadBytes`);
    return Object.freeze({ role, path, sha256, bytes, payloadBytes, payloadSha256, payloadOffset });
  });
  if (new Set(out.map((m) => m.payloadBytes)).size !== out.length)
    bad("payload sizes must be distinct: the guest classifies the media by size");
  return Object.freeze(out);
}

function launchArgs(args, fn) {
  const a = exactRecord(args, ARG_KEYS, `${fn} arguments`);
  return {
    vmId: vmGuid(a.vmId),
    name: text(a.name, "name", MAX_NAME),
    notes: text(a.notes, "notes", MAX_NOTES),
    media: validateDesktopMedia(a.media),
  };
}

/** PowerShell single-quoted literal. Inputs are printable ASCII, so ' is the only quote character to double. */
function q(v) { return "'" + v.replace(/'/g, "''") + "'"; }

// Static part of the script: no interpolation, so nothing a caller passes can reach it.
// Windows PowerShell 5.1. Hyper-V cmdlets are module-qualified so another module's Get-VM cannot shadow them.
// Counts go through @() or DmCount (@($null).Count is 1). Integer readbacks are type-checked, never cast from $null.
const BODY = String.raw`function DmIsInt($x, [int64]$want) {
  if ($null -eq $x) { return $false };
  if (-not (($x -is [int32]) -or ($x -is [int64]) -or ($x -is [int16]) -or ($x -is [byte]) -or ($x -is [uint16]) -or ($x -is [uint32]))) { return $false };
  return ([int64]$x -eq $want)
};
function DmCount($x) { if ($null -eq $x) { return 0 }; return @($x).Count };
function DmSame([string]$a, [string]$b) { return [string]::Equals($a, $b, [System.StringComparison]::Ordinal) };
function DmSameI([string]$a, [string]$b) { return [string]::Equals($a, $b, [System.StringComparison]::OrdinalIgnoreCase) };
function DmHex([byte[]]$h) { return ([System.BitConverter]::ToString($h) -replace '-', '').ToLowerInvariant() };
function DmVm {
  $all = @(Hyper-V\Get-VM -Id $vmId);
  if ($all.Count -ne 1) { throw ('Get-VM -Id returned ' + $all.Count + ' VMs, not exactly one') };
  $v = $all[0];
  if (-not (DmSameI ($v.Id.ToString('D')) $vmId)) { throw 'VM id reads back differently' };
  if (-not (DmSame ([string]$v.Name) $name)) { throw 'VM name reads back differently' };
  if (-not (DmSame ([string]$v.Notes) $notes)) { throw 'VM notes read back differently' };
  if (-not (DmSame ([string]$v.State) 'Off')) { throw ('VM state is ' + [string]$v.State + ', not Off') };
  if (-not (DmIsInt $v.Generation 2)) { throw 'VM is not generation 2' };
  return $v
};
function DmDevices($v) {
  $fw = @(Hyper-V\Get-VMFirmware -VM $v);
  if ($fw.Count -ne 1) { throw 'Get-VMFirmware did not return exactly one firmware object' };
  $boot = 0;
  if ($null -ne $fw[0].BootOrder) { $boot = @($fw[0].BootOrder).Count };
  return [ordered]@{ controllers = (DmCount (Hyper-V\Get-VMScsiController -VM $v)); hardDisks = (DmCount (Hyper-V\Get-VMHardDiskDrive -VM $v)); dvds = (DmCount (Hyper-V\Get-VMDvdDrive -VM $v)); nics = (DmCount (Hyper-V\Get-VMNetworkAdapter -VM $v)); bootEntries = $boot }
};
function DmBare($v) {
  $dev = DmDevices $v;
  foreach ($k in @('controllers', 'hardDisks', 'dvds', 'nics', 'bootEntries')) { if ($dev[$k] -ne 0) { throw ('the VM must start with no ' + $k + ', found ' + $dev[$k]) } }
};
function DmAttached($v) {
  $dev = DmDevices $v;
  if (($dev.controllers -ne 1) -or ($dev.dvds -ne 3) -or ($dev.hardDisks -ne 0) -or ($dev.nics -ne 0) -or ($dev.bootEntries -ne 0)) { throw ('devices read back as ' + (ConvertTo-Json -InputObject $dev -Compress) + ', not one SCSI controller and three DVDs only') };
  $ctl = @(Hyper-V\Get-VMScsiController -VM $v);
  if (-not (DmIsInt $ctl[0].ControllerNumber 0)) { throw 'the SCSI controller is not controller 0' };
  return $dev
};
function DmPin($m) {
  $fs = [System.IO.File]::Open($m.path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read);
  try {
    if ($fs.Length -ne [int64]$m.bytes) { throw ('the ' + $m.role + ' medium length differs before hashing') };
    $whole = [System.Security.Cryptography.SHA256]::Create();
    $tail = [System.Security.Cryptography.SHA256]::Create();
    $buf = New-Object byte[] 1048576;
    $off = [int64]$m.payloadOffset; $pos = [int64]0; $len = [int64]$fs.Length;
    while ($pos -lt $len) {
      $want = [int][Math]::Min([int64]$buf.Length, [int64]($len - $pos));
      if ($pos -lt $off) { $want = [int]($off - $pos) };
      $n = $fs.Read($buf, 0, $want);
      if ($n -le 0) { break };
      [void]$whole.TransformBlock($buf, 0, $n, $null, 0);
      if ($pos -ge $off) { [void]$tail.TransformBlock($buf, 0, $n, $null, 0) };
      $pos += $n
    };
    if ($pos -ne $len -or $fs.ReadByte() -ne -1) { throw 'medium size changed while hashing' };
    [void]$whole.TransformFinalBlock($buf, 0, 0);
    [void]$tail.TransformFinalBlock($buf, 0, 0);
    return [ordered]@{ length = $len; read = $pos; sha = (DmHex $whole.Hash); payloadSha = (DmHex $tail.Hash) }
  } finally {
    $fs.Dispose();
    if (Test-Path variable:whole) { $whole.Dispose() };
    if (Test-Path variable:tail) { $tail.Dispose() }
  }
};
function DmFile($m) {
  $p = [string]$m.path;
  $drive = [System.IO.DriveInfo]::new($p.Substring(0, 1));
  if ($drive.DriveType -ne [System.IO.DriveType]::Fixed) { throw ('the ' + $m.role + ' medium is not on a fixed local drive') };
  $fi = [System.IO.FileInfo]::new($p);
  if (-not $fi.Exists) { throw ('the ' + $m.role + ' medium is not an existing regular file') };
  $badAttr = [System.IO.FileAttributes]::ReparsePoint -bor [System.IO.FileAttributes]::Directory -bor [System.IO.FileAttributes]::Device -bor [System.IO.FileAttributes]::Offline;
  if ([int]($fi.Attributes -band $badAttr) -ne 0) { throw ('the ' + $m.role + ' medium is a reparse point, directory, device or offline file') };
  if (-not (DmSameI $fi.FullName $p)) { throw ('the ' + $m.role + ' medium path does not resolve to itself') };
  $d = $fi.Directory;
  while ($null -ne $d) {
    if (-not $d.Exists) { throw ('a directory above the ' + $m.role + ' medium does not exist') };
    if ([int]($d.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('the ' + $m.role + ' medium has a reparse point (junction, symlink or mount) above it') };
    $d = $d.Parent
  };
  if ($fi.Length -ne [int64]$m.bytes) { throw ('the ' + $m.role + ' medium length differs before opening') };
  $pin = DmPin $m;
  if (($pin.length -ne $m.bytes) -or ($pin.read -ne $m.bytes)) { throw ('the ' + $m.role + ' medium is ' + $pin.length + ' bytes, not the pinned ' + $m.bytes) };
  if (($pin.read - $m.payloadOffset) -ne $m.payloadBytes) { throw ('the ' + $m.role + ' payload size differs from its pin') };
  if (-not (DmSame $pin.sha $m.sha)) { throw ('the ' + $m.role + ' medium sha256 differs from its pin') };
  if (-not (DmSame $pin.payloadSha $m.payloadSha)) { throw ('the ' + $m.role + ' payload sha256 differs from its pin') };
  return $pin
};
$phase = 'before-mutation';
$json = $null;
try {
  $vm = DmVm;
  DmBare $vm;
  foreach ($m in $media) { $null = DmFile $m };
  $vm = DmVm;
  DmBare $vm;
  $phase = 'after-mutation (the caller must tear down the VM by its exact id)';
  Hyper-V\Add-VMScsiController -VM $vm | Out-Null;
  $ctl = @(Hyper-V\Get-VMScsiController -VM $vm);
  if (($ctl.Count -ne 1) -or -not (DmIsInt $ctl[0].ControllerNumber 0)) { throw 'adding the SCSI controller did not leave exactly controller 0' };
  $icacls = [System.IO.Path]::Combine([System.Environment]::SystemDirectory, 'icacls.exe');
  $grant = 'NT VIRTUAL MACHINE\' + $vmId + ':R';
  foreach ($m in $media) {
    & $icacls $m.path /grant $grant | Out-Null;
    if ($LASTEXITCODE -ne 0) { throw ('icacls read grant failed for the ' + $m.role + ' medium, exit ' + $LASTEXITCODE) }
  };
  for ($i = 0; $i -lt 3; $i++) { Hyper-V\Add-VMDvdDrive -VM $vm -ControllerNumber 0 -ControllerLocation $i -Path $media[$i].path | Out-Null };
  $vm = DmVm;
  $null = DmAttached $vm;
  $pins = New-Object 'System.Collections.Generic.List[object]';
  foreach ($m in $media) { $pins.Add((DmFile $m)) };
  $dvds = @(Hyper-V\Get-VMDvdDrive -VM $vm);
  if ($dvds.Count -ne 3) { throw ('expected three DVD drives, found ' + $dvds.Count) };
  $out = New-Object 'System.Collections.Generic.List[object]';
  for ($i = 0; $i -lt 3; $i++) {
    $m = $media[$i];
    $hit = @($dvds | Where-Object { (DmIsInt $_.ControllerNumber 0) -and (DmIsInt $_.ControllerLocation $i) });
    if ($hit.Count -ne 1) { throw ('expected exactly one DVD at SCSI 0:' + $i + ', found ' + $hit.Count) };
    $d = $hit[0];
    if (-not (DmSame ([string]$d.ControllerType) 'SCSI')) { throw ('the ' + $m.role + ' DVD is not on a SCSI controller') };
    if (-not (DmSame ([string]$d.DvdMediaType) 'ISO')) { throw ('the ' + $m.role + ' DVD does not hold an ISO') };
    if (-not (DmSameI ([string]$d.Path) $m.path)) { throw ('the ' + $m.role + ' DVD path reads back differently') };
    $out.Add([ordered]@{ role = $m.role; path = [string]$d.Path; sha256 = $pins[$i].sha; bytes = $pins[$i].length; controller = [int]$d.ControllerNumber; location = [int]$d.ControllerLocation; controllerType = [string]$d.ControllerType })
  };
  $vm = DmVm;
  $dev = DmAttached $vm;
  $json = ConvertTo-Json -Compress -Depth 5 -InputObject ([ordered]@{ vmId = $vm.Id.ToString('D'); name = [string]$vm.Name; notes = [string]$vm.Notes; state = [string]$vm.State; controllers = $dev.controllers; hardDisks = $dev.hardDisks; nics = $dev.nics; bootEntries = $dev.bootEntries; media = $out.ToArray() })
} catch { throw ('desktop-media ' + $phase + ': ' + $_.Exception.Message) };
$json`;

/**
 * -> the attach script (Windows PowerShell 5.1) for one existing, Off, device-free Gen2 VM.
 * Its stdout is the compact JSON readback and nothing else. Its order:
 *   1. identity (exact id, name, notes), Off, Gen2; zero SCSI controllers, disks, DVDs, NICs, boot entries
 *   2. ALL three files: fixed local drive, regular non-reparse file, no reparse directory above it,
 *      length, sha256 and payload sha256 (one read through one handle); then identity and devices again
 *   3. mutation: SCSI controller 0, icacls read grant for the VM's account (exit checked), DVDs at 0:0, 0:1, 0:2
 *   4. readback: devices, all pins again, DVD path/slot/type mapping, identity and Off again
 * Invalid arguments throw here, before any script text exists.
 */
export function desktopMediaScript(args) {
  const { vmId, name, notes, media } = launchArgs(args, "desktopMediaScript");
  const table = media.map((m) => `  @{ role = ${q(m.role)}; path = ${q(m.path)}; sha = ${q(m.sha256)}; bytes = [int64]${m.bytes}; `
    + `payloadSha = ${q(m.payloadSha256)}; payloadBytes = [int64]${m.payloadBytes}; payloadOffset = [int64]${m.payloadOffset} }`).join(",\n");
  return [
    "$ErrorActionPreference = 'Stop';",
    "$ProgressPreference = 'SilentlyContinue';",
    "Set-StrictMode -Version 2.0;",
    `$vmId = ${q(vmId)};`,
    `$name = ${q(name)};`,
    `$notes = ${q(notes)};`,
    `$media = @(\n${table}\n);`,
    BODY,
  ].join("\n");
}

/**
 * Checks the script's stdout (string) or its parsed JSON against what was asked.
 * Exact keys, exact types: false, null, "" and "0" are never a count of 0. VM id and paths compare
 * case-insensitively (ASCII only); everything else exactly. -> a deeply frozen copy of the readback.
 */
export function checkDesktopMedia(result, args) {
  const { vmId, name, notes, media } = launchArgs(args, "checkDesktopMedia");
  let r = result;
  if (typeof r === "string") {
    try { r = JSON.parse(r); } catch { bad("result is not a single JSON document"); }
  }
  const top = exactRecord(r, RESULT_KEYS, "result");
  if (typeof top.vmId !== "string" || !GUID_RE.test(top.vmId) || top.vmId.toLowerCase() !== vmId) bad("result.vmId differs");
  if (top.name !== name) bad("result.name differs");
  if (top.notes !== notes) bad("result.notes differs");
  if (top.state !== "Off") bad(`result.state is ${JSON.stringify(top.state)}, not "Off"`);
  exactNumber(top.controllers, 1, "result.controllers");
  exactNumber(top.hardDisks, 0, "result.hardDisks");
  exactNumber(top.nics, 0, "result.nics");
  exactNumber(top.bootEntries, 0, "result.bootEntries");
  const got = exactArray(top.media, MEDIA_ROLES.length, "result.media");
  const out = got.map((raw, i) => {
    const g = exactRecord(raw, RESULT_MEDIA_KEYS, `result.media[${i}]`);
    const m = media[i];
    if (g.role !== m.role) bad(`result.media[${i}].role differs`);
    if (typeof g.path !== "string" || !PRINTABLE.test(g.path) || g.path.toLowerCase() !== m.path.toLowerCase())
      bad(`result.media[${i}].path differs`);
    if (g.sha256 !== m.sha256) bad(`result.media[${i}].sha256 differs`);
    exactNumber(g.bytes, m.bytes, `result.media[${i}].bytes`);
    exactNumber(g.controller, 0, `result.media[${i}].controller`);
    exactNumber(g.location, i, `result.media[${i}].location`);
    if (g.controllerType !== "SCSI") bad(`result.media[${i}].controllerType is ${JSON.stringify(g.controllerType)}, not "SCSI"`);
    return Object.freeze({ role: m.role, path: g.path, sha256: g.sha256, bytes: g.bytes, controller: 0, location: i, controllerType: "SCSI" });
  });
  return Object.freeze({ vmId, name, notes, state: "Off", controllers: 1, hardDisks: 0, nics: 0, bootEntries: 0, media: Object.freeze(out) });
}
