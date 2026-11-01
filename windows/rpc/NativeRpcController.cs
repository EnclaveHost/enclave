// Explicit native manager controller. No default manager activation, VM adoption,
// start, delete, release or retry. Each command has its own native 30s backstop;
// every definition remains inside the persisted original 900s attempt.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
namespace Enclave.OwnedRpc {
 internal sealed partial class NativeRpcManagerLedger:IDisposable {
  internal static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=65536,RecursionLimit=32};
  internal readonly NativeControllerFiles Files;internal readonly string Root,ConfigHash;
  readonly Action current;
  internal NativeRpcManagerLedger(string root,string configHash,Action current){
   ProtectedAttempt.RequireAdministrator();Hex(configHash,64);Root=ProtectedAttempt.LocalPath(root);ConfigHash=configHash;this.current=current;
   Files=new NativeControllerFiles(current);
   try{Files.PinDirectory(root,true);Files.Open(Path.Combine(root,"manager.lock"),0,true);}catch{Files.Dispose();throw;}
  }
  internal static void Hex(string s,int length){if(s==null||s.Length!=length||s==new string('0',length))throw new ArgumentException("Nonzero controller identity");foreach(char c in s)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))throw new ArgumentException("Controller identity encoding");}
  internal static Dictionary<string,object> Obj(object x){var d=x as Dictionary<string,object>;if(d==null)throw new ArgumentException("Controller object");return d;}
  internal static string Text(object x){var s=x as string;if(s==null)throw new ArgumentException("Controller string");return s;}
  internal static byte[] Encode(object x){return Encoding.UTF8.GetBytes(Json.Serialize(x));}
  internal static Dictionary<string,object> Decode(byte[] b){return Obj(Json.DeserializeObject(new UTF8Encoding(false,true).GetString(b)));}
#if !NATIVE_RPC_BOOTSTRAP_CONTROLLER || NATIVE_RPC_BOOTSTRAP_FIXTURE
  internal void RequireEmpty(){
   current();int count=0;foreach(string path in Directory.EnumerateFileSystemEntries(Root)){string name=Path.GetFileName(path);if(++count>2||(name!="manager.lock"&&name!="transport"))throw new InvalidOperationException("Prior native attempt remains held; no retry or foreign adoption");if(name=="transport")Files.PinDirectory(path,true);}if(count<1)throw new InvalidOperationException("Native ledger lock absent");
  }
  internal Dictionary<string,object> Begin(string epoch,string instance,string deployment,long originalOrigin){
   Hex(epoch,32);if(instance==null||instance.Length!=35||!instance.StartsWith("rpc",StringComparison.Ordinal))throw new ArgumentException("Native instance");Hex(instance.Substring(3),32);
   if(deployment==null||deployment.Length!=66||!deployment.StartsWith("0x",StringComparison.Ordinal))throw new ArgumentException("Native deployment");Hex(deployment.Substring(2),64);
   long now=BoundedWorker.MonotonicMilliseconds();if(originalOrigin<0||originalOrigin>now||now-originalOrigin>=30000||originalOrigin>9007199254740991L-900000)throw new ArgumentException("Original native manager clock");
   RequireEmpty();string attempt=Guid.NewGuid().ToString("N");
   var value=new Dictionary<string,object>{{"schema","native-rpc-manager-attempt/1"},{"config",ConfigHash},{"attempt",attempt},{"boot",ProtectedAttempt.CurrentBoot()},{"managerEpoch",epoch},{"instance",instance},{"deployment",deployment},{"originMs",originalOrigin.ToString(CultureInfo.InvariantCulture)},{"deadlineMs",(originalOrigin+900000).ToString(CultureInfo.InvariantCulture)},{"physicalMemoryMiB",20480},{"appMemoryMiB",19456},{"cpuUnits",400000},{"reservationMayRelease",false}};
   // The original attempt/reservation is durable before acknowledgment or any
   // component preparation. Restart sees this exact record or a torn pending.
   Files.Publish(Path.Combine(Root,"attempt.json"),Encode(value));return value;
  }
