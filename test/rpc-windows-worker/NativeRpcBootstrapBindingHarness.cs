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
public static class NativeRpcBootstrapBindingHarness {
 static int count;
 [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")]static extern bool TerminateProcess(IntPtr p,uint code);
 static void Check(bool ok){if(!ok)throw new Exception("Assertion");}
 static void Refuse(Action f){bool refused=false;try{f();}catch{refused=true;}Check(refused);}
 static void Test(string name,Action f){f();count++;Console.WriteLine("PASS "+name);}
 const string Id="12345678-1234-1234-1234-123456789012";
 static string SystemRef {get{return "Msvm_ComputerSystem.Name=\""+Id+"\"";}}
 static string JobRef {get{return HyperVStartProvider.ReferenceForId("definition-fixture");}}
 static NativeRpcDefinitionPlan Fixed;static long FixtureClock=2000;
 static NativeRpcDefinitionPlan Plan(){if(Fixed!=null)return Fixed;string n=new string('a',32);return PlanAt(n,new string('b',32),@"C:\OwnedRpcFixture\"+n,1000,new string('d',64));}
 static NativeRpcDefinitionPlan PlanAt(string n,string boot,string root,long origin,string worker){return new NativeRpcDefinitionPlan(n,boot,new string('c',32),"rpc"+new string('d',32),"0x"+new string('e',64),new string('f',64),new string('a',64),new string('b',64),new string('c',64),new string('d',64),new string('e',64),root,origin,origin+900000,new string('f',64),new string('a',64),worker);}
 sealed class Journal:IStartJournal {
  public readonly Dictionary<string,string> Data=new Dictionary<string,string>();public string Fail;
  public void WriteOnce(string n,string v){if(n==Fail)throw new IOException("Injected durable write failure");if(Data.ContainsKey(n))throw new IOException("Consumed");Data.Add(n,v);}
  public string Read(string n){string v;return Data.TryGetValue(n,out v)?v:null;}
 }
 sealed class Runtime:INativeRpcDefinitionRuntime {
  public long Clock=FixtureClock;public bool Deny,ObservationDenied;public int Before,Reads;
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
  public void RequireSecurity(NativeRpcDefinitionPlan p,string guid){Checks++;NativeRpcBootstrapBindingHarness.Check(guid==Id);if(WrongSecurity)throw new IOException("Security differs");}
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
  public string CheckStart(NativeRpcDefinitionPlan p,string guid){Checks++;NativeRpcBootstrapBindingHarness.Check(guid==Id);if(Deny)throw new Exception("Independent VM lifecycle owner lost");return Change&&J.Read("native-start.submit")!=null?new string('8',64):Binding;}
  public bool WaitForNextObservation(NativeRpcDefinitionPlan p){NativeRpcBootstrapBindingHarness.Check(J.Read("native-start.job")!=null);Waits++;if(!Wait)return false;Base.Clock+=25;return true;}
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
  internal string Submit(){NativeRpcStart.Prepare(P,J,V,R);return NativeRpcStart.Submit(P,J,V,R);}
  internal string Read(){return NativeRpcStart.Reconcile(P,J,V,R);}
  internal string Proof(){return NativeRpcStart.VerifyCompleted(P,J);}
 }

 static string H(char c){return new string(c,64);}static byte[] B(string s){return Encoding.UTF8.GetBytes(s);}static string Text(object x){return StartRecords.Text(x);}
 sealed class BootstrapFixture {
  internal readonly string Contract,Hash,Root;internal readonly string[] Fields;internal readonly StartCase Start;internal readonly byte[] Record,Bundle;internal readonly Dictionary<string,object> Expected;
  internal BootstrapFixture(){
   string n=Guid.NewGuid().ToString("N"),a=Guid.NewGuid().ToString("N"),home=Path.Combine(Path.GetPathRoot(Environment.SystemDirectory),"rpc-bootstrap-bind-"+n);DirectoryNew(home);Root=Path.Combine(home,n);DirectoryNew(Root);string original=Path.Combine(home,a);DirectoryNew(original);Put(Path.Combine(Root,"entry.exe"),fixtureImage);long now=BoundedWorker.MonotonicMilliseconds();FixtureClock=now+1;
   string deployment="0x"+H('e'),profile=H('c'),runtime=H('b');
   Record=B(StartRecords.Encode(new Dictionary<string,object>{{"derivation","enclave-catalog-bundle/9"},{"catalog",new Dictionary<string,object>()},{"cid","fixture"},{"runtimeId",runtime},{"policy",new Dictionary<string,object>()},{"http",8000},{"ports",new string[0]},{"configBase64","e30="},{"secretDeployment",deployment},{"rpc",new Dictionary<string,object>{{"profile","ethereum-base-rpc-v1"},{"profileSha256",profile},{"l1VolumeId",H('1')},{"baseVolumeId",H('2')}}}}));
   byte[] manifest=B("{\"fixture\":true}"),magic=B("ENCLAVE-BUNDLE/1\n");Bundle=new byte[magic.Length+8+manifest.Length+1];Buffer.BlockCopy(magic,0,Bundle,0,magic.Length);Buffer.BlockCopy(BitConverter.GetBytes(manifest.Length),0,Bundle,magic.Length,4);Buffer.BlockCopy(manifest,0,Bundle,magic.Length+4,manifest.Length);Buffer.BlockCopy(BitConverter.GetBytes(1),0,Bundle,magic.Length+4+manifest.Length,4);
   Fixed=new NativeRpcDefinitionPlan(a,ProtectedAttempt.CurrentBoot(),new string('c',32),"rpc"+new string('d',32),deployment,ProtectedAttempt.Hash(Bundle),ProtectedAttempt.Hash(Record),runtime,profile,H('d'),H('e'),original,now,now+900000,H('f'),H('a'),ProtectedAttempt.Hash(fixtureImage));
   Start=new StartCase();var p=Start.P;Start.J.WriteOnce("native-lifecycle.armed","original-primary-fixture");Start.J.WriteOnce("native-lifecycle.backup-armed","original-backup-fixture");Start.R.Binding=NativeRpcDefinitionPlan.Hash("original-primary-fixture\noriginal-backup-fixture");NativeRpcStart.Prepare(p,Start.J,Start.V,Start.R);
   string workers=StartRecords.Encode(new Dictionary<string,object>{{"schema","native-rpc-start-workers/1"},{"plan",p.Digest},{"intent",NativeRpcDefinitionPlan.Hash(Start.J.Read("native-start.intent"))},{"contractPath",Path.Combine(Root,"start-contract.txt")},{"contractHash",H('a')},{"owner","owner-fixture"},{"observer","observer-fixture"},{"child","child-fixture"}});Start.J.WriteOnce("native-start.workers",workers);foreach(string k in new[]{"native-lifecycle.bound","native-lifecycle.backup-bound"})Start.J.WriteOnce(k,NativeRpcDefinitionPlan.Hash(workers));string proof=NativeRpcStart.Submit(p,Start.J,Start.V,Start.R);
   Put(Path.Combine(original,"native-definition-plan.txt"),B(p.Encode()));Put(Path.Combine(original,"record.json"),Record);Put(Path.Combine(original,"bundle.bin"),Bundle);foreach(var pair in Start.J.Data)Put(Path.Combine(original,pair.Key),B(pair.Value));
   Expected=new Dictionary<string,object>{{"appId",p.App},{"deployment",p.Deployment},{"profile",p.Profile},{"runtime",p.Runtime},{"l1Volume",H('1')},{"baseVolume",H('2')},{"manifestSha256",ProtectedAttempt.Hash(manifest)},{"ownerAttempt",new string('a',32)},{"ownerKeys",new[]{H('3'),H('4')}}};string guid;string owned=NativeRpcSecurity.Ownership(p,Start.J,out guid);
   Fields=new[]{"owned-rpc-host-plan-v2",guid,p.Origin.ToString(),p.Deadline.ToString(),Path.Combine(Root,"node.exe"),H('1'),Path.Combine(Root,"tpm.exe"),H('2'),Path.Combine(Root,"key.pem"),H('3'),Root,H('4'),Convert.ToBase64String(B(StartRecords.Encode(Expected))),"W10=",owned,Path.Combine(original,"native-definition-plan.txt"),p.Digest,proof,""};
   string plan=String.Join("\n",Fields);Put(Path.Combine(Root,"bootstrap-plan.txt"),B(plan));string raw=String.Join("\n",new[]{"owned-rpc-host-bootstrap-v1",n,p.Boot,now.ToString(),(now+20000).ToString(),ProtectedAttempt.Hash(fixtureImage),"host-bootstrap-v1",ProtectedAttempt.Hash(B(plan)),""});Contract=Path.Combine(Root,"contract.txt");Hash=ProtectedAttempt.Hash(B(raw));Put(Contract,B(raw));Fixed=null;
  }
  internal ProtectedAttempt Lease(){return ProtectedAttempt.PinHostBootstrapController(Contract,Hash);}
 }
 public static int Main(string[] args){try{
  if(args.Length!=0)throw new ArgumentException("No selection");var timer=new Timer(delegate{TerminateProcess(GetCurrentProcess(),125);},null,20000,Timeout.Infinite);BoundedWorker.EnterSupervisorEnvelope(256UL*1048576);fixtureImage=File.ReadAllBytes(System.Reflection.Assembly.GetExecutingAssembly().Location);
  Test("pending suffix preserves base bound and rejects malformed names",()=>{var c=new BootstrapFixture();using(var l=c.Lease())using(var p=ProtectedAttempt.PinNativeBootstrapJournalController(l,c.Fields)){string n=new string('a',40);Check(p.ReadPendingOnce(n)==null);Put(Path.Combine(c.Start.P.Root,n+".pending"),new byte[0]);Refuse(()=>p.ReadPendingOnce(n));foreach(string bad in new[]{new string('a',41),"../outside","bad/name","bad\\name","UPPER"})Refuse(()=>p.ReadPendingOnce(bad));Refuse(()=>p.ReadOptionalOnce(n+".pending"));}});
  Console.WriteLine("TOTAL "+count+" PASS; actual protected administrator files and simulated native receipts; SYSTEM peers and guest TPM sockets unqualified");GC.KeepAlive(timer);return 0;
 }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
