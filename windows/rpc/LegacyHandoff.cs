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
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
namespace Enclave.OwnedRpc {
 public sealed class LegacyHandoff : IDisposable {
  readonly ProtectedAttempt lease;readonly Action live;
  readonly JavaScriptSerializer json=new JavaScriptSerializer{MaxJsonLength=65536,RecursionLimit=16};
  readonly List<IDisposable> held=new List<IDisposable>();
  readonly HashSet<string> parents=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  readonly List<AncestorCustody> custody=new List<AncestorCustody>();
  readonly Dictionary<string,object> manifest,master;
  readonly IList issuers,inputs;
  readonly Dictionary<uint,Process> processes=new Dictionary<uint,Process>();
  readonly bool inspect;readonly LegacyPoolSeed seed;readonly Dictionary<string,object> newMaster;
  string phase="initial";int inputIndex=-1,parentDepth=-1;
  [StructLayout(LayoutKind.Sequential,Pack=4)] struct Info {public uint Attributes;public long Created,Accessed,Written;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
  LegacyHandoff(ProtectedAttempt lease,Action live){
   if(lease==null||live==null||lease.LeaseProfile!="legacy-handoff")throw new ArgumentException("Protected handoff authority required");
   this.lease=lease;this.live=live;inspect=lease.Operation=="legacy-memory-inspect-v1"||lease.Operation=="legacy-memory-resident-inspect-v1";manifest=Obj(json.DeserializeObject(new UTF8Encoding(false,true).GetString(lease.ReadLegacyHandoff())));
   bool seeding=lease.Operation=="legacy-memory-cut-seed-v1";
   if(seeding){Keys(manifest,"schema","boot","topology","master","issuers","inputs","pool");seed=new LegacyPoolSeed(Obj(manifest["pool"]),lease.Boot);newMaster=Obj(Obj(manifest["pool"])["newMaster"]);}
   else Keys(manifest,"schema","boot","topology","master","issuers","inputs");
   if(Str(manifest["schema"])!=(seeding?"legacy-memory-handoff/2":"legacy-memory-handoff/1")||Str(manifest["topology"])!="mandatory-copy-direct-powershell/1"||Str(manifest["boot"])!=lease.Boot)
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
  void Check(){lease.CheckDeadline();live();foreach(var edge in custody)edge.Recheck();foreach(var p in processes.Values)if(p.HasExited)throw new InvalidOperationException("Retained issuer exited during handoff");}
  void Parent(string path,string immediateChild){
   if(!parents.Add(path))return;
   phase="input-parent-open";
   var h=ProtectedAttempt.CreateFile(path,0x20000|0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
   if(h.IsInvalid){int e=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(e);}
   held.Add(h);phase="input-parent-authority";
   try{ProtectedAttempt.Authority(h,false,true,path);}catch(InvalidOperationException){
    if(immediateChild==null)throw;
    var edge=new AncestorCustody(h,path,immediateChild);held.Add(edge);custody.Add(edge);
   }
   Check();
  }
  void PinInput(Dictionary<string,object> input){
   Keys(input,"path","sha256","bytes");string path=ProtectedAttempt.LocalPath(Str(input["path"])),hash=Str(input["sha256"]);long size=Num(input["bytes"]);
   StartIdentity.Hex(hash,64);if(size<1||size>128*1048576)throw new InvalidOperationException("Public source input bound");
   if(String.Equals(path,Str(master["path"]),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Master must remain exclusively available for fence");
   string dir=Path.GetDirectoryName(path),current=Path.GetPathRoot(path);string[] parts=dir.Substring(3).Split('\\');parentDepth=0;Parent(current,parts[0]);
   for(int n=0;n<parts.Length;n++){parentDepth++;current=Path.Combine(current,parts[n]);Parent(current,n+1<parts.Length?parts[n+1]:null);}
   phase="input-file-open";
   var h=ProtectedAttempt.CreateFile(path,0x80000000|0x20000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
   if(h.IsInvalid){int e=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(e);}
   held.Add(h);phase="input-file-authority";ProtectedAttempt.PinnedTemplateAuthority(h,path);Info identity;
   phase="input-file-identity";
   if(!GetFileInformationByHandle(h,out identity)||identity.Links!=1)throw new InvalidOperationException("Public source alias/identity unavailable");
   phase="input-file-read";var stream=new FileStream(h,FileAccess.Read);held.Add(stream);
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
   foreach(string k in new[]{"VirtualQuantity","Reservation","Limit"})
    if(!(row[k] is ulong))throw new InvalidOperationException("Exact native memory quantity required");
   ulong quantity=(ulong)row["VirtualQuantity"],minimum=(ulong)row["Reservation"],limit=(ulong)row["Limit"];
   if(quantity==0||quantity>1048576||limit<quantity||minimum>quantity)
    throw new InvalidOperationException("Contradictory static memory configuration");
   // Dynamic memory is explicitly refused above. VirtualQuantity is the fixed
   // guest RAM; Limit is the dormant dynamic ceiling, not automatic static growth.
   // Any future ModifyResourceSettings is a new allocation requiring admission.
   return checked((long)quantity*1048576);
  }
  public sealed class MemoryRecord {
   public string Rule="fixed-memory-virtual-quantity/1";
   public long Bytes;public ulong VirtualQuantityMiB,ReservationMiB,LimitMiB;
   public bool DynamicMemoryEnabled;
  }

  SortedDictionary<string,MemoryRecord> Inventory(){
   const string ns=@"root\virtualization\v2";Check();
   var systems=Query(ns,"SELECT Name FROM Msvm_ComputerSystem WHERE Caption='Virtual Machine'",new[]{"Name"},32);
   var expected=new HashSet<string>();foreach(var s in systems){Guid id;if(!Guid.TryParseExact(Str(s["Name"]),"D",out id)||!expected.Add(id.ToString("D")))throw new InvalidOperationException("VM identifier ambiguity");}
   var result=new SortedDictionary<string,MemoryRecord>(StringComparer.Ordinal);
   var opts=new EnumerationOptions{Timeout=TimeSpan.FromSeconds(3),ReturnImmediately=false,Rewindable=false};
   using(var search=new ManagementObjectSearcher(ns,"SELECT * FROM Msvm_VirtualSystemSettingData WHERE VirtualSystemType='Microsoft:Hyper-V:System:Realized'",opts))using(var rows=search.Get())
    foreach(ManagementObject vm in rows)using(vm){
     Check();Guid id;if(result.Count>=32||!Guid.TryParseExact((string)vm["VirtualSystemIdentifier"],"D",out id)||!expected.Contains(id.ToString("D"))||result.ContainsKey(id.ToString("D")))throw new InvalidOperationException("Realized VM inventory differs");
     int count=0;MemoryRecord record=null;
     using(var memory=vm.GetRelated("Msvm_MemorySettingData"))foreach(ManagementObject m in memory)using(m){
      Check();if(++count!=1)throw new InvalidOperationException("VM memory association ambiguity");var d=new Dictionary<string,object>();
      foreach(string k in new[]{"ResourceType","ResourceSubType","AllocationUnits","VirtualQuantityUnits","VirtualQuantity","Reservation","Limit","DynamicMemoryEnabled"})d[k]=m[k];
      record=new MemoryRecord{Bytes=MaximumMemory(d),VirtualQuantityMiB=(ulong)d["VirtualQuantity"],ReservationMiB=(ulong)d["Reservation"],LimitMiB=(ulong)d["Limit"],DynamicMemoryEnabled=(bool)d["DynamicMemoryEnabled"]};
     }
     if(count!=1)throw new InvalidOperationException("Missing VM memory association");result.Add(id.ToString("D"),record);
    }
   if(result.Count!=expected.Count)throw new InvalidOperationException("Incomplete all-VM inventory");Check();return result;
  }
  internal static SortedDictionary<string,long> AssignedRows(SortedDictionary<string,MemoryRecord> inventory,IEnumerable<Dictionary<string,object>> rows){
   var assigned=new SortedDictionary<string,long>(StringComparer.Ordinal);
   foreach(var row in rows){
    Guid parsed;if(!Guid.TryParseExact(Str(row["SystemName"]),"D",out parsed))throw new InvalidOperationException("Invalid resident GUID");string id=parsed.ToString("D");MemoryRecord record;
    if(!inventory.TryGetValue(id,out record)||assigned.ContainsKey(id)||!(row["BlockSize"] is ulong)||!(row["NumberOfBlocks"] is ulong)||
       (ulong)row["BlockSize"]!=1048576)throw new InvalidOperationException("Current assigned memory identity incomplete");
    long value=checked((long)(ulong)row["NumberOfBlocks"]*1048576);
    if(value<0||value>record.Bytes)throw new InvalidOperationException("Assigned memory exceeds static commitment");assigned.Add(id,value);
   }
   if(assigned.Count!=inventory.Count)throw new InvalidOperationException("Missing assigned memory is not zero");return assigned;
  }
  SortedDictionary<string,long> Assigned(SortedDictionary<string,MemoryRecord> inventory){
   return AssignedRows(inventory,Query(@"root\virtualization\v2","SELECT SystemName,BlockSize,NumberOfBlocks FROM Msvm_Memory",new[]{"SystemName","BlockSize","NumberOfBlocks"},32));
  }
  internal sealed class ResidentSample {
   public long Physical,Free,Configured,Assigned,ObservedAt;
   public SortedDictionary<string,long> Residents;
  }
  ResidentSample ObserveResident(SortedDictionary<string,MemoryRecord> inventory){
   long began=BoundedWorker.MonotonicMilliseconds(),total=0;foreach(var row in inventory)total=checked(total+row.Value.Bytes);
   var residents=Assigned(inventory);long assigned=0;foreach(long value in residents.Values)assigned=checked(assigned+value);
   var rows=Query(@"root\cimv2","SELECT TotalVisibleMemorySize,FreePhysicalMemory FROM Win32_OperatingSystem",new[]{"TotalVisibleMemorySize","FreePhysicalMemory"},2);
   if(rows.Count!=1||json.Serialize(Assigned(inventory))!=json.Serialize(residents))throw new InvalidOperationException("Physical/assigned memory changed");
   long physical=checked(Convert.ToInt64(rows[0]["TotalVisibleMemorySize"])*1024),free=checked(Convert.ToInt64(rows[0]["FreePhysicalMemory"])*1024),now=BoundedWorker.MonotonicMilliseconds();
   if(now<began||now-began>2000||physical<=0||free<0||free>physical||assigned>physical-free||assigned>total)throw new InvalidOperationException("Resident observation inconsistent or stale");
   Check();return new ResidentSample{Physical=physical,Free=free,Configured=total,Assigned=assigned,ObservedAt=now,Residents=residents};
  }
  void SeedFit(SortedDictionary<string,MemoryRecord> inventory){
   if(seed==null)return;var sample=ObserveResident(inventory);seed.Fit(sample.Physical,sample.Free,sample.Configured,sample.Assigned);Check();
  }
  void PublishResident(SortedDictionary<string,MemoryRecord> inventory){
   phase="resident-inspection";var sample=ObserveResident(inventory);BindIssuers();Check();
   lease.WriteOnce("handoff.resident",json.Serialize(new{schema="legacy-resident-memory/1",manifest=lease.PermitHash,boot=lease.Boot,observedAt=sample.ObservedAt,
    physicalBytes=sample.Physical,freeBytes=sample.Free,configuredBytes=sample.Configured,assignedBytes=sample.Assigned,latentBytes=sample.Configured-sample.Assigned,
    nonPoolBytes=sample.Physical-sample.Free-sample.Assigned,residents=sample.Residents}));
  }
  void Execute(){
   Check();long total=0;var paths=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
   foreach(object o in inputs){inputIndex++;phase="input-schema";var d=Obj(o);if(!paths.Add(Str(d["path"])))throw new InvalidOperationException("Duplicate source input");total=checked(total+Num(d["bytes"]));if(total>256*1048576)throw new InvalidOperationException("Reviewed input byte bound");PinInput(d);}
   if(seed!=null){
    phase="seed-preflight";
    Keys(newMaster,"path","sha256","bytes");
    if(Num(newMaster["bytes"])!=Num(master["bytes"])||Str(newMaster["sha256"])!=Str(master["sha256"])||
       paths.Contains(Str(newMaster["path"])))throw new InvalidOperationException("Distinct replacement master required");
    // PinInput rejects the old path and hard-linked aliases, checks exact bytes
    // and keeps the protected replacement immutable through the transition.
    PinInput(newMaster);SeedFit(Inventory());
    if(Directory.Exists(Path.GetDirectoryName(seed.Root))||File.Exists(Path.GetDirectoryName(seed.Root)))throw new InvalidOperationException("Pool namespace already exists");
   }
   phase="issuer-binding";
   var exact=BindIssuers();Check();
   if(inspect){
    phase="inspect-inventory";
    var inventory=Inventory();var again=Inventory();if(json.Serialize(inventory)!=json.Serialize(again))throw new InvalidOperationException("Inspect inventory changed");
    BindIssuers();Check();PublishInventory(inventory,0,exact);if(lease.Operation=="legacy-memory-resident-inspect-v1")PublishResident(inventory);return;
   }
   phase="definition-cut";lease.WriteOnce("handoff.consumed",lease.PermitHash+";"+lease.Token);
   long cutDeadline=Math.Min(lease.Deadline-5000,BoundedWorker.MonotonicMilliseconds()+10000);
   var cut=LegacyLaunchCohort.ApplyAndDrain(exact,Path.Combine(Environment.SystemDirectory,@"WindowsPowerShell\v1.0\powershell.exe"),Str(master["path"]),Str(master["sha256"]),Num(master["bytes"]),lease.Boot,Path.Combine(lease.Root,"definition-fence.intent"),cutDeadline);
   Check();string cohort=json.Serialize(cut.Exited);int childIndex=0;
   foreach(var p in cut.Exited){lease.WriteOnce("cohort-"+(char)('a'+childIndex/26)+(char)('a'+childIndex%26),json.Serialize(p));childIndex++;}
   lease.WriteOnce("handoff.cut",json.Serialize(new{schema="legacy-cut/1",manifest=lease.PermitHash,cutAt=cut.CutAt,master=cut.Fence.ObjectIdentity,intent=cut.Fence.IntentHash,cohortCount=cut.Exited.Length,cohortSha256=ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(cohort)),providerSettled=false,capacityAdmitted=false}));
   phase="cut-inventory";var first=Inventory();var second=Inventory();if(json.Serialize(first)!=json.Serialize(second))throw new InvalidOperationException("Configured VM inventory changed; keep claims held");
   BindIssuers();Check();PublishInventory(first,cut.CutAt,exact);
   if(seed!=null){
    phase="pool-seed";SeedFit(first);
    using(var denial=new LegacyTemplateFence.HeldDenial(Str(master["path"]),cut.Fence.ObjectIdentity,Num(master["bytes"]),lease.Boot,lease.Deadline)){
     seed.Publish(lease,first,()=>{Check();denial.Verify();});
     SeedFit(first);BindIssuers();denial.Verify();Check();
     lease.WriteOnce("pool.complete",ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(lease.ReadOnce("pool.activation"))));
    }
   }
  }
  void PublishInventory(SortedDictionary<string,MemoryRecord> inventory,long cutAt,LegacyLaunchCohort.Issuer[] exact){
   long maximumBytes=0;int n=0;var index=new List<string>();
   foreach(var vm in inventory){
    maximumBytes=checked(maximumBytes+vm.Value.Bytes);string name="vm-"+(char)('a'+n/26)+(char)('a'+n%26);n++;
    string row=json.Serialize(new{guid=vm.Key,maximumBytes=vm.Value.Bytes,memory=vm.Value,cutAt=cutAt,manifest=lease.PermitHash});lease.WriteOnce(name,row);index.Add(vm.Key+":"+ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(row)));
   }
   lease.WriteOnce("handoff.inventory","legacy-vm-inventory/1\n"+String.Join("\n",index));Check();
   lease.WriteOnce("handoff.result",json.Serialize(new{schema="legacy-memory-handoff-result/2",manifest=lease.PermitHash,inspectOnly=inspect,cutAt=cutAt,observedAt=BoundedWorker.MonotonicMilliseconds(),issuers=exact,vmCount=n,maximumBytes=maximumBytes,providerSettled=false,capacityAdmitted=false,reservationMayRelease=false,poolSeeded=false}));
  }
  public static void Run(ProtectedAttempt lease,Action live){using(var work=new LegacyHandoff(lease,live)){
   try{work.Execute();}catch(Exception error){
    // Fixed public metadata only: never publish exception messages, paths,
    // environment values or source contents. Failure never grants admission.
    try{var native=error as Win32Exception;lease.WriteOnce("handoff.failure",work.json.Serialize(new{schema="legacy-handoff-failure/1",manifest=lease.PermitHash,phase=work.phase,inputIndex=work.inputIndex,parentDepth=work.parentDepth,hresult=error.HResult,nativeError=native==null?0:native.NativeErrorCode,capacityAdmitted=false,reservationMayRelease=false}));}catch{}
    throw;
   }
  }}
  public void Dispose(){for(int n=held.Count-1;n>=0;n--)held[n].Dispose();held.Clear();}
 }
}

namespace Enclave.OwnedRpc {
 // Internal to the protected cut worker. Not an operator-supplied receipt parser:
 // only LegacyHandoff calls Publish after its real fence/drain/stable inventory.
 internal sealed class LegacyPoolSeed {
  const long MiB=1048576,GiB=1073741824;
  internal readonly string Nonce,Root,Config,Hash;
  internal readonly long Physical,NonPoolReserve,Floor,Variation,Prospective,Capacity;
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {public int Length;public IntPtr Descriptor;public int Inherit;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectoryW(string path,ref SecurityAttributes security);
  internal LegacyPoolSeed(Dictionary<string,object> plan,string boot){
   string[] keys={"nonce","physicalBytes","nonPoolReserveBytes","floorBytes","variationBytes","prospectiveBytes","capacityBytes","newMaster"};
   if(plan.Count!=keys.Length)throw new InvalidOperationException("Exact seed plan required");foreach(string k in keys)if(!plan.ContainsKey(k))throw new InvalidOperationException("Seed field missing");
   Nonce=LegacyHandoff.Str(plan["nonce"]);StartIdentity.Hex(Nonce,32);StartIdentity.Hex(boot,32);
   Physical=LegacyHandoff.Num(plan["physicalBytes"]);NonPoolReserve=LegacyHandoff.Num(plan["nonPoolReserveBytes"]);
   Floor=LegacyHandoff.Num(plan["floorBytes"]);Variation=LegacyHandoff.Num(plan["variationBytes"]);Prospective=LegacyHandoff.Num(plan["prospectiveBytes"]);Capacity=LegacyHandoff.Num(plan["capacityBytes"]);
   foreach(long n in new[]{Physical,NonPoolReserve,Floor,Variation,Prospective,Capacity})if(n<0||n>9007199254740991L)throw new InvalidOperationException("Seed quantity bound");
   if(Physical==0||NonPoolReserve==0||Floor<18*GiB||Variation<GiB||Prospective<39388*MiB||Capacity<=0||Capacity%MiB!=0||
      Capacity>checked(Physical-NonPoolReserve-Floor-Variation))throw new InvalidOperationException("Whole host pool budget differs");
   Root=Path.Combine(Path.GetPathRoot(Environment.SystemDirectory),"EnclavePhysicalPool-"+Nonce,Nonce);
   Config="host-physical-pool/1\n"+Nonce+"\n"+boot+"\n"+Capacity.ToString(CultureInfo.InvariantCulture)+"\n";
   Hash=ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(Config));
  }
  internal void Fit(long physical,long free,long existing,long assigned){
   if(physical!=Physical||free<0||free>physical||existing<0||existing>physical||assigned<0||assigned>existing||assigned>physical-free||
      Math.Max(0,checked(physical-free-assigned))>NonPoolReserve||
      free<checked(existing-assigned+20*GiB+Prospective+Floor+Variation+512*MiB)||
      checked(existing+20*GiB+Prospective)>Capacity)throw new InvalidOperationException("Fresh physical cut-seed budget does not fit");
  }
  static string Owner(){using(var identity=WindowsIdentity.GetCurrent())return identity.User.Value=="S-1-5-18"?"S-1-5-18":"S-1-5-32-544";}
  static DirectorySecurity DirectoryAcl(){
   var a=new DirectorySecurity();a.SetOwner(new SecurityIdentifier(Owner()));a.SetAccessRuleProtection(true,false);
   foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})a.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));return a;
  }
  static void ExclusiveDirectory(string path){
   byte[] bytes=DirectoryAcl().GetSecurityDescriptorBinaryForm();IntPtr descriptor=Marshal.AllocHGlobal(bytes.Length);
   try{Marshal.Copy(bytes,0,descriptor,bytes.Length);var sa=new SecurityAttributes{Length=Marshal.SizeOf(typeof(SecurityAttributes)),Descriptor=descriptor,Inherit=0};
    if(!CreateDirectoryW(path,ref sa))throw new Win32Exception(Marshal.GetLastWin32Error());
   }finally{Marshal.FreeHGlobal(descriptor);}
  }
  static SafeFileHandle PinDirectory(string path,bool strict){
   var h=ProtectedAttempt.CreateFile(path,0x20000|0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
   if(h.IsInvalid){int e=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(e);}
   try{ProtectedAttempt.Authority(h,strict,true,path);return h;}catch{h.Dispose();throw;}
  }
  static void PublishFile(string path,string value){
   var acl=new FileSecurity();acl.SetOwner(new SecurityIdentifier(Owner()));acl.SetAccessRuleProtection(true,false);
   foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));
   byte[] bytes=Encoding.UTF8.GetBytes(value);
   using(var f=new FileStream(path,FileMode.CreateNew,FileSystemRights.WriteData|FileSystemRights.ReadPermissions,FileShare.None,4096,FileOptions.WriteThrough,acl)){
    ProtectedAttempt.Authority(f.SafeFileHandle,true,false,path);f.Write(bytes,0,bytes.Length);f.Flush(true);
   }
  }
  internal static string ClaimId(string manifest,string boot,string guid){
   StartIdentity.Hex(manifest,64);StartIdentity.Hex(boot,32);Guid parsed;
   if(!Guid.TryParseExact(guid,"D",out parsed)||parsed.ToString("D")!=guid)throw new InvalidOperationException("Canonical seeded GUID");
   return ProtectedAttempt.Hash(Encoding.UTF8.GetBytes("legacy-vm-claim/1\n"+manifest+"\n"+boot+"\n"+guid+"\n"));
  }
  internal string Publish(ProtectedAttempt lease,SortedDictionary<string,LegacyHandoff.MemoryRecord> inventory,Action guard){
   if(lease.Operation!="legacy-memory-cut-seed-v1"||guard==null)throw new InvalidOperationException("Explicit cut-seed authority required");
   // No caller can enable an empty ledger after a partial/ambiguous attempt.
   // The marker is outside the pool because Snapshot rejects unknown entries.
   guard();lease.WriteOnce("pool.seed.consumed",Hash+";"+lease.PermitHash+";"+lease.Token);
   var held=new List<IDisposable>();
   try{
    string parent=Path.GetDirectoryName(Root);held.Add(PinDirectory(Path.GetPathRoot(Root),false));
    guard();ExclusiveDirectory(parent);held.Add(PinDirectory(parent,true));guard();ExclusiveDirectory(Root);held.Add(PinDirectory(Root,true));
    PublishFile(Path.Combine(Root,"pool.lock"),"");
    var claims=new List<PhysicalClaim>();long total=0;
    foreach(var pair in inventory){
     guard();var c=new PhysicalClaim(Hash,lease.Boot,"app-legacy",ClaimId(lease.PermitHash,lease.Boot,pair.Key),pair.Value.Bytes);
     total=checked(total+c.Bytes);if(claims.Count>=32||total>Capacity)throw new InvalidOperationException("Seed inventory exceeds budget");
     claims.Add(c);PublishFile(Path.Combine(Root,c.Id+".claim"),c.Encode());
     // Existing GUIDs cannot receive another start authorization through this
     // record. Their native operations are not presumed settled or released.
     PublishFile(Path.Combine(Root,c.Id+".dispatch"),c.Encode());
    }
    guard();PublishFile(Path.Combine(Root,"pool.txt"),Config);
    guard();using(var pool=new HostPhysicalPool(Path.Combine(Root,"pool.txt"),Hash,lease.Deadline))pool.VerifyInitial(claims);
    guard();var json=new System.Web.Script.Serialization.JavaScriptSerializer();
    string result=json.Serialize(new{schema="legacy-pool-seed/1",manifest=lease.PermitHash,boot=lease.Boot,configPath=Path.Combine(Root,"pool.txt"),poolHash=Hash,
      capacityBytes=Capacity,initialBytes=total,initialCount=claims.Count,physicalBytes=Physical,nonPoolReserveBytes=NonPoolReserve,floorBytes=Floor,variationBytes=Variation,prospectiveBytes=Prospective,
      cutHash=ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(lease.ReadOnce("handoff.cut"))),inventoryHash=ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(lease.ReadOnce("handoff.inventory"))),
      providerSettled=false,capacityAdmitted=false,reservationMayRelease=false});
    // Publication is last; no record grants production start permission alone.
    lease.WriteOnce("pool.activation",result);guard();return result;
   }finally{for(int i=held.Count-1;i>=0;i--)held[i].Dispose();}
  }
 }
}
