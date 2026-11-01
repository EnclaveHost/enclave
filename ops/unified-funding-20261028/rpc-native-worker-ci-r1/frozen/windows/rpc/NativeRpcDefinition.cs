// Native RPC definition transaction. No ordinary Ubuntu recipe, VM adoption,
// start, deletion or retry. Actual caller/namespace/admission qualification is
// mandatory; this library alone is not an installed native manager driver.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Management;
using System.Text;
using System.Text.RegularExpressions;
namespace Enclave.OwnedRpc {
 public sealed class NativeRpcDefinitionPlan {
  public readonly string Attempt,Boot,ManagerEpoch,Instance,Deployment,App,Record,Runtime,Profile,Admission,Claim,Root,FirmwareHash,StateHash,WorkerImageHash;
  public readonly long Origin,Deadline;
  public string Name {get{return "enclave-native-rpc-"+Attempt;}}
  public string Note {get{return "native-rpc/1/"+Attempt+"/"+Deployment+"/"+App+"/"+Digest;}}
  public string ConfigurationRoot {get{return Path.Combine(Root,"vm");}}
  public string Firmware {get{return Path.Combine(Root,"runtime.igvm");}}
  public string State {get{return Path.Combine(Root,"guest-state.vmgs");}}
  public string Digest {get{return Hash(Encode());}}
  internal static string Hash(string text){return ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(text));}
  static void Nonzero(string value,int n){StartIdentity.Hex(value,n);if(value==new string('0',n))throw new ArgumentException("Nonzero identity required");}
  public NativeRpcDefinitionPlan(string attempt,string boot,string epoch,string instance,string deployment,string app,string record,string runtime,string profile,string admission,string claim,string root,long origin,long deadline,string firmware,string state,string workerImage){
   foreach(string x in new[]{attempt,boot,epoch})Nonzero(x,32);
   foreach(string x in new[]{app,record,runtime,profile,admission,claim,firmware,state,workerImage})Nonzero(x,64);
   if(instance==null||instance.Length!=35||!instance.StartsWith("rpc",StringComparison.Ordinal))throw new ArgumentException("Manager RPC instance required");Nonzero(instance.Substring(3),32);
   if(deployment==null||deployment.Length!=66||!deployment.StartsWith("0x",StringComparison.Ordinal))throw new ArgumentException("Deployment identity required");Nonzero(deployment.Substring(2),64);
   ProtectedAttempt.LocalPath(root);
   if(root.Length>180||Path.GetFileName(root)!=attempt||origin<0||origin>Int64.MaxValue-900000||deadline!=origin+900000)throw new ArgumentException("Original namespace/window required");
   Attempt=attempt;Boot=boot;ManagerEpoch=epoch;Instance=instance;Deployment=deployment;App=app;Record=record;Runtime=runtime;Profile=profile;Admission=admission;Claim=claim;Root=root;Origin=origin;Deadline=deadline;FirmwareHash=firmware;StateHash=state;WorkerImageHash=workerImage;
  }
  public string Encode(){return String.Join("\n",new[]{"native-rpc-definition/1",Attempt,Boot,ManagerEpoch,Instance,Deployment,App,Record,Runtime,Profile,Admission,Claim,Root,Origin.ToString(CultureInfo.InvariantCulture),Deadline.ToString(CultureInfo.InvariantCulture),FirmwareHash,StateHash,WorkerImageHash,"type1-linux-direct;guest-mib=19456;support-mib=1024;vcpus=4;start=false",""});}
  public static NativeRpcDefinitionPlan Parse(string raw){
   if(raw==null||Encoding.UTF8.GetByteCount(raw)>4096)throw new ArgumentException("Native definition bound");var f=raw.Split('\n');
   if(f.Length!=20||f[0]!="native-rpc-definition/1"||f[18]!="type1-linux-direct;guest-mib=19456;support-mib=1024;vcpus=4;start=false"||f[19]!="")throw new ArgumentException("Native definition schema");
   var p=new NativeRpcDefinitionPlan(f[1],f[2],f[3],f[4],f[5],f[6],f[7],f[8],f[9],f[10],f[11],f[12],Int64.Parse(f[13],NumberStyles.None,CultureInfo.InvariantCulture),Int64.Parse(f[14],NumberStyles.None,CultureInfo.InvariantCulture),f[15],f[16],f[17]);
   if(p.Encode()!=raw)throw new ArgumentException("Canonical native definition required");return p;
  }
 }
 public sealed partial class ProtectedAttempt {
  public readonly NativeRpcDefinitionPlan NativeDefinitionPlan;
  enum NativeDefinitionJournalKind { Original }
  public static ProtectedAttempt OpenNativeDefinitionJournal(string path,string hash,ProtectedAttempt reader){
   RequireSystem();return new ProtectedAttempt(path,hash,reader,NativeDefinitionJournalKind.Original,false);
  }
  public static ProtectedAttempt PinNativeDefinitionJournalController(string path,string hash,ProtectedAttempt reader){
   RequireAdministrator();return new ProtectedAttempt(path,hash,reader,NativeDefinitionJournalKind.Original,true);
  }
  private ProtectedAttempt(string path,string hash,ProtectedAttempt reader,NativeDefinitionJournalKind kind,bool controller){
   if(kind!=NativeDefinitionJournalKind.Original||reader==null||reader.accessLease!=null||reader.LeaseProfile!="native-definition"||reader.PermitPath!=path||reader.PermitHash!=hash)
    throw new ArgumentException("Exact original native definition reader required");
   reader.CheckDeadline();LocalPath(path);Hex(hash,64);
   if(Path.GetFileName(path)!="native-definition-plan.txt")throw new ArgumentException("Fixed native plan filename");
   Root=Path.GetDirectoryName(path);ContractHash=hash;recordOwner=controller?AdminSid:SystemSid;accessLease=reader;LeaseProfile="native-definition-journal";
   try{
    string current=Path.GetPathRoot(Root);HoldDirectory(current,false);string[] parts=Root.Substring(3).Split('\\');
    for(int n=0;n<parts.Length;n++){current=Path.Combine(current,parts[n]);HoldDirectory(current,n==parts.Length-1);}
    byte[] raw=Bytes(HoldRead(path,4096),4096);if(Hash(raw)!=hash)throw new InvalidOperationException("Native definition plan digest differs");
    NativeDefinitionPlan=NativeRpcDefinitionPlan.Parse(Utf8.GetString(raw));var p=NativeDefinitionPlan;
    Nonce=p.Attempt;Boot=p.Boot;Origin=p.Origin;Deadline=p.Deadline;ExecutableHash=p.WorkerImageHash;
    if(p.Root!=Root||Path.GetFileName(Root)!=Nonce||Boot!=reader.Boot||Boot!=CurrentBoot()||Origin>reader.Origin||ExecutableHash!=reader.ExecutableHash)
     throw new InvalidOperationException("Native namespace/boot/origin/worker differs");
    if(reader.Operation=="define"&&(reader.Deadline>Deadline||BoundedWorker.MonotonicMilliseconds()>=Deadline))throw new InvalidOperationException("Native definition original time expired");
    CheckDeadline();
   }catch{Dispose();throw;}
  }
 }
 public sealed class NativeRpcDefinitionJournal:IStartJournal {
  readonly ProtectedAttempt pin;
  public NativeRpcDefinitionJournal(ProtectedAttempt pin){
   if(pin==null||pin.NativeDefinitionPlan==null||pin.LeaseProfile!="native-definition-journal")throw new ArgumentException("Held original native plan required");
   this.pin=pin;pin.CheckDeadline();
  }
  static void Name(string name){if(!ProtectedAttempt.NativeDefinitionRecordAllowed(name,false))throw new InvalidOperationException("Fixed native journal record required");}
  public void WriteOnce(string name,string value){
   Name(name);if(name=="native-definition.intent"&&value!=pin.NativeDefinitionPlan.Encode())throw new InvalidOperationException("Native intent differs from protected plan");
   pin.WriteOnce(name,value);
  }
  public string Read(string name){
   Name(name);
   // Even an empty pending file consumes the record. Never treat a torn write,
   // sharing error or ACL failure as absence or permission to submit again.
   if(pin.ReadOptionalOnce(name+".pending")!=null)throw new InvalidOperationException("Partial native journal record remains held");
   string value=pin.ReadOptionalOnce(name);
   if(name=="native-definition.intent"&&value!=null&&value!=pin.NativeDefinitionPlan.Encode())throw new InvalidOperationException("Consumed native intent differs");
   return value;
  }
 }
 public interface INativeRpcDefinitionRuntime {
  long Now {get;}
  // Must hold exact independently supervised SYSTEM worker/observer, protected
  // original plan/journal, original controller ledger and shared claim. Before
  // mutation also pin/hash the complete firmware and fresh per-attempt state
  // copy, admission/pending/headroom and namespace; never hand over a master.
  void Check(NativeRpcDefinitionPlan p,bool mutation);
 }
 public sealed class NativeDefinitionResponse {
  public readonly uint Code;public readonly string Job,System;
  public NativeDefinitionResponse(uint code,string job,string system){Code=code;Job=job;System=system;}
 }
 internal static class NativeDefinitionReferences {
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
 public interface INativeRpcDefinitionProvider {
  NativeDefinitionResponse Define(NativeRpcDefinitionPlan p);
  StartJob ReadJob(string reference);
  string ReadResultingSystem(string reference);
  void RequireOwnedOff(NativeRpcDefinitionPlan p,string guid);
 }
 public sealed class NativeRpcDefinitionOutcome {
  public readonly string State,VmGuid,OwnershipReceipt;
  public readonly bool Settled;
  public bool StartAuthorized {get{return false;}}
  public bool ReservationMayRelease {get{return false;}}
  internal NativeRpcDefinitionOutcome(string state,string guid,string receipt,bool settled){State=state;VmGuid=guid;OwnershipReceipt=receipt;Settled=settled;}
 }
 public static class NativeRpcDefinition {
  static string H(string x){return NativeRpcDefinitionPlan.Hash(x);}
  static void Current(NativeRpcDefinitionPlan p,INativeRpcDefinitionRuntime r,bool mutation){r.Check(p,mutation);if(r.Now<p.Origin||(mutation&&r.Now>=p.Deadline))throw new InvalidOperationException("Native original deadline");}
  static string Intent(NativeRpcDefinitionPlan p,IStartJournal j){if(j.Read("native-definition.intent")!=p.Encode())throw new InvalidOperationException("Native consumed plan differs");return p.Digest;}
  public static void Prepare(NativeRpcDefinitionPlan p,IStartJournal j){j.WriteOnce("native-definition.intent",p.Encode());}
  public static NativeRpcDefinitionOutcome Submit(NativeRpcDefinitionPlan p,IStartJournal j,INativeRpcDefinitionProvider provider,INativeRpcDefinitionRuntime r){
   string hash=Intent(p,j);Current(p,r,true);j.WriteOnce("native-definition.submit",hash);
   Current(p,r,true);j.WriteOnce("native-definition.native",hash);Current(p,r,true);
   var response=provider.Define(p);if(response==null)throw new InvalidOperationException("Native response lost");
   string job="",system="";
   if(response.Code==4096)job=HyperVStartProvider.CanonicalJobReference(response.Job);
   else if(!String.IsNullOrEmpty(response.Job))throw new InvalidOperationException("Unexpected native job");
   if(!String.IsNullOrEmpty(response.System))system=NativeDefinitionReferences.SystemReference(response.System);
   if(response.Code!=0&&response.Code!=4096&&system!="")throw new InvalidOperationException("Refused native definition returned a system");
   // This durable receipt precedes ANY job/system read or acknowledgement.
   j.WriteOnce("native-definition.receipt",StartRecords.Encode(new Dictionary<string,object>{{"plan",hash},{"code",response.Code},{"job",job},{"system",system}}));
   return Reconcile(p,j,provider,r);
  }
  public static NativeRpcDefinitionOutcome Reconcile(NativeRpcDefinitionPlan p,IStartJournal j,INativeRpcDefinitionProvider provider,INativeRpcDefinitionRuntime r){
   string hash=Intent(p,j);Current(p,r,false);
   if(j.Read("native-definition.submit")!=hash||j.Read("native-definition.native")!=hash)return Held("submission-unproven");
   string raw=j.Read("native-definition.receipt");if(raw==null)return Held("response-lost");
   var receipt=StartRecords.Parse(raw,new[]{"plan","code","job","system"});long code=StartRecords.Number(receipt["code"]);
   string job=StartRecords.Text(receipt["job"]),system=StartRecords.Text(receipt["system"]);
   if(StartRecords.Text(receipt["plan"])!=hash||code<0||code>UInt32.MaxValue||(code!=4096&&job!="")||(system!=""&&NativeDefinitionReferences.SystemReference(system)!=system))throw new InvalidOperationException("Native receipt differs");
   if(code!=0&&code!=4096){if(system!="")throw new InvalidOperationException("Refusal contains system");return Held("provider-refused");}
   if(code==4096){
    if(HyperVStartProvider.CanonicalJobReference(job)!=job)throw new InvalidOperationException("Exact persisted native job required");
    string identity=j.Read("native-definition.job"),terminal=j.Read("native-definition.terminal");
    if(terminal==null){
     var observed=ReadBoundJob(p,r,provider,job);string bound=BindJob(raw,observed);
     if(identity==null){j.WriteOnce("native-definition.job",bound);identity=bound;}
     if(identity!=bound)throw new InvalidOperationException("Native job incarnation changed");
     if(observed.State!=7||observed.RunTimes!=1)return Held("job-pending");
     terminal=StartRecords.Encode(new Dictionary<string,object>{{"receipt",H(raw)},{"identity",H(identity)},{"state",7},{"runs",1},{"error",observed.ErrorCode}});
     j.WriteOnce("native-definition.terminal",terminal);
    }
    var t=StartRecords.Parse(terminal,new[]{"receipt","identity","state","runs","error"});long error=StartRecords.Number(t["error"]);
    if(identity==null||StartRecords.Text(t["receipt"])!=H(raw)||StartRecords.Text(t["identity"])!=H(identity)||StartRecords.Number(t["state"])!=7||StartRecords.Number(t["runs"])!=1||error<0||error>65535)throw new InvalidOperationException("Native terminal binding differs");
    if(error!=0)return new NativeRpcDefinitionOutcome("definition-failed-held",null,null,true);
   }
   string saved=j.Read("native-definition.system");
   if(saved==null){
    if(system==""){
     if(code!=4096)throw new InvalidOperationException("Synchronous system identity absent");
     RequireAssociated(p,j,provider,r,job,raw);system=NativeDefinitionReferences.SystemReference(provider.ReadResultingSystem(job));RequireAssociated(p,j,provider,r,job,raw);
    }
    saved=StartRecords.Encode(new Dictionary<string,object>{{"receipt",H(raw)},{"system",system}});j.WriteOnce("native-definition.system",saved);
   }
   var result=StartRecords.Parse(saved,new[]{"receipt","system"});string exact=StartRecords.Text(result["system"]);
   if(StartRecords.Text(result["receipt"])!=H(raw)||NativeDefinitionReferences.SystemReference(exact)!=exact||(system!=""&&system!=exact))throw new InvalidOperationException("Native resulting system differs");
   string guid=NativeDefinitionReferences.GuidForReference(exact);Current(p,r,false);provider.RequireOwnedOff(p,guid);Current(p,r,false);
   string owned=StartRecords.Encode(new Dictionary<string,object>{{"schema","native-rpc-owned-off/1"},{"plan",hash},{"system",H(saved)},{"vmGuid",guid},{"app",p.App},{"deployment",p.Deployment},{"instance",p.Instance},{"managerEpoch",p.ManagerEpoch},{"startAuthorized",false},{"reservationMayRelease",false}});
   string prior=j.Read("native-definition.owned");if(prior==null)j.WriteOnce("native-definition.owned",owned);else if(prior!=owned)throw new InvalidOperationException("Original native ownership differs");
   return new NativeRpcDefinitionOutcome("defined-native-owned-off",guid,H(owned),true);
  }
  static NativeRpcDefinitionOutcome Held(string reason){return new NativeRpcDefinitionOutcome(reason+"-held",null,null,false);}
  static StartJob ReadBoundJob(NativeRpcDefinitionPlan p,INativeRpcDefinitionRuntime r,INativeRpcDefinitionProvider provider,string reference){
   Current(p,r,false);var job=provider.ReadJob(reference);Current(p,r,false);
   if(job==null||job.Reference!=reference||HyperVStartProvider.ReferenceForId(job.InstanceId)!=reference||String.IsNullOrEmpty(job.TimeSubmitted)||job.TimeSubmitted.Length>32)throw new InvalidOperationException("Exact native job unavailable");return job;
  }
  static string BindJob(string raw,StartJob job){return StartRecords.Encode(new Dictionary<string,object>{{"receipt",H(raw)},{"job",job.Reference},{"submitted",job.TimeSubmitted}});}
  static void RequireAssociated(NativeRpcDefinitionPlan p,IStartJournal j,INativeRpcDefinitionProvider provider,INativeRpcDefinitionRuntime r,string reference,string raw){
   var job=ReadBoundJob(p,r,provider,reference);
   if(job.State!=7||job.RunTimes!=1||job.ErrorCode!=0||j.Read("native-definition.job")!=BindJob(raw,job))throw new InvalidOperationException("Exact settled native association required");
  }
 }
 // Actual local WMI implementation, never invoked by the qualification harness.
 // Only DEFINE an Off shell. Security/optical/network/serial configuration and
 // accepted boot/start require subsequent separately journaled native stages.
 public sealed class HyperVNativeRpcDefinition : INativeRpcDefinitionProvider {
  readonly INativeRpcDefinitionRuntime runtime;readonly IStartJournal journal;
  public HyperVNativeRpcDefinition(INativeRpcDefinitionRuntime runtime,IStartJournal journal){
   if(runtime==null||journal==null)throw new ArgumentNullException("dependencies");this.runtime=runtime;this.journal=journal;
  }
  internal static Dictionary<string,object> Settings(NativeRpcDefinitionPlan p){return new Dictionary<string,object>{
   {"ElementName",p.Name},{"Notes",new[]{p.Note}},{"VirtualSystemSubType","Microsoft:Hyper-V:SubType:2"},
   {"ConfigurationDataRoot",p.ConfigurationRoot},{"SnapshotDataRoot",p.ConfigurationRoot},{"SuspendDataRoot",p.ConfigurationRoot},{"SwapFileDataRoot",p.ConfigurationRoot},{"LogDataRoot",p.ConfigurationRoot},
   {"GuestStateIsolationEnabled",true},{"GuestStateIsolationType",(ushort)1},{"GuestStateIsolationMode",(ushort)0},{"GuestFeatureSet",(uint)0x201},
   {"Vtl2AddressSpaceConfigurationMode",(ushort)0},{"FirmwareFile",p.Firmware},{"GuestStateDataRoot",p.Root},{"GuestStateFile","guest-state.vmgs"},
   {"VMBusMessageRedirection",false},{"SecureBootEnabled",false},{"EnableHibernation",false},{"VirtualNumaEnabled",false},
   {"UserSnapshotType",(ushort)2},{"AutomaticSnapshotsEnabled",false},{"AutomaticStartupAction",(ushort)2},{"AutomaticShutdownAction",(ushort)4},{"AutomaticRecoveryAction",(ushort)2}};}
  internal static Dictionary<string,object> MemorySettings(){return new Dictionary<string,object>{{"VirtualQuantity",(ulong)19456},{"Reservation",(ulong)19456},{"Limit",(ulong)19456},{"DynamicMemoryEnabled",false},{"AutomaticAllocation",true}};}
  static ManagementObject New(ManagementScope scope,string name,Dictionary<string,object> fields){
   using(var cls=new ManagementClass(scope,new ManagementPath(name),null)){var row=cls.CreateInstance();if(row==null)throw new InvalidOperationException("Native class unavailable");try{foreach(var pair in fields)row[pair.Key]=pair.Value;return row;}catch{row.Dispose();throw;}}
  }
  public NativeDefinitionResponse Define(NativeRpcDefinitionPlan p){
   ProtectedAttempt.RequireSystem();runtime.Check(p,true);
   if(journal.Read("native-definition.intent")!=p.Encode()||journal.Read("native-definition.submit")!=p.Digest||journal.Read("native-definition.native")!=p.Digest)throw new InvalidOperationException("Consumed native intent required");
   journal.WriteOnce("native-definition.invoke",p.Digest);var scope=HyperVStartProvider.Scope();
   using(var service=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_VirtualSystemManagementService"))
   using(var system=New(scope,"Msvm_VirtualSystemSettingData",Settings(p)))
   using(var memory=New(scope,"Msvm_MemorySettingData",MemorySettings()))
   using(var cpu=New(scope,"Msvm_ProcessorSettingData",new Dictionary<string,object>{{"VirtualQuantity",(ulong)4}}))
   using(var input=service.GetMethodParameters("DefineSystem")){
    input["SystemSettings"]=system.GetText(TextFormat.WmiDtd20);input["ResourceSettings"]=new[]{memory.GetText(TextFormat.WmiDtd20),cpu.GetText(TextFormat.WmiDtd20)};input["ReferenceConfiguration"]=null;
    runtime.Check(p,true);if(runtime.Now<p.Origin||runtime.Now>=p.Deadline)throw new InvalidOperationException("Native original deadline");
    using(var output=service.InvokeMethod("DefineSystem",input,new InvokeMethodOptions{Timeout=TimeSpan.FromSeconds(2)})){
     if(output==null||output["ReturnValue"]==null)throw new InvalidOperationException("Native definition response absent");
     return new NativeDefinitionResponse(Convert.ToUInt32(output["ReturnValue"]),output["Job"] as string,output["ResultingSystem"] as string);
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
    string found=null;using(var rows=job.GetRelated("Msvm_ComputerSystem","Msvm_AffectedJobElement",null,null,null,null,false,null))foreach(ManagementObject row in rows)using(row){if(found!=null)throw new InvalidOperationException("Ambiguous resulting system");found=NativeDefinitionReferences.SystemReference(row.Path.Path);}
    if(found==null)throw new InvalidOperationException("Resulting system unavailable; no name scan");return found;
   }
  }
  internal static void RequireProcessors(IList<object> quantities){
   if(quantities==null||quantities.Count!=1||!(quantities[0] is ulong)||(ulong)quantities[0]!=4)throw new InvalidOperationException("Exact four-vCPU definition required");
  }
  public void RequireOwnedOff(NativeRpcDefinitionPlan p,string guid){
   ProtectedAttempt.RequireSystem();runtime.Check(p,false);
   if(NativeDefinitionReferences.GuidForReference("Msvm_ComputerSystem.Name=\""+guid+"\"")!=guid)throw new InvalidOperationException("Canonical returned VM GUID required");
   var scope=HyperVStartProvider.Scope();
   using(var vm=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_ComputerSystem WHERE Name='"+guid+"'"))
   using(var settings=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_VirtualSystemSettingData WHERE VirtualSystemIdentifier='"+guid+"' AND VirtualSystemType='Microsoft:Hyper-V:System:Realized'"))
   using(var memory=HyperVStartProvider.One(scope,"SELECT SystemName,BlockSize,NumberOfBlocks FROM Msvm_Memory WHERE SystemName='"+guid+"'")){
    if((string)vm["Name"]!=guid||(string)vm["ElementName"]!=p.Name||!(vm["EnabledState"] is ushort)||(ushort)vm["EnabledState"]!=3)throw new InvalidOperationException("Native owned Off identity differs");
    foreach(var pair in Settings(p)){
     object value=settings[pair.Key];if(pair.Value is string[]){var a=value as string[];if(a==null||a.Length!=1||a[0]!=p.Note)throw new InvalidOperationException("Native owner marker differs");}
     else if(!Object.Equals(value,pair.Value))throw new InvalidOperationException("Native setting differs: "+pair.Key);
    }
    if((string)memory["SystemName"]!=guid||!(memory["BlockSize"] is ulong)||(ulong)memory["BlockSize"]!=1048576||!(memory["NumberOfBlocks"] is ulong)||(ulong)memory["NumberOfBlocks"]!=0)throw new InvalidOperationException("Native zero allocation unconfirmed");
    int count=0;using(var rows=settings.GetRelated("Msvm_MemorySettingData"))foreach(ManagementObject row in rows)using(row){if(++count>1)throw new InvalidOperationException("Native memory ambiguity");var d=new Dictionary<string,object>();foreach(string k in new[]{"ResourceType","ResourceSubType","AllocationUnits","VirtualQuantityUnits","VirtualQuantity","Reservation","Limit","DynamicMemoryEnabled","AutomaticAllocation","SwapFilesInUse"})d[k]=row[k];HyperVStartProvider.RequireGuestMemory(d,19L*1073741824);}if(count!=1)throw new InvalidOperationException("Native memory absent");
    var cpus=new List<object>();using(var rows=settings.GetRelated("Msvm_ProcessorSettingData"))foreach(ManagementObject row in rows)using(row){if(cpus.Count>=2)throw new InvalidOperationException("Native CPU ambiguity");cpus.Add(row["VirtualQuantity"]);}RequireProcessors(cpus);
   }runtime.Check(p,false);
  }
 }
}
