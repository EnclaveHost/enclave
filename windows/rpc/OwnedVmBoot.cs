// Fixed Gen2 Ubuntu media/network configuration. No Start/Save/Delete operation.
// Each mutation has a durable one-shot journal and exact returned-job identity.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Management;
using System.Text;
using System.Text.RegularExpressions;
namespace Enclave.OwnedRpc {
 public sealed class OwnedVmBootPlan {
  public readonly OwnedVmDefinitionPlan Definition;
  public readonly string VmGuid,SwitchGuid,Mac;
  public OwnedVmBootPlan(OwnedVmDefinitionPlan definition,string guid,string switchGuid,string mac){
   if(definition==null)throw new ArgumentNullException("definition");
   foreach(string id in new[]{guid,switchGuid}){Guid value;if(!Guid.TryParseExact(id,"D",out value)||value==Guid.Empty||value.ToString("D")!=id)throw new ArgumentException("Canonical VM/switch GUID required");}
   if(mac==null||!Regex.IsMatch(mac,"\\A02[0-9A-F]{10}\\z"))throw new ArgumentException("Explicit local unicast MAC required");
   Definition=definition;VmGuid=guid;SwitchGuid=switchGuid;Mac=mac;
  }
  internal static OwnedVmBootPlan FromAdmission(ProtectedAttempt pin,string guid){
   var json=new System.Web.Script.Serialization.JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=32};
   var root=json.DeserializeObject(new UTF8Encoding(false,true).GetString(pin.ReadAdmission(pin.DefinitionPlan.AdmissionHash))) as Dictionary<string,object>;object value;
   if(root==null||!root.TryGetValue("bootNetwork",out value))throw new InvalidOperationException("Reviewed boot network absent");
   var d=value as Dictionary<string,object>;
   if(d==null||d.Count!=3||!d.ContainsKey("schema")||!d.ContainsKey("switchGuid")||!d.ContainsKey("mac")||StartRecords.Text(d["schema"])!="owned-rpc-boot-network/1")throw new InvalidOperationException("Explicit fixed boot network required");
   return new OwnedVmBootPlan(pin.DefinitionPlan,guid,StartRecords.Text(d["switchGuid"]),StartRecords.Text(d["mac"]));
  }
  public string Encode(){return StartRecords.Encode(new Dictionary<string,object>{{"schema","owned-rpc-boot/1"},{"definition",ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(Definition.Encode()))},{"vm",VmGuid},{"switch",SwitchGuid},{"mac",Mac}});}
 }
 public sealed class OwnedBootJournal:IStartJournal {
  readonly ProtectedAttempt pin;
  public OwnedBootJournal(ProtectedAttempt pin){if(pin==null||pin.DefinitionPlan==null)throw new ArgumentException("Held original definition plan required");this.pin=pin;}
  public void WriteOnce(string name,string value){if(!ProtectedAttempt.BootRecordAllowed(name,false))throw new InvalidOperationException("Fixed boot journal name required");pin.WriteOnce(name,value);}
  public string Read(string name){if(!ProtectedAttempt.BootRecordAllowed(name,false))throw new InvalidOperationException("Fixed boot journal name required");return pin.ReadOptionalOnce(name);}
 }
 public interface IBootRuntime {
  long Now{get;}
  void Verify(OwnedVmBootPlan p,bool mutation);
 }
 public sealed class BootResponse {
  public readonly uint Code;public readonly string Job,Resource;
  public BootResponse(uint code,string job,string resource){Code=code;Job=job;Resource=resource;}
 }
 public interface IBootProvider {
  BootResponse Configure(OwnedVmBootPlan p,string step,IDictionary<string,string> prior);
  StartJob ReadJob(string reference);
  void VerifyResource(OwnedVmBootPlan p,string step,string reference,IDictionary<string,string> prior);
  void VerifyComplete(OwnedVmBootPlan p,IDictionary<string,string> resources);
 }
 public sealed class BootOutcome {
  public readonly string State;public readonly bool Configured;
  public bool StartAuthorized{get{return false;}}
  public bool ReservationMayRelease{get{return false;}}
  internal BootOutcome(string state,bool configured){State=state;Configured=configured;}
 }
 public static class OwnedVmBoot {
  internal static readonly string[] Steps={"scsi","diskdrive","diskmedia","bootorder","seeddrive","seedmedia","nic","port"};
  internal static string Hash(string s){return ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(s));}
  public static bool RecordAllowed(string name,bool readOnly){
   return ProtectedAttempt.BootRecordAllowed(name,readOnly);
  }
  static string Intent(OwnedVmBootPlan p,string step,IDictionary<string,string> prior){return StartRecords.Encode(new Dictionary<string,object>{{"plan",Hash(p.Encode())},{"step",step},{"prior",new SortedDictionary<string,string>(prior,StringComparer.Ordinal)}});}
  static void Current(OwnedVmBootPlan p,IBootRuntime r,bool mutation){r.Verify(p,mutation);if(r.Now<p.Definition.Origin||(mutation&&r.Now>=p.Definition.Deadline))throw new InvalidOperationException("Original boot configuration deadline");}
  public static BootOutcome Configure(OwnedVmBootPlan p,IStartJournal journal,IBootProvider provider,IBootRuntime runtime,bool readOnly){
   var resources=new Dictionary<string,string>();
   foreach(string step in Steps){
    Current(p,runtime,!readOnly);string prefix="boot."+step,expected=Intent(p,step,resources),intent=journal.Read(prefix+".intent");
    if(intent==null){if(readOnly)return new BootOutcome("not-submitted-held",false);journal.WriteOnce(prefix+".intent",expected);intent=expected;}
    if(intent!=expected)throw new InvalidOperationException("Boot intent or dependency differs");
    string digest=Hash(intent),submit=journal.Read(prefix+".submit"),receipt=journal.Read(prefix+".receipt");
    if(submit==null){
     if(readOnly)return new BootOutcome("not-submitted-held",false);
     journal.WriteOnce(prefix+".submit",digest);Current(p,runtime,true);
     // A crash or lost response after consumption never repeats this mutation.
     BootResponse response=provider.Configure(p,step,resources);if(response==null)throw new InvalidOperationException("Lost boot response");
     string job="",resource="";
     if(response.Code==4096)job=HyperVStartProvider.CanonicalJobReference(response.Job);
     else if(!String.IsNullOrEmpty(response.Job))throw new InvalidOperationException("Unexpected boot job");
     if(!String.IsNullOrEmpty(response.Resource))resource=HyperVOwnedBoot.CanonicalResource(step,response.Resource);
     if(response.Code!=0&&response.Code!=4096&&resource!="")throw new InvalidOperationException("Refused boot operation returned resource");
     receipt=StartRecords.Encode(new Dictionary<string,object>{{"intent",digest},{"code",response.Code},{"job",job},{"resource",resource}});
     journal.WriteOnce(prefix+".receipt",receipt);submit=digest;
    }
    if(submit!=digest)throw new InvalidOperationException("Boot submission differs");
    if(receipt==null)return new BootOutcome("response-lost-held",false);
    var saved=StartRecords.Parse(receipt,new[]{"intent","code","job","resource"});
    if(StartRecords.Text(saved["intent"])!=digest)throw new InvalidOperationException("Boot receipt differs");
    long code=StartRecords.Number(saved["code"]);if(code<0||code>UInt32.MaxValue)throw new InvalidOperationException("Boot return code");
    string reference=StartRecords.Text(saved["job"]),result=StartRecords.Text(saved["resource"]);
    if(code!=4096&&reference!="")throw new InvalidOperationException("Unexpected persisted boot job");
    if(code!=0&&code!=4096)return new BootOutcome("provider-refused-held",false);
    if(code==4096){
     if(HyperVStartProvider.CanonicalJobReference(reference)!=reference)throw new InvalidOperationException("Canonical boot job required");
     string terminal=journal.Read(prefix+".terminal"),identity=journal.Read(prefix+".job");
     if(terminal==null){
      Current(p,runtime,false);StartJob job=provider.ReadJob(reference);Current(p,runtime,false);
      if(job==null||job.Reference!=reference||HyperVStartProvider.ReferenceForId(job.InstanceId)!=reference||String.IsNullOrEmpty(job.TimeSubmitted)||job.TimeSubmitted.Length>32)throw new InvalidOperationException("Exact boot job unavailable");
      string binding=StartRecords.Encode(new Dictionary<string,object>{{"receipt",Hash(receipt)},{"job",reference},{"submitted",job.TimeSubmitted}});
      if(identity==null){journal.WriteOnce(prefix+".job",binding);identity=binding;}if(identity!=binding)throw new InvalidOperationException("Boot job incarnation changed");
      if(job.State!=7||job.RunTimes!=1)return new BootOutcome("job-pending-held",false);
      terminal=StartRecords.Encode(new Dictionary<string,object>{{"identity",Hash(identity)},{"receipt",Hash(receipt)},{"error",job.ErrorCode},{"state",7},{"runs",1}});journal.WriteOnce(prefix+".terminal",terminal);
     }
     var t=StartRecords.Parse(terminal,new[]{"identity","receipt","error","state","runs"});
     if(identity==null||StartRecords.Text(t["identity"])!=Hash(identity)||StartRecords.Text(t["receipt"])!=Hash(receipt)||StartRecords.Number(t["state"])!=7||StartRecords.Number(t["runs"])!=1)throw new InvalidOperationException("Boot settlement binding differs");
     long error=StartRecords.Number(t["error"]);if(error<0||error>UInt16.MaxValue)throw new InvalidOperationException("Boot error range");if(error!=0)return new BootOutcome("operation-failed-held",false);
    }
    // Never guess a resulting resource from a name or broad inventory after a
    // lost native response. An absent returned resource remains held.
    if(result=="")return new BootOutcome("result-resource-missing-held",false);
    if(HyperVOwnedBoot.CanonicalResource(step,result)!=result)throw new InvalidOperationException("Noncanonical boot resource");
    Current(p,runtime,false);provider.VerifyResource(p,step,result,resources);Current(p,runtime,false);resources.Add(step,result);
   }
   provider.VerifyComplete(p,resources);Current(p,runtime,false);
   string proof=StartRecords.Encode(new Dictionary<string,object>{{"plan",Hash(p.Encode())},{"resources",new SortedDictionary<string,string>(resources,StringComparer.Ordinal)},{"state","configured-owned-off"}});
   string old=journal.Read("boot.ready");if(old==null)journal.WriteOnce("boot.ready",proof);else if(old!=proof)throw new InvalidOperationException("Boot completion differs");
   return new BootOutcome("configured-owned-off",true);
  }
 }
 // Fixed native recipe; requires a supervised SYSTEM caller with retained
 // namespace/media authority. Native ABI and host property support need target
 // qualification. This library has no direct activation entry point.
 public sealed class HyperVOwnedBoot:IBootProvider {
  readonly IBootRuntime runtime;readonly IDefinitionProvider definition;
  public HyperVOwnedBoot(IBootRuntime runtime,IDefinitionProvider definition){if(runtime==null||definition==null)throw new ArgumentNullException("dependencies");this.runtime=runtime;this.definition=definition;}
  internal static string ClassFor(string step){
   if(step=="bootorder")return "Msvm_BootSourceSettingData";
   if(step=="diskmedia"||step=="seedmedia")return "Msvm_StorageAllocationSettingData";
   if(step=="nic")return "Msvm_SyntheticEthernetPortSettingData";
   if(step=="port")return "Msvm_EthernetPortAllocationSettingData";
   if(step=="scsi"||step=="diskdrive"||step=="seeddrive")return "Msvm_ResourceAllocationSettingData";
   throw new ArgumentException("Fixed boot step required");
  }
  internal static string CanonicalResource(string step,string raw){
   if(raw==null||raw.Length>2048)throw new InvalidOperationException("Resource reference bound");var path=new ManagementPath(raw);
   if(!path.IsInstance||!String.Equals(path.ClassName,ClassFor(step),StringComparison.OrdinalIgnoreCase)||(path.Server!=""&&path.Server!="."&&!String.Equals(path.Server,Environment.MachineName,StringComparison.OrdinalIgnoreCase)))throw new InvalidOperationException("Local fixed resource class required");
   string ns=path.NamespacePath;if(ns.StartsWith(@"\\")){int slash=ns.IndexOf('\\',2);if(slash<0)throw new InvalidOperationException("Resource namespace");ns=ns.Substring(slash+1);}
   if(ns!=""&&!String.Equals(ns,@"root\virtualization\v2",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Resource namespace");
   // Preserve provider escaping, but accept exactly one string InstanceID key.
   string relative=path.RelativePath;if(!Regex.IsMatch(relative,"\\A"+ClassFor(step)+"\\.InstanceID=\"(?:[^\"\\\\\\r\\n]|\\\\[\\\\\"]){1,1024}\"\\z",RegexOptions.IgnoreCase))throw new InvalidOperationException("Exact resource instance key required");
   return ClassFor(step)+relative.Substring(relative.IndexOf('.'));
  }
  static ManagementObject Read(string step,string reference){var row=new ManagementObject(HyperVStartProvider.Scope(),new ManagementPath(CanonicalResource(step,reference)),new ObjectGetOptions{Timeout=TimeSpan.FromSeconds(2)});try{row.Get();if(CanonicalResource(step,row.Path.Path)!=reference)throw new InvalidOperationException("Resource changed");return row;}catch{row.Dispose();throw;}}
  static ManagementObject Settings(OwnedVmBootPlan p){return HyperVStartProvider.One(HyperVStartProvider.Scope(),"SELECT * FROM Msvm_VirtualSystemSettingData WHERE VirtualSystemIdentifier='"+p.VmGuid+"' AND VirtualSystemType='Microsoft:Hyper-V:System:Realized'");}
  void Guard(OwnedVmBootPlan p,bool write){runtime.Verify(p,write);definition.RequireOwnedOff(p.Definition,p.VmGuid);runtime.Verify(p,write);}
  internal static Dictionary<string,object> Values(OwnedVmBootPlan p,string step,IDictionary<string,string> prior,string switchPath){
   if(step=="scsi")return new Dictionary<string,object>{{"ResourceType",(ushort)6},{"ResourceSubType","Microsoft:Hyper-V:Synthetic SCSI Controller"},{"Address","0"}};
   if(step=="diskdrive"||step=="seeddrive")return new Dictionary<string,object>{{"ResourceType",(ushort)(step=="diskdrive"?17:16)},{"ResourceSubType",step=="diskdrive"?"Microsoft:Hyper-V:Synthetic Disk Drive":"Microsoft:Hyper-V:Synthetic DVD Drive"},{"Parent",prior["scsi"]},{"AddressOnParent",step=="diskdrive"?"0":"1"}};
   if(step=="diskmedia"||step=="seedmedia")return new Dictionary<string,object>{{"ResourceType",(ushort)31},{"ResourceSubType",step=="diskmedia"?"Microsoft:Hyper-V:Virtual Hard Disk":"Microsoft:Hyper-V:Virtual CD/DVD Disk"},{"Parent",prior[step=="diskmedia"?"diskdrive":"seeddrive"]},{"HostResource",new[]{step=="diskmedia"?p.Definition.Disk:p.Definition.Seed}}};
   if(step=="nic")return new Dictionary<string,object>{{"ResourceType",(ushort)10},{"ResourceSubType","Microsoft:Hyper-V:Synthetic Ethernet Port"},{"ElementName","owned-rpc-nic"},{"Address",p.Mac},{"StaticMacAddress",true}};
   if(step=="port")return new Dictionary<string,object>{{"ResourceType",(ushort)33},{"ResourceSubType","Microsoft:Hyper-V:Ethernet Connection"},{"Parent",prior["nic"]},{"HostResource",new[]{switchPath}},{"EnabledState",(ushort)2}};
   throw new ArgumentException("Fixed resource recipe required");
  }
  static string Switch(OwnedVmBootPlan p){using(var s=HyperVStartProvider.One(HyperVStartProvider.Scope(),"SELECT * FROM Msvm_VirtualEthernetSwitch WHERE Name='"+p.SwitchGuid+"'")){if((string)s["Name"]!=p.SwitchGuid)throw new InvalidOperationException("Exact switch identity differs");return s.Path.Path;}}
  static List<string> Resources(ManagementObject settings,string step,string subtype){
   var rows=new List<string>();int count=0;using(var all=settings.GetRelated(ClassFor(step)))foreach(ManagementObject row in all)using(row){if(++count>64)throw new InvalidOperationException("Resource inventory bound");if(subtype==null||(string)row["ResourceSubType"]==subtype)rows.Add(CanonicalResource(step,row.Path.Path));}return rows;
  }
  static void Equal(object actual,object expected){
   if(expected is string[]){var a=actual as string[];var e=(string[])expected;if(a==null||a.Length!=e.Length)throw new InvalidOperationException("Resource array differs");for(int n=0;n<a.Length;n++)if(!String.Equals(a[n],e[n],StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Resource array value differs");}
   else if(expected is string){if(!String.Equals(actual as string,(string)expected,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Resource string differs");}
   else if(!Object.Equals(actual,expected))throw new InvalidOperationException("Resource typed value differs");
  }
  public BootResponse Configure(OwnedVmBootPlan p,string step,IDictionary<string,string> prior){
   ProtectedAttempt.RequireSystem();Guard(p,true);var scope=HyperVStartProvider.Scope();
   using(var settings=Settings(p))using(var service=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_VirtualSystemManagementService")){
    if(step=="bootorder"){
     string selected=null;var order=settings["BootSourceOrder"] as string[];if(order==null||order.Length>16)throw new InvalidOperationException("Boot sources unavailable");
     foreach(string path in order){string r=CanonicalResource("bootorder",path);using(var boot=Read("bootorder",r)){if(Convert.ToUInt32(boot["BootSourceType"])==1){if(selected!=null)throw new InvalidOperationException("Ambiguous drive boot source");selected=r;}}}
     if(selected==null)throw new InvalidOperationException("Drive boot source absent");
     // At this fixed stage only the exact recorded disk drive/media may exist.
     RequireOnlyDisk(p,settings,prior);settings["BootSourceOrder"]=new[]{scope.Path.Path+":"+selected};
     using(var input=service.GetMethodParameters("ModifySystemSettings")){input["SystemSettings"]=settings.GetText(TextFormat.WmiDtd20);Guard(p,true);using(var output=service.InvokeMethod("ModifySystemSettings",input,new InvokeMethodOptions{Timeout=TimeSpan.FromSeconds(2)}))return Response(output,selected);}
    }
    string sw=step=="port"?Switch(p):null;var values=Values(p,step,prior,sw);var existing=Resources(settings,step,(string)values["ResourceSubType"]);
    if(step=="scsi"&&existing.Count==1){VerifyResource(p,step,existing[0],prior);return new BootResponse(0,null,existing[0]);}
    if(existing.Count!=0)throw new InvalidOperationException("Unexpected existing boot resource; no duplicate attachment");
    using(var cls=new ManagementClass(scope,new ManagementPath(ClassFor(step)),null))using(var row=cls.CreateInstance())using(var input=service.GetMethodParameters("AddResourceSettings")){
     if(row==null)throw new InvalidOperationException("Resource class unavailable");foreach(var pair in values)row[pair.Key]=pair.Key=="Parent"?scope.Path.Path+":"+(string)pair.Value:pair.Value;
     input["AffectedConfiguration"]=settings.Path.Path;input["ResourceSettings"]=new[]{row.GetText(TextFormat.WmiDtd20)};Guard(p,true);
     using(var output=service.InvokeMethod("AddResourceSettings",input,new InvokeMethodOptions{Timeout=TimeSpan.FromSeconds(2)})){
      if(output==null)throw new InvalidOperationException("Missing native resource response");var references=output["ResultingResourceSettings"] as string[];
      if(references!=null&&references.Length>1)throw new InvalidOperationException("Ambiguous returned resource");return Response(output,references==null||references.Length==0?null:references[0]);
     }
    }
   }
  }
  static BootResponse Response(ManagementBaseObject row,string resource){if(row==null||row["ReturnValue"]==null)throw new InvalidOperationException("Missing native boot response");return new BootResponse(Convert.ToUInt32(row["ReturnValue"]),row["Job"] as string,resource);}
  static void RequireOnlyDisk(OwnedVmBootPlan p,ManagementObject settings,IDictionary<string,string> prior){
   var disks=Resources(settings,"diskdrive","Microsoft:Hyper-V:Synthetic Disk Drive");var dvds=Resources(settings,"seeddrive","Microsoft:Hyper-V:Synthetic DVD Drive");var media=Resources(settings,"diskmedia","Microsoft:Hyper-V:Virtual Hard Disk");
   if(disks.Count!=1||disks[0]!=prior["diskdrive"]||dvds.Count!=0||media.Count!=1||media[0]!=prior["diskmedia"])throw new InvalidOperationException("Disk-first stage topology differs");
  }
  public StartJob ReadJob(string reference){return definition.ReadJob(reference);}
  public void VerifyResource(OwnedVmBootPlan p,string step,string reference,IDictionary<string,string> prior){
   ProtectedAttempt.RequireSystem();Guard(p,false);
   using(var settings=Settings(p))using(var row=Read(step,reference)){
    if(step=="bootorder"){
     var order=settings["BootSourceOrder"] as string[];if(order==null||order.Length==0||order.Length>16||CanonicalResource("bootorder",order[0])!=reference||Convert.ToUInt32(row["BootSourceType"])!=1)throw new InvalidOperationException("Owned drive is not first boot source");
    }else{
     var expected=Values(p,step,prior,step=="port"?Switch(p):null);var all=Resources(settings,step,(string)expected["ResourceSubType"]);
     if(all.Count!=1||all[0]!=reference)throw new InvalidOperationException("Returned resource is not uniquely attached to owned VM");
     foreach(var pair in expected){object actual=row[pair.Key];if(pair.Key=="Parent")actual=CanonicalResource(step=="port"?"nic":step=="diskmedia"?"diskdrive":step=="seedmedia"?"seeddrive":"scsi",(string)actual);Equal(actual,pair.Value);}
    }
   }Guard(p,false);
  }
  public void VerifyComplete(OwnedVmBootPlan p,IDictionary<string,string> resources){
   foreach(string step in OwnedVmBoot.Steps)VerifyResource(p,step,resources[step],resources);
   Guard(p,false);
  }
 }
}

namespace Enclave.OwnedRpc {
 public sealed partial class ProtectedAttempt {
  // Holds the exact data-file identity without DELETE sharing. Hashing uses an
  // additional no-WRITE-share handle before attachment; that temporary handle
  // closes to permit the provider's legitimate VHDX metadata writes while Off.
  internal void PinBootMedia(OwnedVmDefinitionPlan plan,bool readOnly){
   if(DefinitionPlan==null||DefinitionPlan.Encode()!=plan.Encode()||Root!=plan.Root)throw new ArgumentException("Held original boot media namespace required");
   string prior=ReadOptionalOnce("boot.media");
   if(prior==null&&readOnly)throw new InvalidOperationException("Initial media verification absent");
   var proof=new Dictionary<string,object>{{"plan",Hash(Encoding.UTF8.GetBytes(plan.Encode()))}};
   foreach(string name in new[]{"disk","seed"}){
    CheckDeadline();string path=name=="disk"?plan.Disk:plan.Seed,hash=name=="disk"?plan.BootDiskHash:plan.SeedHash;long maximum=name=="disk"?4294967296L:67108864L;
    var heldIdentity=CreateFile(path,0x20000|0x80,3,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
    if(heldIdentity.IsInvalid){heldIdentity.Dispose();throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());}
    held.Add(heldIdentity);Authority(heldIdentity,true,false,path);FileInfo info;
    if(!GetFileInformationByHandle(heldIdentity,out info))throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
    long length=checked(((long)info.SizeHigh<<32)|info.SizeLow);if(length<1||length>maximum)throw new InvalidOperationException("Boot media byte bound");
    proof[name]=new object[]{hash,info.Volume,info.IndexHigh,info.IndexLow};
    if(prior==null){
     using(var handle=CreateFile(path,0x80000000|0x20000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero)){
      if(handle.IsInvalid)throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());Authority(handle,true,false,path);FileInfo second;
      if(!GetFileInformationByHandle(handle,out second)||second.Volume!=info.Volume||second.IndexHigh!=info.IndexHigh||second.IndexLow!=info.IndexLow)throw new InvalidOperationException("Boot media incarnation changed");
      using(var stream=new FileStream(handle,FileAccess.Read))using(var digest=System.Security.Cryptography.SHA256.Create()){
       var buffer=new byte[65536];long total=0;int n;
       while((n=stream.Read(buffer,0,buffer.Length))!=0){CheckDeadline();total+=n;if(total>maximum)throw new InvalidOperationException("Boot media grew beyond bound");digest.TransformBlock(buffer,0,n,buffer,0);}
       digest.TransformFinalBlock(new byte[0],0,0);if(total!=length||BitConverter.ToString(digest.Hash).Replace("-","").ToLowerInvariant()!=hash)throw new InvalidOperationException("Original boot media digest differs");
      }
     }
    }
   }
   string expected=StartRecords.Encode(proof);if(prior==null)WriteOnce("boot.media",expected);else if(prior!=expected)throw new InvalidOperationException("Verified boot media identity changed");CheckDeadline();
  }
 }
}
