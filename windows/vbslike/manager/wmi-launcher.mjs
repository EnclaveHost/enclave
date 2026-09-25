/* ============================================================
   The supported launcher: WMI on the Hyper-V role.

   Microsoft's own openhcl/Set-OpenHCL-HyperV-VM.ps1 is the reference and this follows it step for
   step. It does NOT go through the Host Compute Service. A VM is created with the Hyper-V module,
   and its firmware is pinned by writing two fields on the VM's Msvm_VirtualSystemSettingData and
   applying them through Msvm_VirtualSystemManagementService.ModifySystemSettings:

       $vssd.GuestFeatureSet = 0x00000201
       $vssd.FirmwareFile    = <path to the IGVM>

   Everything here is written against that, and every PowerShell fragment is produced by a pure
   function so it can be read and tested without a host. `run` is injected: production passes a real
   PowerShell runner, tests pass recorded answers. Nothing in this file executes anything by itself.

   THREE RULES IT KEEPS.

   Preflight refuses rather than improvises. If the Hyper-V role is absent, the namespace is missing
   or the module has no Get-VM, `start` fails before it creates anything. A launcher that half-built
   a VM and then discovered it could not pin firmware would leave the host dirtier than it found it.

   Ownership is scoped by construction. Every VM this creates is named with the instance prefix and
   carries a Notes marker, and teardown filters on BOTH. It never enumerates VMs for action by any
   other criterion, so a machine that also runs somebody else's VMs is not at risk from this code.

   The image is pinned by hash, checked on the host immediately before it is handed to the firmware
   field. A path is not an identity; two runs must be able to prove they booted the same bytes.
   ============================================================ */

/*  THE VM MUST BE CREATED WITH A GUEST-STATE ISOLATION TYPE, or FirmwareFile is inert.
 *
 *  Measured on nucbox-k11 2026-09-24, and it is not obvious: a Generation 2 VM created WITHOUT
 *  `-GuestStateIsolationType` accepts the firmware pin (ModifySystemSettings returnValue 0), reads
 *  `FirmwareFile` back correctly, starts, and then boots nothing - the worker never logs a
 *  "Loading IGVM file" line at all, because a VM with no guest-state isolation type has no
 *  paravisor and nothing consumes the field. Every failure looks like a bad image; none of them is.
 *
 *  Created WITH `-GuestStateIsolationType OpenHCL`, the worker actually tries, and says what it
 *  wants (Worker-Admin event 5142):
 *      failed to load custom IGVM file because AllowFirmwareLoadFromFile registry key is not set
 *
 *  So the two are independent: the VM setting decides whether our image is CONSIDERED, the host
 *  registry key decides whether it is ALLOWED. Upstream's Guide/src/user_guide/openhcl/run/hyperv.md
 *  documents both; enclave-53 found it there. Secure Boot is NOT part of it - pinned VMs fail the
 *  same way with it on and off - but the guide turns it off because a guest image may need that, so
 *  the default here is off and it is a parameter rather than a decision baked in.
 *
 *  `IsolationType` on Msvm_VirtualSystemSettingData reads EMPTY even when the VM was created with
 *  one, so do not detect this by reading that field back.
 */
/**
 * THE PARTITION KIND IS THE LAUNCHER'S TO STATE, NOT THE GUEST'S.
 *
 * The monitor stopped printing a fixed `partition=hcs-child` (enclave-5d, 4127789d) for the right
 * reason: a guest cannot know what kind of partition it is in. So whichever launcher started the
 * domain says so, and the two launchers must NOT say the same thing - a report carrying no kind, or
 * one copied from the HCS path, would be a false statement about the boundary (enclave-99).
 *
 * `hostExcluded` is false here for the same reason it is false on the HCS path: a Gen2 OpenHCL
 * partition on this host does not exclude the host, and nothing this launcher produces may be
 * advertised as verified or host-excluded capacity.
 */
export const BOUNDARY = Object.freeze({
  tier: "T0-hv",
  partition: "wmi-openhcl-gen2",   // NOT "hcs-child": a different launcher, a different kind
  hostExcluded: false,
  attested: false,
  note: "a Gen2 OpenHCL partition started through WMI. The host is NOT excluded and no chain is "
      + "verified: never advertise this as verified or host-excluded capacity.",
});

