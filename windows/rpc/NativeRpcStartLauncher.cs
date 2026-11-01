// Explicit v2 manager command. This image schedules the existing SYSTEM roles;
// it never invokes Hyper-V, resets an attempt, or retries an uncertain dispatch.
#if NATIVE_RPC_START_CONTROLLER
using System;using System.Collections.Generic;using System.Diagnostics;using System.Globalization;using System.IO;using System.Text;using System.Threading;using System.Web.Script.Serialization;
namespace Enclave.OwnedRpc {
 internal sealed class NativeStartContract {
  internal readonly string Root,Path,Hash,Image,Role,Arguments,TaskName;internal readonly long Origin,End;
  internal NativeStartContract(NativeControllerFiles files,NativeRpcDefinitionPlan p,string workersRoot,byte[] image,byte[] worker,string role,long now,long controllerEnd){
   if(role!="watch"&&role!="watch-backup"&&role!="start")throw new ArgumentException("Explicit original start role required");
   bool keeper=role!="start";if(now<p.Origin||now>=p.Deadline||controllerEnd<=now||controllerEnd-now>30000||p.Deadline>Int64.MaxValue-30000)throw new InvalidOperationException("Original start preparation time invalid");
   string imageHash=ProtectedAttempt.Hash(image);if(!keeper&&imageHash!=p.WorkerImageHash)throw new InvalidOperationException("Original start worker image differs");
   if(image.Length<1||image.Length>262144||worker.Length<1||worker.Length>262144||ProtectedAttempt.Hash(worker)!=p.WorkerImageHash)throw new InvalidOperationException("Pinned start images required");
   Origin=now;End=keeper?p.Deadline+30000:Math.Min(p.Deadline,Math.Min(now+20000,controllerEnd-1000));if(!keeper&&End-now<5000)throw new InvalidOperationException("Insufficient original start time");
   Role=role;string nonce=Guid.NewGuid().ToString("N");Root=System.IO.Path.Combine(workersRoot,nonce);Path=System.IO.Path.Combine(Root,"contract.txt");Image=System.IO.Path.Combine(Root,"entry.exe");
   files.NewDirectory(Root);files.Publish(Image,image);if(keeper)files.Publish(System.IO.Path.Combine(Root,"worker.exe"),worker);
   string raw=String.Join("\n",new[]{keeper?"owned-native-rpc-lifecycle-v1":"owned-native-rpc-start-worker-v1",nonce,p.Boot,now.ToString(CultureInfo.InvariantCulture),End.ToString(CultureInfo.InvariantCulture),imageHash,role,System.IO.Path.Combine(p.Root,"native-definition-plan.txt"),p.Digest,""});
   Hash=NativeRpcDefinitionPlan.Hash(raw);files.Publish(Path,Encoding.UTF8.GetBytes(raw));
   Arguments=Quote(Path)+" "+Hash+" "+Origin+" "+End;TaskName="EnclaveNativeRpcStart-"+nonce;
  }
  internal static string Quote(string s){if(s.IndexOfAny(new[]{'"','\r','\n'})>=0)throw new ArgumentException("Original task argument");return "\""+s+"\"";}
 }
 internal static class NativeStartLaunchRecords {
  internal static void Consume(NativeRpcManagerLedger ledger,string original,NativeRpcDefinitionPlan p,byte[] definition){
   var a=ledger.Original(original);
   if(NativeRpcManagerLedger.Text(a["attempt"])!=p.Attempt||NativeRpcManagerLedger.Text(a["boot"])!=p.Boot||NativeRpcManagerLedger.Text(a["originMs"])!=p.Origin.ToString(CultureInfo.InvariantCulture)||NativeRpcManagerLedger.Text(a["deadlineMs"])!=p.Deadline.ToString(CultureInfo.InvariantCulture))throw new InvalidOperationException("Original start request differs");
   // Must precede directories, tasks and their uncertain COM acknowledgments.
   ledger.Files.Publish(System.IO.Path.Combine(ledger.Root,"start-request.json"),NativeRpcManagerLedger.Encode(new{original=original,plan=p.Digest,definition=ProtectedAttempt.Hash(definition),origin=p.Origin,deadline=p.Deadline,reservationMayRelease=false}));
  }
  internal static Dictionary<string,object> Result(NativeRpcDefinitionPlan p,string raw,string receipt){
   var d=StartRecords.Parse(raw,new[]{"schema","plan","receipt","state","rpcReady","providerOperationFenced","reservationMayRelease"});
   if(StartRecords.Text(d["schema"])!="native-rpc-start-worker-result/1"||StartRecords.Text(d["plan"])!=p.Digest||StartRecords.Text(d["state"])!="native-running-observed"||StartRecords.Text(d["receipt"])!=receipt)throw new InvalidOperationException("Original native start result differs");StartIdentity.Hex(receipt,64);
   foreach(string n in new[]{"rpcReady","providerOperationFenced","reservationMayRelease"})if(!(d[n] is bool)||(bool)d[n])throw new InvalidOperationException("Native start cannot assert serving or release");return d;
  }
 }
 // Shared partial retains original ledger/configuration/plan validators. The
 // start image excludes definition/copy-media dispatch and framed stage input.
#if !NATIVE_RPC_START_FIXTURE
 public static partial class NativeRpcControllerEntry {
  static void StartSchedule(NativeStartContract c,string role){
   Check();long now=BoundedWorker.MonotonicMilliseconds();if(now<c.Origin||now-c.Origin>=5000||now>=c.End)throw new InvalidOperationException("Original task bootstrap cutoff");
   bool keeper=c.Role!="start";string name=c.TaskName+(keeper?"":"-"+role),args=(keeper?"":"start-"+role+" ")+c.Arguments;
   // Record in memory BEFORE the only Register/Run. Durable start-dispatch is
   // already published. Lost response is not authority to call either again.
   if(Tasks.ContainsKey(name))throw new InvalidOperationException("Original task dispatch consumed");Tasks.Add(name,args);
   dynamic service=Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));service.Connect();dynamic folder=service.GetFolder("\\"),task=service.NewTask(0);
   task.RegistrationInfo.Description="One-shot original native RPC start/lifecycle; no retry";task.Principal.UserId="SYSTEM";task.Principal.LogonType=5;task.Principal.RunLevel=1;
   task.Settings.Enabled=true;task.Settings.AllowDemandStart=true;task.Settings.StartWhenAvailable=false;task.Settings.ExecutionTimeLimit=keeper?"PT930S":"PT30S";task.Settings.MultipleInstances=2;task.Settings.DisallowStartIfOnBatteries=false;task.Settings.StopIfGoingOnBatteries=false;
   dynamic action=task.Actions.Create(0);action.Path=c.Image;action.WorkingDirectory=c.Root;action.Arguments=args;
   dynamic registered=folder.RegisterTaskDefinition(name,task,2,"SYSTEM",null,5,null);registered.Run(null);
  }
  static string Await(ProtectedAttempt pin,string name){string raw;while((raw=pin.ReadOptionalOnce(name))==null){Check();pin.CheckDeadline();Thread.Sleep(5);}return raw;}
  static NativeLifecyclePeer StartPeer(ProtectedAttempt lease,string role){return new NativeLifecyclePeer(Await(lease,role+".consumed"),lease.Token,role,lease.Executable,0);}
  static object StartStaged(NativeRpcManagerLedger ledger,Dictionary<string,object> c,string original){
   if(S(c["schema"])!="native-rpc-manager-controller/2")throw new InvalidOperationException("Explicit pinned start configuration required");
   var a=ledger.Original(original);byte[] launchBytes=Files.Read(Path.Combine(ledger.Root,"launch.json"),65536,null);var launch=NativeRpcManagerLedger.Decode(launchBytes);var p=MakePlan(a,c,launch);
   byte[] definition=Files.Read(Path.Combine(ledger.Root,"result.json"),65536,null);var result=NativeRpcManagerLedger.Decode(definition);
   if(S(result["plan"])!=p.Digest||S(result["state"])!="defined-native-owned-off"||!(result["settled"] is bool)||!(bool)result["settled"])throw new InvalidOperationException("Original completed definition required");
   foreach(string n in new[]{"startAuthorized","providerOperationFenced","reservationMayRelease"})if(!(result[n] is bool)||(bool)result[n])throw new InvalidOperationException("Definition cannot authorize a replay");
   NativeStartLaunchRecords.Consume(ledger,original,p,definition);
   Files.Read(Path.Combine(p.Root,"native-definition-plan.txt"),4096,p.Digest);
   byte[] worker=Files.Read(S(c["workerPath"]),262144,p.WorkerImageHash),keeper=Files.Read(S(c["keeperPath"]),262144,S(c["keeperSha256"]));
   // Copy both keepers before starting either. Each native entry independently
   // enforces its own bootstrap cutoff and the unchanged original endpoint.
   var first=new NativeStartContract(Files,p,S(c["workersRoot"]),keeper,worker,"watch",BoundedWorker.MonotonicMilliseconds(),Deadline);
   var second=new NativeStartContract(Files,p,S(c["workersRoot"]),keeper,worker,"watch-backup",BoundedWorker.MonotonicMilliseconds(),Deadline);
   var start=new NativeStartContract(Files,p,S(c["workersRoot"]),worker,worker,"start",BoundedWorker.MonotonicMilliseconds(),Deadline);
   using(var lease=ProtectedAttempt.PinNativeStartController(start.Path,start.Hash))using(var pin=ProtectedAttempt.PinNativeStartJournalController(lease.PermitPath,lease.PermitHash,lease)){
    var journal=new NativeRpcCleanupJournal(pin);VerifyOwnedResult(p,result,journal.Read("native-definition.system"),journal.Read("native-definition.owned"));
    if(S(result["securityReceipt"])!=NativeRpcSecurity.VerifyCompleted(p,journal)||S(result["readGrantReceipt"])!=NativeRpcReadGrant.VerifyCompleted(p,journal)||S(result["opticalReceipt"])!=NativeRpcOptical.VerifyCompleted(p,journal)||S(result["deviceReceipt"])!=NativeRpcDevicePolicy.VerifyCompleted(p,journal))throw new InvalidOperationException("Original definition lineage differs");
    // Admission before any task; the owner/child recheck immediately before
    // provider mutation. Controller reads historical receipts, not fresh Off.
    LegacyHandoff.Completion completion=null;try{WindowsStartAdmission.VerifyNativeDefinition(pin,lease,ref completion);}finally{if(completion!=null)completion.Dispose();}
    ledger.Files.Publish(Path.Combine(ledger.Root,"start-dispatch.json"),E(new{original=original,plan=p.Digest,primary=first.Path,primaryHash=first.Hash,backup=second.Path,backupHash=second.Hash,start=start.Path,startHash=start.Hash,origin=p.Origin,deadline=p.Deadline}));
    StartSchedule(first,null);StartSchedule(second,null);
    Await(pin,NativeLifecycleBinding.Key(false,false));Await(pin,NativeLifecycleBinding.Key(true,false));
    string firstRaw,secondRaw;using(var primary=NativeLifecycleBinding.Peer(pin,false,out firstRaw))using(var backup=NativeLifecycleBinding.Peer(pin,true,out secondRaw)){
     // Require these prepared contracts, not merely another valid keeper pair.
     var f=StartRecords.Parse(firstRaw,new[]{"schema","plan","contract","hash","identity"});var b=StartRecords.Parse(secondRaw,new[]{"schema","plan","contract","hash","identity"});
     if(S(f["contract"])!=first.Path||S(f["hash"])!=first.Hash||S(b["contract"])!=second.Path||S(b["hash"])!=second.Hash||primary.Identity.Split(',')[0]==backup.Identity.Split(',')[0])throw new InvalidOperationException("Prepared keeper pair differs");
     StartSchedule(start,"owner");StartSchedule(start,"observer");
     using(var owner=StartPeer(lease,"owner"))using(var observer=StartPeer(lease,"observer")){
      Check();lease.CheckDeadline();if(!primary.Alive||!backup.Alive)throw new InvalidOperationException("Keeper lost before work admission");lease.WriteOnce("admit",lease.Token);
      foreach(var peer in new[]{owner,observer}){while(peer.Alive){Check();lease.CheckDeadline();if(!primary.Alive||!backup.Alive)throw new InvalidOperationException("Keeper lost during original start");Thread.Sleep(5);}if(peer.ExitCode!=0)throw new InvalidOperationException("Original start worker held");}
      if(lease.ReadOnce("owner.result")!="native-start-observed;rpc-ready=false;provider-fenced=false;reservation-release=false"||lease.ReadOnce("observer.result")!="exact-owner-death;job-empty;provider-fenced=false;reservation-release=false")throw new InvalidOperationException("Exact original start completion absent");
      string workers=journal.Read("native-start.workers");if(!NativeLifecycleBinding.Bound(journal,workers)||!primary.Alive||!backup.Alive)throw new InvalidOperationException("Paired lifecycle custody absent");
      var observed=NativeStartLaunchRecords.Result(p,lease.ReadOnce("child.result"),NativeRpcStart.VerifyCompleted(p,journal));
      ledger.Files.Publish(Path.Combine(ledger.Root,"start-result.json"),E(observed));return observed;
     }
    }
   }
  }
  public static int Main(string[] args){Origin=BoundedWorker.MonotonicMilliseconds();Deadline=Origin+30000;
   try{Arm();BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);ProtectedAttempt.RequireAdministrator();if(args.Length!=4||args[0]!="start-staged")throw new ArgumentException("Explicit one-shot native start command required");
    using(Files=new NativeControllerFiles(Check)){
     var c=NativeRpcManagerLedger.Decode(Files.Read(args[1],65536,args[2]));ValidateConfiguration(c);if(S(c["schema"])!="native-rpc-manager-controller/2")throw new InvalidOperationException("Pinned v2 start required");
     using(var self=Process.GetCurrentProcess()){if(!String.Equals(self.MainModule.FileName,S(c["startControllerPath"]),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Start controller path differs");Files.Read(S(c["startControllerPath"]),262144,S(c["startControllerSha256"]));}
     using(var ledger=new NativeRpcManagerLedger(S(c["ledgerRoot"]),args[2],Check)){object value=StartStaged(ledger,c,args[3]);Check();Console.WriteLine(new JavaScriptSerializer{MaxJsonLength=131072}.Serialize(new{schema="native-rpc-manager-controller-result/2",command=args[0],value=value,elapsedMs=BoundedWorker.MonotonicMilliseconds()-Origin,rpcReady=false,providerOperationFenced=false,reservationMayRelease=false}));return 0;}
    }
   }catch(Exception e){Console.Error.WriteLine(e.GetType().Name+": "+e.Message);return 1;}
   // Deliberately no generic task Stop/Delete: independently scheduled keepers
   // must survive this short command. Their immutable endpoint is originalD+30.
   // Unknown dispatch stays held; no repeat, task-state death claim or release.
  }
 }
#endif
}
#endif
