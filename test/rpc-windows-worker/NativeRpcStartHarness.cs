using System;
using System.Collections.Generic;
using System.Collections;
using System.Web.Script.Serialization;
using System.IO;
using System.Threading;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using Enclave.OwnedRpc;
public static class NativeRpcStartHarness {
 static int count;
 [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")]static extern bool TerminateProcess(IntPtr p,uint code);
 static void Check(bool ok){if(!ok)throw new Exception("Assertion");}
 static void Refuse(Action f){bool refused=false;try{f();}catch{refused=true;}Check(refused);}
 static void Test(string name,Action f){f();count++;Console.WriteLine("PASS "+name);}
 const string Id="12345678-1234-1234-1234-123456789012";
 static string SystemRef {get{return "Msvm_ComputerSystem.Name=\""+Id+"\"";}}
 static string JobRef {get{return HyperVStartProvider.ReferenceForId("definition-fixture");}}
 static NativeRpcDefinitionPlan Plan(){string n=new string('a',32);return PlanAt(n,new string('b',32),@"C:\OwnedRpcFixture\"+n,1000,new string('d',64));}
 static NativeRpcDefinitionPlan PlanAt(string n,string boot,string root,long origin,string worker){return new NativeRpcDefinitionPlan(n,boot,new string('c',32),"rpc"+new string('d',32),"0x"+new string('e',64),new string('f',64),new string('a',64),new string('b',64),new string('c',64),new string('d',64),new string('e',64),root,origin,origin+900000,new string('f',64),new string('a',64),worker);}
 sealed class Journal:IStartJournal {
  public readonly Dictionary<string,string> Data=new Dictionary<string,string>();public string Fail;
  public void WriteOnce(string n,string v){if(n==Fail)throw new IOException("Injected durable write failure");if(Data.ContainsKey(n))throw new IOException("Consumed");Data.Add(n,v);}
  public string Read(string n){string v;return Data.TryGetValue(n,out v)?v:null;}
 }
 sealed class Runtime:INativeRpcDefinitionRuntime {
  public long Clock=2000;public bool Deny,ObservationDenied;public int Before,Reads;
  public long Now{get{return Clock;}}
  public void Check(NativeRpcDefinitionPlan p,bool mutation){if(mutation){Before++;if(Deny)throw new Exception("Admission refused");}else{Reads++;if(ObservationDenied)throw new Exception("Reader expired");}}

 }
 sealed class Provider:INativeRpcDefinitionProvider {
  public readonly Journal Journal;public int Defines,Reads,Associations,Off;public bool Lose,WrongOff,RecycledAfterAssociation;
  public ushort State=7,Error;public uint Runs=1;public string Submitted="20261031070000.000000+000";
  public NativeDefinitionResponse Response=new NativeDefinitionResponse(0,null,SystemRef);
  public Provider(Journal j){Journal=j;}
  public NativeDefinitionResponse Define(NativeRpcDefinitionPlan p){Defines++;Check(Journal.Read("native-definition.intent")==p.Encode()&&Journal.Read("native-definition.native")!=null);if(Lose)throw new IOException("Lost response");return Response;}
  public StartJob ReadJob(string r){Reads++;Check(Journal.Read("native-definition.receipt")!=null&&r==JobRef);return new StartJob(r,"definition-fixture",Submitted,State,Error,Runs);}
  public string ReadResultingSystem(string r){Associations++;Check(Journal.Read("native-definition.terminal")!=null);if(RecycledAfterAssociation)Submitted="20261031070100.000000+000";return SystemRef;}
  public void RequireOwnedOff(NativeRpcDefinitionPlan p,string guid){Off++;Check(Journal.Read("native-definition.system")!=null&&guid==Id);if(WrongOff)throw new Exception("Owned Off readback differs");}
 }
 sealed class Case {public NativeRpcDefinitionPlan P=Plan();public Journal J=new Journal();public Runtime R=new Runtime();public Provider V;public Case(){V=new Provider(J);NativeRpcDefinition.Prepare(P,J);}public NativeRpcDefinitionOutcome Run(){return NativeRpcDefinition.Submit(P,J,V,R);}public NativeRpcDefinitionOutcome Read(){return NativeRpcDefinition.Reconcile(P,J,V,R);}}
 static byte[] fixtureImage;
 static void DirectoryNew(string path){var a=new DirectorySecurity();a.SetOwner(new SecurityIdentifier("S-1-5-32-544"));a.SetAccessRuleProtection(true,false);foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})a.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));Directory.CreateDirectory(path,a);}
 static void Put(string path,byte[] bytes){var a=new FileSecurity();a.SetOwner(new SecurityIdentifier("S-1-5-32-544"));a.SetAccessRuleProtection(true,false);foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})a.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));using(var f=new FileStream(path,FileMode.CreateNew,FileSystemRights.WriteData,FileShare.None,4096,FileOptions.WriteThrough,a)){f.Write(bytes,0,bytes.Length);f.Flush(true);}}

 sealed class ProtectedCase {
  public readonly string Contract,Hash,PlanPath,PlanHash;public readonly NativeRpcDefinitionPlan P;
  public ProtectedCase(string operation="define",bool wrongWorker=false){
   string drive=Path.GetPathRoot(Environment.SystemDirectory),n=Guid.NewGuid().ToString("N"),id=Guid.NewGuid().ToString("N"),boot=ProtectedAttempt.CurrentBoot();
   string parent=Path.Combine(drive,"rpc-native-ci-"+n),root=Path.Combine(parent,n);DirectoryNew(parent);DirectoryNew(root);Put(Path.Combine(root,"entry.exe"),fixtureImage);
   string vp=Path.Combine(drive,"rpc-native-plan-"+id),vr=Path.Combine(vp,id);DirectoryNew(vp);DirectoryNew(vr);long now=BoundedWorker.MonotonicMilliseconds();
   P=PlanAt(id,boot,vr,now,wrongWorker?new string('e',64):ProtectedAttempt.Hash(fixtureImage));
   PlanPath=Path.Combine(vr,"native-definition-plan.txt");byte[] bytes=Encoding.UTF8.GetBytes(P.Encode());PlanHash=ProtectedAttempt.Hash(bytes);Put(PlanPath,bytes);
   bytes=Encoding.UTF8.GetBytes("owned-native-rpc-definition-worker-v1\n"+n+"\n"+boot+"\n"+now+"\n"+(now+20000)+"\n"+ProtectedAttempt.Hash(fixtureImage)+"\n"+operation+"\n"+PlanPath+"\n"+PlanHash+"\n");
   Contract=Path.Combine(root,"contract.txt");Hash=ProtectedAttempt.Hash(bytes);Put(Contract,bytes);
  }
  public ProtectedAttempt Lease(){return ProtectedAttempt.PinNativeDefinitionController(Contract,Hash);}
 }
 sealed class Security:INativeRpcSecurityProvider {
  internal Journal J;internal int Calls,Reads,Off,Checks;internal bool Lose,WrongSecurity,WrongOff;internal ushort State=7,Error;internal uint Runs=1;internal string Time="20261101070000.000000+000";
  internal NativeDefinitionResponse Response=new NativeDefinitionResponse(0,null,null);
  internal Security(Journal j){J=j;}
  public NativeDefinitionResponse ConfigureSecurity(NativeRpcDefinitionPlan p,string guid,string intent){Check(guid==Id&&J.Read("native-definition.owned")!=null&&J.Read("native-security.native")==intent);J.WriteOnce("native-security.invoke",intent);Calls++;if(Lose)throw new IOException("Lost provider response");return Response;}
  public StartJob ReadJob(string reference){Reads++;Check(reference==JobRef&&J.Read("native-security.receipt")!=null);return new StartJob(reference,"definition-fixture",Time,State,Error,Runs);}
  public void RequireOwnedOff(NativeRpcDefinitionPlan p,string guid){Off++;Check(guid==Id);if(WrongOff)throw new IOException("Owned VM changed");}
  public void RequireSecurity(NativeRpcDefinitionPlan p,string guid){Checks++;NativeRpcStartHarness.Check(guid==Id);if(WrongSecurity)throw new IOException("Security differs");}
 }
 sealed class SecurityCase {
  internal Case C=new Case();internal Security V;internal SecurityCase(){C.Run();V=new Security(C.J);}
  internal string Submit(){return NativeRpcSecurity.Submit(C.P,C.J,V,C.R);}
  internal string Read(){return NativeRpcSecurity.Reconcile(C.P,C.J,V,C.R);}
 }

 static string Ref(string step){return HyperVNativeRpcDefinition.OpticalClass(step)+".InstanceID=\"fixture-"+step+"\"";}
 sealed class Optical:INativeRpcOpticalProvider {
  internal readonly Journal J;internal readonly Runtime R;internal readonly Dictionary<string,string> Resources=new Dictionary<string,string>();internal string Special,WrongResource,Time="20261101172400.000000+000";internal int Calls,Reads,Verifies,Complete;internal bool Lose,Async,Missing,WrongFinal,Expire;internal uint Code;internal ushort State=7,Error;
  internal Optical(Journal j,Runtime r){J=j;R=r;}
  public NativeOpticalResponse Attach(NativeRpcDefinitionPlan p,string guid,string step,IDictionary<string,string> prior,string intent){
   Calls++;Check(guid==Id&&J.Read("native-optical."+step+".submit")==intent&&J.Read("native-optical."+step+".receipt")==null&&prior.Count==Resources.Count);
   if(step==Special&&Lose)throw new IOException("Lost attachment response");if(Expire)R.Clock=p.Deadline;
   uint code=step==Special&&Code!=0?Code:Async?4096U:0U;
   return new NativeOpticalResponse(code,code==4096?JobRef:null,step==Special&&(Missing||Code!=0)?null:step==Special&&WrongResource!=null?WrongResource:Ref(step));
  }
  public StartJob ReadJob(string reference){Reads++;Check(reference==JobRef);bool saved=false;foreach(string step in NativeRpcOptical.Steps)if(J.Read("native-optical."+step+".receipt")!=null)saved=true;Check(saved);return new StartJob(reference,"definition-fixture",Time,State,Error,1);}
  public void VerifyOptical(NativeRpcDefinitionPlan p,string guid,string step,string resource,IDictionary<string,string> prior){Verifies++;Check(J.Read("native-optical."+step+".receipt")!=null&&guid==Id&&resource==Ref(step));if(!Resources.ContainsKey(step))Resources.Add(step,resource);}
  public void VerifyOpticalComplete(NativeRpcDefinitionPlan p,string guid,IDictionary<string,string> resources){Complete++;Check(guid==Id&&resources.Count==5);if(WrongFinal)throw new Exception("Actual topology changed");}
 }
 sealed class OpticalCase {
  internal readonly SecurityCase S=new SecurityCase();internal readonly Optical V;
  internal OpticalCase(){S.Submit();V=new Optical(S.C.J,S.C.R);}
  internal string Run(bool readOnly=false){return NativeRpcOptical.Configure(S.C.P,S.C.J,V,S.C.R,readOnly);}
 }
 static Dictionary<string,string> All(){var d=new Dictionary<string,string>();foreach(string step in NativeRpcOptical.Steps)d.Add(step,Ref(step));return d;}
 static Dictionary<string,Dictionary<string,object>> Inventory(NativeRpcDefinitionPlan p,IDictionary<string,string> all){var d=new Dictionary<string,Dictionary<string,object>>();foreach(var x in all)d.Add(x.Value,HyperVNativeRpcDefinition.OpticalValues(p,x.Key,all));return d;}
 const string Sid="S-1-5-83-1-123-456-789-1011";
 sealed class Access:INativeRpcReadAccess {
  internal Journal J;internal Runtime R;internal NativeRpcDefinitionPlan P;internal string Account=Sid,Fail;internal int Applies,Observes,Captures;internal bool Expire,Changed;
  internal Access(SecurityCase c){J=c.C.J;R=c.C.R;P=c.C.P;}
  public string Resolve(string guid){Check(guid==Id);return Account;}
  public string Capture(string name,string sid){Captures++;return name+",00000001:0000000000000002:0000000000000003,1,"+new string('a',64)+","+new string('b',64);}
  public void Apply(string name,string sid,string snapshot){Check(J.Read("native-read.submit")==NativeRpcDefinitionPlan.Hash(J.Read("native-read.intent"))&&J.Read("native-read.receipt")==null);Applies++;if(name==Fail)throw new IOException("Injected failed grant");if(Expire)R.Clock=P.Deadline;}
  public void Observe(string name,string sid,string snapshot){Observes++;if(Changed)throw new IOException("Changed ACL or file identity");}
 }

 static NativeRpcDevice Device(string cls,ushort type,string subtype,string key,string[] host=null,string[] connection=null,bool debugger=false){return new NativeRpcDevice(cls+".InstanceID=\""+key+"\"",cls,type,"Microsoft:Hyper-V:"+subtype,host,connection,debugger);}
 static List<NativeRpcDevice> Devices(NativeRpcDefinitionPlan p){var a=new List<NativeRpcDevice>{Device("Msvm_ProcessorSettingData",3,"Processor","cpu"),Device("Msvm_MemorySettingData",4,"Memory","memory")};foreach(string step in NativeRpcOptical.Steps){var v=HyperVNativeRpcDefinition.OpticalValues(p,step,All());a.Add(new NativeRpcDevice(Ref(step),HyperVNativeRpcDefinition.OpticalClass(step),(ushort)v["ResourceType"],(string)v["ResourceSubType"],v.ContainsKey("HostResource")?(string[])v["HostResource"]:null,null));}return a;}
 sealed class DeviceReader:INativeRpcDeviceProvider {internal Runtime R;internal List<NativeRpcDevice> Rows;internal int Reads,Delay;internal bool Lost;public IList<NativeRpcDevice> ReadDevices(NativeRpcDefinitionPlan p,string guid){Check(guid==Id);Reads++;R.Clock+=Delay;if(Lost)throw new IOException("Unavailable inventory");return Rows;}}
 sealed class DeviceCase {internal OpticalCase O=new OpticalCase();internal DeviceReader V;internal DeviceCase(){O.Run();NativeRpcReadGrant.Run(O.S.C.P,O.S.C.J,O.S.C.R,new Access(O.S),false);V=new DeviceReader{R=O.S.C.R,Rows=Devices(O.S.C.P)};}internal string Run(){return NativeRpcDevicePolicy.Observe(O.S.C.P,O.S.C.J,V,O.S.C.R);}internal string Proof(){return NativeRpcDevicePolicy.VerifyCompleted(O.S.C.P,O.S.C.J);}}

 sealed class StartRuntime:INativeRpcStartRuntime,INativeRpcObservationWait {
  internal Runtime Base;internal Journal J;internal int Checks,Waits;internal bool Deny,Change,Wait=true;internal string Binding=new string('7',64);
  public long Now{get{return Base.Now;}}
  public void Check(NativeRpcDefinitionPlan p,bool mutation){Base.Check(p,mutation);}
  public string CheckStart(NativeRpcDefinitionPlan p,string guid){Checks++;NativeRpcStartHarness.Check(guid==Id);if(Deny)throw new Exception("Independent VM lifecycle owner lost");return Change&&J.Read("native-start.submit")!=null?new string('8',64):Binding;}
  public bool WaitForNextObservation(NativeRpcDefinitionPlan p){NativeRpcStartHarness.Check(J.Read("native-start.job")!=null);Waits++;if(!Wait)return false;Base.Clock+=25;return true;}
 }
 sealed class StartProvider:INativeRpcStartProvider {
  internal DeviceCase D;internal StartRuntime R;internal Journal J;internal int Starts,Reads,Running,RunDelay;internal bool Lose,Off,WrongIdentity,Recycle;
  internal uint Code;internal ushort State=7,Error;internal uint Runs=1;internal string ExtraJob;internal Queue<ushort> States=new Queue<ushort>();
  public IList<NativeRpcDevice> ReadDevices(NativeRpcDefinitionPlan p,string guid){return D.V.ReadDevices(p,guid);}
  public StartResponse StartNative(NativeRpcDefinitionPlan p,string guid,string intent){
   Check(guid==Id&&J.Read("native-start.submit")==intent&&NativeRpcDefinitionPlan.Hash(J.Read("native-start.intent"))==intent&&J.Read("native-start.receipt")==null&&D.V.Reads>0);
   J.WriteOnce("native-start.invoke",intent);Starts++;if(Lose)throw new IOException("Lost response");return new StartResponse(Code,ExtraJob??(Code==4096?JobRef:null));
  }
  public StartJob ReadJob(string reference){Reads++;Check(J.Read("native-start.receipt")!=null&&reference==JobRef);return new StartJob(reference,WrongIdentity?"foreign": "definition-fixture",Recycle&&Reads>1?"20261101190001.000000+000":"20261101190000.000000+000",States.Count==0?State:States.Dequeue(),Error,Runs);}
  public void RequireRunning(NativeRpcDefinitionPlan p,string guid){Running++;Check(guid==Id&&J.Read("native-start.receipt")!=null);R.Base.Clock+=RunDelay;if(Off)throw new Exception("Provider job succeeded but VM Off");}
 }
 sealed class StartCase {
  internal DeviceCase D=new DeviceCase();internal StartRuntime R;internal StartProvider V;
  internal NativeRpcDefinitionPlan P{get{return D.O.S.C.P;}}internal Journal J{get{return D.O.S.C.J;}}
  internal StartCase(){D.Run();R=new StartRuntime{Base=D.O.S.C.R,J=J};V=new StartProvider{D=D,R=R,J=J};}
  internal string Submit(){return NativeRpcStart.Submit(P,J,V,R);}
  internal string Read(){return NativeRpcStart.Reconcile(P,J,V,R);}
  internal string Proof(){return NativeRpcStart.VerifyCompleted(P,J);}
 }
 public static int Main(string[] args){try{
  if(args.Length!=0)throw new ArgumentException("No fixture selection");
  var timer=new Timer(delegate{TerminateProcess(GetCurrentProcess(),125);},null,20000,Timeout.Infinite);BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);fixtureImage=File.ReadAllBytes(System.Reflection.Assembly.GetExecutingAssembly().Location);
  Test("synchronous one-shot start requires fresh original configuration and separate authority",()=>{var c=new StartCase();Check(c.Submit()==c.Proof()&&c.V.Starts==1&&c.V.Reads==0&&c.V.Running==1&&c.D.V.Reads==2);string raw=c.J.Read("native-start.observed");Check(raw.Contains("\"rpcReady\":false")&&raw.Contains("\"providerOperationFenced\":false")&&raw.Contains("\"reservationMayRelease\":false"));Refuse(()=>c.Submit());Check(c.V.Starts==1);});
  Test("asynchronous exact receipt and incarnation precede every paced observation",()=>{var c=new StartCase();c.V.Code=4096;c.V.States.Enqueue(2);c.V.States.Enqueue(4);c.V.States.Enqueue(7);Check(c.Submit()==c.Proof()&&c.V.Starts==1&&c.V.Reads==3&&c.R.Waits==2&&c.V.Running==1);Check(c.Read()==c.Proof()&&c.V.Reads==3&&c.V.Starts==1);});
  Test("read-only pending reconciliation settles saved job without renewed start authority",()=>{var c=new StartCase();c.V.Code=4096;c.V.State=4;c.R.Wait=false;Check(c.Submit()==null);c.V.State=7;c.R.Deny=true;c.R.Base.Deny=true;Check(c.Read()==c.Proof()&&c.V.Starts==1);});
  Test("return zero and successful job do not prove VM running",()=>{foreach(uint code in new[]{0U,4096U}){var c=new StartCase();c.V.Code=code;c.V.Off=true;Refuse(()=>c.Submit());Check(c.J.Read("native-start.receipt")!=null&&c.J.Read("native-start.observed")==null);Refuse(()=>c.Proof());Refuse(()=>c.Submit());Check(c.V.Starts==1);}});
  Test("lost response remains consumed held and cannot be submitted again",()=>{var c=new StartCase();c.V.Lose=true;Refuse(()=>c.Submit());Check(c.Read()==null&&c.V.Reads==0&&c.J.Read("native-start.invoke")!=null);Refuse(()=>c.Submit());Check(c.V.Starts==1);});
  Test("failed response persistence prevents all followup observation",()=>{var c=new StartCase();c.V.Code=4096;c.J.Fail="native-start.receipt";Refuse(()=>c.Submit());Check(c.V.Reads==0&&c.V.Running==0&&c.Read()==null);Refuse(()=>c.Submit());Check(c.V.Starts==1);});
  Test("unexpected response job or refused code cannot claim settlement",()=>{var c=new StartCase();c.V.Code=32775;Check(c.Submit()==null&&c.V.Running==0);c=new StartCase();c.V.ExtraJob=JobRef;Refuse(()=>c.Submit());Check(c.J.Read("native-start.receipt")==null);c=new StartCase();c.V.Code=4096;c.V.ExtraJob=@"\\foreign\root\virtualization\v2:Msvm_ConcreteJob.InstanceID=""x""";Refuse(()=>c.Submit());Check(c.V.Reads==0);});
  Test("changed exact job incarnation refuses before completion",()=>{var c=new StartCase();c.V.Code=4096;c.V.States.Enqueue(4);c.V.Recycle=true;Refuse(()=>c.Submit());Check(c.V.Reads==2&&c.V.Starts==1&&c.V.Running==0&&c.J.Read("native-start.terminal")==null);});
  Test("job error recurrence abnormal and unknown states never authorize running readback",()=>{foreach(ushort state in new ushort[]{5,8,9,10,11,99}){var c=new StartCase();c.V.Code=4096;c.V.State=state;Check(c.Submit()==null&&c.R.Waits==0&&c.V.Running==0);}foreach(uint runs in new[]{0U,2U}){var c=new StartCase();c.V.Code=4096;c.V.Runs=runs;Check(c.Submit()==null&&c.V.Running==0);}var bad=new StartCase();bad.V.Code=4096;bad.V.Error=32768;Check(bad.Submit()==null&&bad.V.Running==0);Refuse(()=>bad.Proof());});
  Test("different job InstanceID refuses despite same supplied reference",()=>{var c=new StartCase();c.V.Code=4096;c.V.WrongIdentity=true;Refuse(()=>c.Submit());Check(c.J.Read("native-start.job")==null&&c.V.Running==0);});
  Test("definition-only runtime and missing or zero lifecycle authority refuse before intent",()=>{var c=new StartCase();Refuse(()=>NativeRpcStart.Submit(c.P,c.J,c.V,c.D.O.S.C.R));Check(c.J.Read("native-start.intent")==null);foreach(string binding in new[]{null,"",new string('0',64),"bad"}){c=new StartCase();c.R.Binding=binding;Refuse(()=>c.Submit());Check(c.V.Starts==0&&c.J.Read("native-start.intent")==null);}Check(!typeof(INativeRpcStartRuntime).IsAssignableFrom(typeof(NativeRpcWorkerRuntime)));});
  Test("authority loss or changed binding after consumption never reaches provider",()=>{var c=new StartCase();c.R.Deny=true;Refuse(()=>c.Submit());Check(c.V.Starts==0&&c.J.Read("native-start.intent")==null);c=new StartCase();c.R.Change=true;Refuse(()=>c.Submit());Check(c.J.Read("native-start.submit")!=null&&c.V.Starts==0);Refuse(()=>c.Submit());Check(c.V.Starts==0);});
  Test("fresh device observation rejects stale rollback and newly attached network",()=>{foreach(int delay in new[]{4001,-1}){var c=new StartCase();c.D.V.Delay=delay;Refuse(()=>c.Submit());Check(c.V.Starts==0);}var changed=new StartCase();changed.D.V.Rows.Add(Device("Msvm_SyntheticEthernetPortSettingData",10,"Synthetic Ethernet Port","nic"));Refuse(()=>changed.Submit());Check(changed.V.Starts==0);});
  Test("original deadline and admission refusal prevent native submission",()=>{var c=new StartCase();c.R.Base.Clock=c.P.Deadline;Refuse(()=>c.Submit());Check(c.V.Starts==0);c=new StartCase();c.R.Base.Deny=true;Refuse(()=>c.Submit());Check(c.V.Starts==0);});
  Test("missing prior owner security grant optical or device receipt cannot authorize start",()=>{foreach(string name in new[]{"native-definition.owned","native-security.observed","native-read.receipt","native-optical.observed"}){var c=new StartCase();c.J.Data.Remove(name);Refuse(()=>c.Submit());Check(c.V.Starts==0);}});
  Test("running observation four second boundary expiry and rollback are enforced",()=>{var ok=new StartCase();ok.V.RunDelay=4000;Check(ok.Submit()!=null);foreach(int delay in new[]{4001,-1,900000}){var c=new StartCase();c.V.RunDelay=delay;Refuse(()=>c.Submit());Check(c.J.Read("native-start.observed")==null&&c.V.Starts==1);}});
  Test("tampered proof or lost running receipt cannot authenticate completion",()=>{var c=new StartCase();c.J.Fail="native-start.observed";Refuse(()=>c.Submit());Refuse(()=>c.Proof());c=new StartCase();c.Submit();c.J.Data["native-start.observed"]=c.J.Data["native-start.observed"].Replace("19456","1");Refuse(()=>c.Proof());});
  Test("completed proof authenticates historical evidence but fresh observation still refuses stopped VM",()=>{var c=new StartCase();string proof=c.Submit();c.V.Off=true;Check(c.Proof()==proof);Refuse(()=>c.Read());Check(c.V.Starts==1);});
  Test("actual protected definition and reconcile leases reject every native start write",()=>{foreach(string operation in new[]{"define","reconcile"}){var c=new ProtectedCase(operation);using(var lease=c.Lease())using(var plan=ProtectedAttempt.PinNativeDefinitionJournalController(c.PlanPath,c.PlanHash,lease)){var j=new NativeRpcDefinitionJournal(plan);foreach(string name in new[]{"native-start.intent","native-start.submit","native-start.invoke","native-start.receipt","native-start.job","native-start.terminal","native-start.observed"})Refuse(()=>j.WriteOnce(name,"unadmitted"));Check(!File.Exists(Path.Combine(c.P.Root,"native-start.intent")));}});
  Console.WriteLine("COMPLETE "+count+" PASS; start provider and lifecycle authority mocked; no VM or RPC readiness");GC.KeepAlive(timer);return 0;
 }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
