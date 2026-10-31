// Read-only exact owned-VM NIC observation. No network scan or provider mutation.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Enclave.OwnedRpc {
 public static class VmEndpoint {
  [StructLayout(LayoutKind.Sequential)] struct Memory {public uint Length,Load;public ulong Total,Available,PageTotal,PageAvailable,VirtualTotal,VirtualAvailable,Extended;}
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GlobalMemoryStatusEx(ref Memory memory);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  static long Origin,Deadline;
  // Retain the actual 18 GiB host floor, full prospective commitments and256MiB
  // reader/bootstrap reservation. Caller/SSH overhead is separately admitted.
  internal const long MinimumFree=(18432L+39388L+256L)*1048576L;
  static void Current(){long now=BoundedWorker.MonotonicMilliseconds();if(now<Origin||now>=Deadline)throw new TimeoutException("Original endpoint lease expired");}
  internal static void Arm(long origin,long deadline){
   long now=BoundedWorker.MonotonicMilliseconds();
   if(origin<0||origin>Int64.MaxValue-30000||now<origin||now-origin>=5000||deadline<=now||deadline-origin>30000)throw new ArgumentException("Fresh bounded original lease required");
   Origin=origin;Deadline=deadline;var armed=new ManualResetEvent(false);
   new Thread(delegate(){armed.Set();while(BoundedWorker.MonotonicMilliseconds()<deadline)Thread.Sleep(5);
    if(!TerminateProcess(GetCurrentProcess(),124))Environment.FailFast("Endpoint watchdog termination failed");
   }){IsBackground=true}.Start();
   if(!armed.WaitOne(1000))throw new TimeoutException("Endpoint watchdog not armed");Current();
  }
  internal static string Select(string[] addresses){
   if(addresses==null||addresses.Length>16)throw new InvalidOperationException("Bounded guest address observation required");
   string selected=null;var seen=new HashSet<string>(StringComparer.Ordinal);
   foreach(string value in addresses){
    IPAddress ip;if(value==null||value.Length>64||!IPAddress.TryParse(value,out ip)||ip.ToString()!=value||!seen.Add(value))throw new InvalidOperationException("Canonical unique guest addresses required");
    if(ip.AddressFamily!=AddressFamily.InterNetwork)continue;
    byte[] b=ip.GetAddressBytes();
    if(b[0]==0||b[0]==127||b[0]>=224||(b[0]==169&&b[1]==254))continue;
    if(selected!=null)throw new InvalidOperationException("Multiple IPv4 endpoints are ambiguous");selected=value;
   }
   // Empty/link-local-only means pending, not an invitation to scan or guess.
   return selected;
  }
  static string[] ReadAddresses(string reference,Action current){
   current();var scope=HyperVStartProvider.Scope();
   using(var nic=new ManagementObject(scope,new ManagementPath(reference),new ObjectGetOptions{Timeout=TimeSpan.FromSeconds(2)})){
    nic.Get();if(BootStartBinding.Reference("nic",nic.Path.Path)!=reference)throw new InvalidOperationException("NIC reference changed");
    var options=new EnumerationOptions{ReturnImmediately=false,Rewindable=false,Timeout=TimeSpan.FromSeconds(2)};
    string[] result=null;int count=0;
    // Exact association documented by Microsoft; no host-wide address query.
    using(var rows=nic.GetRelated("Msvm_GuestNetworkAdapterConfiguration","Msvm_SettingDataComponent",null,null,"PartComponent","GroupComponent",false,options))
     foreach(ManagementObject row in rows)using(row){current();if(++count>1)throw new InvalidOperationException("Ambiguous guest NIC configuration");result=row["IPAddresses"] as string[];}
    if(count==0)return new string[0];if(result==null)throw new InvalidOperationException("Missing address array");current();return result;
   }
  }
  internal static string Observe(ProtectedAttempt vm){
   Current();long began=BoundedWorker.MonotonicMilliseconds();
   Action fresh=delegate{Current();vm.CheckDeadline();long now=BoundedWorker.MonotonicMilliseconds();if(now<began||now-began>2000)throw new TimeoutException("Aggregate endpoint observation exceeds two seconds");};
   var graph=new BootStartBinding(vm,fresh);graph.VerifyRunning();fresh();
   string[] first=ReadAddresses(graph.NetworkReference,fresh);string endpoint=Select(first);
   graph.VerifyRunning();string[] second=ReadAddresses(graph.NetworkReference,fresh);
   if(first.Length!=second.Length)throw new InvalidOperationException("Guest addresses changed");
   for(int i=0;i<first.Length;i++)if(first[i]!=second[i])throw new InvalidOperationException("Guest addresses changed");fresh();
   var p=vm.VmPermit;
   return new JavaScriptSerializer().Serialize(new Dictionary<string,object>{
    {"schema","owned-rpc-vm-endpoint/1"},{"vmAttempt",p.Attempt},{"windowsBoot",p.Boot},{"permitSha256",vm.ContractHash},
    {"vmGuid",p.VmGuid},{"switchGuid",graph.NetworkSwitch},{"mac",graph.NetworkMac},{"nicReference",graph.NetworkReference},
    {"originalOrigin",p.Origin},{"originalDeadline",p.Deadline},{"origin",Origin},{"deadline",Deadline},
    {"observedFrom",began},{"observedAt",BoundedWorker.MonotonicMilliseconds()},{"ipv4",endpoint},{"port",22},
    {"hostAssociationObserved",true},{"guestAuthenticated",false},{"attestationVerified",false},{"rpcReady",false},{"reservationMayRelease",false}});
  }
  static void Image(string expected){
   StartIdentity.Hex(expected,64);
   using(var self=Process.GetCurrentProcess())using(var f=new FileStream(self.MainModule.FileName,FileMode.Open,FileAccess.Read,FileShare.Read)){
    ProtectedAttempt.Authority(f.SafeFileHandle,true,false,self.MainModule.FileName);
    if(f.Length<1||f.Length>262144)throw new InvalidOperationException("Endpoint image bound");
    var bytes=new byte[(int)f.Length];int at=0;
    while(at<bytes.Length){Current();int n=f.Read(bytes,at,bytes.Length-at);if(n==0)throw new IOException("Short image");at+=n;}
    if(f.ReadByte()!=-1||ProtectedAttempt.Hash(bytes)!=expected)throw new InvalidOperationException("Endpoint image differs");
   }
  }
  public static int Main(string[] args){
   try{
    if(args.Length!=6)return 64;
    long origin=Int64.Parse(args[3],NumberStyles.None,CultureInfo.InvariantCulture),deadline=Int64.Parse(args[4],NumberStyles.None,CultureInfo.InvariantCulture);
    Arm(origin,deadline);
    using(var self=Process.GetCurrentProcess())if(self.PrivateMemorySize64>64L*1048576)throw new InvalidOperationException("Endpoint bootstrap allowance exceeded");
    var envelope=BoundedWorker.EnterSupervisorEnvelope(128UL*1048576);
    if(!envelope.MembershipVerified||!envelope.LimitsVerified)throw new InvalidOperationException("Endpoint envelope differs");
    long required=Int64.Parse(args[5],NumberStyles.None,CultureInfo.InvariantCulture);
    if(required<MinimumFree)throw new ArgumentException("Retained pending-aware floor required");
    var memory=new Memory{Length=(uint)Marshal.SizeOf(typeof(Memory))};
    if(!GlobalMemoryStatusEx(ref memory))throw new Win32Exception(Marshal.GetLastWin32Error());
    if(memory.Available<(ulong)required)throw new InvalidOperationException("Endpoint capacity refused");
    Image(args[2]);
    using(var vm=ProtectedAttempt.PinVmGuardianController(args[0],args[1])){
     if(origin<vm.Origin||deadline>vm.Deadline)throw new InvalidOperationException("Original startup deadline differs");
     string receipt=Observe(vm);Current();
     var json=new JavaScriptSerializer();var result=(Dictionary<string,object>)json.DeserializeObject(receipt);
     result.Add("envelope",envelope);result.Add("requiredFreeBytes",required);result.Add("freeBytes",memory.Available);
     Console.WriteLine(json.Serialize(result));return 0;
    }
   }catch(Exception e){Console.Error.WriteLine(e.GetType().Name+": "+e.Message);return 1;}
  }
 }
}
