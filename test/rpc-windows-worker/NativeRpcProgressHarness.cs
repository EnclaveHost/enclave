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
public static class NativeRpcProgressHarness {
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
 sealed class Runtime:INativeRpcDefinitionRuntime,INativeRpcObservationWait {
  internal int Waits,Step=25,StopAfter=8;internal Action OnWait;
  public bool WaitForNextObservation(NativeRpcDefinitionPlan p){Waits++;if(Waits>StopAfter)return false;Clock+=Step;if(OnWait!=null)OnWait();return true;}
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
  public void RequireSecurity(NativeRpcDefinitionPlan p,string guid){Checks++;Check(guid==Id);if(WrongSecurity)throw new IOException("Security differs");}
 }
 sealed class SecurityCase {
  internal Case C=new Case();internal Security V;internal SecurityCase(){C.Run();V=new Security(C.J);}
  internal string Submit(){return NativeRpcSecurity.Submit(C.P,C.J,V,C.R);}
  internal string Read(){return NativeRpcSecurity.Reconcile(C.P,C.J,V,C.R);}
 }

 static string Ref(string step){return HyperVNativeRpcDefinition.OpticalClass(step)+".InstanceID=\"fixture-"+step+"\"";}
 sealed class Optical:INativeRpcOpticalProvider {
  internal readonly Journal J;internal readonly Runtime R;internal readonly Dictionary<string,string> Resources=new Dictionary<string,string>();internal string Special,WrongResource,Time="20261101172400.000000+000";internal int Calls,Reads,Verifies,Complete;internal bool Lose,Async,Missing,WrongFinal,Expire,ResetPending;internal uint Code;internal ushort State=7,Error;
  internal Optical(Journal j,Runtime r){J=j;R=r;}
  public NativeOpticalResponse Attach(NativeRpcDefinitionPlan p,string guid,string step,IDictionary<string,string> prior,string intent){
   if(ResetPending)State=4;Calls++;Check(guid==Id&&J.Read("native-optical."+step+".submit")==intent&&J.Read("native-optical."+step+".receipt")==null&&prior.Count==Resources.Count);
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

 sealed class SingleRuntime:INativeRpcDefinitionRuntime {internal Runtime R;public long Now{get{return R.Now;}}public void Check(NativeRpcDefinitionPlan p,bool m){R.Check(p,m);}}
 static void Bound(Journal j,string prefix){Check(j.Read(prefix+".receipt")!=null&&j.Read(prefix+".job")!=null&&j.Read(prefix+".terminal")==null);}
 public static int Main(string[] args){try{
  if(args.Length!=0)throw new ArgumentException("No fixture selector");
  var timer=new Timer(delegate{TerminateProcess(GetCurrentProcess(),125);},null,20000,Timeout.Infinite);BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);
  Test("definition waits on saved job through starting running and completion without resubmit",()=>{var c=new Case();c.V.Response=new NativeDefinitionResponse(4096,JobRef,SystemRef);c.V.State=2;c.R.OnWait=()=>{Bound(c.J,"native-definition");c.V.State=c.R.Waits==1?(ushort)3:c.R.Waits==2?(ushort)4:(ushort)7;};Check(c.Run().State=="defined-native-owned-off"&&c.V.Defines==1&&c.V.Reads==4&&c.R.Waits==3);});
  Test("security waits on original saved reference and records success once",()=>{var c=new SecurityCase();c.V.Response=new NativeDefinitionResponse(4096,JobRef,null);c.V.State=4;c.C.R.OnWait=()=>{Bound(c.C.J,"native-security");if(c.C.R.Waits==2)c.V.State=7;};Check(c.Submit()!=null&&c.V.Calls==1&&c.V.Reads==3&&c.C.R.Waits==2);});
  Test("five optical jobs progress in same lease with exact receipt before every wait",()=>{var c=new OpticalCase();c.V.Async=true;c.V.ResetPending=true;c.S.C.R.OnWait=()=>{string step=NativeRpcOptical.Steps[c.V.Calls-1];Bound(c.S.C.J,"native-optical."+step);c.V.State=7;};Check(c.Run()!=null&&c.V.Calls==5&&c.V.Reads==10&&c.S.C.R.Waits==5&&c.V.Complete==1);});
  Test("changed definition job incarnation after wait refuses ownership",()=>{var c=new Case();c.V.Response=new NativeDefinitionResponse(4096,JobRef,SystemRef);c.V.State=4;c.R.OnWait=()=>{c.V.State=7;c.V.Submitted="20261101180000.000000+000";};Refuse(()=>c.Run());Check(c.V.Defines==1&&c.V.Reads==2&&c.J.Read("native-definition.owned")==null);});
  Test("changed security job incarnation after wait refuses next stage",()=>{var c=new SecurityCase();c.V.Response=new NativeDefinitionResponse(4096,JobRef,null);c.V.State=4;c.C.R.OnWait=()=>{c.V.State=7;c.V.Time="20261101180000.000000+000";};Refuse(()=>c.Submit());Check(c.V.Calls==1&&c.C.J.Read("native-security.observed")==null);});
  Test("changed optical job incarnation after wait never submits next resource",()=>{var c=new OpticalCase();c.V.Async=true;c.V.State=4;c.S.C.R.OnWait=()=>{c.V.State=7;c.V.Time="20261101180000.000000+000";};Refuse(()=>c.Run());Check(c.V.Calls==1&&c.S.C.J.Read("native-optical.imagedrive.submit")==null);});
  Test("worker wait refusal leaves pending exact job and no success or repeat mutation",()=>{var c=new SecurityCase();c.V.Response=new NativeDefinitionResponse(4096,JobRef,null);c.V.State=4;c.C.R.StopAfter=2;Check(c.Submit()==null&&c.V.Calls==1&&c.V.Reads==3&&c.C.R.Waits==3&&c.C.J.Read("native-security.observed")==null);});
  Test("unsupported failed recurring and nonprogress states never enter wait",()=>{var p=Plan();foreach(ushort state in new ushort[]{0,1,5,7,8,9,10,11,32768}){var r=new Runtime();Check(!NativeRpcJobProgress.Wait(p,r,new StartJob(JobRef,"definition-fixture","fixed",state,0,1))&&r.Waits==0);}foreach(uint runs in new uint[]{0,2,UInt32.MaxValue}){var r=new Runtime();Check(!NativeRpcJobProgress.Wait(p,r,new StartJob(JobRef,"definition-fixture","fixed",4,0,runs))&&r.Waits==0);}var e=new Runtime();Check(!NativeRpcJobProgress.Wait(p,e,new StartJob(JobRef,"definition-fixture","fixed",4,32768,1))&&e.Waits==0);});
  Test("clock stalled rolled back or beyond original startup refuses another observation",()=>{foreach(int step in new[]{0,-1,900000}){var c=new Case();c.V.Response=new NativeDefinitionResponse(4096,JobRef,SystemRef);c.V.State=4;c.R.Step=step;Refuse(()=>c.Run());Check(c.V.Defines==1&&c.V.Reads==1);}var p=Plan();var r=new Runtime();r.Clock=p.Deadline;Check(!NativeRpcJobProgress.Wait(p,r,new StartJob(JobRef,"definition-fixture","fixed",4,0,1))&&r.Waits==0);});
  Test("nonwaiting caller retains single observation semantics",()=>{var c=new Case();c.V.Response=new NativeDefinitionResponse(4096,JobRef,SystemRef);c.V.State=4;var result=NativeRpcDefinition.Submit(c.P,c.J,c.V,new SingleRuntime{R=c.R});Check(result.State=="job-pending-held"&&c.V.Defines==1&&c.V.Reads==1&&c.R.Waits==0);});
  Test("readonly optical settlement waits but cannot submit missing next step",()=>{var c=new OpticalCase();c.V.Async=true;c.V.State=4;c.S.C.R.StopAfter=0;Check(c.Run()==null&&c.V.Calls==1);c.S.C.R.StopAfter=8;c.S.C.R.OnWait=()=>c.V.State=7;Check(c.Run(true)==null&&c.V.Calls==1&&c.V.Verifies==1&&c.S.C.J.Read("native-optical.imagedrive.intent")==null);});
  Test("lost response and completed error never trigger wait or next mutation",()=>{var c=new Case();c.V.Lose=true;Refuse(()=>c.Run());Check(c.R.Waits==0&&c.V.Reads==0&&c.V.Defines==1);var o=new OpticalCase();o.V.Async=true;o.V.State=4;o.S.C.R.OnWait=()=>{o.V.State=7;o.V.Error=32768;};Check(o.Run()==null&&o.V.Calls==1&&o.V.Reads==2&&o.S.C.R.Waits==1&&o.S.C.J.Read("native-optical.imagedrive.intent")==null);});
  GC.KeepAlive(timer);Console.WriteLine("TOTAL "+count+" PASS; provider/admission/clock mocked; no target/SYSTEM/native mutation/RPC");return 0;
 }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
