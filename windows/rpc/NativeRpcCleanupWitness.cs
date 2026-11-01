// Exact start-group custody for native cleanup. Accepts only preheld handles
// transferred by the independent lifecycle owner; never opens a numeric PID.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace Enclave.OwnedRpc {
 internal sealed class NativeRpcStartGroup:IDisposable {
  [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool DuplicateHandle(IntPtr from,IntPtr source,IntPtr to,out SafeWaitHandle target,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll",SetLastError=true)]static extern uint GetProcessId(IntPtr h);
  [DllImport("kernel32.dll",SetLastError=true)]static extern uint WaitForSingleObject(IntPtr h,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetProcessTimes(IntPtr h,out long creation,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool QueryFullProcessImageName(IntPtr h,uint flags,StringBuilder name,ref int size);
  [DllImport("advapi32.dll",SetLastError=true)]static extern bool OpenProcessToken(IntPtr h,uint access,out SafeWaitHandle token);
  readonly List<SafeWaitHandle> handles=new List<SafeWaitHandle>();readonly ProtectedAttempt pin;readonly string digest;bool disposed;
  internal NativeRpcStartGroup(ProtectedAttempt pin,IntPtr[] transferred){
   if(pin==null||pin.LeaseProfile!="native-cleanup-journal"||transferred==null||transferred.Length!=3)throw new ArgumentException("Original cleanup and three preheld peers required");
   this.pin=pin;var journal=new NativeRpcCleanupJournal(pin);string raw=journal.Read("native-start.workers");
   var d=StartRecords.Parse(raw,new[]{"schema","plan","intent","contractPath","contractHash","owner","observer","child"});
   string path=StartRecords.Text(d["contractPath"]),hash=StartRecords.Text(d["contractHash"]),guid,authority;
   string intent=NativeRpcStart.Prepared(pin.NativeDefinitionPlan,journal,out guid,out authority);
   if(StartRecords.Text(d["schema"])!="native-rpc-start-workers/1"||StartRecords.Text(d["plan"])!=pin.ContractHash||StartRecords.Text(d["intent"])!=intent)throw new InvalidOperationException("Original prepared start group differs");
   string token=pin.PinNativeStartGroup(path,hash);digest=NativeRpcDefinitionPlan.Hash(raw);var ids=new HashSet<uint>();int index=0;
   try{foreach(string role in new[]{"owner","observer","child"}){
    string identity=StartRecords.Text(d[role]);if(identity!=pin.PinNativeStartPeer(path,role))throw new InvalidOperationException("Original peer record differs");var f=identity.Split(',');
    if(f.Length!=4||f[2]!=token||f[3]!=role)throw new InvalidOperationException("Original peer contract differs");uint pid=UInt32.Parse(f[0],NumberStyles.None,CultureInfo.InvariantCulture);long creation=Int64.Parse(f[1],NumberStyles.None,CultureInfo.InvariantCulture);
    if(pid==0||creation<=0||!ids.Add(pid)||transferred[index]==IntPtr.Zero||transferred[index]==new IntPtr(-1))throw new InvalidOperationException("Distinct original peer handles required");
    SafeWaitHandle held;if(!DuplicateHandle(GetCurrentProcess(),transferred[index++],GetCurrentProcess(),out held,0x1000|0x100000,false,0))throw new Win32Exception(Marshal.GetLastWin32Error());handles.Add(held);
    long actual,exit,k,u;IntPtr h=held.DangerousGetHandle();if(GetProcessId(h)!=pid||!GetProcessTimes(h,out actual,out exit,out k,out u)||actual!=creation)throw new InvalidOperationException("Original held peer incarnation differs");
    var name=new StringBuilder(512);int size=name.Capacity;if(!QueryFullProcessImageName(h,0,name,ref size)||!String.Equals(name.ToString(),Path.Combine(Path.GetDirectoryName(path),"entry.exe"),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Original held peer image differs");
    SafeWaitHandle security;if(!OpenProcessToken(h,8,out security))throw new Win32Exception(Marshal.GetLastWin32Error());using(security)using(var who=new WindowsIdentity(security.DangerousGetHandle()))if(who.User==null||who.User.Value!="S-1-5-18")throw new InvalidOperationException("Original peer is not SYSTEM");
   }pin.CheckDeadline();}catch{Dispose();throw;}
  }
  internal string RequireDead(){if(disposed)throw new ObjectDisposedException("NativeRpcStartGroup");pin.CheckDeadline();foreach(var h in handles)if(WaitForSingleObject(h.DangerousGetHandle(),0)!=0)throw new InvalidOperationException("Original provider owner observer or child still alive");pin.CheckDeadline();return digest;}
  public void Dispose(){if(disposed)return;disposed=true;foreach(var h in handles)h.Dispose();}
 }
 internal sealed class NativeRpcCleanupRuntime:INativeRpcCleanupRuntime {
  readonly ProtectedAttempt lease,pin;readonly NativeRpcStartGroup group;readonly Action guard;
  internal NativeRpcCleanupRuntime(ProtectedAttempt lease,ProtectedAttempt pin,NativeRpcStartGroup group,Action guard){
   if(lease==null||pin==null||group==null||guard==null||lease.LeaseProfile!="native-cleanup"||pin.LeaseProfile!="native-cleanup-journal"||lease.PermitHash!=pin.ContractHash)throw new ArgumentException("Supervised original cleanup runtime required");this.lease=lease;this.pin=pin;this.group=group;this.guard=guard;
  }
  public long Now{get{return BoundedWorker.MonotonicMilliseconds();}}
  public void Check(NativeRpcDefinitionPlan p,bool mutation){
   ProtectedAttempt.RequireSystem();guard();lease.CheckDeadline();pin.CheckDeadline();
   if(p==null||p.Encode()!=pin.NativeDefinitionPlan.Encode()||p.Boot!=ProtectedAttempt.CurrentBoot()||p.Origin>Now||p.Deadline>Int64.MaxValue-30000||Now>=p.Deadline+30000||(mutation&&lease.Operation!="stop"))throw new InvalidOperationException("Original cleanup authority/window differs");
   group.RequireDead();guard();lease.CheckDeadline();
  }
  public string RequireStartWorkersDead(NativeRpcDefinitionPlan p){Check(p,false);return group.RequireDead();}
  public bool WaitForCleanupObservation(NativeRpcDefinitionPlan p){Check(p,false);if(Math.Min(lease.Deadline,p.Deadline+30000)-Now<=25)return false;System.Threading.Thread.Sleep(25);Check(p,false);return true;}
 }
}
