// Independent SYSTEM lifecycle process. No VM start, adoption or resource release.
// A start owner cannot release its child until this process holds all exact peers.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;
namespace Enclave.OwnedRpc {
 public sealed partial class ProtectedAttempt {
  internal string PinLifecycleEvidence(string path,string hash){return PinLifecycleEvidence(path,hash,false);}
  internal string PinLifecycleEvidence(string path,string hash,bool backup){
   if(LeaseProfile!="native-start-journal"&&LeaseProfile!="native-lifecycle-journal"&&LeaseProfile!="native-bootstrap-journal")throw new InvalidOperationException("Original start custody required");CheckDeadline();LocalPath(path);Hex(hash,64);
   if(Path.GetFileName(path)!="contract.txt")throw new InvalidOperationException("Fixed lifecycle contract");string root=Path.GetDirectoryName(path),current=Path.GetPathRoot(root);HoldDirectory(current,false);
   foreach(string part in root.Substring(3).Split('\\')){current=Path.Combine(current,part);HoldDirectory(current,current==root);}
   byte[] raw=Bytes(HoldRead(path,2048),2048);if(Hash(raw)!=hash)throw new InvalidOperationException("Lifecycle contract changed");var f=Utf8.GetString(raw).Split('\n');var p=NativeDefinitionPlan;
   if(f.Length!=10||f[0]!="owned-native-rpc-lifecycle-v1"||f[6]!=(backup?"watch-backup":"watch")||f[7]!=Path.Combine(Root,"native-definition-plan.txt")||f[8]!=ContractHash||f[9]!="")throw new InvalidOperationException("Original lifecycle binding differs");
   Hex(f[1],32);Hex(f[2],32);Hex(f[5],64);long origin=Int64.Parse(f[3],NumberStyles.None,CultureInfo.InvariantCulture),end=Int64.Parse(f[4],NumberStyles.None,CultureInfo.InvariantCulture);
   if(Path.GetFileName(root)!=f[1]||root==Root||f[2]!=p.Boot||origin<p.Origin||origin>=p.Deadline||p.Deadline>Int64.MaxValue-30000||end!=p.Deadline+30000||origin>BoundedWorker.MonotonicMilliseconds())throw new InvalidOperationException("Lifecycle original window differs");
   if(Hash(Bytes(HoldRead(Path.Combine(root,"entry.exe"),262144),262144))!=f[5])throw new InvalidOperationException("Lifecycle image changed");CheckDeadline();return f[1]+f[2]+hash;
  }
 }
 internal static class NativeLifecycleBinding {
  internal static string Key(bool backup,bool bound){return backup?(bound?"native-lifecycle.backup-bound":"native-lifecycle.backup-armed"):(bound?"native-lifecycle.bound":"native-lifecycle.armed");}
  internal static bool Bound(IStartJournal journal,string workers){if(workers==null)return false;string h=NativeRpcDefinitionPlan.Hash(workers);return journal.Read(Key(false,true))==h&&journal.Read(Key(true,true))==h;}
  internal static NativeLifecyclePeer Peer(ProtectedAttempt pin,bool backup,out string raw){
   raw=new NativeRpcCleanupJournal(pin).Read(Key(backup,false));var d=StartRecords.Parse(raw,new[]{"schema","plan","contract","hash","identity"});
   if(StartRecords.Text(d["schema"])!="native-rpc-lifecycle-armed/1"||StartRecords.Text(d["plan"])!=pin.ContractHash)throw new InvalidOperationException("Original keeper arming absent");string path=StartRecords.Text(d["contract"]),hash=StartRecords.Text(d["hash"]),token=pin.PinLifecycleEvidence(path,hash,backup);
   return new NativeLifecyclePeer(StartRecords.Text(d["identity"]),token,backup?"lifecycle-backup":"lifecycle",Path.Combine(Path.GetDirectoryName(path),"entry.exe"),0);
  }
 }
 internal sealed class NativeLifecyclePeer:IDisposable {
  [DllImport("kernel32.dll",SetLastError=true)]static extern SafeWaitHandle OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)]static extern uint GetProcessId(IntPtr h);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetProcessTimes(IntPtr h,out long c,out long e,out long k,out long u);
  [DllImport("kernel32.dll")]static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetExitCodeProcess(IntPtr h,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool TerminateProcess(IntPtr h,uint code);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool QueryFullProcessImageName(IntPtr h,uint flags,StringBuilder name,ref int size);
  [DllImport("advapi32.dll",SetLastError=true)]static extern bool OpenProcessToken(IntPtr h,uint access,out SafeWaitHandle token);
  internal readonly SafeWaitHandle Handle;internal readonly string Identity;
  internal NativeLifecyclePeer(string identity,string token,string role,string image,uint access){
   var f=identity.Split(',');if(f.Length!=4||f[2]!=token||f[3]!=role)throw new InvalidOperationException("Original lifecycle peer binding differs");
   uint pid=UInt32.Parse(f[0],NumberStyles.None,CultureInfo.InvariantCulture);long creation=Int64.Parse(f[1],NumberStyles.None,CultureInfo.InvariantCulture);if(pid==0||creation<=0)throw new InvalidOperationException("Original peer incarnation absent");
   Handle=OpenProcess(access|0x1000|0x100000,false,pid);Identity=identity;
   try{if(Handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());long c,e,k,u;var h=Handle.DangerousGetHandle();
    if(GetProcessId(h)!=pid||!GetProcessTimes(h,out c,out e,out k,out u)||c!=creation||WaitForSingleObject(h,0)!=258)throw new InvalidOperationException("Original peer incarnation not alive");
    var name=new StringBuilder(512);int length=name.Capacity;if(!QueryFullProcessImageName(h,0,name,ref length)||!String.Equals(name.ToString(),image,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Original peer image differs");
    SafeWaitHandle security;if(!OpenProcessToken(h,8,out security))throw new Win32Exception(Marshal.GetLastWin32Error());using(security)using(var who=new WindowsIdentity(security.DangerousGetHandle()))if(who.User==null||who.User.Value!="S-1-5-18")throw new InvalidOperationException("Original peer is not SYSTEM");
   }catch{Handle.Dispose();throw;}
  }
  internal bool Alive{get{uint w=WaitForSingleObject(Handle.DangerousGetHandle(),0);if(w!=0&&w!=258)throw new InvalidOperationException("Original peer wait failed");return w==258;}}
  internal uint ExitCode{get{uint c;if(Alive||!GetExitCodeProcess(Handle.DangerousGetHandle(),out c))throw new InvalidOperationException("Exact peer exit absent");return c;}}
  internal void Stop(){if(Alive&&!TerminateProcess(Handle.DangerousGetHandle(),125)&&Alive)throw new Win32Exception(Marshal.GetLastWin32Error());}
  public void Dispose(){Handle.Dispose();}
 }
}
