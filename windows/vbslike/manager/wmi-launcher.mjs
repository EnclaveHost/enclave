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

export const GUEST_FEATURE_SET = 0x00000201;   // the value Microsoft's script writes, kept as theirs
export const MIN_VM_VERSION = 12.0;            // their script throws below this
export const OWNER_MARKER = "enclave-vbslike-app-domain";

const ps = (s) => s.replace(/\r?\n\s*/g, " ").trim();
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
  create: ({ name, memMiB, vcpus, version = "12.0" }) => ps(`
    $ErrorActionPreference = 'Stop';
    $vm = $null;
    try {
      $vm = New-VM -Name ${q(name)} -Generation 2 -MemoryStartupBytes ${Math.round(memMiB)}MB -NoVHD -Version ${q(version)};
      Set-VM -VM $vm -Notes ${q(OWNER_MARKER)};
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
   * Did the GUEST say anything? A VM in state Running is a host-side fact; this is the only
   * evidence that something is alive inside it. Reads the console pipe for a bounded window and
   * reports how many bytes arrived and the first of them.
   */
  readConsole: ({ pipe, seconds = 20 }) => ps(`
    $ErrorActionPreference = 'Stop';
    $deadline = (Get-Date).AddSeconds(${Math.max(1, Math.floor(seconds))});
    $buf = New-Object byte[] 4096; $total = 0; $head = '';
    try {
      $fs = [IO.File]::Open(${q(pipe)}, 'Open', 'Read', 'ReadWrite');
      while ((Get-Date) -lt $deadline) {
        if ($fs.CanRead) {
          $n = 0;
          try { $n = $fs.Read($buf, 0, $buf.Length) } catch { $n = 0 };
          if ($n -gt 0) { $total += $n; if ($head.Length -lt 400) { $head += [Text.Encoding]::ASCII.GetString($buf, 0, [Math]::Min($n, 400)) } }
          else { Start-Sleep -Milliseconds 200 }
        }
      };
      $fs.Close()
    } catch { };
    @{bytes=$total; head=$head} | ConvertTo-Json -Compress`),

  state: ({ name }) => ps(`$v = Get-VM -Name ${q(name)} -ErrorAction SilentlyContinue; if ($v) { @{found=$true; state=[string]$v.State; uptime=[string]$v.Uptime} | ConvertTo-Json -Compress } else { @{found=$false} | ConvertTo-Json -Compress }`),
  stop: ({ name }) => ps(`Stop-VM -Name ${q(name)} -TurnOff -Force -ErrorAction SilentlyContinue; @{ok=$true} | ConvertTo-Json -Compress`),

  /**
   * Remove ONLY what this owns. Scoped by the instance prefix, and by the marker when it is there -
   * a VM that failed before its Notes were set still starts with the prefix, and leaving it behind
   * because the marker is missing is how an orphan becomes permanent. Failures are REPORTED, not
   * swallowed: a teardown that could not remove something must not read as a clean one.
   */
  teardown: ({ prefix, requireMarker = false }) => ps(`
    $vms = @(Get-VM -ErrorAction SilentlyContinue | Where-Object { $_.Name.StartsWith(${q(prefix)})${requireMarker ? ` -and $_.Notes -eq ${q(OWNER_MARKER)}` : ""} });
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
    $vms = @(Get-VM -ErrorAction SilentlyContinue | Where-Object { $_.Name.StartsWith(${q(prefix)}) });
    @{vms=@($vms | ForEach-Object { @{name=$_.Name; state=[string]$_.State; notes=[string]$_.Notes} })} | ConvertTo-Json -Compress -Depth 4`),
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
  constructor({ run, imagePath, imageSha256, prefix = "enclave-app-", pipeFor = null, jobTimeoutSec = 120 }) {
    if (typeof run !== "function") throw new Error("a PowerShell runner must be injected");
    this.run = run; this.imagePath = imagePath; this.imageSha256 = (imageSha256 || "").toLowerCase();
    // A STABLE prefix, not one keyed to a pid: a restarted manager must still recognise, and be
    // able to reconcile, the VMs its predecessor left behind.
    this.prefix = prefix;
    this.jobTimeoutSec = jobTimeoutSec;
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
  async start(mapping, { instanceId, guestReadySec = 25 } = {}) {
    if (!instanceId || !/^[A-Za-z0-9._-]{4,64}$/.test(String(instanceId)))
      throw new Error("a unique instanceId is required: naming a domain by its AppID alone collides when the same app is deployed twice");
    const pre = await this.preflight();
    if (!pre.ok) {
      const missing = pre.checks.filter((c) => !c.ok).map((c) => c.name);
      const e = new Error(`the Hyper-V role is not usable on this host: missing ${missing.join(", ")}`);
      e.code = "prerequisites_absent"; e.checks = pre.checks;
      throw e;
    }
    const image = await this.verifyImage();
    const name = `${this.prefix}${instanceId}`;
    const pipe = this.pipeFor(name);
    let created = null;
    try {
      created = await this.#ps(CMD.create({ name, memMiB: mapping.record.policy.memMiB, vcpus: mapping.record.policy.vcpus }));
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

      // THE GUEST ITSELF. Running is the host's word for the partition; this is the only thing that
      // says something inside it came up. No output, no running domain - the manager must never
      // report an app as running on the strength of a VM state alone.
      const console_ = await this.#ps(CMD.readConsole({ pipe, seconds: guestReadySec }));
      if (!(Number(console_.bytes) > 0))
        throw new Error(`the VM is Running but the guest said nothing on ${pipe} within ${guestReadySec}s: a partition that produced no output is not a domain that came up`);

      return { instanceId, name, vmId: created.id, pipe, state: started.state, image,
               appId: mapping.appId, guest: { bytes: console_.bytes, head: String(console_.head || "").slice(0, 400) },
               stop: async () => { await this.#ps(CMD.stop({ name })).catch(() => {}); } };
    } catch (e) {
      // Remove by THIS VM's exact name, whether or not `created` came back: the create script may
      // have made it and failed before reporting, which is the leak the first version had.
      const swept = await this.#ps(CMD.teardown({ prefix: name })).catch((x) => ({ error: x.message }));
      e.cleanup = swept;
      if (swept && Array.isArray(swept.failed) && swept.failed.length)
        e.message += ` (cleanup left ${swept.failed.length} VM(s) behind: ${swept.failed.map((f) => f.name).join(", ")})`;
      throw e;
    }
  }

  async stop(handle) { if (handle && handle.name) await this.#ps(CMD.stop({ name: handle.name })); }
  async state(name) { return await this.#ps(CMD.state({ name })); }
  /** What this prefix owns right now, including anything a previous run left behind. */
  async survey() { return await this.#ps(CMD.survey({ prefix: this.prefix })); }
  /**
   * Remove every VM under this prefix and SAY what could not be removed. It throws when anything
   * was left behind, because a teardown that reports success while an orphan survives is how a
   * host fills up with VMs nobody owns.
   */
  async teardown({ requireMarker = false } = {}) {
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
