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
   if(!settled&&reference!=""&&j.Read("native-security.terminal")==null){
    Current(p,r,false);var job=provider.ReadJob(reference);Current(p,r,false);
    if(job==null||job.Reference!=reference||HyperVStartProvider.ReferenceForId(job.InstanceId)!=reference||String.IsNullOrEmpty(job.TimeSubmitted)||job.TimeSubmitted.Length>32)throw new InvalidOperationException("Exact security job unavailable");
    string bound=StartRecords.Encode(new Dictionary<string,object>{{"receipt",H(raw)},{"job",reference},{"submitted",job.TimeSubmitted}}),prior=j.Read("native-security.job");
    if(prior==null)j.WriteOnce("native-security.job",bound);else if(prior!=bound)throw new InvalidOperationException("Security job incarnation changed");
    if(job.State!=7||job.RunTimes!=1)return null;
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
 public sealed partial class HyperVNativeRpcDefinition : INativeRpcDefinitionProvider, INativeRpcSecurityProvider {
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
  static ManagementObject RelatedOne(ManagementObject parent,string name){
   ManagementObject found=null;
   try{using(var rows=parent.GetRelated(name))foreach(ManagementObject row in rows){if(found!=null){row.Dispose();throw new InvalidOperationException("Ambiguous native association: "+name);}found=row;}
    if(found==null)throw new InvalidOperationException("Missing native association: "+name);return found;
   }catch{if(found!=null)found.Dispose();throw;}
  }
  internal static void RequireSecurityFields(IDictionary<string,object> fields){
   foreach(string key in new[]{"TpmEnabled","VirtualizationBasedSecurityOptOut"})if(!fields.ContainsKey(key)||!(fields[key] is bool)||!(bool)fields[key])throw new InvalidOperationException("Native security readback differs: "+key);
  }
  public NativeDefinitionResponse ConfigureSecurity(NativeRpcDefinitionPlan p,string guid,string intent){
   ProtectedAttempt.RequireSystem();runtime.Check(p,true);string original;NativeRpcSecurity.Ownership(p,journal,out original);
   if(original!=guid||journal.Read("native-security.native")!=intent||NativeRpcDefinitionPlan.Hash(journal.Read("native-security.intent"))!=intent)throw new InvalidOperationException("Exact consumed security intent required");
   RequireOwnedOff(p,guid);var scope=HyperVStartProvider.Scope();
   using(var vm=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_ComputerSystem WHERE Name='"+guid+"'"))
   using(var settings=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_VirtualSystemSettingData WHERE VirtualSystemIdentifier='"+guid+"' AND VirtualSystemType='Microsoft:Hyper-V:System:Realized'"))
   using(var security=RelatedOne(settings,"Msvm_SecuritySettingData"))
   using(var service=RelatedOne(vm,"Msvm_SecurityService"))
   using(var input=service.GetMethodParameters("ModifySecuritySettings")){
    // Modify only this guest's TPM/VTL1 offer. Preserve every other security
    // property; never disable host VBS or alter Type1 partition isolation.
    security["TpmEnabled"]=true;security["VirtualizationBasedSecurityOptOut"]=true;
    input["SecuritySettingData"]=security.GetText(TextFormat.WmiDtd20);
    journal.WriteOnce("native-security.invoke",intent);runtime.Check(p,true);
    if(runtime.Now<p.Origin||runtime.Now>=p.Deadline)throw new InvalidOperationException("Native original deadline");
    using(var output=service.InvokeMethod("ModifySecuritySettings",input,new InvokeMethodOptions{Timeout=TimeSpan.FromSeconds(2)})){
     if(output==null||output["ReturnValue"]==null)throw new InvalidOperationException("Native security response absent");
     return new NativeDefinitionResponse(Convert.ToUInt32(output["ReturnValue"]),output["Job"] as string,null);
    }
   }
  }
  public void RequireSecurity(NativeRpcDefinitionPlan p,string guid){
   ProtectedAttempt.RequireSystem();RequireOwnedOff(p,guid);
   using(var settings=HyperVStartProvider.One(HyperVStartProvider.Scope(),"SELECT * FROM Msvm_VirtualSystemSettingData WHERE VirtualSystemIdentifier='"+guid+"' AND VirtualSystemType='Microsoft:Hyper-V:System:Realized'"))
   using(var security=RelatedOne(settings,"Msvm_SecuritySettingData")){
    RequireSecurityFields(new Dictionary<string,object>{{"TpmEnabled",security["TpmEnabled"]},{"VirtualizationBasedSecurityOptOut",security["VirtualizationBasedSecurityOptOut"]}});
   }runtime.Check(p,false);
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
    if(!settled&&reference!=""&&j.Read(pre+".terminal")==null){
     Current(p,runtime,false);var job=provider.ReadJob(reference);Current(p,runtime,false);
     if(job==null||job.Reference!=reference||HyperVStartProvider.ReferenceForId(job.InstanceId)!=reference||String.IsNullOrEmpty(job.TimeSubmitted)||job.TimeSubmitted.Length>32)throw new InvalidOperationException("Exact optical job unavailable");
     string binding=StartRecords.Encode(new Dictionary<string,object>{{"receipt",H(raw)},{"job",reference},{"submitted",job.TimeSubmitted}}),prior=j.Read(pre+".job");
     if(prior==null)j.WriteOnce(pre+".job",binding);else if(prior!=binding)throw new InvalidOperationException("Optical job incarnation changed");
     if(job.State!=7||job.RunTimes!=1)return null;
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
 public sealed partial class HyperVNativeRpcDefinition : INativeRpcOpticalProvider {
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
  static ManagementObject OpticalSettings(string guid){return HyperVStartProvider.One(HyperVStartProvider.Scope(),"SELECT * FROM Msvm_VirtualSystemSettingData WHERE VirtualSystemIdentifier='"+guid+"' AND VirtualSystemType='Microsoft:Hyper-V:System:Realized'");}
  static Dictionary<string,Dictionary<string,object>> OpticalInventory(ManagementObject settings){
   var found=new Dictionary<string,Dictionary<string,object>>(StringComparer.Ordinal);int count=0;
   using(var rows=settings.GetRelated("Msvm_ResourceAllocationSettingData"))foreach(ManagementObject row in rows)using(row){
    if(++count>64)throw new InvalidOperationException("Optical inventory bound");string sub=row["ResourceSubType"] as string;ushort type=Convert.ToUInt16(row["ResourceType"]);
    bool scsi=sub=="Microsoft:Hyper-V:Synthetic SCSI Controller",drive=sub=="Microsoft:Hyper-V:Synthetic DVD Drive",media=sub=="Microsoft:Hyper-V:Virtual CD/DVD Disk";
    if(!scsi&&!drive&&!media){if(type==5||type==6||type==15||type==16||type==17||type==19||type==31)throw new InvalidOperationException("Unexpected storage device on native VM");continue;}
    string step=scsi?"scsi":drive?"imagedrive":"imagemedia",reference=OpticalReference(step,row.Path.Path);var values=new Dictionary<string,object>();
    foreach(string field in scsi?new[]{"ResourceType","ResourceSubType","Address"}:drive?new[]{"ResourceType","ResourceSubType","Parent","AddressOnParent"}:new[]{"ResourceType","ResourceSubType","Parent","HostResource"})values[field]=row[field];
    found.Add(reference,values);
   }return found;
  }
  // Exact original-VM association and every expected parent/address/media path,
  // not just a matching filename or a resource belonging to another VM.
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
  void OpticalGuard(NativeRpcDefinitionPlan p,string guid,bool mutation){runtime.Check(p,mutation);string original;NativeRpcSecurity.Ownership(p,journal,out original);if(original!=guid)throw new InvalidOperationException("Original optical VM differs");NativeRpcSecurity.VerifyCompleted(p,journal);RequireOwnedOff(p,guid);RequireSecurity(p,guid);runtime.Check(p,mutation);}
  public NativeOpticalResponse Attach(NativeRpcDefinitionPlan p,string guid,string step,IDictionary<string,string> prior,string intent){
   ProtectedAttempt.RequireSystem();OpticalGuard(p,guid,true);string pre="native-optical."+step;
   if(journal.Read(pre+".submit")!=intent||NativeRpcDefinitionPlan.Hash(journal.Read(pre+".intent"))!=intent)throw new InvalidOperationException("Consumed optical intent required");
   var scope=HyperVStartProvider.Scope();using(var settings=OpticalSettings(guid)){
    var inventory=OpticalInventory(settings);
    if(step=="scsi"&&prior.Count==0&&inventory.Count==1){foreach(string existing in inventory.Keys){var one=new Dictionary<string,string>{{"scsi",existing}};VerifyOpticalInventory(p,one,inventory);return new NativeOpticalResponse(0,null,existing,true);}}
    VerifyOpticalInventory(p,prior,inventory);
    var values=OpticalValues(p,step,prior);
    using(var service=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_VirtualSystemManagementService"))using(var row=New(scope,OpticalClass(step),values))using(var input=service.GetMethodParameters("AddResourceSettings")){
     if(values.ContainsKey("Parent"))row["Parent"]=scope.Path.Path+":"+(string)values["Parent"];
     input["AffectedConfiguration"]=settings.Path.Path;input["ResourceSettings"]=new[]{row.GetText(TextFormat.WmiDtd20)};
     journal.WriteOnce(pre+".invoke",intent);OpticalGuard(p,guid,true);
     using(var output=service.InvokeMethod("AddResourceSettings",input,new InvokeMethodOptions{Timeout=TimeSpan.FromSeconds(2)})){
      if(output==null||output["ReturnValue"]==null)throw new InvalidOperationException("Optical response absent");var refs=output["ResultingResourceSettings"] as string[];if(refs!=null&&refs.Length>1)throw new InvalidOperationException("Ambiguous optical resources");
      return new NativeOpticalResponse(Convert.ToUInt32(output["ReturnValue"]),output["Job"] as string,refs==null||refs.Length==0?null:refs[0]);
     }
    }
   }
  }
  public void VerifyOptical(NativeRpcDefinitionPlan p,string guid,string step,string reference,IDictionary<string,string> prior){
   ProtectedAttempt.RequireSystem();OpticalGuard(p,guid,false);var expected=new Dictionary<string,string>(prior);expected.Add(step,reference);
   // Earlier steps may be re-observed after later returned resources exist.
   // Verify their exact association/fields here; before every new mutation and
   // at final completion the entire inventory must match the known closure.
   using(var settings=OpticalSettings(guid))VerifyOpticalSubset(p,expected,OpticalInventory(settings));OpticalGuard(p,guid,false);
  }
  public void VerifyOpticalComplete(NativeRpcDefinitionPlan p,string guid,IDictionary<string,string> resources){
   ProtectedAttempt.RequireSystem();if(resources.Count!=5)throw new InvalidOperationException("Both optical roles required");OpticalGuard(p,guid,false);
   using(var settings=OpticalSettings(guid))VerifyOpticalInventory(p,resources,OpticalInventory(settings));OpticalGuard(p,guid,false);
  }
 }
}
