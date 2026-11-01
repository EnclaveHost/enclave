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
public static class NativeRpcSecurityHarness {
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
  public void RequireSecurity(NativeRpcDefinitionPlan p,string guid){Checks++;Check(guid==Id);if(WrongSecurity)throw new IOException("Security differs");}
 }
 sealed class SecurityCase {
  internal Case C=new Case();internal Security V;internal SecurityCase(){C.Run();V=new Security(C.J);}
  internal string Submit(){return NativeRpcSecurity.Submit(C.P,C.J,V,C.R);}
  internal string Read(){return NativeRpcSecurity.Reconcile(C.P,C.J,V,C.R);}
 }
 public static int Main(){try{
  var timer=new Timer(delegate{TerminateProcess(GetCurrentProcess(),125);},null,20000,Timeout.Infinite);
  BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);
  fixtureImage=File.ReadAllBytes(System.Reflection.Assembly.GetExecutingAssembly().Location);
  Test("security synchronous response durable then exact Off and security readback",()=>{var c=new SecurityCase();string result=c.Submit();Check(result==NativeRpcSecurity.VerifyCompleted(c.C.P,c.C.J)&&c.V.Calls==1&&c.V.Checks==1&&c.V.Off==2);Check(c.C.J.Read("native-security.observed").Contains("\"startAuthorized\":false"));Refuse(()=>c.Submit());Check(c.V.Calls==1);});
  Test("security async exact returned job persisted and settled",()=>{var c=new SecurityCase();c.V.Response=new NativeDefinitionResponse(4096,JobRef,null);Check(c.Submit()!=null&&c.V.Reads==1&&c.V.Checks==1);Check(c.C.J.Read("native-security.job")!=null&&c.C.J.Read("native-security.terminal")!=null);});
  Test("security pending reconciles original job without second submission",()=>{var c=new SecurityCase();c.V.Response=new NativeDefinitionResponse(4096,JobRef,null);c.V.State=4;Check(c.Submit()==null&&c.V.Checks==0);c.V.State=7;Check(c.Read()!=null&&c.V.Calls==1);});
  Test("lost security reply remains consumed without readback or retry",()=>{var c=new SecurityCase();c.V.Lose=true;Refuse(()=>c.Submit());Check(c.Read()==null&&c.V.Checks==0&&c.V.Reads==0);Refuse(()=>c.Submit());Check(c.V.Calls==1);});
  Test("failed durable security response cannot acknowledge or query",()=>{var c=new SecurityCase();c.C.J.Fail="native-security.receipt";Refuse(()=>c.Submit());Check(c.Read()==null&&c.V.Checks==0&&c.V.Reads==0);Refuse(()=>c.Submit());Check(c.V.Calls==1);});
  Test("security intent persistence failure prevents provider invocation",()=>{var c=new SecurityCase();c.C.J.Fail="native-security.intent";Refuse(()=>c.Submit());Check(c.V.Calls==0&&c.C.J.Read("native-security.native")==null);});
  Test("wrong ownership lineage refuses security mutation",()=>{foreach(string key in new[]{"plan","vmGuid","app","deployment","instance","managerEpoch","system"}){var c=new SecurityCase();var raw=c.C.J.Data["native-definition.owned"];var d=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(raw);d[key]="foreign";c.C.J.Data["native-definition.owned"]=StartRecords.Encode(d);Refuse(()=>c.Submit());Check(c.V.Calls==0&&c.C.J.Read("native-security.intent")==null);}});
  Test("changed Off state refuses before security intent",()=>{var c=new SecurityCase();c.V.WrongOff=true;Refuse(()=>c.Submit());Check(c.V.Calls==0&&c.C.J.Read("native-security.intent")==null);});
  Test("missing or false TPM security readback cannot acknowledge",()=>{var c=new SecurityCase();c.V.WrongSecurity=true;Refuse(()=>c.Submit());Check(c.C.J.Read("native-security.observed")==null);Refuse(()=>NativeRpcSecurity.VerifyCompleted(c.C.P,c.C.J));foreach(object bad in new object[]{false,"true",1,null})Refuse(()=>HyperVNativeRpcDefinition.RequireSecurityFields(new Dictionary<string,object>{{"TpmEnabled",bad},{"VirtualizationBasedSecurityOptOut",true}}));Refuse(()=>HyperVNativeRpcDefinition.RequireSecurityFields(new Dictionary<string,object>{{"TpmEnabled",true}}));HyperVNativeRpcDefinition.RequireSecurityFields(new Dictionary<string,object>{{"TpmEnabled",true},{"VirtualizationBasedSecurityOptOut",true}});});
  Test("original deadline or admission refusal prevents security mutation",()=>{var c=new SecurityCase();c.C.R.Clock=c.C.P.Deadline;Refuse(()=>c.Submit());Check(c.V.Calls==0);c=new SecurityCase();c.C.R.Deny=true;Refuse(()=>c.Submit());Check(c.V.Calls==0);});
  Test("security job incarnation change remains held",()=>{var c=new SecurityCase();c.V.Response=new NativeDefinitionResponse(4096,JobRef,null);c.V.State=4;Check(c.Submit()==null);c.V.Time="20261101070100.000000+000";c.V.State=7;Refuse(()=>c.Read());Check(c.V.Checks==0&&c.V.Calls==1);});
  Test("provider refusal and terminal errors never become configured",()=>{foreach(bool async in new[]{false,true}){var c=new SecurityCase();c.V.Response=new NativeDefinitionResponse(async?4096U:32768U,async?JobRef:null,null);c.V.Error=32768;Check(c.Submit()==null&&c.V.Checks==0);Check(c.Read()==null);Refuse(()=>NativeRpcSecurity.VerifyCompleted(c.C.P,c.C.J));Check(c.V.Calls==1);}});
  Test("aborted or multiple-run jobs cannot authorize security completion",()=>{foreach(bool abort in new[]{true,false}){var c=new SecurityCase();c.V.Response=new NativeDefinitionResponse(4096,JobRef,null);if(abort)c.V.State=10;else c.V.Runs=2;Check(c.Submit()==null&&c.V.Checks==0&&c.C.J.Read("native-security.terminal")==null);}});
  Test("returned replacement VM or remote job refused and retained",()=>{foreach(bool system in new[]{true,false}){var c=new SecurityCase();c.V.Response=system?new NativeDefinitionResponse(0,null,SystemRef):new NativeDefinitionResponse(4096,"\\\\foreign\\root\\virtualization\\v2:"+JobRef,null);Refuse(()=>c.Submit());Check(c.Read()==null&&c.V.Calls==1&&c.V.Reads==0);}});
  Test("completed security digest bound to original response and no release",()=>{var c=new SecurityCase();c.Submit();c.C.J.Data["native-security.observed"]=c.C.J.Data["native-security.observed"].Replace("false","true");Refuse(()=>NativeRpcSecurity.VerifyCompleted(c.C.P,c.C.J));});
  Test("actual protected security namespace permits only exact one-shot records",()=>{var c=new ProtectedCase();using(var l=c.Lease())using(var p=ProtectedAttempt.PinNativeDefinitionJournalController(c.PlanPath,c.PlanHash,l)){var j=new NativeRpcDefinitionJournal(p);j.WriteOnce("native-security.intent","fixture");Check(j.Read("native-security.intent")=="fixture");Refuse(()=>j.WriteOnce("native-security.intent","retry"));Refuse(()=>j.WriteOnce("native-security.start","x"));}});
  Test("actual reconcile lease refuses all security submissions and acknowledgments",()=>{var c=new ProtectedCase("reconcile");using(var l=c.Lease())using(var p=ProtectedAttempt.PinNativeDefinitionJournalController(c.PlanPath,c.PlanHash,l)){var j=new NativeRpcDefinitionJournal(p);foreach(string suffix in new[]{"intent","native","invoke","receipt"})Refuse(()=>j.WriteOnce("native-security."+suffix,"x"));foreach(string suffix in new[]{"job","terminal","observed"}){j.WriteOnce("native-security."+suffix,"fixture");Check(j.Read("native-security."+suffix)=="fixture");}}});
  Test("actual torn security response is held even when empty",()=>{var c=new ProtectedCase();Put(Path.Combine(c.P.Root,"native-security.receipt.pending"),new byte[0]);using(var l=c.Lease())using(var p=ProtectedAttempt.PinNativeDefinitionJournalController(c.PlanPath,c.PlanHash,l)){var j=new NativeRpcDefinitionJournal(p);Refuse(()=>j.Read("native-security.receipt"));}});
  GC.KeepAlive(timer);Console.WriteLine("TOTAL "+count+" PASS; provider mocked; protected administrator journal; no SYSTEM/VM/start/RPC");return 0;
 }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
