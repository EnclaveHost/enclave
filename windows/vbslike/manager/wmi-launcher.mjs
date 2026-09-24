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

  /** Create the VM. Generation 2 and an explicit version, because the firmware field needs >= 12.0. */
  create: ({ name, memMiB, vcpus, version = "12.0" }) => ps(`
    $vm = New-VM -Name ${q(name)} -Generation 2 -MemoryStartupBytes ${Math.round(memMiB)}MB -NoVHD -Version ${q(version)};
    Set-VMProcessor -VM $vm -Count ${Math.max(1, Math.floor(vcpus))};
    Set-VMMemory -VM $vm -DynamicMemoryEnabled $false;
    Set-VM -VM $vm -AutomaticStartAction Nothing -AutomaticStopAction TurnOff -CheckpointType Disabled -Notes ${q(OWNER_MARKER)};
    @{id=$vm.Id.Guid; version=[string]$vm.Version; name=$vm.Name} | ConvertTo-Json -Compress`),

  /** Pin the firmware. This is Set-OpenHCL-HyperV-VM.ps1's own sequence. */
  pinFirmware: ({ vmId, imagePath }) => ps(`
    $ns = 'root\\virtualization\\v2';
    $vm = Get-CimInstance -Namespace $ns -Query ("select * from Msvm_ComputerSystem where Name = '" + ${q(vmId)} + "'");
    if (-not $vm) { throw 'no Msvm_ComputerSystem for ' + ${q(vmId)} };
    $vssd = $vm | Get-CimAssociatedInstance -ResultClass Msvm_VirtualSystemSettingData -Association Msvm_SettingsDefineState;
    $vssd.GuestFeatureSet = ${GUEST_FEATURE_SET};
    $vssd.FirmwareFile = ${q(imagePath)};
    $svc = Get-CimInstance -Namespace $ns -ClassName Msvm_VirtualSystemManagementService;
    $txt = ($vssd | ConvertTo-CimEmbeddedString);
    $res = Invoke-CimMethod -InputObject $svc -Name ModifySystemSettings -Arguments @{SystemSettings = $txt};
    @{returnValue=$res.ReturnValue; job=[string]$res.Job} | ConvertTo-Json -Compress`),

  /** A serial port to a named pipe: the only way this learns what the guest said. */
  attachConsole: ({ name, pipe }) => ps(`
    Set-VMComPort -VMName ${q(name)} -Number 1 -Path ${q(pipe)};
    @{ok=$true} | ConvertTo-Json -Compress`),

  start: ({ name }) => ps(`Start-VM -Name ${q(name)}; @{state=[string](Get-VM -Name ${q(name)}).State} | ConvertTo-Json -Compress`),
  state: ({ name }) => ps(`$v = Get-VM -Name ${q(name)} -ErrorAction SilentlyContinue; if ($v) { @{found=$true; state=[string]$v.State; uptime=[string]$v.Uptime} | ConvertTo-Json -Compress } else { @{found=$false} | ConvertTo-Json -Compress }`),
  stop: ({ name }) => ps(`Stop-VM -Name ${q(name)} -TurnOff -Force -ErrorAction SilentlyContinue; @{ok=$true} | ConvertTo-Json -Compress`),

  /** Remove ONLY what this owns: the instance prefix AND the marker in Notes. Both, never one. */
  teardown: ({ prefix }) => ps(`
    $vms = @(Get-VM -ErrorAction SilentlyContinue | Where-Object { $_.Name.StartsWith(${q(prefix)}) -and $_.Notes -eq ${q(OWNER_MARKER)} });
    foreach ($v in $vms) { Stop-VM -VM $v -TurnOff -Force -ErrorAction SilentlyContinue; Remove-VM -VM $v -Force -ErrorAction SilentlyContinue };
    @{removed=$vms.Count; names=@($vms | ForEach-Object { $_.Name })} | ConvertTo-Json -Compress`),
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
  constructor({ run, imagePath, imageSha256, prefix = `enclave-app-${process.pid}-`, pipeFor = null }) {
    if (typeof run !== "function") throw new Error("a PowerShell runner must be injected");
    this.run = run; this.imagePath = imagePath; this.imageSha256 = (imageSha256 || "").toLowerCase();
    this.prefix = prefix;
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
   * Create, pin, attach a console, start. Any failure after creation tears THIS VM down before
   * rethrowing, so a half-built domain never outlives the attempt that made it.
   */
  async start(mapping) {
    const pre = await this.preflight();
    if (!pre.ok) {
      const missing = pre.checks.filter((c) => !c.ok).map((c) => c.name);
      const e = new Error(`the Hyper-V role is not usable on this host: missing ${missing.join(", ")}`);
      e.code = "prerequisites_absent"; e.checks = pre.checks;
      throw e;
    }
    const image = await this.verifyImage();
    const name = `${this.prefix}${String(mapping.appId).slice(0, 12)}`;
    const pipe = this.pipeFor(name);
    let created = null;
    try {
      created = await this.#ps(CMD.create({ name, memMiB: mapping.record.policy.memMiB, vcpus: mapping.record.policy.vcpus }));
      if (parseFloat(created.version) < MIN_VM_VERSION)
        throw new Error(`VM version ${created.version} is below ${MIN_VM_VERSION}, which the firmware field requires`);
      const pinned = await this.#ps(CMD.pinFirmware({ vmId: created.id, imagePath: this.imagePath }));
      // 0 is done, 4096 is "job started" - Microsoft's script treats both as success and so does this
      if (pinned.returnValue !== 0 && pinned.returnValue !== 4096)
        throw new Error(`ModifySystemSettings returned ${pinned.returnValue}`);
      await this.#ps(CMD.attachConsole({ name, pipe }));
      const started = await this.#ps(CMD.start({ name }));
      return { name, vmId: created.id, pipe, state: started.state, image,
               stop: async () => { await this.#ps(CMD.stop({ name })).catch(() => {}); } };
    } catch (e) {
      if (created) await this.run(CMD.teardown({ prefix: name })).catch(() => {});
      throw e;
    }
  }

  async stop(handle) { if (handle && handle.name) await this.#ps(CMD.stop({ name: handle.name })).catch(() => {}); }
  async state(name) { return await this.#ps(CMD.state({ name })); }
  /** Remove every VM THIS instance owns. Scoped by prefix and marker, both required. */
  async teardown() { return await this.#ps(CMD.teardown({ prefix: this.prefix })); }
}