#endif
  internal Dictionary<string,object> Original(string expectedHash){
   Hex(expectedHash,64);int count=0;
   foreach(string path in Directory.EnumerateFileSystemEntries(Root)){
    current();if(++count>15)throw new InvalidOperationException("Native ledger inventory bound");string n=Path.GetFileName(path);
    if(n=="transport"||n=="inputs"||n=="bootstrap")Files.PinDirectory(path,true);
    if(n=="hold.json")throw new InvalidOperationException("Original native attempt is held; no mutation authority");
    if(n.EndsWith(".pending",StringComparison.Ordinal))throw new InvalidOperationException("Partial original native ledger remains held");
    if(n!="manager.lock"&&n!="attempt.json"&&n!="launch.json"&&n!="dispatch.json"&&n!="result.json"&&n!="hold.json"&&n!="transport"&&n!="inputs"&&n!="stage.json"&&n!="stage-ready.json"&&n!="define-request.json"&&n!="start-request.json"&&n!="start-dispatch.json"&&n!="start-result.json"&&n!="bootstrap")throw new InvalidOperationException("Unknown native ledger allocation");
   }
   var a=Decode(Files.Read(Path.Combine(Root,"attempt.json"),4096,expectedHash));
   if(a.Count!=13||Text(a["schema"])!="native-rpc-manager-attempt/1"||Text(a["config"])!=ConfigHash||Text(a["boot"])!=ProtectedAttempt.CurrentBoot()||!(a["reservationMayRelease"] is bool)||((bool)a["reservationMayRelease"]))throw new InvalidOperationException("Original ledger binding differs");
   long origin=Int64.Parse(Text(a["originMs"]),NumberStyles.None,CultureInfo.InvariantCulture),deadline=Int64.Parse(Text(a["deadlineMs"]),NumberStyles.None,CultureInfo.InvariantCulture),now=BoundedWorker.MonotonicMilliseconds();
   if(origin<0||origin>9007199254740991L-900000||deadline!=origin+900000||now<origin||now>=deadline)throw new InvalidOperationException("Original manager deadline expired; reservation remains held");return a;
  }
#if !NATIVE_RPC_BOOTSTRAP_CONTROLLER
  internal void ConsumeLaunch(string originalHash,Dictionary<string,object> launch){
   var a=Original(originalHash);var clock=Obj(launch["originalClock"]);var memory=Obj(launch["memory"]);var cpu=Obj(launch["cpu"]);
   if(Text(launch["managerEpoch"])!=Text(a["managerEpoch"])||Text(launch["id"])!=Text(a["instance"])||Text(launch["instanceId"])!=Text(a["instance"])||Text(launch["name"])!=Text(a["deployment"])||Text(clock["originMs"])!=Text(a["originMs"])||Text(clock["deadlineMs"])!=Text(a["deadlineMs"])||Convert.ToInt64(launch["physicalMemoryMiB"])!=20480||Convert.ToInt64(memory["appMiB"])!=19456||Convert.ToInt64(cpu["grantedUnits"])!=400000||Convert.ToInt64(cpu["vcpus"])!=4||Convert.ToInt64(cpu["appCpuPercent"])!=400)throw new InvalidOperationException("Native launch changed original identity/reservation");
   if(File.Exists(Path.Combine(Root,"hold.json")))throw new InvalidOperationException("Original native attempt stopped/held");
   byte[] data=Encode(launch);if(data.Length>65536)throw new InvalidOperationException("Native launch record bound");Files.Publish(Path.Combine(Root,"launch.json"),data);
  }