/**
 * The image identity for a UEFI boot: the sha256 of the MEDIUM the launcher attached, hashed AT
 * ATTACH TIME.
 *
 * Not the UKI's hash, and this is a security property rather than a preference. With Secure Boot
 * off the pinned stub reads addons, credentials and extensions from the ESP, so TWO MEDIA CARRYING
 * THE SAME UKI CAN BOOT DIFFERENT COMMAND LINES. Only the medium hash separates them, so only the
 * medium hash can honestly answer "what booted". The UKI hash and the composition are published
 * BESIDE it, never in place of it.
 *
 * The HCS-only fields are deliberately absent: on this path there is no host-supplied kernel or
 * initrd file, and filling `kernelSha256`/`initrdSha256` would state an identity the boot never
 * used. (enclave-99's review; adopted in 5d's UEFI-BOOT.md.)
 */
export function uefiImageIdentity({ mediumSha256, mediumPath, ukiSha256 = null, composition = null }) {
  if (!/^[0-9a-f]{64}$/.test(String(mediumSha256 || "").toLowerCase()))
    throw new Error("the medium's sha256 is required, hashed at attach time: without it nothing says WHAT booted");
  const id = {
    partition: BOUNDARY.partition,
    guestImageSha256: String(mediumSha256).toLowerCase(),
    guestImageKind: "uefi-medium",
    guestImagePath: mediumPath ?? null,
  };
  if (ukiSha256) id.ukiSha256 = String(ukiSha256).toLowerCase();   // beside, never instead
  if (composition) id.composition = composition;
  return Object.freeze(id);
}

export const GUEST_FEATURE_SET = 0x00000201;   // the value Microsoft's script writes, kept as theirs
export const MIN_VM_VERSION = 12.0;            // their script throws below this
export const OWNER_MARKER = "enclave-vbslike-app-domain";
/*
 * THE VM CARRIES ITS OWN IDENTITY (63's P1). The manager used to hold every record in memory only,
 * so a restarted manager answered "absent" for a VM that was still running: the node then released
 * the lease and spawned a second VM for the same deployment. Hyper-V outlives this process, so the
 * identity is written where Hyper-V keeps it - the VM's Notes - and a restarted manager rebuilds its
 * inventory from there before it answers anything (server.mjs recover()).
 *
 *   Notes = "enclave-vbslike-app-domain/manager|" + base64url(JSON {v:1, id, name, instanceId, appId})
 *
 * A VM whose Notes are exactly OWNER_MARKER (older managers, the dev canary) is still OURS for
 * removal, but carries no identity: it is recovered as UNATTRIBUTED, and the manager refuses to
 * spawn while one exists rather than guess which deployment it belonged to.
 */
export const MANAGER_NOTES_PREFIX = OWNER_MARKER + "/manager|";
export function notesFor({ id, name, instanceId, appId }) {
  for (const [k, val] of Object.entries({ id, name, instanceId }))
    if (typeof val !== "string" || !val) throw new Error(`notesFor: ${k} must be a non-empty string`);
  return MANAGER_NOTES_PREFIX + Buffer.from(JSON.stringify({ v: 1, id, name, instanceId, appId: appId ?? null })).toString("base64url");
}
/** -> { owned, identity }: owned means the ownership marker is present; identity only when it parses completely. */
export function parseNotes(notes) {
  const t = String(notes ?? "");
  if (t.startsWith(MANAGER_NOTES_PREFIX)) {
    try {
      const o = JSON.parse(Buffer.from(t.slice(MANAGER_NOTES_PREFIX.length), "base64url").toString("utf8"));
      if (o && o.v === 1 && typeof o.id === "string" && o.id && typeof o.name === "string" && o.name
          && typeof o.instanceId === "string" && o.instanceId) return { owned: true, identity: o };
    } catch { /* owned, but the identity is unreadable: unattributed */ }
    return { owned: true, identity: null };
  }
  return { owned: t === OWNER_MARKER, identity: null };
}
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const ps = (s) => s.replace(/\r?\n\s*/g, " ").trim();
/** PowerShell: is VM expression `v` ours? The bare marker OR the manager's identity notes. */
const OWNED = (v) => `(${v}.Notes -eq ${q(OWNER_MARKER)} -or ([string]${v}.Notes).StartsWith(${q(MANAGER_NOTES_PREFIX)}))`;
/**
 * Enumeration is only meaningful where `Get-VM` EXISTS. `Get-VM -ErrorAction SilentlyContinue` on a
 * host without the Hyper-V module yields nothing, which is indistinguishable from a host that owns
 * no VMs - so a survey read "no VMs" and a teardown read "found 0, removed 0, failed []", a CLEAN
 * teardown, on a host that cannot enumerate at all. Measured on nucbox-k11 before the role existed.
 * Reading a missing capability as an empty result is the same fail-open shape as a hash table that
 * verifies nothing and boots anyway; both say PASS while covering no mechanism. So the two scripts
 * that enumerate for action REFUSE rather than report an empty success.
 */
