// Protected one-shot legacy memory handoff. No VM/provider mutation, pool reset,
// claim release or automatic retry. Only the reviewed template DACL is changed.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
namespace Enclave.OwnedRpc {
 public sealed class LegacyHandoff : IDisposable {
  readonly ProtectedAttempt lease;readonly Action live;
  readonly JavaScriptSerializer json=new JavaScriptSerializer{MaxJsonLength=65536,RecursionLimit=16};
  readonly List<IDisposable> held=new List<IDisposable>();
  readonly HashSet<string> parents=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  readonly Dictionary<string,object> manifest,master;
  readonly IList issuers,inputs;
  readonly Dictionary<uint,Process> processes=new Dictionary<uint,Process>();
  readonly bool inspect;
  [StructLayout(LayoutKind.Sequential,Pack=4)] struct Info {public uint Attributes;public long Created,Accessed,Written;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
  LegacyHandoff(ProtectedAttempt lease,Action live){
   if(lease==null||live==null||lease.LeaseProfile!="legacy-handoff")throw new ArgumentException("Protected handoff authority required");
   this.lease=lease;this.live=live;inspect=lease.Operation=="legacy-memory-inspect-v1";manifest=Obj(json.DeserializeObject(new UTF8Encoding(false,true).GetString(lease.ReadLegacyHandoff())));
   Keys(manifest,"schema","boot","topology","master","issuers","inputs");
   if(Str(manifest["schema"])!="legacy-memory-handoff/1"||Str(manifest["topology"])!="mandatory-copy-direct-powershell/1"||Str(manifest["boot"])!=lease.Boot)
    throw new InvalidOperationException("Reviewed handoff topology/boot differs");
   master=Obj(manifest["master"]);Keys(master,"path","sha256","bytes");
   ProtectedAttempt.LocalPath(Str(master["path"]));StartIdentity.Hex(Str(master["sha256"]),64);
   if(Num(master["bytes"])<1||Num(master["bytes"])>16*1048576)throw new InvalidOperationException("Master size bound");
   issuers=Rows(manifest["issuers"],2);inputs=Rows(manifest["inputs"],128);
   if(issuers.Count<1||(!inspect&&inputs.Count<1))throw new InvalidOperationException("Reviewed issuer/source closure absent");
  }
  internal static Dictionary<string,object> Obj(object v){var d=v as Dictionary<string,object>;if(d==null)throw new InvalidOperationException("Object required");return d;}
  internal static string Str(object v){var s=v as string;if(s==null||s.Length>4096)throw new InvalidOperationException("String bound");return s;}
  internal static long Num(object v){if(!(v is int)&&!(v is long))throw new InvalidOperationException("Integral field required");return Convert.ToInt64(v,CultureInfo.InvariantCulture);}
  static IList Rows(object v,int max){var a=v as IList;if(a==null||a.Count>max)throw new InvalidOperationException("Row bound");return a;}
  static void Keys(Dictionary<string,object> d,params string[] keys){if(d.Count!=keys.Length)throw new InvalidOperationException("Exact schema required");foreach(string k in keys)if(!d.ContainsKey(k))throw new InvalidOperationException("Missing field");}
  void Check(){lease.CheckDeadline();live();foreach(var p in processes.Values)if(p.HasExited)throw new InvalidOperationException("Retained issuer exited during handoff");}
  void Parent(string path){
   if(!parents.Add(path))return;
   var h=ProtectedAttempt.CreateFile(path,0x20000|0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
   if(h.IsInvalid){int e=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(e);}
   held.Add(h);ProtectedAttempt.Authority(h,false,true,path);Check();
  }
  void PinInput(Dictionary<string,object> input){
   Keys(input,"path","sha256","bytes");string path=ProtectedAttempt.LocalPath(Str(input["path"])),hash=Str(input["sha256"]);long size=Num(input["bytes"]);
   StartIdentity.Hex(hash,64);if(size<1||size>128*1048576)throw new InvalidOperationException("Public source input bound");
   if(String.Equals(path,Str(master["path"]),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Master must remain exclusively available for fence");
   string dir=Path.GetDirectoryName(path),current=Path.GetPathRoot(path);Parent(current);
   foreach(string part in dir.Substring(3).Split('\\')){current=Path.Combine(current,part);Parent(current);}
   var h=ProtectedAttempt.CreateFile(path,0x80000000|0x20000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
   if(h.IsInvalid){int e=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(e);}
   held.Add(h);ProtectedAttempt.PinnedTemplateAuthority(h,path);Info identity;
   if(!GetFileInformationByHandle(h,out identity)||identity.Links!=1)throw new InvalidOperationException("Public source alias/identity unavailable");
   var stream=new FileStream(h,FileAccess.Read);held.Add(stream);
   if(stream.Length!=size)throw new InvalidOperationException("Reviewed source size differs");
   // Streaming keeps even the pinned Node image within the small worker budget.
   using(var sha=SHA256.Create())if(BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant()!=hash)
    throw new InvalidOperationException("Reviewed source digest differs");
   Check();
  }
  List<Dictionary<string,object>> Query(string scope,string query,string[] fields,int maximum){
   Check();var list=new List<Dictionary<string,object>>();
   var opts=new EnumerationOptions{Timeout=TimeSpan.FromSeconds(3),ReturnImmediately=false,Rewindable=false};
   using(var search=new ManagementObjectSearcher(scope,query,opts))using(var rows=search.Get())
    foreach(ManagementObject row in rows)using(row){Check();if(list.Count>=maximum)throw new InvalidOperationException("Management row bound");var d=new Dictionary<string,object>();foreach(string f in fields)d[f]=row[f];list.Add(d);}
   Check();return list;
  }
  Dictionary<string,object> Health(int port){
   Check();var request=(HttpWebRequest)WebRequest.Create("http://127.0.0.1:"+port+"/health");
   request.Proxy=null;request.AllowAutoRedirect=false;request.KeepAlive=false;request.Timeout=1000;request.ReadWriteTimeout=1000;
   using(var response=(HttpWebResponse)request.GetResponse()){
    if(response.StatusCode!=HttpStatusCode.OK)throw new InvalidOperationException("Loaded manager health unavailable");
    using(var stream=response.GetResponseStream())using(var buffer=new MemoryStream()){
     var b=new byte[1024];int n;while((n=stream.Read(b,0,b.Length))!=0){Check();if(buffer.Length+n>65536)throw new InvalidOperationException("Health body bound");buffer.Write(b,0,n);}
     Check();return Obj(json.DeserializeObject(new UTF8Encoding(false,true).GetString(buffer.ToArray())));
    }
   }
  }
  void MasterCheck(Dictionary<string,object> preflight){
   int found=0;foreach(object o in Rows(preflight["checks"],64)){
    var c=Obj(o);if(Str(c["name"])!="type-1 guest-state master (VMGS)")continue;
    if(++found!=1||!(c["ok"] is bool)||!(bool)c["ok"])throw new InvalidOperationException("Loaded master check unavailable");
    string wanted=Str(master["path"])+" ("+Num(master["bytes"]).ToString(CultureInfo.InvariantCulture)+" bytes); each run gets a fresh copy";
    if(!String.Equals(Str(c["detail"]),wanted,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Loaded master differs from reviewed object");
   }
   if(found!=1)throw new InvalidOperationException("Loaded master absent");
  }
  LegacyLaunchCohort.Issuer[] BindIssuers(){
   var result=new List<LegacyLaunchCohort.Issuer>();var ports=new HashSet<int>();var ids=new HashSet<uint>();
   var listeners=Query(@"root\StandardCimv2","SELECT LocalPort,OwningProcess FROM MSFT_NetTCPConnection WHERE (LocalPort=8091 OR LocalPort=8095) AND State=2",new[]{"LocalPort","OwningProcess"},8);
   if(listeners.Count!=issuers.Count)throw new InvalidOperationException("Uncovered or missing old manager listener");
   foreach(object o in issuers){
    var d=Obj(o);Keys(d,"port","pid","created","createdUtc","image","epoch","desktop");int port=checked((int)Num(d["port"]));uint pid=checked((uint)Num(d["pid"]));
    if((port!=8091&&port!=8095)||!ports.Add(port)||!ids.Add(pid)||!(d["desktop"] is bool))throw new InvalidOperationException("Issuer binding shape");
    string epoch=Str(d["epoch"]);StartIdentity.Hex(epoch,32);int count=0;foreach(var l in listeners)if(Convert.ToInt32(l["LocalPort"])==port&&Convert.ToUInt32(l["OwningProcess"])==pid)count++;
    if(count!=1)throw new InvalidOperationException("Loaded manager listener differs");
    var h=Health(port);if(Str(h["managerEpoch"])!=epoch)throw new InvalidOperationException("Loaded manager epoch differs");
    var pre=Obj(h["preflight"]);MasterCheck(pre);
    if((bool)d["desktop"]){var roles=Obj(pre["roles"]);if(roles.Count!=1||!roles.ContainsKey("desktop"))throw new InvalidOperationException("Desktop role coverage differs");MasterCheck(Obj(roles["desktop"]));}
    else if(pre.ContainsKey("roles")&&Obj(pre["roles"]).Count!=0)throw new InvalidOperationException("Unreviewed role");
    string image=ProtectedAttempt.LocalPath(Str(d["image"]));bool imagePinned=false;
    foreach(object f in inputs)if(String.Equals(Str(Obj(f)["path"]),image,StringComparison.OrdinalIgnoreCase))imagePinned=true;
    if(!inspect&&!imagePinned)throw new InvalidOperationException("Issuer executable absent from held closure");
    Process process;if(!processes.TryGetValue(pid,out process)){
     process=Process.GetProcessById(checked((int)pid));held.Add(process);var handle=process.Handle;processes.Add(pid,process);
    }
    if(process.HasExited||!String.Equals(process.MainModule.FileName,image,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Held issuer image/liveness differs");
    DateTime native=process.StartTime.ToUniversalTime(),expected=DateTime.Parse(Str(d["createdUtc"]),CultureInfo.InvariantCulture,DateTimeStyles.RoundtripKind).ToUniversalTime();
    if(native.Ticks-native.Ticks%10!=expected.Ticks)throw new InvalidOperationException("Retained issuer creation differs from reviewed CIM timestamp");
    long creation=native.ToFileTimeUtc(),wanted=Num(d["created"]);
    if((!inspect||wanted!=0)&&wanted!=creation)throw new InvalidOperationException("Exact native issuer creation differs");
    result.Add(new LegacyLaunchCohort.Issuer(pid,creation,image));
   }
   Check();return result.ToArray();
  }
  internal static long MaximumMemory(IDictionary<string,object> row){
   foreach(string k in new[]{"ResourceType","ResourceSubType","AllocationUnits","VirtualQuantityUnits","VirtualQuantity","Reservation","Limit","DynamicMemoryEnabled"})
    if(!row.ContainsKey(k)||row[k]==null)throw new InvalidOperationException("Incomplete VM memory");
   if(!(row["ResourceType"] is ushort)||(ushort)row["ResourceType"]!=4||Str(row["ResourceSubType"])!="Microsoft:Hyper-V:Memory"||
      Str(row["AllocationUnits"])!="byte * 2^20"||Str(row["VirtualQuantityUnits"])!="byte * 2^20"||
      !(row["DynamicMemoryEnabled"] is bool)||(bool)row["DynamicMemoryEnabled"])
    throw new InvalidOperationException("Unsupported or dynamic old VM memory");
   ulong maximum=0;foreach(string k in new[]{"VirtualQuantity","Reservation","Limit"}){
    if(!(row[k] is ulong))throw new InvalidOperationException("Exact native memory quantity required");maximum=Math.Max(maximum,(ulong)row[k]);
   }
   if(maximum==0||maximum>1048576)throw new InvalidOperationException("Configured maximum bound");return checked((long)maximum*1048576);
  }
  SortedDictionary<string,long> Inventory(){
   const string ns=@"root\virtualization\v2";Check();
   var systems=Query(ns,"SELECT Name FROM Msvm_ComputerSystem WHERE Caption='Virtual Machine'",new[]{"Name"},32);
   var expected=new HashSet<string>();foreach(var s in systems){Guid id;if(!Guid.TryParseExact(Str(s["Name"]),"D",out id)||!expected.Add(id.ToString("D")))throw new InvalidOperationException("VM identifier ambiguity");}
   var result=new SortedDictionary<string,long>(StringComparer.Ordinal);
   var opts=new EnumerationOptions{Timeout=TimeSpan.FromSeconds(3),ReturnImmediately=false,Rewindable=false};
   using(var search=new ManagementObjectSearcher(ns,"SELECT * FROM Msvm_VirtualSystemSettingData WHERE VirtualSystemType='Microsoft:Hyper-V:System:Realized'",opts))using(var rows=search.Get())
    foreach(ManagementObject vm in rows)using(vm){
     Check();Guid id;if(result.Count>=32||!Guid.TryParseExact((string)vm["VirtualSystemIdentifier"],"D",out id)||!expected.Contains(id.ToString("D"))||result.ContainsKey(id.ToString("D")))throw new InvalidOperationException("Realized VM inventory differs");
     int count=0;long maximum=0;
     using(var memory=vm.GetRelated("Msvm_MemorySettingData"))foreach(ManagementObject m in memory)using(m){
      Check();if(++count!=1)throw new InvalidOperationException("VM memory association ambiguity");var d=new Dictionary<string,object>();
      foreach(string k in new[]{"ResourceType","ResourceSubType","AllocationUnits","VirtualQuantityUnits","VirtualQuantity","Reservation","Limit","DynamicMemoryEnabled"})d[k]=m[k];
      maximum=MaximumMemory(d);
     }
     if(count!=1)throw new InvalidOperationException("Missing VM memory association");result.Add(id.ToString("D"),maximum);
    }
   if(result.Count!=expected.Count)throw new InvalidOperationException("Incomplete all-VM inventory");Check();return result;
  }
  void Execute(){
   Check();long total=0;var paths=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
   foreach(object o in inputs){var d=Obj(o);if(!paths.Add(Str(d["path"])))throw new InvalidOperationException("Duplicate source input");total=checked(total+Num(d["bytes"]));if(total>256*1048576)throw new InvalidOperationException("Reviewed input byte bound");PinInput(d);}
   var exact=BindIssuers();Check();
   if(inspect){
    var inventory=Inventory();var again=Inventory();if(json.Serialize(inventory)!=json.Serialize(again))throw new InvalidOperationException("Inspect inventory changed");
    BindIssuers();Check();PublishInventory(inventory,0,exact);return;
   }
   lease.WriteOnce("handoff.consumed",lease.PermitHash+";"+lease.Token);
   long cutDeadline=Math.Min(lease.Deadline-5000,BoundedWorker.MonotonicMilliseconds()+10000);
   var cut=LegacyLaunchCohort.ApplyAndDrain(exact,Path.Combine(Environment.SystemDirectory,@"WindowsPowerShell\v1.0\powershell.exe"),Str(master["path"]),Str(master["sha256"]),Num(master["bytes"]),lease.Boot,Path.Combine(lease.Root,"definition-fence.intent"),cutDeadline);
   Check();string cohort=json.Serialize(cut.Exited);int childIndex=0;
   foreach(var p in cut.Exited){lease.WriteOnce("cohort-"+(char)('a'+childIndex/26)+(char)('a'+childIndex%26),json.Serialize(p));childIndex++;}
   lease.WriteOnce("handoff.cut",json.Serialize(new{schema="legacy-cut/1",manifest=lease.PermitHash,cutAt=cut.CutAt,master=cut.Fence.ObjectIdentity,intent=cut.Fence.IntentHash,cohortCount=cut.Exited.Length,cohortSha256=ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(cohort)),providerSettled=false,capacityAdmitted=false}));
   var first=Inventory();var second=Inventory();if(json.Serialize(first)!=json.Serialize(second))throw new InvalidOperationException("Configured VM inventory changed; keep claims held");
   BindIssuers();Check();PublishInventory(first,cut.CutAt,exact);
  }
  void PublishInventory(SortedDictionary<string,long> inventory,long cutAt,LegacyLaunchCohort.Issuer[] exact){
   long maximumBytes=0;int n=0;var index=new List<string>();
   foreach(var vm in inventory){
    maximumBytes=checked(maximumBytes+vm.Value);string name="vm-"+(char)('a'+n/26)+(char)('a'+n%26);n++;
    string row=json.Serialize(new{guid=vm.Key,maximumBytes=vm.Value,cutAt=cutAt,manifest=lease.PermitHash});lease.WriteOnce(name,row);index.Add(vm.Key+":"+ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(row)));
   }
   lease.WriteOnce("handoff.inventory","legacy-vm-inventory/1\n"+String.Join("\n",index));Check();
   lease.WriteOnce("handoff.result",json.Serialize(new{schema="legacy-memory-handoff-result/1",manifest=lease.PermitHash,inspectOnly=inspect,cutAt=cutAt,observedAt=BoundedWorker.MonotonicMilliseconds(),issuers=exact,vmCount=n,maximumBytes=maximumBytes,providerSettled=false,capacityAdmitted=false,reservationMayRelease=false,poolSeeded=false}));
  }
  public static void Run(ProtectedAttempt lease,Action live){using(var work=new LegacyHandoff(lease,live))work.Execute();}
  public void Dispose(){for(int n=held.Count-1;n>=0;n--)held[n].Dispose();held.Clear();}
 }
}