#endif
  public void Dispose(){Files.Dispose();}
 }
 public static partial class NativeRpcControllerEntry {
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr handle,uint code);
  static long Origin,Deadline;static readonly List<Process> Peers=new List<Process>();static readonly Dictionary<string,string> Tasks=new Dictionary<string,string>();
  static bool CleanupAttempted;static dynamic Folder;static string Worker,WorkRoot;static NativeControllerFiles Files;
  static string S(object x){return NativeRpcManagerLedger.Text(x);}static Dictionary<string,object> D(object x){return NativeRpcManagerLedger.Obj(x);}
  static byte[] E(object x){return NativeRpcManagerLedger.Encode(x);}static void Check(){long n=BoundedWorker.MonotonicMilliseconds();if(n<Origin||n>=Deadline)throw new TimeoutException("Native controller original short deadline");}
  static string Quote(string s){if(s.IndexOfAny(new[]{'"','\r','\n'})>=0)throw new ArgumentException("Controller argument");return "\""+s+"\"";}
  static void Arm(){
   var ack=new ManualResetEvent(false);var thread=new Thread(delegate(){ack.Set();while(BoundedWorker.MonotonicMilliseconds()<Deadline)Thread.Sleep(5);if(!TerminateProcess(GetCurrentProcess(),125))Environment.FailFast("Native controller backstop failed");});thread.IsBackground=true;thread.Start();if(!ack.WaitOne(1000))throw new InvalidOperationException("Native controller watchdog unarmed");
  }
#if !NATIVE_RPC_START_CONTROLLER
  static Process Peer(ProtectedAttempt lease,string role){
   string path=Path.Combine(lease.Root,role+".consumed");while(!File.Exists(path)){Check();lease.CheckDeadline();Thread.Sleep(5);}
   string[] f=lease.ReadOnce(role+".consumed").Split(',');if(f.Length!=4||f[2]!=lease.Token||f[3]!=role)throw new InvalidOperationException("Exact role binding differs");
   var p=Process.GetProcessById(Int32.Parse(f[0],NumberStyles.None,CultureInfo.InvariantCulture));Peers.Add(p);IntPtr handle=p.Handle;
   if(p.HasExited||p.StartTime.ToUniversalTime().ToFileTimeUtc()!=Int64.Parse(f[1],NumberStyles.None,CultureInfo.InvariantCulture)||!String.Equals(p.MainModule.FileName,lease.Executable,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Exact role process differs");return p;
  }
  static void Schedule(ProtectedAttempt lease,string role,string args){
   Check();lease.CheckDeadline();if(BoundedWorker.MonotonicMilliseconds()-lease.Origin>=5000)throw new InvalidOperationException("Original worker bootstrap cutoff");
   string name="EnclaveNativeRpc-"+lease.Nonce+"-"+role;Tasks.Add(name,args);
   dynamic service=Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));service.Connect();Folder=service.GetFolder("\\");dynamic task=service.NewTask(0);
   task.RegistrationInfo.Description="Original native RPC definition; no VM start";task.Principal.UserId="SYSTEM";task.Principal.LogonType=5;task.Principal.RunLevel=1;
   task.Settings.Enabled=true;task.Settings.AllowDemandStart=true;task.Settings.StartWhenAvailable=false;task.Settings.ExecutionTimeLimit="PT30S";task.Settings.MultipleInstances=2;
   task.Settings.DisallowStartIfOnBatteries=false;task.Settings.StopIfGoingOnBatteries=false;dynamic action=task.Actions.Create(0);action.Path=Worker;action.WorkingDirectory=WorkRoot;action.Arguments=args;
   // TASK_CREATE (2), never UPDATE. Unknown COM/Run response stays consumed.
   dynamic registered=Folder.RegisterTaskDefinition(name,task,2,"SYSTEM",null,5,null);registered.Run(null);
  }
  static void Cleanup(){
   CleanupAttempted=true;
   foreach(var pair in Tasks){dynamic task=Folder.GetTask(pair.Key),d=task.Definition,a=d.Actions.Item(1);string user=d.Principal.UserId;
    if(d.Actions.Count!=1||(user!="SYSTEM"&&user!="S-1-5-18")||d.Principal.LogonType!=5||a.Path!=Worker||a.WorkingDirectory!=WorkRoot||a.Arguments!=pair.Value)throw new InvalidOperationException("Exact native task cleanup association differs");
    task.Enabled=false;task.Stop(0);Folder.DeleteTask(pair.Key,0);
   }
   foreach(var p in Peers)if(!p.HasExited)throw new InvalidOperationException("Exact native role death not observed");
  }
