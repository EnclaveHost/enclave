// Fixed ordinary Generation 2 definition transaction. No start, save, delete,
// restore, name-based recovery or automatic retry. Target activation is separate.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Management;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
namespace Enclave.OwnedRpc {
 public sealed class OwnedVmDefinitionPlan {
  public readonly string Attempt,Boot,AdmissionHash,ProviderImageHash,Root,BootDiskHash,SeedHash;
  public readonly long Origin,Deadline;
  public const long GuestBytes=19L*1073741824,SupportBytes=1073741824;
  public string Name {get{return "enclave-owned-rpc-"+Attempt;}}
  public string Note {get{return "owned-rpc/"+Attempt+"/"+AdmissionHash;}}
  public string ConfigurationRoot {get{return Path.Combine(Root,"vm");}}
  public string Disk {get{return Path.Combine(Root,"boot.vhdx");}}
  public string Seed {get{return Path.Combine(Root,"seed.iso");}}
  public OwnedVmDefinitionPlan(string attempt,string boot,string admission,string providerImage,string root,long origin,long deadline,string bootDisk,string seed) {
   StartIdentity.Hex(attempt,32);StartIdentity.Hex(boot,32);StartIdentity.Hex(admission,64);StartIdentity.Hex(providerImage,64);StartIdentity.Hex(bootDisk,64);StartIdentity.Hex(seed,64);
   ProtectedAttempt.LocalPath(root);
   if(Path.GetFileName(root)!=attempt||origin<0||origin>Int64.MaxValue-900000||deadline!=origin+900000)throw new ArgumentException("Original owned definition namespace/time");
   Attempt=attempt;Boot=boot;AdmissionHash=admission;ProviderImageHash=providerImage;Root=root;Origin=origin;Deadline=deadline;BootDiskHash=bootDisk;SeedHash=seed;
  }
  public static OwnedVmDefinitionPlan Parse(string raw){
   if(raw==null||Encoding.UTF8.GetByteCount(raw)>4096)throw new ArgumentException("Definition plan bound");
   string[] f=raw.Split('\n');if(f.Length!=12||f[0]!="owned-rpc-definition/1"||f[10]!="generation-2-ubuntu;guest=20401094656;support=1073741824;vcpus=4;start=false"||f[11]!="")throw new ArgumentException("Exact definition plan schema");
   var p=new OwnedVmDefinitionPlan(f[1],f[2],f[3],f[4],f[5],Int64.Parse(f[6],NumberStyles.None,CultureInfo.InvariantCulture),Int64.Parse(f[7],NumberStyles.None,CultureInfo.InvariantCulture),f[8],f[9]);
   if(p.Encode()!=raw)throw new ArgumentException("Canonical definition plan required");return p;
  }
  public string Encode(){return String.Join("\n",new[]{"owned-rpc-definition/1",Attempt,Boot,AdmissionHash,ProviderImageHash,Root,Origin.ToString(CultureInfo.InvariantCulture),Deadline.ToString(CultureInfo.InvariantCulture),BootDiskHash,SeedHash,"generation-2-ubuntu;guest=20401094656;support=1073741824;vcpus=4;start=false",""});}
  public OwnedVmPermit Permit(string actualGuid){return new OwnedVmPermit(Attempt,Boot,AdmissionHash,ProviderImageHash,actualGuid,ConfigurationRoot,Origin,Deadline,GuestBytes,SupportBytes);}
 }
 public interface IDefinitionRuntime {
  long Now {get;}
  // Must retain protected plan/namespace, current capacity/cut authority and
  // exact independent worker/observer identities across the native call.
  void VerifyBeforeDefinition(OwnedVmDefinitionPlan plan);
  void VerifyObservation(OwnedVmDefinitionPlan plan);
 }
 public sealed class DefinitionResponse {
  public readonly uint Code;public readonly string Job,System;
  public DefinitionResponse(uint code,string job,string system){Code=code;Job=job;System=system;}
 }
 public interface IDefinitionProvider {
  DefinitionResponse Define(OwnedVmDefinitionPlan plan);
  StartJob ReadJob(string exactReference);
  string ReadResultingSystem(string exactSettledJob);
  void RequireOwnedOff(OwnedVmDefinitionPlan plan,string actualGuid);
 }
 public sealed class DefinitionOutcome {
  public readonly string State,Guid;public readonly bool DefinitionSettled;
  public bool StartAuthorized {get{return false;}}
  public bool ReservationMayRelease {get{return false;}}
  internal DefinitionOutcome(string state,string guid,bool settled){State=state;Guid=guid;DefinitionSettled=settled;}
 }
 public static class OwnedVmDefinition {
  static string Hash(string s){return ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(s));}
  static void Current(OwnedVmDefinitionPlan p,IDefinitionRuntime r){if(r.Now<p.Origin||r.Now>=p.Deadline)throw new InvalidOperationException("Original startup deadline");}
  static string Intent(OwnedVmDefinitionPlan p,IStartJournal j){string raw=p.Encode();if(j.Read("definition.intent")!=raw)throw new InvalidOperationException("Exact consumed definition plan required");return Hash(raw);}
  public static void Prepare(OwnedVmDefinitionPlan p,IStartJournal j){j.WriteOnce("definition.intent",p.Encode());}
  public static DefinitionOutcome Submit(OwnedVmDefinitionPlan p,IStartJournal j,IDefinitionProvider provider,IDefinitionRuntime r){
   string intent=Intent(p,j);Current(p,r);j.WriteOnce("definition.submit",intent);
   r.VerifyBeforeDefinition(p);Current(p,r);
   // Consumption survives a lost native return. No catch/retry/delete path.
   j.WriteOnce("definition.native",intent);r.VerifyBeforeDefinition(p);Current(p,r);
   DefinitionResponse response=provider.Define(p);if(response==null)throw new InvalidOperationException("Lost definition response");
   string job="",system="";
   if(response.Code==4096)job=HyperVStartProvider.CanonicalJobReference(response.Job);
   else if(!String.IsNullOrEmpty(response.Job))throw new InvalidOperationException("Unexpected definition job");
   if(!String.IsNullOrEmpty(response.System))system=SystemReference(response.System);
   if(response.Code!=0&&response.Code!=4096&&system!="")throw new InvalidOperationException("Refused definition returned a system");
   j.WriteOnce("definition.receipt",StartRecords.Encode(new Dictionary<string,object>{{"intent",intent},{"code",response.Code},{"job",job},{"system",system}}));
   return Reconcile(p,j,provider,r);
  }
  public static DefinitionOutcome Reconcile(OwnedVmDefinitionPlan p,IStartJournal j,IDefinitionProvider provider,IDefinitionRuntime r){
   string intent=Intent(p,j);r.VerifyObservation(p);
   if(j.Read("definition.submit")!=intent||j.Read("definition.native")!=intent)return new DefinitionOutcome("submission-unproven-held",null,false);
   string raw=j.Read("definition.receipt");if(raw==null)return new DefinitionOutcome("response-lost-held",null,false);
   var receipt=StartRecords.Parse(raw,new[]{"intent","code","job","system"});
   if(StartRecords.Text(receipt["intent"])!=intent)throw new InvalidOperationException("Definition receipt binding");
   long code=StartRecords.Number(receipt["code"]);if(code<0||code>UInt32.MaxValue)throw new InvalidOperationException("Definition return code");
   string job=StartRecords.Text(receipt["job"]),system=StartRecords.Text(receipt["system"]);
   if(system!=""&&SystemReference(system)!=system)throw new InvalidOperationException("Canonical returned system required");
   if(code!=4096&&job!="")throw new InvalidOperationException("Unexpected persisted job");
   if(code!=0&&code!=4096)return new DefinitionOutcome("provider-refused-held",null,false);
   if(code==4096){
    if(HyperVStartProvider.CanonicalJobReference(job)!=job)throw new InvalidOperationException("Canonical returned job required");
    string terminal=j.Read("definition.terminal"),identity=j.Read("definition.job");
    if(terminal==null){
     r.VerifyObservation(p);StartJob current=provider.ReadJob(job);r.VerifyObservation(p);
     if(current==null||current.Reference!=job||HyperVStartProvider.ReferenceForId(current.InstanceId)!=job||String.IsNullOrEmpty(current.TimeSubmitted)||current.TimeSubmitted.Length>32)throw new InvalidOperationException("Exact definition job unavailable");
     string expected=StartRecords.Encode(new Dictionary<string,object>{{"receipt",Hash(raw)},{"job",job},{"submitted",current.TimeSubmitted}});
     if(identity==null){j.WriteOnce("definition.job",expected);identity=expected;}if(identity!=expected)throw new InvalidOperationException("Definition job incarnation changed");
     if(current.State!=7||current.RunTimes!=1)return new DefinitionOutcome("definition-pending-held",null,false);
     terminal=StartRecords.Encode(new Dictionary<string,object>{{"receipt",Hash(raw)},{"identity",Hash(identity)},{"state",7},{"error",current.ErrorCode},{"runs",1}});j.WriteOnce("definition.terminal",terminal);
    }
    var t=StartRecords.Parse(terminal,new[]{"receipt","identity","state","error","runs"});
    if(identity==null||StartRecords.Text(t["receipt"])!=Hash(raw)||StartRecords.Text(t["identity"])!=Hash(identity)||StartRecords.Number(t["state"])!=7||StartRecords.Number(t["runs"])!=1)throw new InvalidOperationException("Definition terminal evidence differs");
    long error=StartRecords.Number(t["error"]);if(error<0||error>UInt16.MaxValue)throw new InvalidOperationException("Definition error range");
    if(error!=0)return new DefinitionOutcome("definition-failed-held",null,true);
   }
   string result=j.Read("definition.system");
   if(result==null){
    if(system==""){if(code!=4096)throw new InvalidOperationException("Synchronous resulting system absent");r.VerifyObservation(p);VerifyAssociatedJob(j,provider,job,raw);system=SystemReference(provider.ReadResultingSystem(job));VerifyAssociatedJob(j,provider,job,raw);r.VerifyObservation(p);}
    result=StartRecords.Encode(new Dictionary<string,object>{{"receipt",Hash(raw)},{"system",system}});j.WriteOnce("definition.system",result);
   }
   var saved=StartRecords.Parse(result,new[]{"receipt","system"});string exact=StartRecords.Text(saved["system"]);
   if(StartRecords.Text(saved["receipt"])!=Hash(raw)||SystemReference(exact)!=exact||(system!=""&&system!=exact))throw new InvalidOperationException("Resulting system association differs");
   string guid=GuidForReference(exact);r.VerifyObservation(p);provider.RequireOwnedOff(p,guid);r.VerifyObservation(p);
   string off=Hash(result)+";"+Hash(p.Encode())+";owned-off-zero;start-authorized=false";
   string prior=j.Read("definition.off");if(prior==null)j.WriteOnce("definition.off",off);else if(prior!=off)throw new InvalidOperationException("Off receipt differs");
   return new DefinitionOutcome("defined-owned-off",guid,true);
  }
  static void VerifyAssociatedJob(IStartJournal j,IDefinitionProvider provider,string reference,string receipt){
   StartJob job=provider.ReadJob(reference);string identity=j.Read("definition.job");
   if(job==null||job.Reference!=reference||HyperVStartProvider.ReferenceForId(job.InstanceId)!=reference||job.State!=7||job.ErrorCode!=0||job.RunTimes!=1||String.IsNullOrEmpty(job.TimeSubmitted))throw new InvalidOperationException("Associated definition job not settled");
   string expected=StartRecords.Encode(new Dictionary<string,object>{{"receipt",Hash(receipt)},{"job",reference},{"submitted",job.TimeSubmitted}});
   if(identity!=expected)throw new InvalidOperationException("Associated definition job incarnation differs");
  }
  public static string SystemReference(string raw){
   if(raw==null||raw.Length>2048)throw new InvalidOperationException("Resulting system reference bound");var p=new ManagementPath(raw);
   if(!p.IsInstance||!String.Equals(p.ClassName,"Msvm_ComputerSystem",StringComparison.OrdinalIgnoreCase)||
      (p.Server!=""&&p.Server!="."&&!String.Equals(p.Server,Environment.MachineName,StringComparison.OrdinalIgnoreCase)))throw new InvalidOperationException("Local resulting system required");
   string ns=p.NamespacePath;if(ns.StartsWith(@"\\")){int slash=ns.IndexOf('\\',2);if(slash<0)throw new InvalidOperationException("System namespace");ns=ns.Substring(slash+1);}
   if(ns!=""&&!String.Equals(ns,@"root\virtualization\v2",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("System namespace");
   var m=Regex.Match(p.RelativePath,"\\AMsvm_ComputerSystem\\.(?:CreationClassName=\"Msvm_ComputerSystem\",)?Name=\"([0-9a-fA-F-]{36})\"\\z",RegexOptions.IgnoreCase);
   if(!m.Success)m=Regex.Match(p.RelativePath,"\\AMsvm_ComputerSystem\\.Name=\"([0-9a-fA-F-]{36})\",CreationClassName=\"Msvm_ComputerSystem\"\\z",RegexOptions.IgnoreCase);
   Guid id;if(!m.Success||!Guid.TryParseExact(m.Groups[1].Value,"D",out id)||id==Guid.Empty)throw new InvalidOperationException("Exact returned GUID required");
   return "Msvm_ComputerSystem.CreationClassName=\"Msvm_ComputerSystem\",Name=\""+id.ToString("D")+"\"";
  }
  internal static string GuidForReference(string canonical){string r=SystemReference(canonical);return r.Substring(r.Length-37,36);}
 }
 // Actual fixed local native recipe. Caller must be the independently supervised
 // SYSTEM definition worker with protected plan, journal and held resources.
 public sealed class HyperVOwnedDefinition : IDefinitionProvider {
  readonly IDefinitionRuntime runtime;readonly IStartJournal journal;
  public HyperVOwnedDefinition(IDefinitionRuntime runtime,IStartJournal journal){if(runtime==null||journal==null)throw new ArgumentNullException("dependencies");this.runtime=runtime;this.journal=journal;}
  static ManagementObject Instance(ManagementScope scope,string name,Dictionary<string,object> values){
   using(var c=new ManagementClass(scope,new ManagementPath(name),null)){var v=c.CreateInstance();if(v==null)throw new InvalidOperationException("Native class instance absent");try{foreach(var pair in values)v[pair.Key]=pair.Value;return v;}catch{v.Dispose();throw;}}
  }
  internal static Dictionary<string,object> SystemSettings(OwnedVmDefinitionPlan p){return new Dictionary<string,object>{
   {"ElementName",p.Name},{"VirtualSystemSubType","Microsoft:Hyper-V:SubType:2"},{"Notes",new[]{p.Note}},
   {"ConfigurationDataRoot",p.ConfigurationRoot},{"SnapshotDataRoot",p.ConfigurationRoot},{"SuspendDataRoot",p.ConfigurationRoot},{"SwapFileDataRoot",p.ConfigurationRoot},{"LogDataRoot",p.ConfigurationRoot},
   {"AutomaticStartupAction",(ushort)2},{"AutomaticShutdownAction",(ushort)4},{"AutomaticRecoveryAction",(ushort)2},
   {"UserSnapshotType",(ushort)2},{"AutomaticSnapshotsEnabled",false},{"EnableHibernation",false},{"VirtualNumaEnabled",false},
   {"SecureBootEnabled",true},{"SecureBootTemplateId","272e7447-90a4-4563-a4b9-8e4ab00526ce"}};}
  internal static Dictionary<string,object> MemorySettings(){return new Dictionary<string,object>{{"VirtualQuantity",(ulong)19456},{"Reservation",(ulong)19456},{"Limit",(ulong)19456},{"DynamicMemoryEnabled",false},{"AutomaticAllocation",true}};}
  public DefinitionResponse Define(OwnedVmDefinitionPlan p){
   ProtectedAttempt.RequireSystem();runtime.VerifyBeforeDefinition(p);string raw=p.Encode(),digest=ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(raw));
   if(journal.Read("definition.intent")!=raw||journal.Read("definition.submit")!=digest||journal.Read("definition.native")!=digest)throw new InvalidOperationException("Consumed native definition intent required");
   journal.WriteOnce("definition.invoke",digest);var scope=HyperVStartProvider.Scope();
   using(var service=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_VirtualSystemManagementService"))
   using(var system=Instance(scope,"Msvm_VirtualSystemSettingData",SystemSettings(p)))
   using(var memory=Instance(scope,"Msvm_MemorySettingData",MemorySettings()))
   using(var cpu=Instance(scope,"Msvm_ProcessorSettingData",new Dictionary<string,object>{{"VirtualQuantity",(ulong)4}}))
   using(var input=service.GetMethodParameters("DefineSystem")){
    input["SystemSettings"]=system.GetText(TextFormat.WmiDtd20);input["ResourceSettings"]=new[]{memory.GetText(TextFormat.WmiDtd20),cpu.GetText(TextFormat.WmiDtd20)};input["ReferenceConfiguration"]=null;
    runtime.VerifyBeforeDefinition(p);if(runtime.Now<p.Origin||runtime.Now>=p.Deadline)throw new InvalidOperationException("Original definition deadline");
    using(var output=service.InvokeMethod("DefineSystem",input,new InvokeMethodOptions{Timeout=TimeSpan.FromSeconds(2)})){
     if(output==null||output["ReturnValue"]==null)throw new InvalidOperationException("Missing definition response");
     return new DefinitionResponse(Convert.ToUInt32(output["ReturnValue"]),output["Job"] as string,output["ResultingSystem"] as string);
    }
   }
  }
  public StartJob ReadJob(string reference){
   ProtectedAttempt.RequireSystem();if(HyperVStartProvider.CanonicalJobReference(reference)!=reference)throw new InvalidOperationException("Exact persisted job required");
   using(var job=new ManagementObject(HyperVStartProvider.Scope(),new ManagementPath(reference),new ObjectGetOptions{Timeout=TimeSpan.FromSeconds(2)})){
    job.Get();if(HyperVStartProvider.CanonicalJobReference(job.Path.Path)!=reference)throw new InvalidOperationException("Job reference changed");
    foreach(string field in new[]{"InstanceID","TimeSubmitted","JobState","ErrorCode","JobRunTimes"})if(job[field]==null)throw new InvalidOperationException("Definition job field absent");
    string time=(string)job["TimeSubmitted"];ManagementDateTimeConverter.ToDateTime(time);
    return new StartJob(reference,(string)job["InstanceID"],time,Convert.ToUInt16(job["JobState"]),Convert.ToUInt16(job["ErrorCode"]),Convert.ToUInt32(job["JobRunTimes"]));
   }
  }
  public string ReadResultingSystem(string exactSettledJob){
   ProtectedAttempt.RequireSystem();if(HyperVStartProvider.CanonicalJobReference(exactSettledJob)!=exactSettledJob)throw new InvalidOperationException("Exact settled job required");
   using(var job=new ManagementObject(HyperVStartProvider.Scope(),new ManagementPath(exactSettledJob),new ObjectGetOptions{Timeout=TimeSpan.FromSeconds(2)})){
    job.Get();if(HyperVStartProvider.CanonicalJobReference(job.Path.Path)!=exactSettledJob||Convert.ToUInt16(job["JobState"])!=7||Convert.ToUInt16(job["ErrorCode"])!=0||Convert.ToUInt32(job["JobRunTimes"])!=1)throw new InvalidOperationException("Successful settled definition required");
    string found=null;using(var rows=job.GetRelated("Msvm_ComputerSystem","Msvm_AffectedJobElement",null,null,null,null,false,null))foreach(ManagementObject row in rows)using(row){if(found!=null)throw new InvalidOperationException("Ambiguous resulting system");found=OwnedVmDefinition.SystemReference(row.Path.Path);}
    if(found==null)throw new InvalidOperationException("Resulting system unavailable; no name scan");return found;
   }
  }
  internal static void RequireProcessors(IList<object> quantities){
   if(quantities==null||quantities.Count!=1||!(quantities[0] is ulong)||(ulong)quantities[0]!=4)throw new InvalidOperationException("Exact four-vCPU definition required");
  }
  public void RequireOwnedOff(OwnedVmDefinitionPlan p,string guid){
   ProtectedAttempt.RequireSystem();runtime.VerifyObservation(p);var scope=HyperVStartProvider.Scope();
   // The GUID came only from a durably recorded returned/associated system.
   if(OwnedVmDefinition.GuidForReference("Msvm_ComputerSystem.Name=\""+guid+"\"")!=guid)throw new InvalidOperationException("Canonical GUID");
   using(var vm=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_ComputerSystem WHERE Name='"+guid+"'"))
   using(var settings=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_VirtualSystemSettingData WHERE VirtualSystemIdentifier='"+guid+"' AND VirtualSystemType='Microsoft:Hyper-V:System:Realized'"))
   using(var allocated=HyperVStartProvider.One(scope,"SELECT SystemName,BlockSize,NumberOfBlocks FROM Msvm_Memory WHERE SystemName='"+guid+"'")){
    if((string)vm["Name"]!=guid||(string)vm["ElementName"]!=p.Name||vm["EnabledState"]==null||Convert.ToUInt16(vm["EnabledState"])!=3)throw new InvalidOperationException("Owned Off VM differs");
    foreach(var pair in SystemSettings(p)){object value=settings[pair.Key];if(pair.Value is string[]){var a=value as string[];if(a==null||a.Length!=1||a[0]!=p.Note)throw new InvalidOperationException("Owner note differs");}
     else if(value==null||!Object.Equals(value,pair.Value))throw new InvalidOperationException("Defined configuration differs: "+pair.Key);}
    if(allocated["SystemName"]==null||(string)allocated["SystemName"]!=guid||!(allocated["BlockSize"] is ulong)||(ulong)allocated["BlockSize"]!=1048576||!(allocated["NumberOfBlocks"] is ulong)||(ulong)allocated["NumberOfBlocks"]!=0)throw new InvalidOperationException("Defined zero allocation unconfirmed");
    var quantities=new List<object>();using(var rows=settings.GetRelated("Msvm_ProcessorSettingData"))foreach(ManagementObject cpu in rows)using(cpu){if(quantities.Count>=2)throw new InvalidOperationException("Processor ambiguity");quantities.Add(cpu["VirtualQuantity"]);}RequireProcessors(quantities);
    int n=0;using(var rows=settings.GetRelated("Msvm_MemorySettingData"))foreach(ManagementObject m in rows)using(m){if(++n>1)throw new InvalidOperationException("Memory ambiguity");var d=new Dictionary<string,object>();foreach(string k in new[]{"ResourceType","ResourceSubType","AllocationUnits","VirtualQuantityUnits","VirtualQuantity","Reservation","Limit","DynamicMemoryEnabled","AutomaticAllocation","SwapFilesInUse"})d[k]=m[k];HyperVStartProvider.RequireGuestMemory(d,OwnedVmDefinitionPlan.GuestBytes);}if(n!=1)throw new InvalidOperationException("Memory absent");
   }runtime.VerifyObservation(p);
  }
 }
}

namespace Enclave.OwnedRpc {
 public sealed partial class ProtectedAttempt {
  public readonly OwnedVmDefinitionPlan DefinitionPlan;
  enum DefinitionJournalKind { FixedOffDefinition }
  public static ProtectedAttempt OpenDefinitionJournal(string path,string hash,ProtectedAttempt reader){
   RequireSystem();return new ProtectedAttempt(path,hash,reader,DefinitionJournalKind.FixedOffDefinition,false);
  }
  public static ProtectedAttempt PinDefinitionJournalController(string path,string hash,ProtectedAttempt reader){
   RequireAdministrator();return new ProtectedAttempt(path,hash,reader,DefinitionJournalKind.FixedOffDefinition,true);
  }
  private ProtectedAttempt(string path,string hash,ProtectedAttempt reader,DefinitionJournalKind definition,bool controller){
   if(definition!=DefinitionJournalKind.FixedOffDefinition||reader==null||reader.LeaseProfile!="definition"||reader.PermitPath!=path||reader.PermitHash!=hash)throw new ArgumentException("Exact definition reader binding required");
   reader.CheckDeadline();LocalPath(path);Hex(hash,64);if(Path.GetFileName(path)!="definition-plan.txt")throw new ArgumentException("Fixed plan filename");
   Root=Path.GetDirectoryName(path);ContractHash=hash;recordOwner=controller?AdminSid:SystemSid;accessLease=reader;definitionJournal=true;LeaseProfile="definition-journal";
   try{
    string current=Path.GetPathRoot(Root);HoldDirectory(current,false);string[] parts=Root.Substring(3).Split('\\');
    for(int n=0;n<parts.Length;n++){current=Path.Combine(current,parts[n]);HoldDirectory(current,n==parts.Length-1);}
    byte[] raw=Bytes(HoldRead(path,4096),4096);if(Hash(raw)!=hash)throw new InvalidOperationException("Definition plan digest differs");
    DefinitionPlan=OwnedVmDefinitionPlan.Parse(Utf8.GetString(raw));var p=DefinitionPlan;
    Nonce=p.Attempt;Boot=p.Boot;Origin=p.Origin;Deadline=p.Deadline;ExecutableHash=p.ProviderImageHash;
    if(p.Root!=Root||Path.GetFileName(Root)!=Nonce||Boot!=reader.Boot||Boot!=CurrentBoot()||Origin>reader.Origin)throw new InvalidOperationException("Definition namespace/boot/origin differs");
    if(reader.Operation=="define"&&(BoundedWorker.MonotonicMilliseconds()<Origin||reader.Deadline>Deadline))throw new InvalidOperationException("Definition worker exceeds original startup window");
    CheckDeadline();
   }catch{Dispose();throw;}
  }
 }
 public sealed class OwnedDefinitionJournal:IStartJournal {
  readonly ProtectedAttempt pin;
  public OwnedDefinitionJournal(ProtectedAttempt pin){if(pin==null||pin.DefinitionPlan==null||pin.LeaseProfile!="definition-journal")throw new ArgumentException("Held definition plan required");this.pin=pin;pin.CheckDeadline();}
  public void WriteOnce(string name,string value){
   if(!ProtectedAttempt.DefinitionRecordAllowed(name,false))throw new InvalidOperationException("Definition record name");
   if(name=="definition.intent"&&value!=pin.DefinitionPlan.Encode())throw new InvalidOperationException("Definition intent differs from protected plan");
   pin.WriteOnce(name,value);
  }
  public string Read(string name){
   if(!ProtectedAttempt.DefinitionRecordAllowed(name,false))throw new InvalidOperationException("Definition record name");
   string v=pin.ReadOptionalOnce(name);if(name=="definition.intent"&&v!=null&&v!=pin.DefinitionPlan.Encode())throw new InvalidOperationException("Consumed definition intent differs");return v;
  }
 }
}
