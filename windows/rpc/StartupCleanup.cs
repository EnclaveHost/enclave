// Independent startup cleanup binding. This is host-owner lifecycle authority,
// not an RPC-readiness proof and never permission to release a memory claim.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
namespace Enclave.OwnedRpc {
 public sealed class StartupCleanupBinding {
  public const long ReservedBytes=192L*1048576;
  public readonly string ImageHash;
  StartupCleanupBinding(string hash){StartIdentity.Hex(hash,64);ImageHash=hash;}
  internal static StartupCleanupBinding Parse(object value){
   var d=value as Dictionary<string,object>;
   if(d==null||d.Count!=3||!d.ContainsKey("schema")||!d.ContainsKey("imageHash")||!d.ContainsKey("reservedBytes")||StartRecords.Text(d["schema"])!="owned-rpc-startup-cleanup/1"||StartRecords.Number(d["reservedBytes"])!=ReservedBytes)throw new InvalidOperationException("Explicit reserved cleanup binding required");
   return new StartupCleanupBinding(StartRecords.Text(d["imageHash"]));
  }
  internal static StartupCleanupBinding Read(ProtectedAttempt vm){
   if(vm==null||vm.VmPermit==null)throw new ArgumentException("Held VM permit required");
   var json=new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=32};
   var d=json.DeserializeObject(new UTF8Encoding(false,true).GetString(vm.ReadAdmission(vm.VmPermit.AdmissionHash))) as Dictionary<string,object>;object value;
   if(d==null||!d.TryGetValue("startupCleanup",out value))throw new InvalidOperationException("Independent startup cleanup not reviewed");return Parse(value);
  }
  internal string Armed(ProtectedAttempt vm,uint pid,long creation){
   var p=vm.VmPermit;return StartRecords.Encode(new Dictionary<string,object>{{"schema","owned-rpc-cleanup-armed/1"},{"permit",vm.ContractHash},{"boot",p.Boot},{"origin",p.Origin},{"deadline",p.Deadline},{"pid",pid},{"created",creation},{"image",ImageHash}});
  }
 }
 public sealed partial class ProtectedAttempt {
  internal byte[] ReadCleanupImage(string hash){Hex(hash,64);CheckDeadline();byte[] raw=Bytes(HoldRead(Path.Combine(Root,"cleanup.exe"),262144),262144);if(Hash(raw)!=hash)throw new InvalidOperationException("Cleanup executable digest differs");return raw;}
  internal byte[] ReadStartupReport(string hash){Hex(hash,64);CheckDeadline();byte[] raw=Bytes(HoldRead(Path.Combine(Root,"startup-report.json"),65536),65536);if(Hash(raw)!=hash)throw new InvalidOperationException("Adopted report differs");return raw;}
  public static ProtectedAttempt OpenStartupCleanup(string path,string hash,long origin,long deadline){RequireSystem();return new ProtectedAttempt(path,hash,origin,deadline);}
  private ProtectedAttempt(string path,string hash,long origin,long startupDeadline){
   LocalPath(path);Hex(hash,64);if(Path.GetFileName(path)!="vm-permit.txt")throw new ArgumentException("Exact original VM permit required");
   Root=Path.GetDirectoryName(path);ContractHash=hash;recordOwner=SystemSid;startupCleanup=true;LeaseProfile="startup-cleanup";
   try{
    string current=Path.GetPathRoot(Root);HoldDirectory(current,false);string[] parts=Root.Substring(3).Split('\\');
    for(int i=0;i<parts.Length;i++){current=Path.Combine(current,parts[i]);HoldDirectory(current,i==parts.Length-1);}
    byte[] raw=Bytes(HoldRead(path,2048),2048);if(Hash(raw)!=hash)throw new InvalidOperationException("Original cleanup permit differs");
    VmPermit=OwnedVmPermit.Parse(Utf8.GetString(raw));var p=VmPermit;
    if(p.Origin!=origin||p.Deadline!=startupDeadline||origin>Int64.MaxValue-930000||BoundedWorker.MonotonicMilliseconds()<origin||BoundedWorker.MonotonicMilliseconds()>=startupDeadline)throw new InvalidOperationException("Cleanup must arm before original startup expires");
    Nonce=p.Attempt;Boot=p.Boot;Origin=p.Origin;Deadline=checked(p.Deadline+30000);ExecutableHash=p.ImageHash;
    if(Path.GetFileName(Root)!=Nonce||p.ConfigurationRoot!=Path.Combine(Root,"vm")||Boot!=CurrentBoot())throw new InvalidOperationException("Original cleanup namespace differs");
    if(Hash(Bytes(HoldRead(Path.Combine(Root,"entry.exe"),262144),262144))!=ExecutableHash)throw new InvalidOperationException("Original provider image differs");
    CheckDeadline();
   }catch{Dispose();throw;}
  }
 }
 // Retained by the start worker through its native submit. This checks a real
 // independently running SYSTEM process, not task state or an 'armed' file alone.
 internal sealed class StartupCleanupWitness:IDisposable {
  [DllImport("kernel32.dll",SetLastError=true)]static extern SafeWaitHandle OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetProcessTimes(IntPtr p,out long creation,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool QueryFullProcessImageName(IntPtr p,uint flags,StringBuilder path,ref int size);
  [DllImport("advapi32.dll",SetLastError=true)]static extern bool OpenProcessToken(IntPtr p,uint access,out SafeWaitHandle token);
  readonly SafeWaitHandle process;readonly uint pid;readonly long created,deadline;
  internal StartupCleanupWitness(ProtectedAttempt vm){
   var b=StartupCleanupBinding.Read(vm);vm.ReadCleanupImage(b.ImageHash);
   var d=StartRecords.Parse(vm.ReadOnce("cleanup.armed"),new[]{"schema","permit","boot","origin","deadline","pid","created","image"});
   long n=StartRecords.Number(d["pid"]);if(n<=0||n>UInt32.MaxValue)throw new InvalidOperationException("Cleanup PID bound");pid=(uint)n;created=StartRecords.Number(d["created"]);deadline=vm.VmPermit.Deadline;
   if(b.Armed(vm,pid,created)!=vm.ReadOnce("cleanup.armed")||created<=0)throw new InvalidOperationException("Original cleanup process binding differs");
   process=OpenProcess(0x1000|0x100000,false,pid);if(process.IsInvalid){int error=Marshal.GetLastWin32Error();process.Dispose();throw new Win32Exception(error);}
   try{
    Check();long c,e,k,u;if(!GetProcessTimes(process.DangerousGetHandle(),out c,out e,out k,out u)||c!=created)throw new InvalidOperationException("Cleanup incarnation differs");
    var name=new StringBuilder(512);int length=name.Capacity;if(!QueryFullProcessImageName(process.DangerousGetHandle(),0,name,ref length)||!String.Equals(name.ToString(),Path.Combine(vm.Root,"cleanup.exe"),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Cleanup image path differs");
    SafeWaitHandle token;if(!OpenProcessToken(process.DangerousGetHandle(),8,out token))throw new Win32Exception(Marshal.GetLastWin32Error());
    using(token)using(var identity=new WindowsIdentity(token.DangerousGetHandle()))if(identity.User==null||identity.User.Value!="S-1-5-18")throw new InvalidOperationException("Cleanup is not SYSTEM");Check();
   }catch{process.Dispose();throw;}
  }
  internal void Check(){BoundedWorker.VerifyObserverBeforeResume(process.DangerousGetHandle(),pid,created,deadline);}
  public void Dispose(){if(process!=null)process.Dispose();}
 }
 // A published decision is immutable: evaluate once. Diagnostic failure must
 // never abort the independent cleanup path or leak repeated held file handles.
 internal sealed class StartupAdoptionPoll {
  bool refused;
  internal bool Check(Func<bool> beforeDeadline,Func<string> read,Action<string> validate,Action recordRefusal){
   if(refused||!beforeDeadline())return false;
   try{string raw=read();if(raw==null)return false;validate(raw);return beforeDeadline();}
   catch{refused=true;try{recordRefusal();}catch{}return false;}
  }
 }
 internal static class StartupOperatorAdoption {
  // An explicit protected host-owner decision. This deliberately does not claim
  // that a report digest proves sync/finality or consumer readiness. The operator
  // must verify those before publishing. No automatic adoption producer exists.
  internal static void Validate(string raw,OwnedVmPermit p,string permitHash,string intent,string receipt,string reportHash,long now){
   var d=StartRecords.Parse(raw,new[]{"schema","permit","boot","vmGuid","startIntent","startReceipt","reportHash","observedAt","decision"});
   long observed=StartRecords.Number(d["observedAt"]);
   if(now<p.Origin||now>=p.Deadline||observed<p.Origin||observed>now||StartRecords.Text(d["schema"])!="owned-rpc-operator-adoption/1"||StartRecords.Text(d["decision"])!="retain-owned-vm"||StartRecords.Text(d["permit"])!=permitHash||StartRecords.Text(d["boot"])!=p.Boot||StartRecords.Text(d["vmGuid"])!=p.VmGuid||
      StartRecords.Text(d["startIntent"])!=ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(intent))||StartRecords.Text(d["startReceipt"])!=ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(receipt))||StartRecords.Text(d["reportHash"])!=reportHash)throw new InvalidOperationException("Explicit original-window adoption differs");
   StartIdentity.Hex(reportHash,64);p.Bind(StartIdentity.Decode(intent),permitHash);
  }
 }
}