#endif
  internal static NativeRpcDefinitionPlan MakePlan(Dictionary<string,object> a,Dictionary<string,object> c,Dictionary<string,object> launch){
   var record=D(launch["record"]);var claim=D(launch["physicalClaim"]);string app=S(launch["appId"]),epoch=S(a["managerEpoch"]),instance=S(a["instance"]);
   string id=ProtectedAttempt.Hash(E(new[]{epoch,instance,app}));
   if(S(record["runtimeId"])!=S(c["runtimeId"])||S(D(record["rpc"])["profileSha256"])!=S(c["profileSha256"])||S(record["secretDeployment"])!=S(a["deployment"])||S(record["derivation"])!="enclave-catalog-bundle/9"||claim.Count!=5||S(claim["actor"])!="app-native"||S(claim["boot"])!=S(a["boot"])||S(claim["id"])!=id||Convert.ToInt64(claim["bytes"])!=21474836480L)throw new InvalidOperationException("Native runtime/deployment/claim binding differs");
   return new NativeRpcDefinitionPlan(S(a["attempt"]),S(a["boot"]),epoch,instance,S(a["deployment"]),app,S(launch["recordSha256"]),S(c["runtimeId"]),S(c["profileSha256"]),S(c["admissionSha256"]),id,Path.Combine(S(c["attemptsRoot"]),S(a["attempt"])),Int64.Parse(S(a["originMs"])),Int64.Parse(S(a["deadlineMs"])),S(c["firmwareSha256"]),S(c["initialStateSha256"]),S(c["workerSha256"]));
  }
