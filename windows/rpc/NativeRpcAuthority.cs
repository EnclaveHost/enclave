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
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
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
  SafeFileHandle nativeStatePin;string nativeStateRecord;
  readonly Dictionary<string,SafeFileHandle> nativeReadPins=new Dictionary<string,SafeFileHandle>();
  internal void PinNativeMedia(){
   if(NativeDefinitionPlan==null||accessLease==null||!((LeaseProfile=="native-definition-journal"&&accessLease.Operation=="define")||(LeaseProfile=="native-start-journal"&&accessLease.Operation=="start")))throw new InvalidOperationException("Original native media custody requires submit lease");
   var p=NativeDefinitionPlan;var profile=new NativeRpcMediaProfile(Bytes(HoldRead(Path.Combine(Root,"profile.json"),16384),16384),p.Profile);
   foreach(bool tree in new[]{false,true}){
    CheckDeadline();string path=Path.Combine(Root,NativeRpcMediaProfile.Name(tree));
    var h=CreateFile(path,0x80000000|0x20000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
    if(h.IsInvalid){int error=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(error);}
    FileStream f=null;
    try{Authority(h,true,false,path);FileInfo info;if(!GetFileInformationByHandle(h,out info)||info.Links!=1)throw new InvalidOperationException("Single-link optical media required");
     f=new FileStream(h,FileAccess.Read);profile.Verify(f,tree,CheckDeadline,null);held.Add(f);nativeReadPins.Add(NativeRpcMediaProfile.Name(tree),h);f=null;
    }catch{if(f!=null)f.Dispose();else if(!h.IsClosed)h.Dispose();throw;}
   }CheckDeadline();
  }
  internal void PinNativeAsset(string name,string digest,int maximum,bool mutable){
   if(NativeDefinitionPlan==null||accessLease==null||!((LeaseProfile=="native-definition-journal"&&accessLease.Operation=="define")||(LeaseProfile=="native-start-journal"&&accessLease.Operation=="start"))||
      (name!="runtime.igvm"&&name!="guest-state.vmgs"&&name!="bundle.bin"&&name!="record.json"&&name!="profile.json")||mutable!=(name=="guest-state.vmgs"))throw new InvalidOperationException("Fixed original native assets required");
   CheckDeadline();Hex(digest,64);string path=Path.Combine(Root,name);
   var h=CreateFile(path,0x80000000|0x20000,mutable?3U:1U,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
   if(h.IsInvalid){int e=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(e);}
   FileStream stream=null;
   try{
    Authority(h,true,false,path);FileInfo info;
    if(!GetFileInformationByHandle(h,out info)||info.Links!=1)throw new InvalidOperationException("Native asset must be a single-link private copy");
    stream=new FileStream(h,FileAccess.Read);if(stream.Length<1||stream.Length>maximum)throw new InvalidOperationException("Native asset size bound");
    if(mutable){
     if(digest!=NativeDefinitionPlan.StateHash||maximum!=64*1024*1024)throw new InvalidOperationException("Fixed original state budget required");
     if(nativeStatePin!=null)throw new InvalidOperationException("State custody already acquired");
     if(LeaseProfile=="native-definition-journal"){
      // This record is created before any provider submission. A partial or
      // existing record never permits recapturing a changed file as initial.
      var journal=new NativeRpcDefinitionJournal(this);
      if(journal.Read("native-state.initial")!=null||journal.Read("native-definition.submit")!=null)throw new InvalidOperationException("Initial state capture already consumed");
      string actual;using(var sha=SHA256.Create())actual=BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
      if(actual!=digest)throw new InvalidOperationException("Initial native state digest differs");
      long size;string identity=ReadGrantFileIdentity(h,out size);
      nativeStateRecord=String.Join("\n",new[]{"native-rpc-state-custody/1",NativeDefinitionPlan.Digest,digest,identity,size.ToString(CultureInfo.InvariantCulture),ReadGrantSecurityHash(ReadGrantDescriptor(h)),""});
      journal.WriteOnce("native-state.initial",nativeStateRecord);
     }else nativeStateRecord=new NativeRpcCleanupJournal(this).Read("native-state.initial");
     ValidateNativeState(h,nativeStateRecord);nativeStatePin=h;
    }else{
     string actual;using(var sha=SHA256.Create())actual=BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
     if(actual!=digest)throw new InvalidOperationException("Native asset digest differs");
    }
    // Firmware/bundle/profile/record deny write+delete. VMGS permits provider
    // writes, never replacement while held. Later start custody checks the
    // recorded original file incarnation and ACL, not pristine template bytes.
    // This is not continuous custody between processes or guest attestation.
    held.Add(stream);if(name=="runtime.igvm")nativeReadPins.Add(name,h);stream=null;CheckDeadline();
   }catch{if(stream!=null)stream.Dispose();else if(!h.IsClosed)h.Dispose();throw;}
  }
  void ValidateNativeState(SafeFileHandle h,string raw){
   if(raw==null)throw new InvalidOperationException("Original state receipt missing");var f=raw.Split('\n');long initial;
   if(f.Length!=7||f[0]!="native-rpc-state-custody/1"||f[1]!=NativeDefinitionPlan.Digest||f[2]!=NativeDefinitionPlan.StateHash||f[6]!=""||!Int64.TryParse(f[4],NumberStyles.None,CultureInfo.InvariantCulture,out initial)||initial<1||initial>64*1024*1024)throw new InvalidOperationException("Original state receipt differs");
   long size;string identity=ReadGrantFileIdentity(h,out size);
   if(identity!=f[3]||size>64*1024*1024||ReadGrantSecurityHash(ReadGrantDescriptor(h))!=f[5])throw new InvalidOperationException("Original state identity permissions or size changed");
  }
  internal void ObserveNativeState(){CheckDeadline();if(nativeStatePin==null)throw new InvalidOperationException("Original state handle missing");ValidateNativeState(nativeStatePin,nativeStateRecord);CheckDeadline();}
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
   if(plan==null||plan.NativeDefinitionPlan==null||reader==null||!((reader.LeaseProfile=="native-definition"&&reader.Operation=="define")||(reader.LeaseProfile=="native-start"&&reader.Operation=="start")))throw new InvalidOperationException("Explicit native definition admission required");
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
 internal sealed class NativeRpcWorkerRuntime:INativeRpcDefinitionRuntime,INativeRpcObservationWait,IDisposable {
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
   if(pinned)plan.ObserveNativeState();
   guard();plan.CheckDeadline();if(mutation&&Now>=p.Deadline)throw new InvalidOperationException("Native startup deadline expired");
  }
  public bool WaitForNextObservation(NativeRpcDefinitionPlan p){
   Check(p,false);long remaining=Math.Min(p.Deadline,lease.Deadline)-Now;
   if(remaining<=25)return false;
   // Independent owner/observer watchdogs are already armed. This only paces
   // queries; a blocked provider call still dies at the original worker deadline.
   System.Threading.Thread.Sleep(25);Check(p,false);return true;
  }
  public void Dispose(){if(completed!=null)completed.Dispose();}
 }
 // Only fixed immutable firmware/media files receive this grant. No directory,
 // VMGS, journal, bundle, credentials or all-VM group permission is added.
 internal interface INativeRpcReadAccess {
  string Resolve(string originalGuid);
  string Capture(string name,string sid);
  void Apply(string name,string sid,string snapshot);
  void Observe(string name,string sid,string snapshot);
 }
 internal static class NativeRpcReadGrant {
  internal static readonly string[] Names={"runtime.igvm","image.container","hash.container"};
  internal const int ReadMask=0x120089; // FILE_GENERIC_READ; no execute/write/delete/ACL rights.
  internal static void Sid(string sid){
   if(sid==null||!System.Text.RegularExpressions.Regex.IsMatch(sid,@"\AS-1-5-83-1-(?:[0-9]+-){3}[0-9]+\z")||new SecurityIdentifier(sid).Value!=sid)
    throw new InvalidOperationException("Exact per-VM SID required; group and caller SIDs refused");
  }
  static void Current(NativeRpcDefinitionPlan p,INativeRpcDefinitionRuntime r,bool mutation){r.Check(p,mutation);if(r.Now<p.Origin||r.Now>=p.Deadline)throw new InvalidOperationException("Original read grant deadline expired");}
  static string Context(NativeRpcDefinitionPlan p,IStartJournal j,out string guid){string owned=NativeRpcSecurity.Ownership(p,j,out guid);return p.Digest+","+guid+","+owned+","+NativeRpcSecurity.VerifyCompleted(p,j);}
  internal static string VerifyCompleted(NativeRpcDefinitionPlan p,IStartJournal j){
   string guid,context=Context(p,j,out guid),intent=j.Read("native-read.intent");if(intent==null)throw new InvalidOperationException("Original media read grant missing");
   var fields=intent.Split('\n');if(fields.Length!=7||fields[0]!="native-rpc-read-grant/1"||fields[1]!=context||fields[6]!="")throw new InvalidOperationException("Original read grant context differs");Sid(fields[2]);
   for(int n=0;n<3;n++)ValidateSnapshot(fields[3+n],Names[n]);
   string h=NativeRpcDefinitionPlan.Hash(intent);if(j.Read("native-read.submit")!=h||j.Read("native-read.receipt")!=h)throw new InvalidOperationException("Original read grant unsettled");return h;
  }
  internal static void ValidateSnapshot(string value,string name){
   var f=value.Split(',');if(f.Length!=5||f[0]!=name||!System.Text.RegularExpressions.Regex.IsMatch(f[1],@"\A[0-9a-f]{8}:[0-9a-f]{16}:[0-9a-f]{16}\z"))throw new InvalidOperationException("Read grant file identity differs");
   long size;if(!Int64.TryParse(f[2],NumberStyles.None,CultureInfo.InvariantCulture,out size)||size<=0||size>Int32.MaxValue)throw new InvalidOperationException("Read grant size");
   StartIdentity.Hex(f[3],64);StartIdentity.Hex(f[4],64);
  }
  internal static string Run(NativeRpcDefinitionPlan p,IStartJournal j,INativeRpcDefinitionRuntime r,INativeRpcReadAccess access,bool readOnly){
   Current(p,r,!readOnly);string guid,context=Context(p,j,out guid),sid=access.Resolve(guid);Sid(sid);
   string intent=j.Read("native-read.intent");
   if(intent==null){
    if(readOnly)return null;
    var f=new List<string>{"native-rpc-read-grant/1",context,sid};foreach(string name in Names){Current(p,r,true);string snapshot=access.Capture(name,sid);ValidateSnapshot(snapshot,name);f.Add(snapshot);}f.Add("");intent=String.Join("\n",f.ToArray());
    j.WriteOnce("native-read.intent",intent);string h=NativeRpcDefinitionPlan.Hash(intent);j.WriteOnce("native-read.submit",h);
    foreach(string snapshot in f.GetRange(3,3)){Current(p,r,true);access.Apply(snapshot.Split(',')[0],sid,snapshot);}
    // Persist success only after all actual handle ACL and identity readbacks.
    Current(p,r,true);j.WriteOnce("native-read.receipt",h);
   }
   if(j.Read("native-read.receipt")==null)return null; // consumed partial grant never retried
   string proof=VerifyCompleted(p,j);var parts=intent.Split('\n');if(parts[2]!=sid)throw new InvalidOperationException("Original VM account resolution changed");
   foreach(string snapshot in new[]{parts[3],parts[4],parts[5]}){Current(p,r,false);access.Observe(snapshot.Split(',')[0],sid,snapshot);}Current(p,r,false);return proof;
  }
  internal static RawSecurityDescriptor AddRead(RawSecurityDescriptor sd,string sid){
   Sid(sid);if(sd.Owner==null||(sd.Owner.Value!="S-1-5-18"&&sd.Owner.Value!="S-1-5-32-544")||sd.DiscretionaryAcl==null||sd.DiscretionaryAcl.Count>64||(sd.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0)throw new InvalidOperationException("Protected owner/ACL required");
   bool allow=false,system=false,admin=false;
   foreach(GenericAce entry in sd.DiscretionaryAcl){var ace=entry as CommonAce;
    if(ace==null||ace.IsCallback||ace.AceFlags!=AceFlags.None)throw new InvalidOperationException("Explicit non-inheriting file ACL required");
    if(ace.AceQualifier==AceQualifier.AccessDenied){if(allow)throw new InvalidOperationException("Noncanonical file ACL");continue;}
    if(ace.AceQualifier!=AceQualifier.AccessAllowed)throw new InvalidOperationException("Unsupported grant ACE");allow=true;
    string principal=ace.SecurityIdentifier.Value;if(principal!="S-1-5-18"&&principal!="S-1-5-32-544")throw new InvalidOperationException("Unexpected preexisting file access");
    system|=principal=="S-1-5-18";admin|=principal=="S-1-5-32-544";
   }
   if(!system||!admin)throw new InvalidOperationException("Original administrator and SYSTEM access required");
   var bytes=new byte[sd.BinaryLength];sd.GetBinaryForm(bytes,0);var next=new RawSecurityDescriptor(bytes,0);
   next.DiscretionaryAcl.InsertAce(next.DiscretionaryAcl.Count,new CommonAce(AceFlags.None,AceQualifier.AccessAllowed,ReadMask,new SecurityIdentifier(sid),false,null));return next;
  }
 }
 public sealed partial class ProtectedAttempt {
  [DllImport("advapi32.dll")]static extern uint SetSecurityInfo(SafeFileHandle h,int type,uint info,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  internal static RawSecurityDescriptor ReadGrantDescriptor(SafeFileHandle h){
   IntPtr owner,group,dacl,sacl,descriptor;uint error=GetSecurityInfo(h,1,1|2|4,out owner,out group,out dacl,out sacl,out descriptor);if(error!=0)throw new Win32Exception((int)error);
   try{uint n=GetSecurityDescriptorLength(descriptor);if(n==0||n>65536)throw new InvalidOperationException("Read grant descriptor bound");var b=new byte[n];Marshal.Copy(descriptor,b,0,(int)n);return new RawSecurityDescriptor(b,0);}finally{if(descriptor!=IntPtr.Zero)LocalFree(descriptor);}
  }
  internal static string ReadGrantSecurityHash(RawSecurityDescriptor sd){
   // Hash precisely the owner/group/protected DACL fields we preserve/read back.
   // AutoInherited/AutoInheritRequired are Windows bookkeeping, not ACEs.
   // Compare protected status plus exact ACL binary; never mask an ACE bit.
   if(sd.DiscretionaryAcl==null)throw new InvalidOperationException("Null grant ACL");
   byte[] acl=new byte[sd.DiscretionaryAcl.BinaryLength];sd.DiscretionaryAcl.GetBinaryForm(acl,0);
   string value=(sd.Owner==null?"":sd.Owner.Value)+"\n"+(sd.Group==null?"":sd.Group.Value)+"\n"+((sd.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0?"protected":"inherited")+"\n"+Convert.ToBase64String(acl);
   return Hash(Encoding.UTF8.GetBytes(value));
  }
  internal static string ReadGrantFileIdentity(SafeFileHandle h,out long size){
   Authority(h,true,false,"original VM read grant");FileInfo f;if(!GetFileInformationByHandle(h,out f)||f.Links!=1)throw new InvalidOperationException("Single-link read grant target required");
   size=((long)f.SizeHigh<<32)|f.SizeLow;if(size<=0||size>Int32.MaxValue)throw new InvalidOperationException("Read grant target size");
   return f.Volume.ToString("x8")+":"+(((ulong)f.IndexHigh<<32)|f.IndexLow).ToString("x16")+":"+f.Created.ToString("x16");
  }
  // Reusable held-handle primitive. The caller must consume the original intent
  // before this call; no path lookup, replacement, owner change or inheritance.
  internal static void SetReadGrantOnHandle(SafeFileHandle h,string sid,string expectedBefore,string expectedAfter){
   var before=ReadGrantDescriptor(h);if(ReadGrantSecurityHash(before)!=expectedBefore)throw new InvalidOperationException("Original ACL changed before grant");var after=NativeRpcReadGrant.AddRead(before,sid);if(ReadGrantSecurityHash(after)!=expectedAfter)throw new InvalidOperationException("Planned ACL differs");
   byte[] acl=new byte[after.DiscretionaryAcl.BinaryLength];after.DiscretionaryAcl.GetBinaryForm(acl,0);var memory=Marshal.AllocHGlobal(acl.Length);
   try{Marshal.Copy(acl,0,memory,acl.Length);uint e=SetSecurityInfo(h,1,0x80000004,IntPtr.Zero,IntPtr.Zero,memory,IntPtr.Zero);if(e!=0)throw new Win32Exception((int)e);}finally{Marshal.FreeHGlobal(memory);}
   if(ReadGrantSecurityHash(ReadGrantDescriptor(h))!=expectedAfter)throw new InvalidOperationException("Read grant ACL readback differs");Authority(h,true,false,"original VM read grant");
  }
  internal INativeRpcReadAccess NativeReadAccess(){return new NativeReadAccessHandles(this);}
  sealed class NativeReadAccessHandles:INativeRpcReadAccess {
   readonly ProtectedAttempt p;readonly Dictionary<string,SafeFileHandle> handles=new Dictionary<string,SafeFileHandle>();readonly HashSet<string> applied=new HashSet<string>();
   internal NativeReadAccessHandles(ProtectedAttempt p){this.p=p;if(p.NativeDefinitionPlan==null||p.accessLease==null)throw new InvalidOperationException("Original native read lease required");}
   public string Resolve(string guid){
    p.CheckDeadline();string original;NativeRpcSecurity.Ownership(p.NativeDefinitionPlan,new NativeRpcDefinitionJournal(p),out original);if(guid!=original)throw new InvalidOperationException("Original VM account required");
    string account=@"NT VIRTUAL MACHINE\"+guid;var sid=(SecurityIdentifier)new NTAccount(account).Translate(typeof(SecurityIdentifier));NativeRpcReadGrant.Sid(sid.Value);
    if(!String.Equals(((NTAccount)sid.Translate(typeof(NTAccount))).Value,account,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("VM SID reverse binding differs");p.CheckDeadline();return sid.Value;
   }
   SafeFileHandle Handle(string name,bool mutation){
    if(Array.IndexOf(NativeRpcReadGrant.Names,name)<0)throw new InvalidOperationException("Fixed read grant file required");p.CheckDeadline();SafeFileHandle h;
    if(handles.TryGetValue(name,out h))return h;
    if(mutation&&(p.accessLease.Operation!="define"||!p.nativeReadPins.ContainsKey(name)))throw new InvalidOperationException("Original pinned asset required before read grant");
    // FILE_READ_DATA makes no-write/no-delete sharing effective; metadata-only
    // handles do not provide the same Windows replacement exclusion.
    string path=Path.Combine(p.Root,name);h=CreateFile(path,0x20081U|(mutation?0x40000U:0U),1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
    if(h.IsInvalid){int error=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(error);}p.held.Add(h);handles.Add(name,h);
    long size;string identity=ReadGrantFileIdentity(h,out size);if(mutation){long other;if(ReadGrantFileIdentity(p.nativeReadPins[name],out other)!=identity||other!=size)throw new InvalidOperationException("Pinned asset identity differs");}return h;
   }
   public string Capture(string name,string sid){var h=Handle(name,true);long size;string id=ReadGrantFileIdentity(h,out size);var before=ReadGrantDescriptor(h);var after=NativeRpcReadGrant.AddRead(before,sid);return name+","+id+","+size.ToString(CultureInfo.InvariantCulture)+","+ReadGrantSecurityHash(before)+","+ReadGrantSecurityHash(after);}
   public void Apply(string name,string sid,string snapshot){p.CheckDeadline();if(!applied.Add(name))throw new InvalidOperationException("Handle grant already consumed");if(Capture(name,sid)!=snapshot)throw new InvalidOperationException("Pinned grant snapshot changed");var f=snapshot.Split(',');SetReadGrantOnHandle(Handle(name,true),sid,f[3],f[4]);Observe(name,sid,snapshot);}
   public void Observe(string name,string sid,string snapshot){NativeRpcReadGrant.ValidateSnapshot(snapshot,name);NativeRpcReadGrant.Sid(sid);var f=snapshot.Split(',');var h=Handle(name,false);long size;string id=ReadGrantFileIdentity(h,out size);var sd=ReadGrantDescriptor(h);
    if(id!=f[1]||size.ToString(CultureInfo.InvariantCulture)!=f[2]||ReadGrantSecurityHash(sd)!=f[4])throw new InvalidOperationException("Original grant identity/ACL changed");int matches=0;foreach(GenericAce entry in sd.DiscretionaryAcl){var ace=entry as CommonAce;if(ace!=null&&ace.SecurityIdentifier.Value==sid){if(ace.AceFlags!=AceFlags.None||ace.AceQualifier!=AceQualifier.AccessAllowed||ace.AccessMask!=NativeRpcReadGrant.ReadMask)throw new InvalidOperationException("VM read ACE differs");matches++;}}if(matches!=1)throw new InvalidOperationException("Exact VM read ACE missing");p.CheckDeadline();
   }
  }
 }

}
