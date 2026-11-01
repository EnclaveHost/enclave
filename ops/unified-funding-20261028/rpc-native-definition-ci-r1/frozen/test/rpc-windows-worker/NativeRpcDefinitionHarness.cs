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
public static class NativeRpcDefinitionHarness {
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
  public DefinitionResponse Response=new DefinitionResponse(0,null,SystemRef);
  public Provider(Journal j){Journal=j;}
  public DefinitionResponse Define(NativeRpcDefinitionPlan p){Defines++;Check(Journal.Read("native-definition.intent")==p.Encode()&&Journal.Read("native-definition.native")!=null);if(Lose)throw new IOException("Lost response");return Response;}
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
 public static int Main(){
  try{
   BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);
   fixtureImage=File.ReadAllBytes(System.Reflection.Assembly.GetExecutingAssembly().Location);
   Test("canonical native app plan and reset rejection",()=>{var p=Plan();Check(NativeRpcDefinitionPlan.Parse(p.Encode()).Digest==p.Digest);Refuse(()=>NativeRpcDefinitionPlan.Parse(p.Encode().Replace("901000","901001")));Refuse(()=>NativeRpcDefinitionPlan.Parse(p.Encode().Replace("1000\n","01000\n")));Refuse(()=>PlanAt(p.Attempt,p.Boot,p.Root,Int64.MaxValue,p.WorkerImageHash));});
   Test("initial native recipe has Type1 firmware and no automatic boot",()=>{var p=Plan();var x=HyperVNativeRpcDefinition.Settings(p);Check((ushort)x["GuestStateIsolationType"]==1&&(bool)x["GuestStateIsolationEnabled"]&&(uint)x["GuestFeatureSet"]==0x201&&(string)x["FirmwareFile"]==p.Firmware&&(string)x["GuestStateFile"]=="guest-state.vmgs"&&!(bool)x["SecureBootEnabled"]&&!(bool)x["AutomaticSnapshotsEnabled"]&&(ushort)x["AutomaticStartupAction"]==2&&(ushort)x["AutomaticShutdownAction"]==4);});
   Test("synchronous exact VM identity durable before ownership",()=>{var c=new Case();var o=c.Run();Check(o.State=="defined-native-owned-off"&&o.VmGuid==Id&&o.Settled&&!o.StartAuthorized&&!o.ReservationMayRelease&&c.V.Defines==1&&c.V.Off==1&&c.J.Read("native-definition.owned")!=null);Refuse(()=>c.Run());Check(c.V.Defines==1);});
   Test("async exact job persisted before queries and association",()=>{var c=new Case();c.V.Response=new DefinitionResponse(4096,JobRef,null);var o=c.Run();Check(o.Settled&&o.VmGuid==Id&&c.V.Associations==1&&c.V.Reads==3);});
   Test("pending native job held then original association settles",()=>{var c=new Case();c.V.Response=new DefinitionResponse(4096,JobRef,null);c.V.State=4;Check(c.Run().State=="job-pending-held"&&c.V.Off==0);c.V.State=7;Check(c.Read().Settled&&c.V.Defines==1);});
   Test("lost native response consumes submission without retry",()=>{var c=new Case();c.V.Lose=true;Refuse(()=>c.Run());Check(c.Read().State=="response-lost-held");Refuse(()=>c.Run());Check(c.V.Defines==1&&c.V.Reads==0&&c.V.Off==0);});
   Test("receipt write failure prevents followup provider reads",()=>{var c=new Case();c.J.Fail="native-definition.receipt";Refuse(()=>c.Run());Check(c.Read().State=="response-lost-held"&&c.V.Reads==0&&c.V.Off==0);Refuse(()=>c.Run());Check(c.V.Defines==1);});
   Test("job reincarnation after association refuses ownership",()=>{var c=new Case();c.V.Response=new DefinitionResponse(4096,JobRef,null);c.V.RecycledAfterAssociation=true;Refuse(()=>c.Run());Check(c.J.Read("native-definition.owned")==null);});
   Test("owned Off mismatch cannot publish ownership",()=>{var c=new Case();c.V.WrongOff=true;Refuse(()=>c.Run());Check(c.J.Read("native-definition.owned")==null);});
   Test("original expiry refuses mutation before consumption",()=>{var c=new Case();c.R.Clock=c.P.Deadline;Refuse(()=>c.Run());Check(c.V.Defines==0&&c.J.Read("native-definition.submit")==null);});
   Test("provider failure remains held without release",()=>{var c=new Case();c.V.Response=new DefinitionResponse(4096,JobRef,null);c.V.Error=32768;var o=c.Run();Check(o.State=="definition-failed-held"&&o.Settled&&!o.ReservationMayRelease&&c.V.Off==0);});
   Test("actual protected native journal roundtrip and exclusive intent",()=>{var c=new ProtectedCase();using(var l=c.Lease())using(var p=ProtectedAttempt.PinNativeDefinitionJournalController(c.PlanPath,c.PlanHash,l)){var j=new NativeRpcDefinitionJournal(p);NativeRpcDefinition.Prepare(c.P,j);Check(j.Read("native-definition.intent")==c.P.Encode());Refuse(()=>NativeRpcDefinition.Prepare(c.P,j));Refuse(()=>j.Read("native-definition.intent"));}});
   Test("actual partial receipt cannot become absence",()=>{var c=new ProtectedCase();Put(Path.Combine(c.P.Root,"native-definition.receipt.pending"),new byte[0]);using(var l=c.Lease())using(var p=ProtectedAttempt.PinNativeDefinitionJournalController(c.PlanPath,c.PlanHash,l)){var j=new NativeRpcDefinitionJournal(p);Refuse(()=>j.Read("native-definition.receipt"));}});
   Test("actual reconcile lease cannot submit or acknowledge native work",()=>{var c=new ProtectedCase("reconcile");using(var l=c.Lease())using(var p=ProtectedAttempt.PinNativeDefinitionJournalController(c.PlanPath,c.PlanHash,l)){var j=new NativeRpcDefinitionJournal(p);foreach(string n in new[]{"intent","submit","native","invoke","receipt"})Refuse(()=>j.WriteOnce("native-definition."+n,"x"));j.WriteOnce("native-definition.job","fixture");Check(j.Read("native-definition.job")=="fixture");Refuse(()=>j.WriteOnce("start.intent","x"));}});
   Test("actual worker image lineage mismatch refused",()=>{var c=new ProtectedCase("define",true);using(var l=c.Lease())Refuse(()=>ProtectedAttempt.PinNativeDefinitionJournalController(c.PlanPath,c.PlanHash,l));});
   Test("ordinary definition lease cannot open native plan",()=>{var c=new ProtectedCase();Refuse(()=>ProtectedAttempt.PinDefinitionController(c.Contract,c.Hash));});
   Console.WriteLine("TOTAL "+count+" PASS; provider mocked; actual protected administrator namespace; no VM/attestation/start");return 0;
  }catch(Exception e){Console.Error.WriteLine(e);return 1;}
 }
}
