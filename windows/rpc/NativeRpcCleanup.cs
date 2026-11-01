// Native VM cleanup under its own short, supervised lease. Original start
// authority is never renewed. This is not an installed independent scheduler.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Management;
using System.Text;
namespace Enclave.OwnedRpc {
 public sealed partial class ProtectedAttempt {
  public static ProtectedAttempt OpenNativeCleanupJournal(string path,string hash,ProtectedAttempt reader){RequireSystem();return new ProtectedAttempt(path,hash,reader,false,1);}
  public static ProtectedAttempt PinNativeCleanupJournalController(string path,string hash,ProtectedAttempt reader){RequireAdministrator();return new ProtectedAttempt(path,hash,reader,true,1);}
  public static ProtectedAttempt OpenNativeStartJournal(string path,string hash,ProtectedAttempt reader){RequireSystem();return new ProtectedAttempt(path,hash,reader,false,2);}
  public static ProtectedAttempt PinNativeStartJournalController(string path,string hash,ProtectedAttempt reader){RequireAdministrator();return new ProtectedAttempt(path,hash,reader,true,2);}
  public static ProtectedAttempt OpenNativeLifecycleJournal(string path,string hash,ProtectedAttempt reader){RequireSystem();return new ProtectedAttempt(path,hash,reader,false,3);}
  public static ProtectedAttempt PinNativeLifecycleJournalController(string path,string hash,ProtectedAttempt reader){RequireAdministrator();return new ProtectedAttempt(path,hash,reader,true,3);}
  private ProtectedAttempt(string path,string hash,ProtectedAttempt reader,bool controller,int nativeCleanup){
   string profile=nativeCleanup==1?"native-cleanup":nativeCleanup==2?"native-start":nativeCleanup==3?"native-lifecycle":"invalid";
   if(profile=="invalid"||reader==null||reader.accessLease!=null||reader.LeaseProfile!=profile||reader.PermitPath!=path||reader.PermitHash!=hash)throw new ArgumentException("Exact original native cleanup lease required");
   reader.CheckDeadline();LocalPath(path);Hex(hash,64);if(Path.GetFileName(path)!="native-definition-plan.txt")throw new ArgumentException("Original native plan filename");
   Root=Path.GetDirectoryName(path);ContractHash=hash;recordOwner=controller?AdminSid:SystemSid;accessLease=reader;LeaseProfile=profile+"-journal";
   try{
    string current=Path.GetPathRoot(Root);HoldDirectory(current,false);string[] parts=Root.Substring(3).Split('\\');
    for(int i=0;i<parts.Length;i++){current=Path.Combine(current,parts[i]);HoldDirectory(current,i==parts.Length-1);}
    byte[] raw=Bytes(HoldRead(path,4096),4096);if(Hash(raw)!=hash)throw new InvalidOperationException("Original native plan changed");
    NativeDefinitionPlan=NativeRpcDefinitionPlan.Parse(Utf8.GetString(raw));var p=NativeDefinitionPlan;
    RootIdentity(p,reader);Nonce=p.Attempt;Boot=p.Boot;Origin=p.Origin;Deadline=p.Deadline;ExecutableHash=p.WorkerImageHash;CheckDeadline();
   }catch{Dispose();throw;}
  }
  void RootIdentity(NativeRpcDefinitionPlan p,ProtectedAttempt reader){
   // Cleanup has a separate <=30s lease, clipped to original startup end+30s.
   // It can stop early after a failure. It cannot submit/revive any start.
   if(p.Root!=Root||p.Boot!=reader.Boot||p.Boot!=CurrentBoot()||(reader.LeaseProfile!="native-lifecycle"&&p.WorkerImageHash!=reader.ExecutableHash)||p.Origin>reader.Origin||p.Deadline>Int64.MaxValue-30000||reader.Deadline>p.Deadline+30000)throw new InvalidOperationException("Original cleanup namespace boot image or window differs");
   if((reader.LeaseProfile=="native-start"&&reader.Deadline>p.Deadline)||(reader.LeaseProfile=="native-lifecycle"&&reader.Deadline!=p.Deadline+30000))throw new InvalidOperationException("Original lifecycle endpoint differs");
  }
 }
 public sealed class NativeRpcCleanupJournal:IStartJournal {
  readonly ProtectedAttempt pin;
  public NativeRpcCleanupJournal(ProtectedAttempt pin){if(pin==null||pin.NativeDefinitionPlan==null||(pin.LeaseProfile!="native-cleanup-journal"&&pin.LeaseProfile!="native-start-journal"&&pin.LeaseProfile!="native-lifecycle-journal"))throw new ArgumentException("Protected native cleanup journal required");this.pin=pin;pin.CheckDeadline();}
  static bool StartName(string n){return n=="native-start.intent"||n=="native-start.submit"||n=="native-start.invoke"||n=="native-start.receipt"||n=="native-start.job"||n=="native-start.terminal"||n=="native-start.observed"||n=="native-start.workers"||n=="native-start.registration"||n=="native-lifecycle.armed"||n=="native-lifecycle.bound"||n=="native-lifecycle.backup-armed"||n=="native-lifecycle.backup-bound"||n=="native-lifecycle.stop"||n=="native-lifecycle.result";}
  static bool StopName(string n){return n=="native-stop.intent"||n=="native-stop.submit"||n=="native-stop.invoke"||n=="native-stop.receipt"||n=="native-stop.job"||n=="native-stop.terminal"||n=="native-stop.observed";}
  static void Name(string n){if(!StartName(n)&&!StopName(n)&&!ProtectedAttempt.NativeDefinitionRecordAllowed(n,false))throw new ArgumentException("Fixed cleanup record required");}
  public string Read(string n){Name(n);pin.CheckDeadline();if(pin.ReadOptionalOnce(n+".pending")!=null)throw new InvalidOperationException("Torn original record held");return pin.ReadOptionalOnce(n);}
  public void WriteOnce(string n,string value){Name(n);pin.WriteOnce(n,value);}
 }
 public interface INativeRpcCleanupRuntime:INativeRpcDefinitionRuntime {
  // Must close the original one-shot work gate and verify exact held owner,
  // observer and provider child death, not task state/kill request/PID absence.
  // Digest binds that original group to the original plan and start intent.
  string RequireStartWorkersDead(NativeRpcDefinitionPlan plan);
  bool WaitForCleanupObservation(NativeRpcDefinitionPlan plan);
 }
 public interface INativeRpcCleanupProvider {
  StartJob ReadJob(string exactReference);
  StartResponse DisableNative(NativeRpcDefinitionPlan plan,string originalGuid,string stopIntent);
  void RequireOwnedOff(NativeRpcDefinitionPlan plan,string originalGuid);
 }
 public static class NativeRpcCleanup {
  static string H(string x){return NativeRpcDefinitionPlan.Hash(x);}
  static void Current(NativeRpcDefinitionPlan p,INativeRpcCleanupRuntime r,bool mutation){r.Check(p,mutation);if(r.Now<p.Origin||p.Deadline>Int64.MaxValue-30000||r.Now>=p.Deadline+30000)throw new InvalidOperationException("Original bounded cleanup window expired");}
  internal static string Dead(NativeRpcDefinitionPlan p,INativeRpcCleanupRuntime r){Current(p,r,false);string h=r.RequireStartWorkersDead(p);StartIdentity.Hex(h,64);if(h==new string('0',64))throw new InvalidOperationException("Exact original start worker death unproven");Current(p,r,false);return h;}
  static bool Wait(NativeRpcDefinitionPlan p,INativeRpcCleanupRuntime r,StartJob job){
   if(job.RunTimes!=1||job.ErrorCode!=0||(job.State!=2&&job.State!=3&&job.State!=4&&job.State!=6))return false;
   Current(p,r,false);long before=r.Now;if(!r.WaitForCleanupObservation(p))return false;Current(p,r,false);if(r.Now<=before)throw new InvalidOperationException("Cleanup observation clock stalled");return true;
  }
  // Successful terminal error is not required for an original start to be
  // conclusively done; a completed failed start may still need VM cleanup.
  // Unknown/lost response and abnormal job states are NEVER settled by inference.
  static bool Operation(NativeRpcDefinitionPlan p,IStartJournal j,INativeRpcCleanupProvider provider,INativeRpcCleanupRuntime r,string prefix,string intent,bool allowError){
   if(prefix!="native-start"&&prefix!="native-stop")throw new ArgumentException("Fixed native cleanup operation");
   string raw=j.Read(prefix+".receipt");if(raw==null)return false;
   var d=StartRecords.Parse(raw,new[]{"intent","code","job"});long code=StartRecords.Number(d["code"]);string reference=StartRecords.Text(d["job"]);
   if(StartRecords.Text(d["intent"])!=intent||code<0||code>UInt32.MaxValue||(code!=4096&&reference!=""))throw new InvalidOperationException("Exact original cleanup response differs");
   if(code==0)return true;if(code!=4096)return false;
   if(HyperVStartProvider.CanonicalJobReference(reference)!=reference)throw new InvalidOperationException("Exact saved cleanup job required");
   string terminal=j.Read(prefix+".terminal"),bound=j.Read(prefix+".job");
   while(terminal==null){
    Current(p,r,false);var job=provider.ReadJob(reference);Current(p,r,false);
    if(job==null||job.Reference!=reference||HyperVStartProvider.ReferenceForId(job.InstanceId)!=reference||String.IsNullOrEmpty(job.TimeSubmitted)||job.TimeSubmitted.Length>32)throw new InvalidOperationException("Exact cleanup job identity absent");
    string observed=StartRecords.Encode(new Dictionary<string,object>{{"receipt",H(raw)},{"job",reference},{"submitted",job.TimeSubmitted}});
    if(bound==null){j.WriteOnce(prefix+".job",observed);bound=observed;}else if(bound!=observed)throw new InvalidOperationException("Cleanup job incarnation changed");
    if(job.State!=7||job.RunTimes!=1){if(Wait(p,r,job))continue;return false;}
    terminal=StartRecords.Encode(new Dictionary<string,object>{{"receipt",H(raw)},{"identity",H(bound)},{"state",7},{"runs",1},{"error",job.ErrorCode}});j.WriteOnce(prefix+".terminal",terminal);
   }
   var b=StartRecords.Parse(bound,new[]{"receipt","job","submitted"});string time=StartRecords.Text(b["submitted"]);
   var t=StartRecords.Parse(terminal,new[]{"receipt","identity","state","runs","error"});long error=StartRecords.Number(t["error"]);
   if(StartRecords.Text(b["receipt"])!=H(raw)||StartRecords.Text(b["job"])!=reference||String.IsNullOrEmpty(time)||time.Length>32||StartRecords.Text(t["receipt"])!=H(raw)||StartRecords.Text(t["identity"])!=H(bound)||StartRecords.Number(t["state"])!=7||StartRecords.Number(t["runs"])!=1||error<0||error>65535)throw new InvalidOperationException("Cleanup terminal binding differs");return allowError||error==0;
  }
  static string Context(NativeRpcDefinitionPlan p,IStartJournal j,INativeRpcCleanupProvider v,INativeRpcCleanupRuntime r,out string guid){
   string dead=Dead(p,r),authority,start=NativeRpcStart.Consumed(p,j,out guid,out authority);
   if(j.Read("native-start.invoke")!=start)throw new InvalidOperationException("Original possibly submitted start remains unproven");
   if(!Operation(p,j,v,r,"native-start",start,true))return null;
   if(Dead(p,r)!=dead)throw new InvalidOperationException("Original start group death changed");
   return StartRecords.Encode(new Dictionary<string,object>{{"schema","native-rpc-stop-intent/1"},{"plan",p.Digest},{"vmGuid",guid},{"start",start},{"startReceipt",H(j.Read("native-start.receipt"))},{"startTerminal",j.Read("native-start.terminal")==null?"":H(j.Read("native-start.terminal"))},{"workersDead",dead},{"requestedState",3}});
  }
  public static string Submit(NativeRpcDefinitionPlan p,IStartJournal j,INativeRpcCleanupProvider v,INativeRpcCleanupRuntime r){
   Current(p,r,true);string guid,intent=Context(p,j,v,r,out guid);if(intent==null)return null;
   j.WriteOnce("native-stop.intent",intent);j.WriteOnce("native-stop.submit",H(intent));Current(p,r,true);
   var response=v.DisableNative(p,guid,H(intent));if(response==null)throw new InvalidOperationException("Native stop response lost");
   string reference="";if(response.ReturnCode==4096)reference=HyperVStartProvider.CanonicalJobReference(response.JobReference);else if(!String.IsNullOrEmpty(response.JobReference))throw new InvalidOperationException("Unexpected stop job");
   if(j.Read("native-stop.invoke")!=H(intent))throw new InvalidOperationException("Native stop invocation absent");
   j.WriteOnce("native-stop.receipt",StartRecords.Encode(new Dictionary<string,object>{{"intent",H(intent)},{"code",response.ReturnCode},{"job",reference}}));return Reconcile(p,j,v,r);
  }
  internal static string ConsumedStop(NativeRpcDefinitionPlan p,IStartJournal j,INativeRpcCleanupProvider v,INativeRpcCleanupRuntime r,out string guid){
   string intent=Context(p,j,v,r,out guid);if(intent==null||j.Read("native-stop.intent")!=intent||j.Read("native-stop.submit")!=H(intent))throw new InvalidOperationException("Exact consumed native stop required");return H(intent);
  }
  public static string Reconcile(NativeRpcDefinitionPlan p,IStartJournal j,INativeRpcCleanupProvider v,INativeRpcCleanupRuntime r){
   Current(p,r,false);string guid,intent=ConsumedStop(p,j,v,r,out guid);
   if(j.Read("native-stop.invoke")!=intent)throw new InvalidOperationException("Native stop invocation unproven");
   if(!Operation(p,j,v,r,"native-stop",intent,false))return null;
   long before=r.Now;v.RequireOwnedOff(p,guid);Current(p,r,false);NativeRpcStart.Fresh(r,before);string dead=Dead(p,r);
   string proof=StartRecords.Encode(new Dictionary<string,object>{{"schema","native-rpc-stop-observed/1"},{"plan",p.Digest},{"vmGuid",guid},{"intent",intent},{"receipt",H(j.Read("native-stop.receipt"))},{"terminal",j.Read("native-stop.terminal")==null?"":H(j.Read("native-stop.terminal"))},{"workersDead",dead},{"enabledState",3},{"allocatedBytes",0},{"providerOperationFenced",false},{"reservationMayRelease",false}});
   string saved=j.Read("native-stop.observed");if(saved==null)j.WriteOnce("native-stop.observed",proof);else if(saved!=proof)throw new InvalidOperationException("Native stop observation changed");Current(p,r,false);NativeRpcStart.Fresh(r,before);return H(proof);
  }
 }
}
