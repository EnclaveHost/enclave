// Explicit original-attempt bootstrap command. Public enrollment out, one signed
// owner offer in; never host keys, generic commands, retries, or readiness claims.
using System.Web.Script.Serialization;using System;using System.Collections.Generic;using System.Diagnostics;using System.Globalization;using System.IO;using System.Runtime.InteropServices;using System.Security.Cryptography;using System.Text;using System.Threading;
namespace Enclave.OwnedRpc {
 internal sealed class NativeBootstrapContract {
  internal readonly string Root,Path,Hash,Image;internal readonly string[] Fields;internal readonly long Origin,End;
  internal static readonly string[] ConfigurationKeys={"schema","managerConfigSha256","controllerPath","controllerSha256","workerPath","workerSha256","nodePath","nodeSha256","tpmPath","tpmSha256","keyPath","keySha256","sourceRoot","sourceSha256","expectedBase64","ekChainBase64"};
  internal static string S(object x){return NativeRpcManagerLedger.Text(x);}
  internal static void Configuration(Dictionary<string,object> c,string managerHash){
   if(c==null||c.Count!=ConfigurationKeys.Length)throw new ArgumentException("Exact native bootstrap configuration required");foreach(string n in ConfigurationKeys)if(!c.ContainsKey(n))throw new ArgumentException("Missing bootstrap field");
   if(S(c["schema"])!="native-rpc-bootstrap-controller/1"||S(c["managerConfigSha256"])!=managerHash)throw new InvalidOperationException("Bootstrap original manager differs");
   foreach(string n in new[]{"managerConfigSha256","controllerSha256","workerSha256","nodeSha256","tpmSha256","keySha256","sourceSha256"})NativeRpcManagerLedger.Hex(S(c[n]),64);
   foreach(string n in new[]{"controllerPath","workerPath","nodePath","tpmPath","keyPath","sourceRoot"})ProtectedAttempt.LocalPath(S(c[n]));
   foreach(var n in new[]{new[]{"expectedBase64","32768"},new[]{"ekChainBase64","65536"}}){string raw=S(c[n[0]]);byte[] b=Convert.FromBase64String(raw);if(b.Length==0||b.Length>Int32.Parse(n[1])||Convert.ToBase64String(b)!=raw)throw new ArgumentException("Canonical bounded bootstrap input required");}
  }
  internal static void Consume(NativeRpcManagerLedger ledger,string original,string configHash,NativeRpcDefinitionPlan p,byte[] start){
   ledger.Original(original);NativeRpcManagerLedger.Hex(configHash,64);
   string root=System.IO.Path.Combine(ledger.Root,"bootstrap");ledger.Files.NewDirectory(root);
   ledger.Files.Publish(System.IO.Path.Combine(root,"request.json"),NativeRpcManagerLedger.Encode(new{schema="native-rpc-bootstrap-request/1",original=original,config=configHash,plan=p.Digest,start=ProtectedAttempt.Hash(start)}));
  }
  internal NativeBootstrapContract(NativeControllerFiles files,NativeRpcDefinitionPlan p,string workersRoot,Dictionary<string,object> c,Dictionary<string,object> definition,Dictionary<string,object> started,long controllerEnd){
   byte[] image=files.Read(S(c["workerPath"]),262144,S(c["workerSha256"]));
   foreach(var item in new[]{new[]{"nodePath","nodeSha256","134217728"},new[]{"tpmPath","tpmSha256","1048576"},new[]{"keyPath","keySha256","16384"}}){using(var hash=SHA256.Create()){var input=files.Open(S(c[item[0]]),Int32.Parse(item[2]),false);string actual=BitConverter.ToString(hash.ComputeHash(input)).Replace("-","").ToLowerInvariant();if(actual!=S(c[item[1]]))throw new InvalidOperationException("Bootstrap dependency pin differs");}}
   string source=S(c["sourceRoot"]);string[] pins=Encoding.UTF8.GetString(files.Read(System.IO.Path.Combine(source,"bootstrap-source.txt"),65536,S(c["sourceSha256"]))).Split('\n');
   if(pins.Length!=ProtectedAttempt.BootstrapSourceNames.Length+1||pins[pins.Length-1]!="")throw new InvalidOperationException("Exact bootstrap source closure required");
   for(int i=0;i<ProtectedAttempt.BootstrapSourceNames.Length;i++){string[] row=pins[i].Split('|');if(row.Length!=2||row[0]!=ProtectedAttempt.BootstrapSourceNames[i])throw new InvalidOperationException("Bootstrap source name differs");NativeRpcManagerLedger.Hex(row[1],64);files.Read(System.IO.Path.Combine(source,row[0].Replace('/','\\')),262144,row[1]);}
   Origin=BoundedWorker.MonotonicMilliseconds();End=Math.Min(p.Deadline,Math.Min(Origin+25000,controllerEnd-1000));if(Origin<p.Origin||p.Deadline-Origin<125000||End-Origin<10000)throw new InvalidOperationException("Original owner/bootstrap windows do not fit");
   string nonce=Guid.NewGuid().ToString("N");Root=System.IO.Path.Combine(workersRoot,nonce);files.NewDirectory(Root);Image=System.IO.Path.Combine(Root,"entry.exe");files.Publish(Image,image);
   Fields=new[]{"owned-rpc-host-plan-v2",S(definition["vmGuid"]),p.Origin.ToString(CultureInfo.InvariantCulture),p.Deadline.ToString(CultureInfo.InvariantCulture),S(c["nodePath"]),S(c["nodeSha256"]),S(c["tpmPath"]),S(c["tpmSha256"]),S(c["keyPath"]),S(c["keySha256"]),source,S(c["sourceSha256"]),S(c["expectedBase64"]),S(c["ekChainBase64"]),S(definition["ownedReceipt"]),System.IO.Path.Combine(p.Root,"native-definition-plan.txt"),p.Digest,S(started["receipt"]),""};NativeBootstrapBinding.Shape(Fields);
   byte[] plan=Encoding.UTF8.GetBytes(String.Join("\n",Fields));files.Publish(System.IO.Path.Combine(Root,"bootstrap-plan.txt"),plan);
   byte[] raw=Encoding.UTF8.GetBytes(String.Join("\n",new[]{"owned-rpc-host-bootstrap-v1",nonce,p.Boot,Origin.ToString(CultureInfo.InvariantCulture),End.ToString(CultureInfo.InvariantCulture),S(c["workerSha256"]),"host-bootstrap-v1",ProtectedAttempt.Hash(plan),""}));Path=System.IO.Path.Combine(Root,"contract.txt");Hash=ProtectedAttempt.Hash(raw);files.Publish(Path,raw);
  }
 }
#if !NATIVE_RPC_BOOTSTRAP_FIXTURE
 public static class NativeRpcBootstrapControllerEntry {
  [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();[DllImport("kernel32.dll")]static extern bool TerminateProcess(IntPtr p,uint code);
  static long origin,end;static readonly HashSet<string> dispatched=new HashSet<string>();static string S(object x){return NativeRpcManagerLedger.Text(x);}
  static byte[] Encode(object value){return Encoding.UTF8.GetBytes(new JavaScriptSerializer{MaxJsonLength=131072,RecursionLimit=32}.Serialize(value));}
  static Dictionary<string,object> Decode(byte[] value){return NativeRpcManagerLedger.Obj(new JavaScriptSerializer{MaxJsonLength=131072,RecursionLimit=32}.DeserializeObject(new UTF8Encoding(false,true).GetString(value)));}
  static void Check(){long now=BoundedWorker.MonotonicMilliseconds();if(now<origin||now>=end)throw new TimeoutException("Original bootstrap command expired");}
  static void Arm(){var ack=new ManualResetEvent(false);new Thread(delegate(){ack.Set();while(BoundedWorker.MonotonicMilliseconds()<end)Thread.Sleep(5);if(!TerminateProcess(GetCurrentProcess(),125))Environment.FailFast("Bootstrap controller deadline");}){IsBackground=true}.Start();if(!ack.WaitOne(1000))throw new InvalidOperationException("Bootstrap command watchdog unarmed");}
  static string Quote(string x){if(x.IndexOfAny(new[]{'"','\r','\n'})>=0)throw new ArgumentException("Bootstrap argument");return "\""+x+"\"";}
  static void Schedule(NativeBootstrapContract c,string role){
   Check();long now=BoundedWorker.MonotonicMilliseconds();if(now<c.Origin||now-c.Origin>=5000||now>=c.End||(role!="owner"&&role!="observer"))throw new InvalidOperationException("Original bootstrap scheduling cutoff");
   string name="EnclaveNativeBootstrap-"+System.IO.Path.GetFileName(c.Root)+"-"+role;if(!dispatched.Add(name))throw new InvalidOperationException("Consumed bootstrap task");
   dynamic service=Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));service.Connect();dynamic folder=service.GetFolder("\\"),task=service.NewTask(0);
   task.RegistrationInfo.Description="One-shot original native RPC bootstrap";task.Principal.UserId="SYSTEM";task.Principal.LogonType=5;task.Principal.RunLevel=1;task.Settings.Enabled=true;task.Settings.AllowDemandStart=true;task.Settings.StartWhenAvailable=false;task.Settings.ExecutionTimeLimit="PT30S";task.Settings.MultipleInstances=2;task.Settings.DisallowStartIfOnBatteries=false;task.Settings.StopIfGoingOnBatteries=false;
   dynamic action=task.Actions.Create(0);action.Path=c.Image;action.WorkingDirectory=c.Root;action.Arguments=role+" "+Quote(c.Path)+" "+c.Hash+" "+c.Origin+" "+c.End;dynamic registered=folder.RegisterTaskDefinition(name,task,2,"SYSTEM",null,5,null);registered.Run(null);
  }
  static string Await(ProtectedAttempt lease,string name){string value;while((value=lease.ReadOptionalOnce(name))==null){Check();Thread.Sleep(5);}return value;}
  static byte[] Frame(Stream input){var header=new byte[4];Read(input,header);uint n=((uint)header[0]<<24)|((uint)header[1]<<16)|((uint)header[2]<<8)|header[3];if(n==0||n>131072)throw new InvalidOperationException("Owner offer frame bound");var raw=new byte[(int)n];Read(input,raw);if(input.ReadByte()!=-1)throw new InvalidOperationException("One owner offer only");return raw;}
  static void Read(Stream input,byte[] b){int at=0;while(at<b.Length){Check();int n=input.Read(b,at,b.Length-at);if(n==0)throw new EndOfStreamException("Owner response lost");at+=n;}}
  static void Emit(object value){Check();byte[] raw=Encode(value);if(raw.Length==0||raw.Length>131072)throw new InvalidOperationException("Public bootstrap frame bound");byte[] h={(byte)(raw.Length>>24),(byte)(raw.Length>>16),(byte)(raw.Length>>8),(byte)raw.Length};var output=Console.OpenStandardOutput();output.Write(h,0,4);output.Write(raw,0,raw.Length);output.Flush();Check();}
  static object Run(NativeControllerFiles files,NativeRpcManagerLedger ledger,Dictionary<string,object> manager,Dictionary<string,object> config,string configHash,string original){
   var a=ledger.Original(original);var p=NativeRpcControllerEntry.MakePlan(a,manager,NativeRpcManagerLedger.Decode(files.Read(System.IO.Path.Combine(ledger.Root,"launch.json"),65536,null)));
   var definition=NativeRpcManagerLedger.Decode(files.Read(System.IO.Path.Combine(ledger.Root,"result.json"),65536,null));byte[] startRaw=files.Read(System.IO.Path.Combine(ledger.Root,"start-result.json"),4096,null);
   var started=StartRecords.Parse(Encoding.UTF8.GetString(startRaw),new[]{"schema","plan","receipt","state","rpcReady","providerOperationFenced","reservationMayRelease"});
   if(S(started["schema"])!="native-rpc-start-worker-result/1"||S(started["plan"])!=p.Digest||S(started["state"])!="native-running-observed")throw new InvalidOperationException("Original completed native start required");foreach(string n in new[]{"rpcReady","providerOperationFenced","reservationMayRelease"})if(!(started[n] is bool)||(bool)started[n])throw new InvalidOperationException("Start cannot claim readiness");
   NativeBootstrapContract.Consume(ledger,original,configHash,p,startRaw);var c=new NativeBootstrapContract(files,p,S(manager["workersRoot"]),config,definition,started,end);
   string root=System.IO.Path.Combine(ledger.Root,"bootstrap");
   using(var lease=ProtectedAttempt.PinHostBootstrapController(c.Path,c.Hash))using(var pin=ProtectedAttempt.PinNativeBootstrapJournalController(lease,c.Fields)){
    pin.VerifyNativeBootstrapInputs(c.Fields);var journal=new NativeRpcCleanupJournal(pin);NativeBootstrapBinding.Proof(p,journal,c.Fields);NativeRpcControllerEntry.VerifyOwnedResult(p,definition,journal.Read("native-definition.system"),journal.Read("native-definition.owned"));
    string f,b;using(var primary=NativeLifecycleBinding.Peer(pin,false,out f))using(var backup=NativeLifecycleBinding.Peer(pin,true,out b)){
     if(primary.Identity.Split(',')[0]==backup.Identity.Split(',')[0])throw new InvalidOperationException("Distinct lifecycle keepers required");
     Action live=delegate{Check();lease.CheckDeadline();if(!primary.Alive||!backup.Alive)throw new InvalidOperationException("Original keeper lost");foreach(string n in new[]{"native-lifecycle.dispatch","native-lifecycle.backup-dispatch","native-lifecycle.stop","native-stop.intent"})if(journal.Read(n)!=null)throw new InvalidOperationException("Original lifecycle closing");};live();
     LegacyHandoff.Completion completed=null;try{WindowsStartAdmission.VerifyNativeBootstrap(pin,lease,ref completed);}finally{if(completed!=null)completed.Dispose();}live();
     ledger.Files.Publish(System.IO.Path.Combine(root,"dispatch.json"),NativeRpcManagerLedger.Encode(new{original=original,plan=p.Digest,contract=c.Path,hash=c.Hash,origin=c.Origin,deadline=c.End}));Schedule(c,"owner");Schedule(c,"observer");
     using(var owner=new NativeLifecyclePeer(Await(lease,"owner.consumed"),lease.Token,"owner",lease.Executable,0))using(var observer=new NativeLifecyclePeer(Await(lease,"observer.consumed"),lease.Token,"observer",lease.Executable,0)){
      live();lease.WriteOnce("admit",lease.Token);string enrolled=System.IO.Path.Combine(c.Root,"enrollment.json");while(!File.Exists(enrolled)){live();if(!owner.Alive||!observer.Alive)throw new InvalidOperationException("Bootstrap ended before enrollment");Thread.Sleep(5);}
      byte[] raw=lease.BootstrapRead(enrolled,131072,null);var enrollment=Decode(raw);if(enrollment.Count!=6||S(enrollment["token"])!=lease.Token||S(enrollment["vmGuid"])!=c.Fields[1]||S(enrollment["ownershipReceiptSha256"])!=c.Fields[14]||S(enrollment["originalOriginMs"])!=c.Fields[2]||S(enrollment["originalDeadlineMs"])!=c.Fields[3])throw new InvalidOperationException("Original public enrollment differs");live();
      ledger.Files.Publish(System.IO.Path.Combine(root,"enrollment.json"),raw);Emit(new{schema="native-rpc-bootstrap-enrollment/1",original=original,plan=p.Digest,enrollmentSha256=ProtectedAttempt.Hash(raw),enrollment=enrollment});
      byte[] offer=Frame(Console.OpenStandardInput());live();var response=Decode(offer);if(response.Count!=3||S(response["schema"])!="native-rpc-bootstrap-offer/1"||S(response["enrollmentSha256"])!=ProtectedAttempt.Hash(raw))throw new InvalidOperationException("Owner offer enrollment binding differs");var offered=NativeRpcManagerLedger.Obj(response["offer"]);if(offered.Count!=4||!offered.ContainsKey("proof")||!offered.ContainsKey("ownerServerDer")||!offered.ContainsKey("exportServerDer")||!offered.ContainsKey("policy"))throw new InvalidOperationException("Exact owner offer shape required");
      byte[] body=Encode(offered);ledger.Files.Publish(System.IO.Path.Combine(root,"offer.intent"),NativeRpcManagerLedger.Encode(new{enrollment=ProtectedAttempt.Hash(raw),offer=ProtectedAttempt.Hash(body)}));files.Publish(System.IO.Path.Combine(c.Root,"owner-offer.json"),body);
      foreach(var peer in new[]{owner,observer}){while(peer.Alive){live();Thread.Sleep(5);}if(peer.ExitCode!=0)throw new InvalidOperationException("Bootstrap exact process failed");}
      live();if(lease.ReadOnce("owner.result")!="bootstrap-acquisition-requested;rpc-ready=false;provider-fenced=false;reservation-release=false"||lease.ReadOnce("observer.result")!="exact-owner-death;job-empty;provider-fenced=false;reservation-release=false")throw new InvalidOperationException("Bootstrap exact cleanup missing");
      var observed=NativeRpcManagerLedger.Decode(lease.BootstrapRead(System.IO.Path.Combine(c.Root,"native-result.json"),131072,null));if(observed.Count!=5||S(observed["token"])!=lease.Token||!(observed["acquisitionRequested"] is bool)||!(bool)observed["acquisitionRequested"])throw new InvalidOperationException("Bootstrap request result differs");foreach(string n in new[]{"rpcReady","providerOperationFenced","reservationMayRelease"})if(!(observed[n] is bool)||(bool)observed[n])throw new InvalidOperationException("Bootstrap cannot grant serving/release");
      object result=new{schema="native-rpc-bootstrap-result/1",original=original,plan=p.Digest,enrollmentSha256=ProtectedAttempt.Hash(raw),acquisitionRequested=true,rpcReady=false,providerOperationFenced=false,reservationMayRelease=false};ledger.Files.Publish(System.IO.Path.Combine(root,"result.json"),NativeRpcManagerLedger.Encode(result));return result;
     }
    }
   }
  }
  public static int Main(string[] args){origin=BoundedWorker.MonotonicMilliseconds();end=origin+30000;try{Arm();BoundedWorker.EnterSupervisorEnvelope(128UL*1048576);ProtectedAttempt.RequireAdministrator();if(args.Length!=6||args[0]!="bootstrap-staged")throw new ArgumentException("Explicit bootstrap command required");using(var files=new NativeControllerFiles(Check)){
   var manager=NativeRpcManagerLedger.Decode(files.Read(args[1],65536,args[2]));NativeRpcControllerEntry.ValidateConfiguration(manager);if(S(manager["schema"])!="native-rpc-manager-controller/2")throw new InvalidOperationException("Original v2 manager required");
   var config=Decode(files.Read(args[4],131072,args[5]));NativeBootstrapContract.Configuration(config,args[2]);using(var self=Process.GetCurrentProcess()){if(!String.Equals(self.MainModule.FileName,S(config["controllerPath"]),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Pinned bootstrap controller path differs");files.Read(S(config["controllerPath"]),262144,S(config["controllerSha256"]));}
   using(var ledger=new NativeRpcManagerLedger(S(manager["ledgerRoot"]),args[2],Check))Emit(Run(files,ledger,manager,config,args[5],args[3]));return 0;
  }}catch(Exception e){Console.Error.WriteLine(e.GetType().Name+": "+e.Message);return 1;}}
  // No Stop/Delete/retry on controller loss; original owner/observer deadlines
  // terminate this phase, and original VM keepers remain independently owned.
 }
#endif
}