#if !NATIVE_RPC_START_CONTROLLER
  static object Define(NativeRpcManagerLedger ledger,Dictionary<string,object> c,string originalHash,string launchPath,string launchHash,string bundlePath,string recordPath,bool staged){
   var a=ledger.Original(originalHash);var launch=NativeRpcManagerLedger.Decode(Files.Read(launchPath,65536,launchHash));
   if(!staged)ledger.ConsumeLaunch(originalHash,launch);else if(!BytesEqual(Files.Read(Path.Combine(ledger.Root,"launch.json"),65536,launchHash),E(launch)))throw new InvalidOperationException("Staged launch differs");var plan=MakePlan(a,c,launch);
   // All asset bytes are privately copied, hashed, flushed and pinned under the
   // original attempt. No master VMGS is passed to Hyper-V and no path from the
   // deployment wire is used. Preparation failures never reopen launch.json.
   Files.NewDirectory(plan.Root);
   Files.Publish(Path.Combine(plan.Root,"native-definition-plan.txt"),Encoding.UTF8.GetBytes(plan.Encode()));
   Files.Publish(Path.Combine(plan.Root,"admission.json"),Files.Read(S(c["admissionPath"]),262144,plan.Admission));
   foreach(var item in new[]{new[]{"runtime.igvm","firmwarePath",plan.FirmwareHash},new[]{"guest-state.vmgs","initialStatePath",plan.StateHash},new[]{"profile.json","profilePath",plan.Profile}}){
    int maximum=item[0]=="runtime.igvm"?Int32.MaxValue:(item[0]=="guest-state.vmgs"?67108864:65536);var input=Files.Open(S(c[item[1]]),maximum,false);Files.Copy(Path.Combine(plan.Root,item[0]),input,maximum,item[2]);
   }
   // Profile already binds both payload hashes/geometry. Fixed siblings of the
   // operator-pinned profile are the ONLY source paths, never app request paths.
   // Original define-request/launch records consumed before all preparation.
   var mediaProfile=new NativeRpcMediaProfile(Files.Read(Path.Combine(plan.Root,"profile.json"),16384,plan.Profile),plan.Profile);
   var mediaDigests=new Dictionary<string,object>();
   foreach(bool tree in new[]{false,true}){
    string name=NativeRpcMediaProfile.Name(tree),source=Path.Combine(Path.GetDirectoryName(S(c["profilePath"])),name);
    string digest=Files.CopyMedia(Path.Combine(plan.Root,name),Files.Open(source,NativeRpcMediaProfile.Size(tree),false),mediaProfile,tree);mediaDigests.Add(name,digest);
   }
   Files.Publish(Path.Combine(plan.Root,"native-media-prepared.json"),E(new{plan=plan.Digest,profile=plan.Profile,containers=mediaDigests,attached=false,rpcReady=false}));
   Files.Copy(Path.Combine(plan.Root,"bundle.bin"),Files.Open(bundlePath,9*1048576,false),9*1048576,plan.App);
   Files.Publish(Path.Combine(plan.Root,"record.json"),Files.Read(recordPath,65536,plan.Record));
   byte[] image=Files.Read(S(c["workerPath"]),262144,plan.WorkerImageHash);
   string nonce=Guid.NewGuid().ToString("N");WorkRoot=Path.Combine(S(c["workersRoot"]),nonce);Files.NewDirectory(WorkRoot);Worker=Path.Combine(WorkRoot,"entry.exe");Files.Publish(Worker,image);
   long phase=BoundedWorker.MonotonicMilliseconds(),end=Math.Min(Math.Min(phase+20000,Deadline-1000),plan.Deadline);
   if(end-phase<5000)throw new InvalidOperationException("Insufficient original worker time after preparation");
   string contract=Path.Combine(WorkRoot,"contract.txt"),planPath=Path.Combine(plan.Root,"native-definition-plan.txt");
   byte[] raw=Encoding.UTF8.GetBytes("owned-native-rpc-definition-worker-v1\n"+nonce+"\n"+plan.Boot+"\n"+phase+"\n"+end+"\n"+plan.WorkerImageHash+"\ndefine\n"+planPath+"\n"+plan.Digest+"\n");string hash=ProtectedAttempt.Hash(raw);Files.Publish(contract,raw);
   using(var lease=ProtectedAttempt.PinNativeDefinitionController(contract,hash))using(var pin=ProtectedAttempt.PinNativeDefinitionJournalController(planPath,plan.Digest,lease)){
    // Controller independently performs current complete app/capacity admission
    // BEFORE scheduling roles. The child repeats it before provider mutation.
    LegacyHandoff.Completion completion=null;
    try{WindowsStartAdmission.VerifyNativeDefinition(pin,lease,ref completion);}finally{if(completion!=null)completion.Dispose();}
    ledger.Files.Publish(Path.Combine(ledger.Root,"dispatch.json"),E(new{original=originalHash,plan=plan.Digest,contract=hash,workerRoot=WorkRoot,origin=phase,deadline=end}));
    string args=Quote(contract)+" "+hash+" "+phase+" "+end;Schedule(lease,"owner","owner "+args);Schedule(lease,"observer","observer "+args);
    Process owner=Peer(lease,"owner"),observer=Peer(lease,"observer");lease.WriteOnce("admit",lease.Token);
    // Child may finish before collection; owner+observer still retain the exact
    // child identity and prove an empty job. Do not substitute task state.
    foreach(var p in new[]{owner,observer})if(!p.WaitForExit((int)Math.Max(0,end-BoundedWorker.MonotonicMilliseconds()))||p.ExitCode!=0)throw new InvalidOperationException("Native exact role completion failed");
    if(lease.ReadOnce("owner.result")!="native-definition-observed;rpc-ready=false;provider-fenced=false;reservation-release=false"||lease.ReadOnce("observer.result")!="exact-owner-death;job-empty;provider-fenced=false;reservation-release=false")throw new InvalidOperationException("Native exact cleanup receipts absent");
    var result=StartRecords.Parse(lease.ReadOnce("child.result"),new[]{"deviceReceipt","readGrantReceipt","opticalReceipt","securityReceipt","plan","state","vmGuid","ownedReceipt","settled","startAuthorized","providerOperationFenced","reservationMayRelease"});
    if(S(result["plan"])!=plan.Digest||S(result["state"])!="defined-native-owned-off"||!(result["settled"] is bool)||!(bool)result["settled"])throw new InvalidOperationException("Native result not owned Off");
    foreach(string flag in new[]{"startAuthorized","providerOperationFenced","reservationMayRelease"})if(!(result[flag] is bool)||(bool)result[flag])throw new InvalidOperationException("Invalid native release assertion");
    VerifyOwnedResult(plan,result,pin.ReadOnce("native-definition.system"),pin.ReadOnce("native-definition.owned"));
    if(S(result["securityReceipt"])!=NativeRpcSecurity.VerifyCompleted(plan,new NativeRpcDefinitionJournal(pin)))throw new InvalidOperationException("Original security readback differs");
    if(S(result["readGrantReceipt"])!=NativeRpcReadGrant.VerifyCompleted(plan,new NativeRpcDefinitionJournal(pin)))throw new InvalidOperationException("Original VM media read grant differs");
    if(S(result["opticalReceipt"])!=NativeRpcOptical.VerifyCompleted(plan,new NativeRpcDefinitionJournal(pin)))throw new InvalidOperationException("Original optical readback differs");
    if(S(result["deviceReceipt"])!=NativeRpcDevicePolicy.VerifyCompleted(plan,new NativeRpcDefinitionJournal(pin)))throw new InvalidOperationException("Original device policy differs");
    ledger.Files.Publish(Path.Combine(ledger.Root,"result.json"),E(result));return result;
   }
  }
