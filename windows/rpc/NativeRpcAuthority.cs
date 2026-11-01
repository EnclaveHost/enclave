// Concrete native app admission and asset custody for the supervised worker.
// Local manager records are admission inputs, never hardware attestation or a
// substitute for the storage owner's current deployment/writer authority.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
namespace Enclave.OwnedRpc {
 // Fixed native RPC profile and optical containers. These pins authenticate
 // bytes relative to the operator's accepted profile, not hardware or boot.
 internal sealed class NativeRpcMediaProfile {
  internal const int Header=65536,ImageBytes=1073741824,HashBytes=8458240;
  internal readonly string ImageHash,TreeHash;
  static string S(object x){return StartRecords.Text(x);}
  static string Pin(object x){string h=S(x);StartIdentity.Hex(h,64);if(h==new string('0',64))throw new InvalidOperationException("Nonzero media profile digest required");return h;}
  static Dictionary<string,object> Object(object x,string[] keys){var d=x as Dictionary<string,object>;if(d==null||d.Count!=keys.Length)throw new InvalidOperationException("Media profile object differs");foreach(string key in keys)if(!d.ContainsKey(key))throw new InvalidOperationException("Media profile key missing");return d;}
  internal NativeRpcMediaProfile(byte[] bytes,string digest){
   if(bytes==null||bytes.Length<1||bytes.Length>16384||ProtectedAttempt.Hash(bytes)!=digest)throw new InvalidOperationException("Exact native RPC profile bytes required");
   string raw=new UTF8Encoding(false,true).GetString(bytes);
   var p=StartRecords.Parse(raw,new[]{"controllerSha256","entrySha256","kernel","profile","root","schema","wrapperSha256"});
   var k=Object(p["kernel"],new[]{"bootSha256","elfSha256","release"});
   var r=Object(p["root"],new[]{"dataBlocks","hashBytes","hashSha256","imageBytes","imageSha256","rootHash","salt"});
   if(S(p["schema"])!="enclave-native-rpc-profile/2"||S(p["profile"])!="ethereum-base-rpc-v1"||S(k["release"])!="6.6.87.2-enclave-kvm-box"||StartRecords.Number(r["dataBlocks"])!=262144||StartRecords.Number(r["hashBytes"])!=HashBytes||StartRecords.Number(r["imageBytes"])!=ImageBytes)throw new InvalidOperationException("Fixed RPC profile geometry differs");
   ImageHash=Pin(r["imageSha256"]);TreeHash=Pin(r["hashSha256"]);
   var kernel=new Dictionary<string,object>{{"bootSha256",Pin(k["bootSha256"])},{"elfSha256",Pin(k["elfSha256"])},{"release",S(k["release"])}};
   var root=new Dictionary<string,object>{{"dataBlocks",262144},{"hashBytes",HashBytes},{"hashSha256",TreeHash},{"imageBytes",ImageBytes},{"imageSha256",ImageHash},{"rootHash",Pin(r["rootHash"])},{"salt",Pin(r["salt"])}};
   var canonical=new Dictionary<string,object>{{"controllerSha256",Pin(p["controllerSha256"])},{"entrySha256",Pin(p["entrySha256"])},{"kernel",kernel},{"profile",S(p["profile"])},{"root",root},{"schema",S(p["schema"])},{"wrapperSha256",Pin(p["wrapperSha256"])}};
   if(StartRecords.Encode(canonical)+"\n"!=raw)throw new InvalidOperationException("Canonical RPC profile required");
  }
  internal static string Name(bool tree){return tree?"hash.container":"image.container";}
  internal static int Size(bool tree){return Header+(tree?HashBytes:ImageBytes);}
  // Both input and optional new private output belong to the caller's held
  // namespace. No allocation proportional to media size; no header extensions.
  internal string Verify(Stream input,bool tree,Action current,Stream output){
   if(input==null||current==null||!input.CanRead||!input.CanSeek||input.Position!=0||input.Length!=Size(tree))throw new InvalidOperationException("Exact optical container geometry required");
   current();var buffer=new byte[1048576];long position=0;
   using(var payload=new SHA256Cng())using(var whole=new SHA256Cng()){
    while(position<input.Length){
     current();int need=(int)Math.Min(buffer.Length,input.Length-position),n=input.Read(buffer,0,need);if(n==0)throw new EndOfStreamException("Short optical container");
     int header=(int)Math.Min(n,Math.Max(0,Header-position));for(int i=0;i<header;i++)if(buffer[i]!=0)throw new InvalidOperationException("Optical header must be zero");
     if(n>header)payload.TransformBlock(buffer,header,n-header,buffer,header);
     whole.TransformBlock(buffer,0,n,buffer,0);if(output!=null)output.Write(buffer,0,n);position+=n;
    }
    if(position!=Size(tree)||input.ReadByte()!=-1||input.Length!=Size(tree))throw new InvalidOperationException("Optical container changed");
    payload.TransformFinalBlock(new byte[0],0,0);whole.TransformFinalBlock(new byte[0],0,0);
    string actual=BitConverter.ToString(payload.Hash).Replace("-","").ToLowerInvariant();
    if(actual!=(tree?TreeHash:ImageHash))throw new InvalidOperationException("Optical payload differs from original profile");
    current();return BitConverter.ToString(whole.Hash).Replace("-","").ToLowerInvariant();
   }
  }
 }
 public sealed partial class ProtectedAttempt {
  internal void PinNativeMedia(){
   if(LeaseProfile!="native-definition-journal"||NativeDefinitionPlan==null||accessLease.Operation!="define")throw new InvalidOperationException("Original native media custody requires submit lease");
   var p=NativeDefinitionPlan;var profile=new NativeRpcMediaProfile(Bytes(HoldRead(Path.Combine(Root,"profile.json"),16384),16384),p.Profile);
   foreach(bool tree in new[]{false,true}){
    CheckDeadline();string path=Path.Combine(Root,NativeRpcMediaProfile.Name(tree));
    var h=CreateFile(path,0x80000000|0x20000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
    if(h.IsInvalid){int error=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(error);}
    FileStream f=null;
    try{Authority(h,true,false,path);FileInfo info;if(!GetFileInformationByHandle(h,out info)||info.Links!=1)throw new InvalidOperationException("Single-link optical media required");
     f=new FileStream(h,FileAccess.Read);profile.Verify(f,tree,CheckDeadline,null);held.Add(f);f=null;
    }catch{if(f!=null)f.Dispose();else if(!h.IsClosed)h.Dispose();throw;}
   }CheckDeadline();
  }
  internal void PinNativeAsset(string name,string digest,int maximum,bool mutable){
   if(LeaseProfile!="native-definition-journal"||NativeDefinitionPlan==null||accessLease.Operation!="define"||
      (name!="runtime.igvm"&&name!="guest-state.vmgs"&&name!="bundle.bin"&&name!="record.json"&&name!="profile.json")||mutable!=(name=="guest-state.vmgs"))throw new InvalidOperationException("Fixed original native assets required");
   CheckDeadline();Hex(digest,64);string path=Path.Combine(Root,name);
   var h=CreateFile(path,0x80000000|0x20000,mutable?3U:1U,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
   if(h.IsInvalid){int e=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(e);}
   FileStream stream=null;
   try{
    Authority(h,true,false,path);FileInfo info;
    if(!GetFileInformationByHandle(h,out info)||info.Links!=1)throw new InvalidOperationException("Native asset must be a single-link private copy");
    stream=new FileStream(h,FileAccess.Read);if(stream.Length<1||stream.Length>maximum)throw new InvalidOperationException("Native asset size bound");
    string actual;using(var sha=SHA256.Create())actual=BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
    if(actual!=digest)throw new InvalidOperationException("Native asset digest differs");
    // Firmware/bundle/profile/record deny write+delete. VMGS allows provider
    // updates but not replacement: hash is the INITIAL state copy, not a claim
    // that VMGS stays immutable after DefineSystem. The full guest verifier
    // must authenticate actual hardware/runtime before accepting any service.
    held.Add(stream);stream=null;CheckDeadline();
   }catch{if(stream!=null)stream.Dispose();else if(!h.IsClosed)h.Dispose();throw;}
  }
 }
 internal static class NativeManagerAuthority {
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=32};
  static Dictionary<string,object> D(object x){var d=x as Dictionary<string,object>;if(d==null)throw new InvalidOperationException("Native manager object required");return d;}
  static IList A(object x){var a=x as IList;if(a==null||a.Count>128)throw new InvalidOperationException("Native manager row bound");return a;}
  static string S(object x){var s=x as string;if(s==null||s.Length>4096)throw new InvalidOperationException("Native manager string");return s;}
  static long N(object x){if(!(x is int)&&!(x is long))throw new InvalidOperationException("Native manager integer");return Convert.ToInt64(x,CultureInfo.InvariantCulture);}
  static void B(object x,bool expected){if(!(x is bool)||(bool)x!=expected)throw new InvalidOperationException("Native manager flag differs");}
  internal static PhysicalClaim Claim(NativeRpcDefinitionPlan p,Dictionary<string,object> shared){
   if(shared.Count!=4||S(shared["schema"])!="host-physical-pool-binding/1")throw new InvalidOperationException("Original shared pool binding required");
   string id=ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(Json.Serialize(new[]{p.ManagerEpoch,p.Instance,p.App})));
   if(id!=p.Claim)throw new InvalidOperationException("Native manager claim identity differs");
   return new PhysicalClaim(S(shared["configHash"]),p.Boot,"app-native",id,20L*1073741824);
  }
  internal static string Verify(NativeRpcDefinitionPlan p,PhysicalClaim claim,object[] snapshots){
   if(snapshots==null||snapshots.Length!=3)throw new InvalidOperationException("All original manager listeners required");
   var ports=new HashSet<long>();Dictionary<string,object> found=null;long foundPort=0;string revision=null;
   foreach(object item in snapshots){
    var snap=D(item);long port=N(snap["port"]);if((port!=8091&&port!=8095&&port!=8097)||!ports.Add(port))throw new InvalidOperationException("Native manager listener set");
    var health=D(snap["health"]);var vms=D(snap["vms"]);
    if(S(health["managerEpoch"])!=S(vms["managerEpoch"]))throw new InvalidOperationException("Manager epoch changed");
    var rows=A(vms["vms"]);
    if(S(health["managerEpoch"])!=p.ManagerEpoch){foreach(object row in rows){var other=D(row);if(S(other["id"])==p.Instance||(other.ContainsKey("name")&&other["name"] is string&&S(other["name"])==p.Deployment))throw new InvalidOperationException("Native deployment already held by another manager");}continue;}
    if(found!=null)throw new InvalidOperationException("Ambiguous original manager");
    var allocation=D(health["allocation"]);if(S(allocation["schema"])!="enclave-manager-allocation/1"||S(allocation["scope"])!="manager-local"||S(allocation["managerEpoch"])!=p.ManagerEpoch)throw new InvalidOperationException("Manager allocation binding");
    B(allocation["known"],true);B(allocation["inventoryReady"],true);
    if(A(allocation["unknown"]).Count!=0||N(allocation["preparing"])!=0||(N(allocation["heldMiB"])<20480||N(allocation["heldMiB"])>N(allocation["poolMiB"])))throw new InvalidOperationException("Manager allocation incomplete");
    revision=S(allocation["revision"]);long rv;if(!Int64.TryParse(revision,NumberStyles.None,CultureInfo.InvariantCulture,out rv)||rv<0||rv.ToString(CultureInfo.InvariantCulture)!=revision)throw new InvalidOperationException("Allocation revision");
    var pool=D(health["sharedPhysicalPool"]);if(S(pool["poolHash"])!=claim.PoolHash||S(pool["boot"])!=claim.Boot)throw new InvalidOperationException("Manager shared pool differs");
    var cpu=D(health["cpu"]);if(N(cpu["unitsPerVcpu"])!=100000||N(cpu["poolVcpus"])<4||N(cpu["poolVcpus"])>65536||N(cpu["allocatedUnits"])<400000||N(cpu["allocatedUnits"])>N(cpu["poolVcpus"])*100000||N(cpu["freeUnits"])<0)throw new InvalidOperationException("Manager CPU admission differs");
    int matches=0;foreach(object row in rows){var r=D(row);if(S(r["id"])==p.Instance){found=r;matches++;}else if(r.ContainsKey("name")&&r["name"] is string&&S(r["name"])==p.Deployment)throw new InvalidOperationException("Deployment already held");}
    if(matches!=1)throw new InvalidOperationException("Exact manager RPC record missing");foundPort=port;
    int reserved=0;foreach(object row in A(allocation["reservations"])){var r=D(row);if(S(r["id"])==p.Instance){if(N(r["physicalMiB"])!=20480)throw new InvalidOperationException("Native reservation size");reserved++;}}
    if(reserved!=1)throw new InvalidOperationException("Exact native manager reservation missing");
   }
   if(found==null)throw new InvalidOperationException("Original native manager absent");var x=found;
   if(S(x["managerEpoch"])!=p.ManagerEpoch||S(x["id"])!=p.Instance||S(x["instanceId"])!=p.Instance||S(x["name"])!=p.Deployment||S(x["derivation"])!="enclave-catalog-bundle/9"||S(x["imageRole"])!="rpc"||S(x["appId"])!=p.App||S(x["recordSha256"])!=p.Record||S(x["runtimeId"])!=p.Runtime||S(D(x["rpc"])["profileSha256"])!=p.Profile||S(x["status"])!="starting"||N(x["physicalMemoryMiB"])!=20480||N(x["gpuMilli"])!=0)throw new InvalidOperationException("Original native manager record differs");
   foreach(string flag in new[]{"appReady","hostExcluded","providerOperationFenced","reservationMayRelease"})B(x[flag],false);B(x["launching"],true);
   foreach(string key in new[]{"recovered","unattributed"})if(x.ContainsKey(key))B(x[key],false);
   if(x.ContainsKey("vmId")||x.ContainsKey("vmGuid"))throw new InvalidOperationException("Native definition cannot adopt an existing VM");
   var clock=D(x["originalClock"]);if(S(clock["originMs"])!=p.Origin.ToString(CultureInfo.InvariantCulture)||S(clock["deadlineMs"])!=p.Deadline.ToString(CultureInfo.InvariantCulture))throw new InvalidOperationException("Original native clock differs");
   var memory=D(x["memory"]);var cores=D(x["cpu"]);if(N(memory["appMiB"])!=19456||N(cores["vcpus"])!=4||N(cores["grantedUnits"])!=400000||N(cores["appCpuPercent"])!=400)throw new InvalidOperationException("Native purchase differs");
   var c=D(x["sharedPhysicalClaim"]);if(c.Count!=5||S(c["poolHash"])!=claim.PoolHash||S(c["boot"])!=claim.Boot||S(c["actor"])!=claim.Actor||S(c["id"])!=claim.Id||N(c["bytes"])!=claim.Bytes)throw new InvalidOperationException("Original consumed shared claim differs");
   return Json.Serialize(new object[]{foundPort,p.ManagerEpoch,p.Instance,p.Deployment,p.App,p.Record,p.Runtime,p.Profile,p.Origin,p.Deadline,claim.Encode(),revision});
  }
 }
 internal sealed partial class WindowsStartAdmission {
  internal static void VerifyNativeDefinition(ProtectedAttempt plan,ProtectedAttempt reader,ref LegacyHandoff.Completion completed){
   if(plan==null||plan.NativeDefinitionPlan==null||reader==null||reader.LeaseProfile!="native-definition"||reader.Operation!="define")throw new InvalidOperationException("Explicit native definition admission required");
   plan.CheckDeadline();reader.CheckDeadline();var p=plan.NativeDefinitionPlan;
   var reviewed=Obj(new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=32}.DeserializeObject(new UTF8Encoding(false,true).GetString(plan.ReadAdmission(p.Admission))));
   if(reviewed.ContainsKey("unsubmittedPredecessor"))throw new InvalidOperationException("Native app cannot adopt ordinary predecessor authority");
   var shared=Obj(reviewed["sharedPhysicalPool"]);var claim=NativeManagerAuthority.Claim(p,shared);
   var pins=Obj(reviewed["nativeRuntime"]);
   if(pins.Count!=4||Str(pins["runtimeId"])!=p.Runtime||Str(pins["profileSha256"])!=p.Profile||Str(pins["firmwareSha256"])!=p.FirmwareHash||Str(pins["initialStateSha256"])!=p.StateHash)throw new InvalidOperationException("Reviewed native runtime pins differ");
   if(completed==null)completed=new LegacyHandoff.Completion(Obj(reviewed["legacyCutSeed"]),shared,reader,claim);else completed.Verify();
   new WindowsStartAdmission(plan,p.Admission,completed,false,rows=>NativeManagerAuthority.Verify(p,claim,rows)).Read();
   plan.CheckDeadline();reader.CheckDeadline();
  }
 }
 internal sealed class NativeRpcWorkerRuntime:INativeRpcDefinitionRuntime,IDisposable {
  readonly ProtectedAttempt lease,plan;readonly Action guard;LegacyHandoff.Completion completed;bool pinned;
  public long Now{get{return BoundedWorker.MonotonicMilliseconds();}}
  internal NativeRpcWorkerRuntime(ProtectedAttempt lease,ProtectedAttempt plan,Action guard){this.lease=lease;this.plan=plan;this.guard=guard;if(guard==null)throw new ArgumentNullException("guard");}
  public void Check(NativeRpcDefinitionPlan p,bool mutation){
   ProtectedAttempt.RequireSystem();guard();plan.CheckDeadline();
   if(p==null||p.Encode()!=plan.NativeDefinitionPlan.Encode()||lease.PermitHash!=plan.ContractHash||lease.Boot!=p.Boot||p.Boot!=ProtectedAttempt.CurrentBoot())throw new InvalidOperationException("Held native original plan differs");
   if(mutation){
    if(lease.Operation!="define"||Now<p.Origin||Now>=p.Deadline)throw new InvalidOperationException("Native original submit authority expired");
    if(!pinned){plan.PinNativeAsset("runtime.igvm",p.FirmwareHash,Int32.MaxValue,false);plan.PinNativeAsset("guest-state.vmgs",p.StateHash,64*1024*1024,true);plan.PinNativeAsset("bundle.bin",p.App,9*1024*1024,false);plan.PinNativeAsset("record.json",p.Record,65536,false);plan.PinNativeAsset("profile.json",p.Profile,65536,false);plan.PinNativeMedia();pinned=true;}
    WindowsStartAdmission.VerifyNativeDefinition(plan,lease,ref completed);
   }
   guard();plan.CheckDeadline();if(mutation&&Now>=p.Deadline)throw new InvalidOperationException("Native startup deadline expired");
  }
  public void Dispose(){if(completed!=null)completed.Dispose();}
 }
}
