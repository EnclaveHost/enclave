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
 // Optional bounded observation only. It never grants mutation or renews the
 // original lease. Existing single-observation callers remain single-shot.
 public interface INativeRpcObservationWait {
  bool WaitForNextObservation(NativeRpcDefinitionPlan plan);
 }
 internal static class NativeRpcJobProgress {
  internal static bool Wait(NativeRpcDefinitionPlan p,INativeRpcDefinitionRuntime r,StartJob job){
   // Suspended/terminated/killed/exception/service or recurring jobs remain held.
   // New/starting/running/shutting-down may progress within the SAME lease.
   if(job.RunTimes!=1||job.ErrorCode!=0||(job.State!=2&&job.State!=3&&job.State!=4&&job.State!=6))return false;
   var waiter=r as INativeRpcObservationWait;if(waiter==null)return false;
   r.Check(p,false);long before=r.Now;if(before<p.Origin||before>=p.Deadline)return false;
   if(!waiter.WaitForNextObservation(p))return false;
   r.Check(p,false);long after=r.Now;if(after<=before||after>=p.Deadline)throw new InvalidOperationException("Observation did not advance inside original deadline");return true;
  }
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
    while(terminal==null){
     var observed=ReadBoundJob(p,r,provider,job);string bound=BindJob(raw,observed);
     if(identity==null){j.WriteOnce("native-definition.job",bound);identity=bound;}
     if(identity!=bound)throw new InvalidOperationException("Native job incarnation changed");
     if(observed.State!=7||observed.RunTimes!=1){if(NativeRpcJobProgress.Wait(p,r,observed))continue;return Held("job-pending");}
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
 // The original definition is the sole source of VM identity. No GUID from a
 // caller, VM inventory or matching name can authorize this subsequent mutation.
 public interface INativeRpcSecurityProvider {
  NativeDefinitionResponse ConfigureSecurity(NativeRpcDefinitionPlan p,string guid,string intent);
  StartJob ReadJob(string reference);
  void RequireOwnedOff(NativeRpcDefinitionPlan p,string guid);
  void RequireSecurity(NativeRpcDefinitionPlan p,string guid);
 }
 public static class NativeRpcSecurity {
  const string Recipe="tpm=true;guest-vbs-opt-out=true;partition-type=1;start=false";
  static string H(string x){return NativeRpcDefinitionPlan.Hash(x);}
  static void Current(NativeRpcDefinitionPlan p,INativeRpcDefinitionRuntime r,bool mutation){r.Check(p,mutation);if(r.Now<p.Origin||(mutation&&r.Now>=p.Deadline))throw new InvalidOperationException("Native original deadline");}
  internal static string Ownership(NativeRpcDefinitionPlan p,IStartJournal j,out string guid){
   if(j.Read("native-definition.intent")!=p.Encode()||j.Read("native-definition.submit")!=p.Digest||j.Read("native-definition.native")!=p.Digest)throw new InvalidOperationException("Original consumed definition required");
   string response=j.Read("native-definition.receipt"),system=j.Read("native-definition.system"),owned=j.Read("native-definition.owned");
   if(response==null||system==null||owned==null)throw new InvalidOperationException("Original owned definition missing");
   var sr=StartRecords.Parse(system,new[]{"receipt","system"});string exact=StartRecords.Text(sr["system"]);
   if(StartRecords.Text(sr["receipt"])!=H(response)||NativeDefinitionReferences.SystemReference(exact)!=exact)throw new InvalidOperationException("Original resulting system differs");
   guid=NativeDefinitionReferences.GuidForReference(exact);
   var o=StartRecords.Parse(owned,new[]{"schema","plan","system","vmGuid","app","deployment","instance","managerEpoch","startAuthorized","reservationMayRelease"});
   if(StartRecords.Text(o["schema"])!="native-rpc-owned-off/1"||StartRecords.Text(o["plan"])!=p.Digest||StartRecords.Text(o["system"])!=H(system)||StartRecords.Text(o["vmGuid"])!=guid||StartRecords.Text(o["app"])!=p.App||StartRecords.Text(o["deployment"])!=p.Deployment||StartRecords.Text(o["instance"])!=p.Instance||StartRecords.Text(o["managerEpoch"])!=p.ManagerEpoch)throw new InvalidOperationException("Original native ownership differs");
   foreach(string key in new[]{"startAuthorized","reservationMayRelease"})if(!(o[key] is bool)||(bool)o[key])throw new InvalidOperationException("Original ownership cannot authorize start/release");
   return H(owned);
  }
  static string Intent(NativeRpcDefinitionPlan p,string guid,string owned){return StartRecords.Encode(new Dictionary<string,object>{{"schema","native-rpc-security-intent/1"},{"plan",p.Digest},{"vmGuid",guid},{"owned",owned},{"recipe",Recipe}});}
  public static string Submit(NativeRpcDefinitionPlan p,IStartJournal j,INativeRpcSecurityProvider provider,INativeRpcDefinitionRuntime r){
   Current(p,r,true);string guid;string owned=Ownership(p,j,out guid),intent=Intent(p,guid,owned);
   provider.RequireOwnedOff(p,guid);Current(p,r,true);
   j.WriteOnce("native-security.intent",intent);j.WriteOnce("native-security.native",H(intent));
   Current(p,r,true);var response=provider.ConfigureSecurity(p,guid,H(intent));
   if(response==null)throw new InvalidOperationException("Security response lost");
   if(!String.IsNullOrEmpty(response.System))throw new InvalidOperationException("Security response cannot replace VM identity");
   string job="";if(response.Code==4096)job=HyperVStartProvider.CanonicalJobReference(response.Job);else if(!String.IsNullOrEmpty(response.Job))throw new InvalidOperationException("Unexpected security job");
   // Persist exact returned reference before job read, readback or acknowledgement.
   j.WriteOnce("native-security.receipt",StartRecords.Encode(new Dictionary<string,object>{{"intent",H(intent)},{"code",response.Code},{"job",job}}));
   return Reconcile(p,j,provider,r);
  }
  static string Receipt(NativeRpcDefinitionPlan p,IStartJournal j,out string guid,out string intent){
   string owned=Ownership(p,j,out guid);intent=Intent(p,guid,owned);
   if(j.Read("native-security.intent")!=intent||j.Read("native-security.native")!=H(intent))throw new InvalidOperationException("Original consumed security intent missing");
   return j.Read("native-security.receipt");
  }
  static bool Settled(IStartJournal j,string raw,string intent,out string job){
   var receipt=StartRecords.Parse(raw,new[]{"intent","code","job"});long code=StartRecords.Number(receipt["code"]);job=StartRecords.Text(receipt["job"]);
   if(StartRecords.Text(receipt["intent"])!=H(intent)||code<0||code>UInt32.MaxValue||(code!=4096&&job!=""))throw new InvalidOperationException("Security provider receipt differs");
   if(code==0)return true;if(code!=4096)return false;
   if(HyperVStartProvider.CanonicalJobReference(job)!=job)throw new InvalidOperationException("Exact security job required");
   string bound=j.Read("native-security.job"),terminal=j.Read("native-security.terminal");if(terminal==null)return false;
   if(bound==null)throw new InvalidOperationException("Security job binding absent");
   var b=StartRecords.Parse(bound,new[]{"receipt","job","submitted"});string submitted=StartRecords.Text(b["submitted"]);
   if(StartRecords.Text(b["receipt"])!=H(raw)||StartRecords.Text(b["job"])!=job||String.IsNullOrEmpty(submitted)||submitted.Length>32)throw new InvalidOperationException("Security job binding differs");
   var t=StartRecords.Parse(terminal,new[]{"receipt","identity","state","runs","error"});long error=StartRecords.Number(t["error"]);
   if(StartRecords.Text(t["receipt"])!=H(raw)||StartRecords.Text(t["identity"])!=H(bound)||StartRecords.Number(t["state"])!=7||StartRecords.Number(t["runs"])!=1||error<0||error>65535)throw new InvalidOperationException("Security terminal differs");
   return error==0;
  }
  static string Complete(NativeRpcDefinitionPlan p,IStartJournal j,string guid,string intent,string raw){return StartRecords.Encode(new Dictionary<string,object>{{"schema","native-rpc-security-observed/1"},{"plan",p.Digest},{"vmGuid",guid},{"intent",H(intent)},{"receipt",H(raw)},{"terminal",j.Read("native-security.terminal")==null?"":H(j.Read("native-security.terminal"))},{"recipe",Recipe},{"startAuthorized",false},{"providerOperationFenced",false},{"reservationMayRelease",false}});}
  // Null means held, never permission to invoke the operation again.
  public static string Reconcile(NativeRpcDefinitionPlan p,IStartJournal j,INativeRpcSecurityProvider provider,INativeRpcDefinitionRuntime r){
   Current(p,r,false);string guid,intent;string raw=Receipt(p,j,out guid,out intent);if(raw==null)return null;
   string reference;bool settled=Settled(j,raw,intent,out reference);
   while(!settled&&reference!=""&&j.Read("native-security.terminal")==null){
    Current(p,r,false);var job=provider.ReadJob(reference);Current(p,r,false);
    if(job==null||job.Reference!=reference||HyperVStartProvider.ReferenceForId(job.InstanceId)!=reference||String.IsNullOrEmpty(job.TimeSubmitted)||job.TimeSubmitted.Length>32)throw new InvalidOperationException("Exact security job unavailable");
    string bound=StartRecords.Encode(new Dictionary<string,object>{{"receipt",H(raw)},{"job",reference},{"submitted",job.TimeSubmitted}}),prior=j.Read("native-security.job");
    if(prior==null)j.WriteOnce("native-security.job",bound);else if(prior!=bound)throw new InvalidOperationException("Security job incarnation changed");
    if(job.State!=7||job.RunTimes!=1){if(NativeRpcJobProgress.Wait(p,r,job))continue;return null;}
    j.WriteOnce("native-security.terminal",StartRecords.Encode(new Dictionary<string,object>{{"receipt",H(raw)},{"identity",H(bound)},{"state",7},{"runs",1},{"error",job.ErrorCode}}));
    settled=Settled(j,raw,intent,out reference);
   }
   if(!settled)return null;
   Current(p,r,false);provider.RequireOwnedOff(p,guid);provider.RequireSecurity(p,guid);Current(p,r,false);
   string observed=Complete(p,j,guid,intent,raw),saved=j.Read("native-security.observed");
   if(saved==null)j.WriteOnce("native-security.observed",observed);else if(saved!=observed)throw new InvalidOperationException("Security observed record differs");
   return H(observed);
  }
  internal static string VerifyCompleted(NativeRpcDefinitionPlan p,IStartJournal j){
   string guid,intent,job;string raw=Receipt(p,j,out guid,out intent);
   if(raw==null||!Settled(j,raw,intent,out job))throw new InvalidOperationException("Security operation not settled");
   string observed=Complete(p,j,guid,intent,raw);if(j.Read("native-security.observed")!=observed)throw new InvalidOperationException("Security readback not recorded");return H(observed);
  }
 }
 // Actual local WMI implementation, never invoked by the qualification harness.
 // Defines an Off shell and separately journals guest security configuration.
 // Optical/network/serial configuration and accepted boot/start remain separate.
 public sealed partial class HyperVNativeRpcDefinition {
  internal static Dictionary<string,object> Settings(NativeRpcDefinitionPlan p){return new Dictionary<string,object>{
   {"ElementName",p.Name},{"Notes",new[]{p.Note}},{"VirtualSystemSubType","Microsoft:Hyper-V:SubType:2"},
   {"ConfigurationDataRoot",p.ConfigurationRoot},{"SnapshotDataRoot",p.ConfigurationRoot},{"SuspendDataRoot",p.ConfigurationRoot},{"SwapFileDataRoot",p.ConfigurationRoot},{"LogDataRoot",p.ConfigurationRoot},
   {"GuestStateIsolationEnabled",true},{"GuestStateIsolationType",(ushort)1},{"GuestStateIsolationMode",(ushort)0},{"GuestFeatureSet",(uint)0x201},
   {"Vtl2AddressSpaceConfigurationMode",(ushort)0},{"FirmwareFile",p.Firmware},{"GuestStateDataRoot",p.Root},{"GuestStateFile","guest-state.vmgs"},
   {"VMBusMessageRedirection",false},{"SecureBootEnabled",false},{"EnableHibernation",false},{"VirtualNumaEnabled",false},
   {"UserSnapshotType",(ushort)2},{"AutomaticSnapshotsEnabled",false},{"AutomaticStartupAction",(ushort)2},{"AutomaticShutdownAction",(ushort)4},{"AutomaticRecoveryAction",(ushort)2}};}
  internal static Dictionary<string,object> MemorySettings(){return new Dictionary<string,object>{{"VirtualQuantity",(ulong)19456},{"Reservation",(ulong)19456},{"Limit",(ulong)19456},{"DynamicMemoryEnabled",false},{"AutomaticAllocation",true}};}
  internal static void RequireSecurityFields(IDictionary<string,object> fields){
   foreach(string key in new[]{"TpmEnabled","VirtualizationBasedSecurityOptOut"})if(!fields.ContainsKey(key)||!(fields[key] is bool)||!(bool)fields[key])throw new InvalidOperationException("Native security readback differs: "+key);
  }
  internal static void RequireProcessors(IList<object> quantities){
   if(quantities==null||quantities.Count!=1||!(quantities[0] is ulong)||(ulong)quantities[0]!=4)throw new InvalidOperationException("Exact four-vCPU definition required");
  }

 }

 // Fixed boot-media attachment transaction. The original owned-Off/security
 // records authorize configuration only; no start/readiness/release assertion.
 public sealed class NativeOpticalResponse {
  public readonly uint Code;public readonly string Job,Resource;public readonly bool Existing;
  public NativeOpticalResponse(uint code,string job,string resource,bool existing=false){Code=code;Job=job;Resource=resource;Existing=existing;}
 }
 public interface INativeRpcOpticalProvider {
  NativeOpticalResponse Attach(NativeRpcDefinitionPlan p,string guid,string step,IDictionary<string,string> prior,string intent);
  StartJob ReadJob(string reference);
  void VerifyOptical(NativeRpcDefinitionPlan p,string guid,string step,string resource,IDictionary<string,string> prior);
  void VerifyOpticalComplete(NativeRpcDefinitionPlan p,string guid,IDictionary<string,string> resources);
 }
 public static class NativeRpcOptical {
  internal static readonly string[] Steps={"scsi","imagedrive","imagemedia","hashdrive","hashmedia"};
  static string H(string x){return NativeRpcDefinitionPlan.Hash(x);}
  static string S(object x){return StartRecords.Text(x);}
  static void Current(NativeRpcDefinitionPlan p,INativeRpcDefinitionRuntime r,bool mutation){r.Check(p,mutation);if(r.Now<p.Origin||(mutation&&r.Now>=p.Deadline))throw new InvalidOperationException("Original optical deadline");}
  internal static bool Allowed(string name,bool readOnly){
   if(name=="native-optical.observed")return true;
   foreach(string step in Steps){string pre="native-optical."+step+".";if(name==pre+"job"||name==pre+"terminal")return true;if(!readOnly&&(name==pre+"intent"||name==pre+"submit"||name==pre+"invoke"||name==pre+"receipt"))return true;}return false;
  }
  static string Intent(NativeRpcDefinitionPlan p,string guid,string owned,string security,string step,IDictionary<string,string> prior){
   return StartRecords.Encode(new Dictionary<string,object>{{"schema","native-rpc-optical-intent/1"},{"plan",p.Digest},{"vmGuid",guid},{"owned",owned},{"security",security},{"profile",p.Profile},{"step",step},{"dependencies",new SortedDictionary<string,string>(prior,StringComparer.Ordinal)}});
  }
  static bool Settled(IStartJournal j,string pre,string raw,string intent,string step,out string resource,out string job){
   var d=StartRecords.Parse(raw,new[]{"intent","code","job","resource","existing"});long code=StartRecords.Number(d["code"]);resource=S(d["resource"]);job=S(d["job"]);
   if(S(d["intent"])!=H(intent)||code<0||code>UInt32.MaxValue||!(d["existing"] is bool)||(code!=4096&&job!="")||(resource!=""&&HyperVNativeRpcDefinition.OpticalReference(step,resource)!=resource))throw new InvalidOperationException("Optical provider receipt differs");
   if((bool)d["existing"]&&(step!="scsi"||code!=0||resource==""))throw new InvalidOperationException("Only original default SCSI may preexist");
   if(code!=0&&code!=4096){if(resource!="")throw new InvalidOperationException("Refused optical response has resource");return false;}
   if(code==0)return true;
   if(HyperVStartProvider.CanonicalJobReference(job)!=job)throw new InvalidOperationException("Exact optical job required");
   string bound=j.Read(pre+".job"),terminal=j.Read(pre+".terminal");if(terminal==null)return false;
   if(bound==null)throw new InvalidOperationException("Optical job identity missing");
   var b=StartRecords.Parse(bound,new[]{"receipt","job","submitted"});string at=S(b["submitted"]);
   if(S(b["receipt"])!=H(raw)||S(b["job"])!=job||at.Length==0||at.Length>32)throw new InvalidOperationException("Optical job identity differs");
   var t=StartRecords.Parse(terminal,new[]{"receipt","identity","state","runs","error"});long error=StartRecords.Number(t["error"]);
   if(S(t["receipt"])!=H(raw)||S(t["identity"])!=H(bound)||StartRecords.Number(t["state"])!=7||StartRecords.Number(t["runs"])!=1||error<0||error>65535)throw new InvalidOperationException("Optical terminal differs");return error==0;
  }
  static string Proof(NativeRpcDefinitionPlan p,string guid,string owned,string security,IDictionary<string,string> resources){return StartRecords.Encode(new Dictionary<string,object>{{"schema","native-rpc-optical-observed/1"},{"plan",p.Digest},{"vmGuid",guid},{"owned",owned},{"security",security},{"profile",p.Profile},{"resources",new SortedDictionary<string,string>(resources,StringComparer.Ordinal)},{"startAuthorized",false},{"providerOperationFenced",false},{"reservationMayRelease",false}});}
  // A read-only worker can settle original returned references; it cannot
  // create missing intents, invoke a mutation, or acknowledge a lost response.
  public static string Configure(NativeRpcDefinitionPlan p,IStartJournal j,INativeRpcOpticalProvider provider,INativeRpcDefinitionRuntime runtime,bool readOnly){
   Current(p,runtime,!readOnly);string guid,owned=NativeRpcSecurity.Ownership(p,j,out guid),security=NativeRpcSecurity.VerifyCompleted(p,j);var resources=new Dictionary<string,string>();
   foreach(string step in Steps){
    Current(p,runtime,!readOnly);string pre="native-optical."+step,intent=Intent(p,guid,owned,security,step,resources),saved=j.Read(pre+".intent");
    if(saved==null){if(readOnly)return null;j.WriteOnce(pre+".intent",intent);saved=intent;}if(saved!=intent)throw new InvalidOperationException("Optical original dependency differs");
    string submitted=j.Read(pre+".submit"),raw=j.Read(pre+".receipt");
    if(submitted==null){
     if(readOnly)return null;j.WriteOnce(pre+".submit",H(intent));Current(p,runtime,true);
     var response=provider.Attach(p,guid,step,resources,H(intent));if(response==null)throw new InvalidOperationException("Optical response lost");
     string job="",resource="";if(response.Code==4096)job=HyperVStartProvider.CanonicalJobReference(response.Job);else if(!String.IsNullOrEmpty(response.Job))throw new InvalidOperationException("Unexpected optical job");
     if(!String.IsNullOrEmpty(response.Resource))resource=HyperVNativeRpcDefinition.OpticalReference(step,response.Resource);
     raw=StartRecords.Encode(new Dictionary<string,object>{{"intent",H(intent)},{"code",response.Code},{"job",job},{"resource",resource},{"existing",response.Existing}});
     j.WriteOnce(pre+".receipt",raw);submitted=H(intent);
    }
    if(submitted!=H(intent))throw new InvalidOperationException("Optical consumed submission differs");if(raw==null)return null;
    string result,reference;bool settled=Settled(j,pre,raw,intent,step,out result,out reference);
    while(!settled&&reference!=""&&j.Read(pre+".terminal")==null){
     Current(p,runtime,false);var job=provider.ReadJob(reference);Current(p,runtime,false);
     if(job==null||job.Reference!=reference||HyperVStartProvider.ReferenceForId(job.InstanceId)!=reference||String.IsNullOrEmpty(job.TimeSubmitted)||job.TimeSubmitted.Length>32)throw new InvalidOperationException("Exact optical job unavailable");
     string binding=StartRecords.Encode(new Dictionary<string,object>{{"receipt",H(raw)},{"job",reference},{"submitted",job.TimeSubmitted}}),prior=j.Read(pre+".job");
     if(prior==null)j.WriteOnce(pre+".job",binding);else if(prior!=binding)throw new InvalidOperationException("Optical job incarnation changed");
     if(job.State!=7||job.RunTimes!=1){if(NativeRpcJobProgress.Wait(p,runtime,job))continue;return null;}
     j.WriteOnce(pre+".terminal",StartRecords.Encode(new Dictionary<string,object>{{"receipt",H(raw)},{"identity",H(binding)},{"state",7},{"runs",1},{"error",job.ErrorCode}}));
     settled=Settled(j,pre,raw,intent,step,out result,out reference);
    }
    if(!settled||result=="")return null; // No association scan to recover a lost resource.
    Current(p,runtime,false);provider.VerifyOptical(p,guid,step,result,resources);Current(p,runtime,false);resources.Add(step,result);
   }
   provider.VerifyOpticalComplete(p,guid,resources);Current(p,runtime,false);
   string proof=Proof(p,guid,owned,security,resources),old=j.Read("native-optical.observed");if(old==null)j.WriteOnce("native-optical.observed",proof);else if(old!=proof)throw new InvalidOperationException("Optical observation differs");return H(proof);
  }
  internal static string VerifyCompleted(NativeRpcDefinitionPlan p,IStartJournal j){
   string guid,owned=NativeRpcSecurity.Ownership(p,j,out guid),security=NativeRpcSecurity.VerifyCompleted(p,j);var resources=new Dictionary<string,string>();
   foreach(string step in Steps){string pre="native-optical."+step,intent=Intent(p,guid,owned,security,step,resources),raw=j.Read(pre+".receipt"),result,job;
    if(j.Read(pre+".intent")!=intent||j.Read(pre+".submit")!=H(intent)||raw==null||!Settled(j,pre,raw,intent,step,out result,out job)||result=="")throw new InvalidOperationException("Original optical operation not settled");resources.Add(step,result);
   }
   string proof=Proof(p,guid,owned,security,resources);if(j.Read("native-optical.observed")!=proof)throw new InvalidOperationException("Original optical readback absent");return H(proof);
  }
 }
 public sealed partial class HyperVNativeRpcDefinition {
  internal static string OpticalClass(string step){if(step=="scsi"||step=="imagedrive"||step=="hashdrive")return "Msvm_ResourceAllocationSettingData";if(step=="imagemedia"||step=="hashmedia")return "Msvm_StorageAllocationSettingData";throw new ArgumentException("Fixed optical role required");}
  internal static string OpticalReference(string step,string raw){
   if(raw==null||raw.Length>2048)throw new InvalidOperationException("Optical reference bound");var path=new ManagementPath(raw);string cls=OpticalClass(step);
   if(!path.IsInstance||!String.Equals(path.ClassName,cls,StringComparison.OrdinalIgnoreCase)||(path.Server!=""&&path.Server!="."&&!String.Equals(path.Server,Environment.MachineName,StringComparison.OrdinalIgnoreCase)))throw new InvalidOperationException("Local exact optical class required");
   string ns=path.NamespacePath;if(ns.StartsWith(@"\\")){int slash=ns.IndexOf('\\',2);if(slash<0)throw new InvalidOperationException("Optical namespace");ns=ns.Substring(slash+1);}if(ns!=""&&!String.Equals(ns,@"root\virtualization\v2",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Optical namespace");
   string relative=path.RelativePath;if(!Regex.IsMatch(relative,"\\A"+cls+"\\.InstanceID=\"(?:[^\"\\\\\\r\\n]|\\\\[\\\\\"]){1,1024}\"\\z",RegexOptions.IgnoreCase))throw new InvalidOperationException("Exact optical instance key required");return cls+relative.Substring(relative.IndexOf('.'));
  }
  internal static Dictionary<string,object> OpticalValues(NativeRpcDefinitionPlan p,string step,IDictionary<string,string> prior){
   if(step=="scsi")return new Dictionary<string,object>{{"ResourceType",(ushort)6},{"ResourceSubType","Microsoft:Hyper-V:Synthetic SCSI Controller"},{"Address","0"}};
   if(step=="imagedrive"||step=="hashdrive")return new Dictionary<string,object>{{"ResourceType",(ushort)16},{"ResourceSubType","Microsoft:Hyper-V:Synthetic DVD Drive"},{"Parent",prior["scsi"]},{"AddressOnParent",step=="imagedrive"?"0":"1"}};
   if(step=="imagemedia"||step=="hashmedia")return new Dictionary<string,object>{{"ResourceType",(ushort)31},{"ResourceSubType","Microsoft:Hyper-V:Virtual CD/DVD Disk"},{"Parent",prior[step=="imagemedia"?"imagedrive":"hashdrive"]},{"HostResource",new[]{Path.Combine(p.Root,NativeRpcMediaProfile.Name(step=="hashmedia"))}}};
   throw new ArgumentException("Fixed optical role required");
  }
  internal static void VerifyOpticalInventory(NativeRpcDefinitionPlan p,IDictionary<string,string> resources,IDictionary<string,Dictionary<string,object>> actual){
   if(actual.Count!=resources.Count)throw new InvalidOperationException("Unexpected optical topology");var unique=new HashSet<string>(StringComparer.Ordinal);
   foreach(string step in NativeRpcOptical.Steps){string reference;if(!resources.TryGetValue(step,out reference))continue;if(OpticalReference(step,reference)!=reference||!unique.Add(reference)||!actual.ContainsKey(reference))throw new InvalidOperationException("Returned optical resource absent or aliased");
    var expected=OpticalValues(p,step,resources);var row=actual[reference];if(row.Count!=expected.Count)throw new InvalidOperationException("Optical field closure differs");
    foreach(var pair in expected){object value;if(!row.TryGetValue(pair.Key,out value))throw new InvalidOperationException("Optical property missing");
     if(pair.Key=="Parent"){value=OpticalReference(step=="imagedrive"||step=="hashdrive"?"scsi":"imagedrive",value as string);}
     if(pair.Value is string[]){var a=value as string[];var e=(string[])pair.Value;if(a==null||a.Length!=1||a[0]!=e[0])throw new InvalidOperationException("Original optical media path differs");}
     else if(!Object.Equals(value,pair.Value))throw new InvalidOperationException("Optical field differs: "+pair.Key);
    }
   }
  }
  internal static void VerifyOpticalSubset(NativeRpcDefinitionPlan p,IDictionary<string,string> expected,IDictionary<string,Dictionary<string,object>> actual){
   var selected=new Dictionary<string,Dictionary<string,object>>();foreach(var x in expected){Dictionary<string,object> row;if(!actual.TryGetValue(x.Value,out row))throw new InvalidOperationException("Original returned optical association missing");selected.Add(x.Value,row);}VerifyOpticalInventory(p,expected,selected);
  }

 }

 // Closed resource policy for the original native VM. Observation only: no
 // remove/adopt/reconfigure/start operation is exposed by this interface.
 public sealed class NativeRpcDevice {
  public readonly string Reference,Class,Subtype;public readonly ushort Type;
  public readonly string[] Host,Connection;public readonly bool Debugger;
  public NativeRpcDevice(string reference,string cls,ushort type,string subtype,string[] host,string[] connection,bool debugger=false){Reference=reference;Class=cls;Type=type;Subtype=subtype;Host=host==null?null:(string[])host.Clone();Connection=connection==null?null:(string[])connection.Clone();Debugger=debugger;}
 }
 public interface INativeRpcDeviceProvider {IList<NativeRpcDevice> ReadDevices(NativeRpcDefinitionPlan p,string guid);}
 public static class NativeRpcDevicePolicy {
  static string H(string x){return NativeRpcDefinitionPlan.Hash(x);}
  static string S(object x){return StartRecords.Text(x);}
  static void Current(NativeRpcDefinitionPlan p,INativeRpcDefinitionRuntime r){r.Check(p,false);if(r.Now<p.Origin||r.Now>=p.Deadline)throw new InvalidOperationException("Original device deadline");}
  static bool Empty(string[] a){return a==null||a.Length==0||(a.Length==1&&a[0]=="");}
  internal static string Reference(NativeRpcDevice d){
   if(d==null||d.Reference==null||d.Reference.Length>2048||d.Class==null||!Regex.IsMatch(d.Class,"\\AMsvm_[A-Za-z]+SettingData\\z"))throw new InvalidOperationException("Device reference bound/class");
   var p=new ManagementPath(d.Reference);
   if(!p.IsInstance||p.Server!=""||p.NamespacePath!=""||p.ClassName!=d.Class||p.RelativePath!=d.Reference||!Regex.IsMatch(d.Reference,"\\A"+d.Class+"\\.InstanceID=\"(?:[^\"\\\\\\r\\n]|\\\\[\\\\\"]){1,1024}\"\\z"))throw new InvalidOperationException("Exact relative device instance required");return d.Reference;
  }
  internal static string Validate(NativeRpcDefinitionPlan p,IDictionary<string,string> optical,IList<NativeRpcDevice> rows){
   if(rows==null||rows.Count<7||rows.Count>10||optical==null||optical.Count!=5)throw new InvalidOperationException("Closed native device count");
   var expected=new Dictionary<string,string>(StringComparer.Ordinal);foreach(string step in NativeRpcOptical.Steps){string value;if(!optical.TryGetValue(step,out value)||HyperVNativeRpcDefinition.OpticalReference(step,value)!=value)throw new InvalidOperationException("Original optical resource absent");expected.Add(value,step);}
   var all=new SortedDictionary<string,string>(StringComparer.Ordinal);int cpu=0,memory=0,serial=0,display=0,media=0;
   foreach(var d in rows){string reference=Reference(d),step;if(all.ContainsKey(reference)||!Empty(d.Connection)||d.Debugger)throw new InvalidOperationException("Aliased or externally connected device");
    if(expected.TryGetValue(reference,out step)){
     var v=HyperVNativeRpcDefinition.OpticalValues(p,step,optical);
     if(d.Class!=HyperVNativeRpcDefinition.OpticalClass(step)||d.Type!=(ushort)v["ResourceType"]||d.Subtype!=(string)v["ResourceSubType"])throw new InvalidOperationException("Original optical device type differs");
     if(v.ContainsKey("HostResource")){var host=(string[])v["HostResource"];if(d.Host==null||d.Host.Length!=1||d.Host[0]!=host[0])throw new InvalidOperationException("Original media backing differs");}else if(!Empty(d.Host))throw new InvalidOperationException("Unexpected storage host backing");media++;
    }else{
     if(!Empty(d.Host))throw new InvalidOperationException("Host resource assignment refused");
     if(d.Class=="Msvm_ProcessorSettingData"&&d.Type==3&&d.Subtype=="Microsoft:Hyper-V:Processor"){if(++cpu>1)throw new InvalidOperationException("CPU ambiguity");}
     else if(d.Class=="Msvm_MemorySettingData"&&d.Type==4&&d.Subtype=="Microsoft:Hyper-V:Memory"){if(++memory>1)throw new InvalidOperationException("Memory ambiguity");}
     else if((d.Class=="Msvm_ResourceAllocationSettingData"||d.Class=="Msvm_SerialPortSettingData")&&d.Type==21&&d.Subtype=="Microsoft:Hyper-V:Serial Port"){if(++serial>2)throw new InvalidOperationException("Serial count");}
     else if(d.Class=="Msvm_SyntheticDisplayControllerSettingData"&&d.Type==24&&d.Subtype=="Microsoft:Hyper-V:Synthetic Display Controller"){if(++display>1)throw new InvalidOperationException("Display count");}
     else throw new InvalidOperationException("Unexpected native device class/type/subtype");
    }
    all.Add(reference,StartRecords.Encode(new Dictionary<string,object>{{"class",d.Class},{"type",d.Type},{"subtype",d.Subtype},{"host",Empty(d.Host)?new string[0]:d.Host},{"connection",new string[0]},{"debugger",false}}));
   }
   if(cpu!=1||memory!=1||media!=5)throw new InvalidOperationException("Required native resources missing");
   var buffer=new StringBuilder();foreach(var pair in all){buffer.Append(pair.Key.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(pair.Key).Append(pair.Value.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(pair.Value);}string encoded=buffer.ToString();if(Encoding.UTF8.GetByteCount(encoded)>65536)throw new InvalidOperationException("Device inventory encoding bound");return H(encoded);
  }
  static Dictionary<string,string> Resources(NativeRpcDefinitionPlan p,IStartJournal j){
   NativeRpcOptical.VerifyCompleted(p,j);var proof=StartRecords.Parse(j.Read("native-optical.observed"),new[]{"schema","plan","vmGuid","owned","security","profile","resources","startAuthorized","providerOperationFenced","reservationMayRelease"});
   var raw=proof["resources"] as Dictionary<string,object>;if(raw==null||raw.Count!=5)throw new InvalidOperationException("Optical resource receipt shape");var result=new Dictionary<string,string>();foreach(string step in NativeRpcOptical.Steps)result.Add(step,S(raw[step]));return result;
  }
  static string Proof(NativeRpcDefinitionPlan p,IStartJournal j,string inventory,int count){
   string guid,owned=NativeRpcSecurity.Ownership(p,j,out guid);StartIdentity.Hex(inventory,64);if(count<7||count>10)throw new InvalidOperationException("Device count receipt");
   return StartRecords.Encode(new Dictionary<string,object>{{"schema","native-rpc-device-observed/1"},{"plan",p.Digest},{"vmGuid",guid},{"owned",owned},{"security",NativeRpcSecurity.VerifyCompleted(p,j)},{"readGrant",NativeRpcReadGrant.VerifyCompleted(p,j)},{"optical",NativeRpcOptical.VerifyCompleted(p,j)},{"inventory",inventory},{"count",count},{"network","no-nic-af-hyperv-only"},{"serial","disconnected"},{"startAuthorized",false},{"providerOperationFenced",false},{"reservationMayRelease",false}});
  }
  public static string Observe(NativeRpcDefinitionPlan p,IStartJournal j,INativeRpcDeviceProvider provider,INativeRpcDefinitionRuntime runtime){
   Current(p,runtime);long before=runtime.Now;string guid;NativeRpcSecurity.Ownership(p,j,out guid);var resources=Resources(p,j);
   NativeRpcReadGrant.VerifyCompleted(p,j);var rows=provider.ReadDevices(p,guid);Current(p,runtime);
   string proof=Proof(p,j,Validate(p,resources,rows),rows.Count);Current(p,runtime);long after=runtime.Now;
   if(after<before||after-before>4000)throw new InvalidOperationException("Device observation stale");
   string saved=j.Read("native-device.observed");if(saved==null)j.WriteOnce("native-device.observed",proof);else if(saved!=proof)throw new InvalidOperationException("Original device inventory changed");return H(proof);
  }
  // This authenticates historical evidence only. It never authorizes a later
  // start; that operation must call Observe again within its original deadline.
  internal static string VerifyCompleted(NativeRpcDefinitionPlan p,IStartJournal j){
   string raw=j.Read("native-device.observed");var d=StartRecords.Parse(raw,new[]{"schema","plan","vmGuid","owned","security","readGrant","optical","inventory","count","network","serial","startAuthorized","providerOperationFenced","reservationMayRelease"});
   long count=StartRecords.Number(d["count"]);if(count<7||count>10||raw!=Proof(p,j,S(d["inventory"]),(int)count))throw new InvalidOperationException("Original device policy receipt differs");return H(raw);
  }
 }
}