#endif
  internal static void VerifyOwnedResult(NativeRpcDefinitionPlan plan,Dictionary<string,object> result,string system,string owned){
   var record=StartRecords.Parse(owned,new[]{"schema","plan","system","vmGuid","app","deployment","instance","managerEpoch","startAuthorized","reservationMayRelease"});
   var binding=StartRecords.Parse(system,new[]{"receipt","system"});string guid=NativeDefinitionReferences.GuidForReference(S(binding["system"]));
   if(S(result["ownedReceipt"])!=ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(owned))||S(result["vmGuid"])!=guid||S(record["schema"])!="native-rpc-owned-off/1"||S(record["plan"])!=plan.Digest||S(record["system"])!=ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(system))||S(record["vmGuid"])!=guid||S(record["app"])!=plan.App||S(record["deployment"])!=plan.Deployment||S(record["instance"])!=plan.Instance||S(record["managerEpoch"])!=plan.ManagerEpoch)throw new InvalidOperationException("Original native ownership receipt differs");
   foreach(string flag in new[]{"startAuthorized","reservationMayRelease"})if(!(record[flag] is bool)||(bool)record[flag])throw new InvalidOperationException("Native owned result cannot authorize start or release");
  }
  internal static void ValidateConfiguration(Dictionary<string,object> c){
   string[] keys={"schema","ledgerRoot","attemptsRoot","workersRoot","runtimeId","profileSha256","admissionSha256","firmwareSha256","initialStateSha256","workerSha256","admissionPath","firmwarePath","initialStatePath","profilePath","workerPath"};
   bool start=S(c["schema"])=="native-rpc-manager-controller/2";
   if(c.Count!=keys.Length+(start?4:0)||(!start&&S(c["schema"])!="native-rpc-manager-controller/1"))throw new ArgumentException("Explicit native controller configuration required");
   foreach(string key in keys)if(!c.ContainsKey(key))throw new ArgumentException("Missing native controller field");
   foreach(string key in new[]{"runtimeId","profileSha256","admissionSha256","firmwareSha256","initialStateSha256","workerSha256"})NativeRpcManagerLedger.Hex(S(c[key]),64);
   foreach(string key in new[]{"ledgerRoot","attemptsRoot","workersRoot","admissionPath","firmwarePath","initialStatePath","profilePath","workerPath"})ProtectedAttempt.LocalPath(S(c[key]));
   if(start){foreach(string key in new[]{"keeperSha256","startControllerSha256"})NativeRpcManagerLedger.Hex(S(c[key]),64);foreach(string key in new[]{"keeperPath","startControllerPath"})ProtectedAttempt.LocalPath(S(c[key]));}
   var roots=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
   foreach(string key in new[]{"ledgerRoot","attemptsRoot","workersRoot"})if(!roots.Add(S(c[key])))throw new ArgumentException("Separate private controller roots required");
  }