const ENUMERABLE = ps(`if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) { throw 'Get-VM is absent: the Hyper-V PowerShell module is not installed, so VMs cannot be enumerated - this host is UNENUMERABLE, not empty' };`);

/** PowerShell single-quoted literal: the only escape inside one is a doubled quote. */
export function q(v) { return "'" + String(v).replace(/'/g, "''") + "'"; }

/* ---- the commands, as pure functions so a test can read them ---------------------------------- */

export const CMD = {
  /** Is the role actually here? Each answer is a fact, not an inference. */
  preflight: () => ps(`
    $r = [ordered]@{};
    $r.vmms = [bool](Get-Service vmms -ErrorAction SilentlyContinue);
    $r.namespace = [bool](Get-CimClass -Namespace 'root\\virtualization\\v2' -ClassName Msvm_VirtualSystemManagementService -ErrorAction SilentlyContinue);
    $r.module = [bool](Get-Command Get-VM -ErrorAction SilentlyContinue);
    $r.firmwareField = [bool]((Get-CimClass -Namespace 'root\\virtualization\\v2' -ClassName Msvm_VirtualSystemSettingData -ErrorAction SilentlyContinue).CimClassProperties.Name -contains 'FirmwareFile');
    $r.hypervisor = (Get-CimInstance Win32_ComputerSystem).HypervisorPresent;
    $r | ConvertTo-Json -Compress`),

  /** The image, by hash, on the host that will load it. */
  imageHash: (path) => ps(`
    if (-not (Test-Path ${q(path)})) { @{present=$false} | ConvertTo-Json -Compress; exit 0 };
    @{present=$true; sha256=(Get-FileHash ${q(path)} -Algorithm SHA256).Hash.ToLower(); bytes=(Get-Item ${q(path)}).Length} | ConvertTo-Json -Compress`),

  /**
   * Create the VM, under a terminating-error policy, and remove it HERE if any step after New-VM
   * fails. The first version returned JSON only on the happy path, so a failure between New-VM and
   * that JSON left a VM on the host and `created` null in the caller, which then cleaned up
   * nothing. The marker is applied inside the same try for the same reason: a VM that exists
   * without it is invisible to a marker-scoped teardown.
   */
  create: ({ name, memMiB, vcpus, version = "12.0", isolation = "OpenHCL", secureBoot = false, notes = OWNER_MARKER }) => ps(`
    $ErrorActionPreference = 'Stop';
    $vm = $null;
    try {
      $vm = New-VM -Name ${q(name)} -Generation 2 -MemoryStartupBytes ${Math.round(memMiB)}MB -NoVHD -Version ${q(version)}${isolation ? ` -GuestStateIsolationType ${q(isolation)}` : ""};
      ${secureBoot ? "" : "Set-VMFirmware -VM $vm -EnableSecureBoot Off;"}
      Set-VM -VM $vm -Notes ${q(notes)};
      Set-VMProcessor -VM $vm -Count ${Math.max(1, Math.floor(vcpus))};
      Set-VMMemory -VM $vm -DynamicMemoryEnabled $false;
      Set-VM -VM $vm -AutomaticStartAction Nothing -AutomaticStopAction TurnOff -CheckpointType Disabled;
      @{id=$vm.Id.Guid; version=[string]$vm.Version; name=$vm.Name; notes=[string]$vm.Notes} | ConvertTo-Json -Compress
    } catch {
      if ($vm) { try { Remove-VM -VM $vm -Force -ErrorAction SilentlyContinue } catch {} };
      throw
    }`),

  /**
   * Pin the firmware. Set-OpenHCL-HyperV-VM.ps1's own sequence, including the two things the first
   * version of this file left out.
   *
   * ConvertTo-CimEmbeddedString is NOT a cmdlet. Their script defines it, and so does this: a
   * CimSerializer round trip. Calling it without defining it is a command-not-found at runtime.
   *
   * ReturnValue 4096 means "a job was STARTED", not "it worked". Their Trace-CimMethodExecution
   * polls Msvm_ConcreteJob while JobState is 4 (running) and treats anything other than 7
   * (completed) as an error, surfacing ErrorDescription or ErrorCode. This does the same, bounded.
   *
   * Then it READS THE SETTINGS BACK. A job that completed is not the same as a field that holds
   * what we asked for, and the whole point of this call is that the field holds our image.
   */
  pinFirmware: ({ vmId, imagePath, jobTimeoutSec = 120 }) => ps(`
    $ErrorActionPreference = 'Stop';
    function ConvertTo-CimEmbeddedString([Microsoft.Management.Infrastructure.CimInstance]$CimInstance) {
      if ($null -eq $CimInstance) { return '' };
      $s = [Microsoft.Management.Infrastructure.Serialization.CimSerializer]::Create();
      return [System.Text.Encoding]::Unicode.GetString($s.Serialize($CimInstance, [Microsoft.Management.Infrastructure.Serialization.InstanceSerializationOptions]::None))
    };
    $ns = 'root\\virtualization\\v2';
    $vm = Get-CimInstance -Namespace $ns -Query ("select * from Msvm_ComputerSystem where Name = '" + ${q(vmId)} + "'");
    if (-not $vm) { throw 'no Msvm_ComputerSystem for ' + ${q(vmId)} };
    $vssd = $vm | Get-CimAssociatedInstance -ResultClass Msvm_VirtualSystemSettingData -Association Msvm_SettingsDefineState;
    $vssd.GuestFeatureSet = ${GUEST_FEATURE_SET};
    $vssd.FirmwareFile = ${q(imagePath)};
    $svc = Get-CimInstance -Namespace $ns -ClassName Msvm_VirtualSystemManagementService;
    $res = Invoke-CimMethod -InputObject $svc -Name ModifySystemSettings -Arguments @{SystemSettings = (ConvertTo-CimEmbeddedString $vssd)};
    $rv = [int]$res.ReturnValue;
    $jobState = $null; $jobError = $null;
    if ($rv -eq 4096) {
      if (-not $res.Job) { throw 'ReturnValue 4096 with no Job object' };
      $job = $res.Job | Get-CimInstance;
      $deadline = (Get-Date).AddSeconds(${Math.max(1, Math.floor(jobTimeoutSec))});
      while ($job.JobState -eq 4) {
        if ((Get-Date) -gt $deadline) { throw 'ModifySystemSettings job did not finish within ${Math.max(1, Math.floor(jobTimeoutSec))}s (JobState still 4)' };
        Start-Sleep -Milliseconds 500;
        $job = $job | Get-CimInstance
      };
      $jobState = [int]$job.JobState;
      if ($jobState -ne 7) { $jobError = if ($job.ErrorDescription) { [string]$job.ErrorDescription } else { 'JobState ' + $jobState + ' ErrorCode ' + [string]$job.ErrorCode } }
    } elseif ($rv -ne 0) { throw 'ModifySystemSettings returned ' + $rv };
    if ($jobError) { throw $jobError };
    $after = (Get-CimInstance -Namespace $ns -Query ("select * from Msvm_ComputerSystem where Name = '" + ${q(vmId)} + "'")) |
             Get-CimAssociatedInstance -ResultClass Msvm_VirtualSystemSettingData -Association Msvm_SettingsDefineState;
    @{returnValue=$rv; jobState=$jobState; firmwareFile=[string]$after.FirmwareFile; guestFeatureSet=[int]$after.GuestFeatureSet} | ConvertTo-Json -Compress`),

  /** A serial port to a named pipe: the only way this learns what the guest said. */
  attachConsole: ({ name, pipe }) => ps(`
    Set-VMComPort -VMName ${q(name)} -Number 1 -Path ${q(pipe)};
    @{ok=$true} | ConvertTo-Json -Compress`),

  start: ({ name }) => ps(`$ErrorActionPreference='Stop'; Start-VM -Name ${q(name)}; @{state=[string](Get-VM -Name ${q(name)}).State} | ConvertTo-Json -Compress`),

  /**
   * Did the GUEST say anything, within a bound this function itself keeps?
   *
   * The first version opened the pipe with [IO.File]::Open and called a SYNCHRONOUS Read in a loop.
   * A synchronous read on a named pipe with no data blocks indefinitely: the deadline was only
   * consulted between reads, so the first one could outlive it, and the outer PowerShell kill then
   * returned no JSON at all - a timeout that looked like a crash. This connects with a timeout and
   * reads asynchronously, cancelling at the deadline, so it always answers.
   *
   * It reports BYTES, and says nothing about what they mean. Firmware banners are bytes.
   */
  readConsole: ({ pipe, seconds = 20, connectMs = 5000 }) => ps(`
    $ErrorActionPreference = 'Stop';
    $name = ${q(pipe)} -replace '^\\\\\\\\\.\\\\pipe\\\\', '';
    $total = 0; $head = ''; $connected = $false; $why = '';
    $cts = New-Object System.Threading.CancellationTokenSource;
    $cts.CancelAfter(${Math.max(1, Math.floor(seconds))} * 1000);
    $cli = $null;
    try {
      $cli = New-Object System.IO.Pipes.NamedPipeClientStream('.', $name, [System.IO.Pipes.PipeDirection]::In);
      $cli.Connect(${Math.max(250, Math.floor(connectMs))});
      $connected = $true;
      $buf = New-Object byte[] 4096;
      while (-not $cts.IsCancellationRequested) {
        $t = $cli.ReadAsync($buf, 0, $buf.Length, $cts.Token);
        if (-not $t.Wait(500)) { continue };
        $n = $t.Result;
        if ($n -le 0) { break };
        $total += $n;
        if ($head.Length -lt 400) { $head += [Text.Encoding]::ASCII.GetString($buf, 0, [Math]::Min($n, 400)) }
      }
    } catch { $why = [string]$_.Exception.Message } finally {
      if ($cli) { try { $cli.Dispose() } catch {} };
      $cts.Dispose()
    };
    @{connected=$connected; bytes=$total; head=$head; note=$why} | ConvertTo-Json -Compress`),

  state: ({ name }) => ps(`$v = Get-VM -Name ${q(name)} -ErrorAction SilentlyContinue; if ($v) { @{found=$true; state=[string]$v.State; uptime=[string]$v.Uptime} | ConvertTo-Json -Compress } else { @{found=$false} | ConvertTo-Json -Compress }`),

  /** Stop, and report a failure AS one: SilentlyContinue used to answer ok whatever happened. */
  stop: ({ name }) => ps(`
    try { Stop-VM -Name ${q(name)} -TurnOff -Force -ErrorAction Stop; @{ok=$true} | ConvertTo-Json -Compress }
    catch {
      $v = Get-VM -Name ${q(name)} -ErrorAction SilentlyContinue;
      if (-not $v) { @{ok=$true; note='already gone'} | ConvertTo-Json -Compress }
      else { @{ok=$false; state=[string]$v.State; error=[string]$_.Exception.Message} | ConvertTo-Json -Compress }
    }`),

  /** Remove ONE VM by EXACT name. The failure path must never match by prefix. */
  removeExact: ({ name, requireMarker = true }) => ps(`
    $v = Get-VM -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq ${q(name)}${requireMarker ? ` -and ${OWNED("$_")}` : ""} };
    if (-not $v) { @{found=$false; removed=$false} | ConvertTo-Json -Compress; exit 0 };
    try {
      Stop-VM -VM $v -TurnOff -Force -ErrorAction SilentlyContinue;
      Remove-VM -VM $v -Force -ErrorAction Stop;
      @{found=$true; removed=$true} | ConvertTo-Json -Compress
    } catch { @{found=$true; removed=$false; error=[string]$_.Exception.Message} | ConvertTo-Json -Compress }`),

  /**
   * Remove ONLY what this owns. Scoped by the instance prefix, and by the marker when it is there -
   * a VM that failed before its Notes were set still starts with the prefix, and leaving it behind
   * because the marker is missing is how an orphan becomes permanent. Failures are REPORTED, not
   * swallowed: a teardown that could not remove something must not read as a clean one.
   */
  teardown: ({ prefix, requireMarker = false }) => ps(`
    ${ENUMERABLE}
    $vms = @(Get-VM | Where-Object { $_.Name.StartsWith(${q(prefix)})${requireMarker ? ` -and ${OWNED("$_")}` : ""} });
    $removed = @(); $failed = @();
    foreach ($v in $vms) {
      try {
        Stop-VM -VM $v -TurnOff -Force -ErrorAction SilentlyContinue;
        Remove-VM -VM $v -Force -ErrorAction Stop;
        $removed += $v.Name
      } catch { $failed += @{name=$v.Name; error=[string]$_.Exception.Message} }
    };
    @{found=$vms.Count; removed=@($removed); failed=@($failed)} | ConvertTo-Json -Compress -Depth 4`),

  /** Everything this prefix owns, whether or not we think we started it: the reconciliation read. */
  survey: ({ prefix }) => ps(`
    ${ENUMERABLE}
    $vms = @(Get-VM | Where-Object { $_.Name.StartsWith(${q(prefix)}) -or ([string]$_.Notes).StartsWith(${q(MANAGER_NOTES_PREFIX)}) });
    @{vms=@($vms | ForEach-Object { @{vmId=$_.Id.Guid; name=$_.Name; state=[string]$_.State; notes=[string]$_.Notes} })} | ConvertTo-Json -Compress -Depth 4`),

  /**
   * Stop and REMOVE one VM by its Id (63's P2). Names are not unique in Hyper-V, so acting by name
   * could stop somebody else's VM of the same name. The ownership marker is checked on the VM the Id
   * resolves to before anything is done to it. Waits for Off before Remove-VM, because removing a VM
   * that is still stopping throws InvalidState (measured on nucbox-k11 in uefi-dev-boot.ps1).
   */
  removeById: ({ vmId }) => ps(`
    ${ENUMERABLE}
    $v = $null; try { $v = Get-VM -Id ${q(vmId)} -ErrorAction Stop } catch { $v = $null };
    if (-not $v) { @{found=$false; removed=$false} | ConvertTo-Json -Compress; exit 0 };
    if (-not ${OWNED("$v")}) { @{found=$true; removed=$false; error='not ours: the ownership marker is absent'} | ConvertTo-Json -Compress; exit 0 };
    try {
      Stop-VM -VM $v -TurnOff -Force -ErrorAction SilentlyContinue;
      $dl = (Get-Date).AddSeconds(20);
      while ((Get-Date) -lt $dl -and [string](Get-VM -Id ${q(vmId)} -ErrorAction SilentlyContinue).State -ne 'Off') { Start-Sleep -Milliseconds 500 };
      $last = '';
      for ($a = 0; $a -lt 5; $a++) {
        $now = Get-VM -Id ${q(vmId)} -ErrorAction SilentlyContinue;
        if (-not $now) { break };
        try { Remove-VM -VM $now -Force -ErrorAction Stop } catch { $last = [string]$_.Exception.Message; Start-Sleep -Seconds 2 }
      };
      if (Get-VM -Id ${q(vmId)} -ErrorAction SilentlyContinue) { @{found=$true; removed=$false; error=('still present after removal: ' + $last)} | ConvertTo-Json -Compress }
      else { @{found=$true; removed=$true} | ConvertTo-Json -Compress }
    } catch { @{found=$true; removed=$false; error=[string]$_.Exception.Message} | ConvertTo-Json -Compress }`),
};

function parse(out) {
  const t = String(out ?? "").trim();
  if (!t) throw new Error("no output from PowerShell");
  try { return JSON.parse(t); } catch { throw new Error(`PowerShell output is not JSON: ${t.slice(0, 160)}`); }
}

export class WmiHyperVLauncher {
  /**
   * @param run  async (script) => { code, stdout, stderr }   injected; nothing here spawns anything
   * @param imagePath / imageSha256  the guest image and the hash it must have, checked on the host
   * @param prefix  every VM this instance creates starts with it, and teardown filters on it
   */
  constructor({ run, imagePath, imageSha256, medium = null, mediumSha256 = null, prefix = "enclave-app-", pipeFor = null, jobTimeoutSec = 120 }) {
    // The boot medium, beside the firmware and never confused with it. The firmware is the
    // paravisor image the worker loads; the medium is what the guest BOOTS, and only the medium's
    // hash can answer "what ran" - with Secure Boot off the ESP can differ under one UKI.
    this.medium = medium;
    this.mediumSha256 = mediumSha256 ? String(mediumSha256).toLowerCase() : null;
    if (typeof run !== "function") throw new Error("a PowerShell runner must be injected");
    this.run = run; this.imagePath = imagePath; this.imageSha256 = (imageSha256 || "").toLowerCase();
    // A STABLE prefix, not one keyed to a pid: a restarted manager must still recognise, and be
    // able to reconcile, the VMs its predecessor left behind.
    this.prefix = prefix;
    this.jobTimeoutSec = jobTimeoutSec;
    // The names THIS launcher created. Cleanup and reconciliation work from this, not from a
    // prefix match, so a duplicate name or a neighbour sharing the prefix is never removed by us.
    this.created = new Set();
    this.pipeFor = pipeFor || ((name) => `\\\\.\\pipe\\${name}-com1`);
  }

  async #ps(script) {
    const r = await this.run(script);
    if (!r || r.code !== 0) {
      const e = new Error((r && (r.stderr || "").trim()) || `PowerShell exited ${r ? r.code : "?"}`);
      e.code = "powershell_failed";
      throw e;
    }
    return parse(r.stdout);
  }

  /** Every prerequisite, each answered rather than assumed. Never throws: it reports. */
  async preflight() {
    let got;
    try { got = await this.#ps(CMD.preflight()); }
    catch (e) { return { ok: false, checks: [{ name: "preflight", ok: false, detail: e.message }] }; }
    const checks = [
      { name: "vmms service", ok: got.vmms === true, detail: "the Hyper-V Virtual Machine Management service" },
      { name: "root\\virtualization\\v2", ok: got.namespace === true, detail: "the WMI namespace the firmware pin is written through" },
      { name: "Hyper-V PowerShell module", ok: got.module === true, detail: "Get-VM, which creates and owns the VM" },
      { name: "Msvm_VirtualSystemSettingData.FirmwareFile", ok: got.firmwareField === true, detail: "the field that carries a custom IGVM" },
      { name: "hypervisor present", ok: got.hypervisor === true, detail: "already true here: VBS runs on it" },
    ];
    return { ok: checks.every((c) => c.ok), checks };
  }

  /** The image must be the bytes we expect, on the host, at the moment we pin it. */
  async verifyImage() {
    const got = await this.#ps(CMD.imageHash(this.imagePath));
    if (got.present !== true) throw new Error(`guest image not present at ${this.imagePath}`);
    if (!this.imageSha256) throw new Error("no expected image sha256 was configured; a path is not an identity");
    if (String(got.sha256).toLowerCase() !== this.imageSha256)
      throw new Error(`guest image sha256 is ${got.sha256}, expected ${this.imageSha256}`);
    return { sha256: this.imageSha256, bytes: got.bytes };
  }

  /**
   * Create, pin, verify the pin, start, and require the guest to say something.
   *
   * `instanceId` is the caller's unique handle for THIS domain and is what the VM is named after.
   * Naming by AppID alone meant two deployments of the same app collided on one VM name: the second
   * New-VM fails, or worse, adopts the first. The AppID is carried in the notes, not in the name.
   *
   * Any failure after New-VM removes this VM before rethrowing, and the create script removes it
   * itself if it fails before returning - both, because a leak here is a VM nobody owns.
   */
  async start(mapping, { instanceId, identity = null, guestReadySec = 25 } = {}) {
    if (!instanceId || !/^[A-Za-z0-9._-]{4,64}$/.test(String(instanceId)))
      throw new Error("a unique instanceId is required: naming a domain by its AppID alone collides when the same app is deployed twice");
    const pre = await this.preflight();
    if (!pre.ok) {
      const missing = pre.checks.filter((c) => !c.ok).map((c) => c.name);
      const e = new Error(`the Hyper-V role is not usable on this host: missing ${missing.join(", ")}`);
      e.code = "prerequisites_absent"; e.checks = pre.checks;
      throw e;
    }
    // THE FIRMWARE's hash, and it is NOT the image identity. Keeping the name `image` for it was
    // the bug: it was returned as handle.image, server.mjs copied it to rec.image, and 5d's
    // datapath compares `want.image !== rec.image` as 64-hex STRINGS - so an object could never
    // match and EVERY route would be refused as "identity", never as a type error (enclave-53).
    const firmware = await this.verifyImage();
    const name = `${this.prefix}${instanceId}`;
    const pipe = this.pipeFor(name);
    let created = null;
    try {
      created = await this.#ps(CMD.create({ name, memMiB: mapping.record.policy.memMiB, vcpus: mapping.record.policy.vcpus,
                                           notes: identity ? notesFor({ ...identity, instanceId }) : OWNER_MARKER }));
      this.created.add(name);
      if (parseFloat(created.version) < MIN_VM_VERSION)
        throw new Error(`VM version ${created.version} is below ${MIN_VM_VERSION}, which the firmware field requires`);

      // The pin, the job, and then what the field ACTUALLY holds. A completed job is not a set field.
      const pinned = await this.#ps(CMD.pinFirmware({ vmId: created.id, imagePath: this.imagePath, jobTimeoutSec: this.jobTimeoutSec }));
      if (pinned.returnValue !== 0 && pinned.returnValue !== 4096)
        throw new Error(`ModifySystemSettings returned ${pinned.returnValue}`);
      if (pinned.returnValue === 4096 && pinned.jobState !== 7)
        throw new Error(`ModifySystemSettings job ended in state ${pinned.jobState}, not 7 (completed)`);
      if (String(pinned.firmwareFile || "").toLowerCase() !== String(this.imagePath).toLowerCase())
        throw new Error(`FirmwareFile reads back as ${JSON.stringify(pinned.firmwareFile ?? null)}, not the image we pinned`);
      if (Number(pinned.guestFeatureSet) !== GUEST_FEATURE_SET)
        throw new Error(`GuestFeatureSet reads back as ${pinned.guestFeatureSet}, not ${GUEST_FEATURE_SET}`);

      await this.#ps(CMD.attachConsole({ name, pipe }));
      const started = await this.#ps(CMD.start({ name }));
      if (started.state !== "Running")
        throw new Error(`the VM is ${JSON.stringify(started.state ?? null)} after Start-VM, not Running`);

      // THE GUEST BOOTED - and that is ALL this establishes. Bytes on a serial port are bytes: a
      // firmware banner is bytes, a kernel panic is bytes. It says something inside the partition
      // executed, which is more than "Running" says, and it is NOT evidence that the component was
      // delivered, compiled or served. There is no app-readiness handshake on this backend yet, so
      // there is no state here that means "the app is up", and the launcher does not invent one.
      const con = await this.#ps(CMD.readConsole({ pipe, seconds: guestReadySec }));
      if (con.connected !== true)
        throw new Error(`could not attach to the guest console at ${pipe}: ${con.note || "no connection"}`);
      const booted = Number(con.bytes) > 0;
      if (!booted)
        throw new Error(`the VM is Running but the guest produced no output on ${pipe} within ${guestReadySec}s: a silent partition is not a booted one`);

      // `image` is the guest's identity as a 64-hex STRING: the MEDIUM's hash when one was
      // attached (uefiImageIdentity), never the firmware's, and never an object. Null when no
      // medium was attached, so a caller can tell "no medium" from "wrong medium" - the datapath
      // then refuses for want of an identity rather than on a mismatch it cannot explain.
      return { instanceId, name, vmId: created.id, pipe, state: started.state,
               image: this.mediumSha256 ? uefiImageIdentity({ mediumSha256: this.mediumSha256,
                                                              mediumPath: this.medium }).guestImageSha256
                                        : null,
               firmware, boundary: BOUNDARY, appId: mapping.appId,
               // guestBooted: something executed. appReady: NOT established - no handshake exists.
               guest: { booted, bytes: con.bytes, head: String(con.head || "").slice(0, 400) },
               appReady: false,
               stop: async () => await this.stop({ name, vmId: created.id }) };
    } catch (e) {
      // EXACT name, never a prefix. The first version swept with StartsWith(name), so a failure
      // while creating a duplicate would have removed the EXISTING domain of that name, and any
      // neighbour whose name merely began with ours. It also requires the ownership marker unless
      // this attempt is the thing that made the VM.
      const mine = this.created.has(name);
      const swept = await this.#ps(CMD.removeExact({ name, requireMarker: !mine }))
        .catch((x) => ({ found: null, removed: false, error: x.message }));
      this.created.delete(name);
      e.cleanup = swept;
      if (swept && swept.found === true && swept.removed !== true)
        e.message += ` (cleanup could NOT remove ${name}: ${swept.error || "unknown"} - it is still on this host)`;
      throw e;
    }
  }

  /** Stop, and SAY when it did not: "ok" for a VM that is still running is how one gets orphaned. */
  async stop(handle) {
    if (handle && handle.vmId) {
      // BY ID, and removed, not just turned off: a stopped VM that keeps its identity notes would be
      // recovered as live by the next manager, and a VM left Off is one nobody owns (63's P2).
      if (!GUID.test(String(handle.vmId))) throw Object.assign(new Error(`not a VM Id: ${handle.vmId}`), { code: "stop_failed" });
      const r = await this.#ps(CMD.removeById({ vmId: handle.vmId }));
      if (r && r.found === true && r.removed !== true) {
        const e = new Error(`could not stop and remove ${handle.name || handle.vmId}: ${r.error || "unknown"}`);
        e.code = "stop_failed"; throw e;
      }
      if (handle.name) this.created.delete(handle.name);
      return { stopped: true, removed: r && r.removed === true, name: handle.name ?? null, vmId: handle.vmId,
               ...(r && r.found === false ? { note: "already gone" } : {}) };
    }
    if (!handle || !handle.name) return { stopped: false, reason: "no handle" };
    const r = await this.#ps(CMD.stop({ name: handle.name }));
    if (r && r.ok === false) {
      const e = new Error(`could not stop ${handle.name}: ${r.error || "unknown"}`);
      e.code = "stop_failed"; throw e;
    }
    return { stopped: true, name: handle.name };
  }
  async state(name) { return await this.#ps(CMD.state({ name })); }
  /** What this prefix owns right now, including anything a previous run left behind. */
  async survey() { return await this.#ps(CMD.survey({ prefix: this.prefix })); }
  /**
   * Remove every VM under this prefix and SAY what could not be removed. It throws when anything
   * was left behind, because a teardown that reports success while an orphan survives is how a
   * host fills up with VMs nobody owns.
   */
  async teardown({ requireMarker = true } = {}) {
    // Marker-required by DEFAULT now: a prefix alone can collide with a VM this manager never made,
    // and removing somebody else's domain is worse than leaving one of ours behind. The narrow gap
    // - a VM that died between New-VM and its Notes - is closed by the exact names we recorded.
    for (const name of [...this.created]) {
      const one = await this.#ps(CMD.removeExact({ name, requireMarker: false })).catch(() => null);
      if (one && one.removed) this.created.delete(name);
    }
    const r = await this.#ps(CMD.teardown({ prefix: this.prefix, requireMarker }));
    if (Array.isArray(r.failed) && r.failed.length) {
      const e = new Error(`teardown could not remove ${r.failed.length} VM(s): `
        + r.failed.map((f) => `${f.name} (${f.error})`).join("; "));
      e.code = "teardown_incomplete"; e.result = r;
      throw e;
    }
    return r;
  }
}
