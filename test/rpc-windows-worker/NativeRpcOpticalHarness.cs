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
public static class NativeRpcOpticalHarness {
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
 public static int Main(string[] args){try{
  if(args.Length!=0)throw new ArgumentException("No fixture selection");
  var timer=new Timer(delegate{TerminateProcess(GetCurrentProcess(),125);},null,20000,Timeout.Infinite);BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);fixtureImage=File.ReadAllBytes(System.Reflection.Assembly.GetExecutingAssembly().Location);
  Test("five synchronous attachments persist exact references before readback",()=>{var c=new OpticalCase();string proof=c.Run();Check(proof==NativeRpcOptical.VerifyCompleted(c.S.C.P,c.S.C.J)&&c.V.Calls==5&&c.V.Verifies==5&&c.V.Complete==1);Check(c.Run()==proof&&c.V.Calls==5);});
  Test("async jobs settle exact persisted identities before next attachment",()=>{var c=new OpticalCase();c.V.Async=true;Check(c.Run()!=null&&c.V.Calls==5&&c.V.Reads==5);foreach(string step in NativeRpcOptical.Steps)Check(c.S.C.J.Read("native-optical."+step+".terminal")!=null);});
  Test("pending original reference read-only settlement cannot submit next step",()=>{var c=new OpticalCase();c.V.Async=true;c.V.State=4;Check(c.Run()==null&&c.V.Calls==1&&c.V.Verifies==0);c.V.State=7;Check(c.Run(true)==null&&c.V.Calls==1&&c.V.Verifies==1&&c.S.C.J.Read("native-optical.imagedrive.intent")==null);Check(c.Run()!=null&&c.V.Calls==5);});
  Test("lost second response stays held without scan or resubmission",()=>{var c=new OpticalCase();c.V.Special="imagedrive";c.V.Lose=true;Refuse(()=>c.Run());Check(c.V.Calls==2&&c.V.Verifies==1);Check(c.Run(true)==null&&c.Run()==null&&c.V.Calls==2&&c.V.Reads==0);});
  Test("missing resulting resource stays held after successful provider return",()=>{var c=new OpticalCase();c.V.Special="scsi";c.V.Missing=true;Check(c.Run()==null&&c.Run()==null&&c.V.Calls==1&&c.V.Verifies==0);});
  Test("provider refusal blocks subsequent attachments and retries",()=>{var c=new OpticalCase();c.V.Special="imagedrive";c.V.Code=5;Check(c.Run()==null&&c.V.Calls==2&&c.V.Verifies==1);Check(c.Run()==null&&c.V.Calls==2);});
  Test("resource response persistence failure prevents query acknowledgement",()=>{var c=new OpticalCase();c.V.Async=true;c.S.C.J.Fail="native-optical.scsi.receipt";Refuse(()=>c.Run());Check(c.V.Calls==1&&c.V.Reads==0&&c.V.Verifies==0);c.S.C.J.Fail=null;Check(c.Run()==null&&c.V.Calls==1);});
  Test("changed job incarnation cannot settle prior attachment",()=>{var c=new OpticalCase();c.V.Async=true;c.V.State=4;Check(c.Run()==null);c.V.Time="20261101172500.000000+000";c.V.State=7;Refuse(()=>c.Run(true));Check(c.V.Calls==1&&c.V.Verifies==0);});
  Test("terminal provider error cannot produce optical ready receipt",()=>{var c=new OpticalCase();c.V.Async=true;c.V.Error=32768;Check(c.Run()==null&&c.V.Calls==1&&c.V.Verifies==0);Check(c.Run(true)==null&&c.V.Reads==1);});
  Test("readonly unsubmitted and changed original ownership fail before mutation",()=>{var c=new OpticalCase();Check(c.Run(true)==null&&c.V.Calls==0&&c.S.C.J.Read("native-optical.scsi.intent")==null);c.S.C.J.Data["native-definition.owned"]=c.S.C.J.Data["native-definition.owned"].Replace(Id,"87654321-4321-4321-4321-210987654321");Refuse(()=>c.Run());Check(c.V.Calls==0);});
  Test("security and dependency tampering refuse attachment authority",()=>{var c=new OpticalCase();c.S.C.J.Data.Remove("native-security.observed");Refuse(()=>c.Run());Check(c.V.Calls==0);c=new OpticalCase();c.V.Async=true;c.V.State=4;Check(c.Run()==null);c.S.C.J.Data["native-optical.scsi.intent"]+=" ";Refuse(()=>c.Run());Check(c.V.Calls==1);});
  Test("expired original startup after returned response cannot submit next step",()=>{var c=new OpticalCase();c.V.Expire=true;Refuse(()=>c.Run());Check(c.V.Calls==1&&c.S.C.J.Read("native-optical.scsi.receipt")!=null&&c.S.C.J.Read("native-optical.imagedrive.submit")==null);});
  Test("final topology readback failure prevents completed observation",()=>{var c=new OpticalCase();c.V.WrongFinal=true;Refuse(()=>c.Run());Check(c.V.Calls==5&&c.S.C.J.Read("native-optical.observed")==null);Refuse(()=>NativeRpcOptical.VerifyCompleted(c.S.C.P,c.S.C.J));});
  Test("resource reference rejects foreign servers classes namespaces and keys",()=>{foreach(string wrong in new[]{@"\\foreign\root\virtualization\v2:"+Ref("scsi"),@"root\cimv2:"+Ref("scsi"),"Msvm_ComputerSystem.Name=\""+Id+"\"",Ref("scsi")+",Name=\"extra\""})Refuse(()=>HyperVNativeRpcDefinition.OpticalReference("scsi",wrong));var c=new OpticalCase();c.V.Special="scsi";c.V.WrongResource=Ref("imagemedia");Refuse(()=>c.Run());Check(c.V.Calls==1&&c.V.Verifies==0);});
  Test("fixed two optical topology rejects swapped media wrong parent slot type extras",()=>{var p=Plan();var all=All();HyperVNativeRpcDefinition.VerifyOpticalInventory(p,all,Inventory(p,all));
   foreach(string fault in new[]{"path","parent","slot","type","extra","alias"}){var actual=Inventory(p,all);var chosen=new Dictionary<string,string>(all);if(fault=="path")actual[Ref("imagemedia")]["HostResource"]=new[]{Path.Combine(p.Root,"hash.container")};if(fault=="parent")actual[Ref("imagemedia")]["Parent"]=Ref("hashdrive");if(fault=="slot")actual[Ref("hashdrive")]["AddressOnParent"]="0";if(fault=="type")actual[Ref("hashdrive")]["ResourceType"]=(ushort)17;if(fault=="extra")actual.Add("extra",new Dictionary<string,object>());if(fault=="alias")chosen["hashdrive"]=Ref("imagedrive");Refuse(()=>HyperVNativeRpcDefinition.VerifyOpticalInventory(p,chosen,actual));}
  });
  Test("earlier readback permits later known topology but new mutation requires exact closure",()=>{var p=Plan();var all=All();var one=new Dictionary<string,string>{{"scsi",Ref("scsi")}};HyperVNativeRpcDefinition.VerifyOpticalSubset(p,one,Inventory(p,all));Refuse(()=>HyperVNativeRpcDefinition.VerifyOpticalInventory(p,one,Inventory(p,all)));var absent=Inventory(p,all);absent.Remove(Ref("scsi"));Refuse(()=>HyperVNativeRpcDefinition.VerifyOpticalSubset(p,one,absent));});
  Test("only original default SCSI may be acknowledged as preexisting",()=>{var c=new OpticalCase();Check(c.Run()!=null);string n="native-optical.hashdrive.receipt";c.S.C.J.Data[n]=c.S.C.J.Data[n].Replace("\"existing\":false","\"existing\":true");Refuse(()=>NativeRpcOptical.VerifyCompleted(c.S.C.P,c.S.C.J));var p=Plan();var one=new Dictionary<string,string>{{"scsi",Ref("scsi")}};HyperVNativeRpcDefinition.VerifyOpticalInventory(p,one,Inventory(p,one));});
  Test("actual protected optical journal one-shot and partial writes stay consumed",()=>{var c=new ProtectedCase();using(var lease=c.Lease())using(var pin=ProtectedAttempt.PinNativeDefinitionJournalController(c.PlanPath,c.PlanHash,lease)){var j=new NativeRpcDefinitionJournal(pin);j.WriteOnce("native-optical.scsi.intent","fixed");Check(j.Read("native-optical.scsi.intent")=="fixed");Refuse(()=>j.WriteOnce("native-optical.scsi.intent","again"));Put(Path.Combine(c.P.Root,"native-optical.scsi.receipt.pending"),new byte[0]);Refuse(()=>j.Read("native-optical.scsi.receipt"));}});
  Test("actual reconcile lease cannot write any optical submission or receipt",()=>{var c=new ProtectedCase("reconcile");using(var lease=c.Lease())using(var pin=ProtectedAttempt.PinNativeDefinitionJournalController(c.PlanPath,c.PlanHash,lease)){var j=new NativeRpcDefinitionJournal(pin);foreach(string step in NativeRpcOptical.Steps)foreach(string end in new[]{"intent","submit","invoke","receipt"})Refuse(()=>j.WriteOnce("native-optical."+step+"."+end,"deny"));j.WriteOnce("native-optical.scsi.job","observation");Check(j.Read("native-optical.scsi.job")=="observation");Refuse(()=>j.WriteOnce("native-optical.other.job","deny"));}});
  GC.KeepAlive(timer);Console.WriteLine("TOTAL "+count+" PASS; provider mocked/private administrator journals real; no SYSTEM/provider/VM attachment/start/RPC");return 0;
 }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