#if !NATIVE_RPC_START_CONTROLLER
  public static int Main(string[] args){
   Origin=BoundedWorker.MonotonicMilliseconds();Deadline=Origin+30000;
   try{
    // Arm before blocking files/COM/WMI. This is not a prior-allocation bound;
    // target startup overhead/admission must be qualified separately.
    Arm();BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);ProtectedAttempt.RequireAdministrator();
    if(args.Length<3)throw new ArgumentException("Native command/config/hash required");
    using(Files=new NativeControllerFiles(Check)){
     var c=NativeRpcManagerLedger.Decode(Files.Read(args[1],65536,args[2]));
     ValidateConfiguration(c);
     // The fixed operator config owns ledger, runtime assets and worker paths.
     // Caller cannot switch ledgers or reset history inside the same config.
     using(var ledger=new NativeRpcManagerLedger(S(c["ledgerRoot"]),args[2],Check)){
      object result;
      if(args[0]=="begin"&&args.Length==6){var begun=ledger.Begin(args[3],args[4],args[5],Origin);result=new{original=begun,originalSha256=ProtectedAttempt.Hash(E(begun))};}
      else if(args[0]=="stage"&&args.Length==4)result=Stage(ledger,c,args[3],Console.OpenStandardInput());
      else if(args[0]=="define-staged"&&args.Length==4)result=DefineStaged(ledger,c,args[3]);
      else if(args[0]=="inspect"&&args.Length==3)result=ledger.Inspect();
      else if(args[0]=="current"&&args.Length==4)result=new{original=ledger.Original(args[3]),nowMs=BoundedWorker.MonotonicMilliseconds().ToString(CultureInfo.InvariantCulture)};
      else if(args[0]=="hold"&&args.Length==4)result=ledger.Hold(args[3]);
      else if(args[0]=="inventory"&&args.Length==3){ledger.RequireEmpty();result=new{empty=true,reservationMayRelease=false};}
      else throw new ArgumentException("Explicit one-shot native command required");
      Cleanup();Console.WriteLine(new JavaScriptSerializer{MaxJsonLength=131072,RecursionLimit=32}.Serialize(new{schema="native-rpc-manager-controller-result/2",command=args[0],value=result,elapsedMs=BoundedWorker.MonotonicMilliseconds()-Origin,rpcReady=false,providerOperationFenced=false,reservationMayRelease=false}));return 0;
     }
    }
   }catch(Exception e){Console.Error.WriteLine(e.GetType().Name+": "+e.Message);return 1;}
   finally{
    if(!CleanupAttempted&&Tasks.Count!=0)try{Cleanup();}catch(Exception cleanup){Console.Error.WriteLine("Native cleanup remains unconfirmed: "+cleanup.GetType().Name+": "+cleanup.Message);}
    foreach(var p in Peers)p.Dispose();
   }
  }
#endif
 }
}
