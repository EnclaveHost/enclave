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
  internal void Stop(){if(Alive&&!TerminateProcess(Handle.DangerousGetHandle(),125))throw new Win32Exception(Marshal.GetLastWin32Error());}
  public void Dispose(){Handle.Dispose();}
 }
}
