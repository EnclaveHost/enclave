// A process cut around the old mandatory template-copy path. This neither
// cancels provider jobs nor admits memory: ALL defined VM maxima must be read
// AFTER CutAt and retained, including Off/Starting/ambiguous VMs.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;
namespace Enclave.OwnedRpc {
 public static class LegacyLaunchCohort {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Entry {
   public uint Size,Usage,Pid;public UIntPtr Heap;public uint Module,Threads,Parent;
   public int Priority;public uint Flags;
   [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string Name;
  }
  [DllImport("kernel32.dll",SetLastError=true)] static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32FirstW(SafeFileHandle h,ref Entry e);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32NextW(SafeFileHandle h,ref Entry e);
  [DllImport("kernel32.dll",SetLastError=true)] static extern SafeFileHandle OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(SafeFileHandle h,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(SafeFileHandle h,uint flags,StringBuilder value,ref uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(SafeFileHandle h,uint millis);
  public sealed class Issuer {
   public readonly uint Pid;public readonly long Created;public readonly string Image;
   public Issuer(uint pid,long created,string image){
    ProtectedAttempt.LocalPath(image);if(pid==0||created<=0)throw new ArgumentException("Exact issuer identity required");
    Pid=pid;Created=created;Image=image;
   }
  }
  public sealed class ProcessIdentity {
   public uint Pid;public long Created;public string Image;
  }
  public sealed class Receipt {
   public LegacyTemplateFence.Receipt Fence;
   public ProcessIdentity[] Exited;
   public long CutAt;
   public bool ProviderOperationsSettled {get{return false;}}
   public bool CapacityAdmitted {get{return false;}}
   public bool ReservationMayRelease {get{return false;}}
  }
  sealed class Held : IDisposable {
   public readonly SafeFileHandle Handle;public readonly ProcessIdentity Identity;
   public Held(uint pid){
    Handle=OpenProcess(0x100000|0x1000,false,pid);
    if(Handle.IsInvalid){int e=Marshal.GetLastWin32Error();Handle.Dispose();throw new Win32Exception(e,"Snapshot process could not be held; outcome unknown");}
    try{
     long c,x,k,u;if(!GetProcessTimes(Handle,out c,out x,out k,out u))throw new Win32Exception(Marshal.GetLastWin32Error());
     var b=new StringBuilder(1024);uint n=1024;if(!QueryFullProcessImageNameW(Handle,0,b,ref n))throw new Win32Exception(Marshal.GetLastWin32Error());
     Identity=new ProcessIdentity{Pid=pid,Created=c,Image=b.ToString()};
    }catch{Handle.Dispose();throw;}
   }
   public bool Dead(){uint r=WaitForSingleObject(Handle,0);if(r==0)return true;if(r==258)return false;throw new Win32Exception(Marshal.GetLastWin32Error());}
   public void Dispose(){Handle.Dispose();}
  }
  static void Check(long d){if(BoundedWorker.MonotonicMilliseconds()>=d)throw new InvalidOperationException("Legacy process cut expired; keep fence and claims held");}
  static void IssuersLive(List<Held> issuers,long d){Check(d);foreach(var p in issuers)if(p.Dead())throw new InvalidOperationException("Retained issuer exited; serving handoff unqualified");}
  static void Capture(List<Held> issuers,Dictionary<string,Held> cohort,string shell,long d){
   IssuersLive(issuers,d);var parents=new HashSet<uint>();foreach(var p in issuers)parents.Add(p.Identity.Pid);
   using(var snapshot=CreateToolhelp32Snapshot(2,0)){
    if(snapshot.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
    var e=new Entry{Size=(uint)Marshal.SizeOf(typeof(Entry))};
    if(!Process32FirstW(snapshot,ref e))throw new Win32Exception(Marshal.GetLastWin32Error());
    int count=0;
    do{
     Check(d);if(++count>8192)throw new InvalidOperationException("Process snapshot bound");
     // The pinned old psrun creates PowerShell DIRECTLY. This is not a generic
     // descendant scanner: a different launch topology must not use this cut.
     if(parents.Contains(e.Parent)&&String.Equals(e.Name,Path.GetFileName(shell),StringComparison.OrdinalIgnoreCase)){
      if(cohort.Count>=64)throw new InvalidOperationException("Legacy cohort bound");
      var p=new Held(e.Pid);bool keep=false;
      try{
       if(!String.Equals(p.Identity.Image,shell,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Unexpected legacy shell image");
       // A reused snapshot PID cannot silently replace an already-held identity.
       foreach(var old in cohort.Values)if(old.Identity.Pid==e.Pid&&old.Identity.Created!=p.Identity.Created)
        throw new InvalidOperationException("Snapshot PID reuse; keep outcome held");
       string key=e.Pid+":"+p.Identity.Created;
       if(!cohort.ContainsKey(key)){cohort.Add(key,p);keep=true;}
      }finally{if(!keep)p.Dispose();}
     }
    }while(Process32NextW(snapshot,ref e));
    if(Marshal.GetLastWin32Error()!=18)throw new Win32Exception(Marshal.GetLastWin32Error());
   }
   IssuersLive(issuers,d);
  }
  // Must run inside the independently bounded protected worker. The caller
  // supplies qualified source/config/issuer coverage, not an arbitrary list of
  // PIDs inferred from an empty API response. Exactly one shared old master is
  // supported; multiple masters require an explicit different implementation.
  public static Receipt ApplyAndDrain(Issuer[] expected,string shell,string master,string hash,long length,string boot,string intent,long deadline){
   ProtectedAttempt.RequireAdministrator();ProtectedAttempt.LocalPath(shell);
   if(expected==null||expected.Length<1||expected.Length>2||
      !String.Equals(shell,Path.Combine(Environment.SystemDirectory,@"WindowsPowerShell\v1.0\powershell.exe"),StringComparison.OrdinalIgnoreCase))
    throw new ArgumentException("One or two exact direct PowerShell issuers required");
   long now=BoundedWorker.MonotonicMilliseconds();if(deadline<=now||deadline-now>10000)throw new ArgumentException("Original finite cut deadline required");
   var issuers=new List<Held>();var cohort=new Dictionary<string,Held>();
   try{
    foreach(var e in expected){
     if(e==null)throw new ArgumentException("Missing issuer");foreach(var old in issuers)if(old.Identity.Pid==e.Pid)throw new ArgumentException("Duplicate issuer");
     var p=new Held(e.Pid);issuers.Add(p);
     if(p.Identity.Created!=e.Created||!String.Equals(p.Identity.Image,e.Image,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Retained issuer identity differs");
    }
    Capture(issuers,cohort,shell,deadline);
    var fence=LegacyTemplateFence.Apply(master,hash,length,boot,intent,deadline);
    // Includes defining shells born between the first snapshot and the fence.
    // New shells after the fence cannot pass the mandatory master read/copy.
    Capture(issuers,cohort,shell,deadline);
    while(true){
     IssuersLive(issuers,deadline);bool done=true;foreach(var p in cohort.Values)if(!p.Dead())done=false;
     if(done)break;Thread.Sleep(5);
    }
    IssuersLive(issuers,deadline);var identities=new List<ProcessIdentity>();foreach(var p in cohort.Values)identities.Add(p.Identity);
    var result=new Receipt{Fence=fence,Exited=identities.ToArray()};
    IssuersLive(issuers,deadline);result.CutAt=BoundedWorker.MonotonicMilliseconds();Check(deadline);return result;
   }finally{foreach(var p in cohort.Values)p.Dispose();foreach(var p in issuers)p.Dispose();}
  }
 }
}
