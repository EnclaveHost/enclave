using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using Enclave.OwnedRpc;
public static class OwnedVmDefinitionHarness {
 static int count;
 [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")]static extern bool TerminateProcess(IntPtr p,uint code);
 static void Check(bool ok){if(!ok)throw new Exception("Assertion");}
 static void Refuse(Action f){bool refused=false;try{f();}catch{refused=true;}Check(refused);}
 static void Test(string name,Action f){f();count++;Console.WriteLine("PASS "+name);}
 const string Id="12345678-1234-1234-1234-123456789012";
 static string SystemRef {get{return "Msvm_ComputerSystem.Name=\""+Id+"\"";}}
 static string JobRef {get{return HyperVStartProvider.ReferenceForId("definition-fixture");}}
 static OwnedVmDefinitionPlan Plan(){string n=new string('a',32);return new OwnedVmDefinitionPlan(n,new string('b',32),new string('c',64),new string('d',64),@"C:\OwnedRpcFixture\"+n,1000,901000,new string('e',64),new string('f',64));}
 sealed class Journal:IStartJournal {
  public readonly Dictionary<string,string> Data=new Dictionary<string,string>();public string Fail;
  public void WriteOnce(string n,string v){if(n==Fail)throw new IOException("Injected durable write failure");if(Data.ContainsKey(n))throw new IOException("Consumed");Data.Add(n,v);}
  public string Read(string n){string v;return Data.TryGetValue(n,out v)?v:null;}
 }
 sealed class Runtime:IDefinitionRuntime {
  public long Clock=2000;public bool Deny,ObservationDenied;public int Before,Reads;
  public long Now{get{return Clock;}}
  public void VerifyBeforeDefinition(OwnedVmDefinitionPlan p){Before++;if(Deny)throw new Exception("Admission refused");}
  public void VerifyObservation(OwnedVmDefinitionPlan p){Reads++;if(ObservationDenied)throw new Exception("Reader expired");}
 }
 sealed class Provider:IDefinitionProvider {
  public readonly Journal Journal;public int Defines,Reads,Associations,Off;public bool Lose,WrongOff,RecycledAfterAssociation;
  public ushort State=7,Error;public uint Runs=1;public string Submitted="20261031070000.000000+000";
  public DefinitionResponse Response=new DefinitionResponse(0,null,SystemRef);
  public Provider(Journal j){Journal=j;}
  public DefinitionResponse Define(OwnedVmDefinitionPlan p){Defines++;Check(Journal.Read("definition.intent")==p.Encode()&&Journal.Read("definition.native")!=null);if(Lose)throw new IOException("Lost response");return Response;}
  public StartJob ReadJob(string r){Reads++;Check(Journal.Read("definition.receipt")!=null&&r==JobRef);return new StartJob(r,"definition-fixture",Submitted,State,Error,Runs);}
  public string ReadResultingSystem(string r){Associations++;Check(Journal.Read("definition.terminal")!=null);if(RecycledAfterAssociation)Submitted="20261031070100.000000+000";return SystemRef;}
  public void RequireOwnedOff(OwnedVmDefinitionPlan p,string guid){Off++;Check(Journal.Read("definition.system")!=null&&guid==Id);if(WrongOff)throw new Exception("Owned Off readback differs");}
 }
 sealed class Case {public OwnedVmDefinitionPlan P=Plan();public Journal J=new Journal();public Runtime R=new Runtime();public Provider V;public Case(){V=new Provider(J);OwnedVmDefinition.Prepare(P,J);}public DefinitionOutcome Run(){return OwnedVmDefinition.Submit(P,J,V,R);}public DefinitionOutcome Read(){return OwnedVmDefinition.Reconcile(P,J,V,R);}}
 static byte[] fixtureImage;
 static void DirectoryNew(string path){var a=new DirectorySecurity();a.SetOwner(new SecurityIdentifier("S-1-5-32-544"));a.SetAccessRuleProtection(true,false);foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})a.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));Directory.CreateDirectory(path,a);}
 static void Put(string path,byte[] bytes){var a=new FileSecurity();a.SetOwner(new SecurityIdentifier("S-1-5-32-544"));a.SetAccessRuleProtection(true,false);foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})a.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));using(var f=new FileStream(path,FileMode.CreateNew,FileSystemRights.WriteData,FileShare.None,4096,FileOptions.WriteThrough,a)){f.Write(bytes,0,bytes.Length);f.Flush(true);}}
 sealed class ProtectedCase {
  internal readonly string Contract,Hash,PlanPath,PlanHash,ObservationHash;internal readonly OwnedVmDefinitionPlan P;
  internal ProtectedCase(string op="define",bool wrongHash=false,bool wrongBoot=false){
   string n=Guid.NewGuid().ToString("N"),b=ProtectedAttempt.CurrentBoot(),basePath=Path.GetPathRoot(Environment.SystemDirectory),parent=Path.Combine(basePath,"rpc-definition-ci-"+n),root=Path.Combine(parent,n);
   DirectoryNew(parent);DirectoryNew(root);Put(Path.Combine(root,"entry.exe"),fixtureImage);
   string id=Guid.NewGuid().ToString("N"),vp=Path.Combine(basePath,"EnclaveRpcVm-"+id),vr=Path.Combine(vp,id);DirectoryNew(vp);DirectoryNew(vr);
   long now=BoundedWorker.MonotonicMilliseconds(),origin=now;
   P=new OwnedVmDefinitionPlan(id,wrongBoot?new string('b',32):b,new string('c',64),ProtectedAttempt.Hash(fixtureImage),vr,origin,origin+900000,new string('e',64),new string('f',64));
   PlanPath=Path.Combine(vr,"definition-plan.txt");byte[] plan=Encoding.UTF8.GetBytes(P.Encode());PlanHash=wrongHash?new string('0',64):ProtectedAttempt.Hash(plan);Put(PlanPath,plan);
   bool probe=op=="admission-check";byte[] observation=Encoding.UTF8.GetBytes("{}");ObservationHash=ProtectedAttempt.Hash(observation);
   if(probe)Put(Path.Combine(root,"admission.json"),observation);
   byte[] c=Encoding.UTF8.GetBytes((probe?"owned-rpc-definition-admission-v1":"owned-rpc-definition-worker-v1")+"\n"+n+"\n"+b+"\n"+now+"\n"+(now+20000)+"\n"+ProtectedAttempt.Hash(fixtureImage)+"\n"+op+"\n"+PlanPath+"\n"+PlanHash+"\n"+(probe?ObservationHash+"\n":""));
   Contract=Path.Combine(root,"contract.txt");Hash=ProtectedAttempt.Hash(c);Put(Contract,c);
  }
  internal ProtectedAttempt Lease(){return ProtectedAttempt.PinDefinitionController(Contract,Hash);}
 }

 sealed class PriorCase : IDisposable {
  internal readonly string Root,Contract,Hash,PlanPath,PlanHash;internal readonly OwnedVmDefinitionPlan P;
  readonly List<System.Diagnostics.Process> dead=new List<System.Diagnostics.Process>();
  internal PriorCase(bool alive=false){
   string drive=Path.GetPathRoot(Environment.SystemDirectory),n=Guid.NewGuid().ToString("N"),id=Guid.NewGuid().ToString("N"),boot=ProtectedAttempt.CurrentBoot();
   Root=Path.Combine(drive,"EnclaveRpcDefinition-"+n,n);DirectoryNew(Path.GetDirectoryName(Root));DirectoryNew(Root);Put(Path.Combine(Root,"entry.exe"),fixtureImage);
   string vr=Path.Combine(drive,"EnclaveRpcVm-"+id,id);DirectoryNew(Path.GetDirectoryName(vr));DirectoryNew(vr);
   long end=BoundedWorker.MonotonicMilliseconds()-1000,planEnd=Math.Max(end,900001);P=new OwnedVmDefinitionPlan(id,boot,new string('c',64),ProtectedAttempt.Hash(fixtureImage),vr,planEnd-900000,planEnd,new string('e',64),new string('f',64));
   PlanPath=Path.Combine(vr,"definition-plan.txt");PlanHash=ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(P.Encode()));Put(PlanPath,Encoding.UTF8.GetBytes(P.Encode()));
   byte[] bytes=Encoding.UTF8.GetBytes("owned-rpc-definition-worker-v1\n"+n+"\n"+boot+"\n"+(end-20000)+"\n"+end+"\n"+ProtectedAttempt.Hash(fixtureImage)+"\ndefine\n"+PlanPath+"\n"+PlanHash+"\n");
   Contract=Path.Combine(Root,"contract.txt");Hash=ProtectedAttempt.Hash(bytes);Put(Contract,bytes);Put(Path.Combine(vr,"definition.intent"),Encoding.UTF8.GetBytes(P.Encode()));Put(Path.Combine(vr,"definition.submit"),Encoding.UTF8.GetBytes(PlanHash));
   foreach(string role in new[]{"owner","observer","child"}){
    System.Diagnostics.Process q;
    if(alive&&role=="child")q=System.Diagnostics.Process.GetCurrentProcess();
    else {q=System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(Path.Combine(Environment.SystemDirectory,"cmd.exe"),"/c exit 0"){UseShellExecute=false,CreateNoWindow=true});}
    dead.Add(q);IntPtr held=q.Handle;long creation=q.StartTime.ToUniversalTime().ToFileTimeUtc();
    if(!(alive&&role=="child")&&!q.WaitForExit(1000))throw new Exception("Finite exact fixture death unconfirmed");
    Put(Path.Combine(Root,role+".consumed"),Encoding.UTF8.GetBytes(q.Id+","+creation+","+n+boot+Hash+","+role));
   }
  }
  internal Dictionary<string,object> Binding(){return new Dictionary<string,object>{{"schema","owned-rpc-unsubmitted-predecessor/1"},{"contractPath",Contract},{"contractHash",Hash},{"producerHash",ProtectedAttempt.Hash(fixtureImage)}};}
  public void Dispose(){foreach(var q in dead)q.Dispose();}
 }
 static void PredecessorTests(){
  Test("predecessor-exact-consumed-records-accepted",()=>{var d=new Dictionary<string,string>{{"definition.intent","plan"},{"definition.submit","hash"}};UnsubmittedDefinition.RequireUnsubmitted(n=>d.ContainsKey(n)?d[n]:null,"plan","hash");});
  Test("predecessor-all-native-or-pending-markers-refused",()=>{foreach(string name in new[]{"definition.native","definition.invoke","definition.receipt","definition.job","definition.terminal","definition.system","definition.off","boot.media","boot.ready"})foreach(string suffix in new[]{"",".pending"}){string target=name+suffix;Refuse(()=>UnsubmittedDefinition.RequireUnsubmitted(n=>n=="definition.intent"?"plan":n=="definition.submit"?"hash":n==target?"held":null,"plan","hash"));}});
  Test("predecessor-partial-pre-native-publication-refused",()=>{foreach(string name in new[]{"definition.intent.pending","definition.submit.pending"})Refuse(()=>UnsubmittedDefinition.RequireUnsubmitted(n=>n=="definition.intent"?"plan":n=="definition.submit"?"hash":n==name?"partial":null,"plan","hash"));});
  Test("predecessor-missing-or-wrong-submission-refused",()=>{Refuse(()=>UnsubmittedDefinition.RequireUnsubmitted(n=>null,"plan","hash"));Refuse(()=>UnsubmittedDefinition.RequireUnsubmitted(n=>n=="definition.intent"?"plan":"other","plan","hash"));});
  Test("predecessor-live-exact-process-refused",()=>{using(var q=System.Diagnostics.Process.GetCurrentProcess()){string record=q.Id+","+q.StartTime.ToUniversalTime().ToFileTimeUtc()+",token,child";Refuse(()=>UnsubmittedDefinition.RequireExactDeath(record,"token","child"));}});
  Test("predecessor-malformed-role-binding-refused",()=>{foreach(string record in new[]{"0,1,t,child","01,1,t,child","1,0,t,child","1,1,wrong,child","1,1,t,owner"})Refuse(()=>UnsubmittedDefinition.RequireExactDeath(record,"t","child"));});
  Test("predecessor-window-exact-expiry-and-enclosure",()=>{UnsubmittedDefinition.RequirePriorWindow(1,900001,880001,900001,900001);Refuse(()=>UnsubmittedDefinition.RequirePriorWindow(1,900001,880001,900001,900000));Refuse(()=>UnsubmittedDefinition.RequirePriorWindow(1,900001,880001,900002,900003));});
  Test("predecessor-window-overflow-and-renewal-refused",()=>{Refuse(()=>UnsubmittedDefinition.RequirePriorWindow(Int64.MaxValue-100,Int64.MaxValue,1,2,Int64.MaxValue));Refuse(()=>UnsubmittedDefinition.RequirePriorWindow(1,900002,880001,900001,900003));});
  Test("actual-expired-worker-custody-readonly",()=>{using(var old=new PriorCase()){var c=new ProtectedCase();using(var a=c.Lease())using(var w=ProtectedAttempt.OpenPriorDefinitionWorker(old.Contract,old.Hash,a)){Check(w.PermitHash==old.PlanHash);Refuse(()=>w.WriteOnce("child.result","forbidden"));}}});
  Test("actual-held-prior-worker-cannot-replace",()=>{using(var old=new PriorCase()){var c=new ProtectedCase();using(var a=c.Lease())using(var w=ProtectedAttempt.OpenPriorDefinitionWorker(old.Contract,old.Hash,a))Refuse(()=>File.Move(old.Contract,old.Contract+".moved"));}});
  Test("actual-prior-worker-digest-refused",()=>{using(var old=new PriorCase()){var c=new ProtectedCase();using(var a=c.Lease())Refuse(()=>{using(var w=ProtectedAttempt.OpenPriorDefinitionWorker(old.Contract,new string('0',64),a)){} });}});
  Test("actual-prior-dead-roles-bound-to-held-contract",()=>{using(var old=new PriorCase()){var c=new ProtectedCase();using(var a=c.Lease())using(var w=ProtectedAttempt.OpenPriorDefinitionWorker(old.Contract,old.Hash,a))foreach(string role in new[]{"owner","observer","child"})UnsubmittedDefinition.RequireExactDeath(w.ReadOnce(role+".consumed"),w.Token,role);}});

 }
 static void ProtectedTests(){
  Test("admission-only-contract-binds-fresh-private-observation",()=>{var c=new ProtectedCase("admission-check");using(var a=c.Lease()){
   Check(a.Operation=="admission-check"&&a.AdmissionObservationHash==c.ObservationHash&&Encoding.UTF8.GetString(a.ReadAdmission(a.AdmissionObservationHash))=="{}");
   Refuse(()=>a.ReadAdmission(new string('0',64)));
  }});
  Test("admission-only-cannot-write-any-definition-or-boot-record",()=>{var c=new ProtectedCase("admission-check");using(var a=c.Lease())using(var p=ProtectedAttempt.PinDefinitionJournalController(c.PlanPath,c.PlanHash,a)){
   var j=new OwnedDefinitionJournal(p);foreach(string n in new[]{"definition.intent","definition.submit","definition.native","definition.receipt","definition.job","definition.terminal","definition.system","definition.off","boot.media","boot.ready","boot.nic.intent","start.native"})Refuse(()=>p.WriteOnce(n,"x"));
   Refuse(()=>OwnedVmDefinition.Prepare(c.P,j));Check(p.ReadOptionalOnce("definition.intent")==null&&p.ReadOptionalOnce("definition.native")==null);
  }});
  Test("admission-only-cannot-grant-native-definition-admission",()=>{var c=new ProtectedCase("admission-check");using(var a=c.Lease())using(var p=ProtectedAttempt.PinDefinitionJournalController(c.PlanPath,c.PlanHash,a)){
   LegacyHandoff.Completion completed=null;Refuse(()=>WindowsStartAdmission.VerifyDefinition(p,c.P.AdmissionHash,a,ref completed));Check(completed==null);
  }});
  Test("ordinary-define-cannot-use-read-only-inspector",()=>{var c=new ProtectedCase();using(var a=c.Lease())using(var p=ProtectedAttempt.PinDefinitionJournalController(c.PlanPath,c.PlanHash,a))Refuse(()=>WindowsStartAdmission.InspectDefinitionAdmission(p,a));});
  Test("read-only-worker-window-does-not-change-consumed-plan",()=>{var p=Plan();string before=p.Encode();p.ValidateWorkerWindow(902000,922000,903000,true);Refuse(()=>p.ValidateWorkerWindow(902000,922000,903000,false));Check(p.Encode()==before&&p.Deadline==901000);});
  Test("admission-only-rejects-missing-completed-cut-without-journal-write",()=>{var c=new ProtectedCase("admission-check");using(var a=c.Lease())using(var p=ProtectedAttempt.PinDefinitionJournalController(c.PlanPath,c.PlanHash,a)){
   Refuse(()=>WindowsStartAdmission.InspectDefinitionAdmission(p,a));Check(p.ReadOptionalOnce("definition.native")==null&&p.ReadOptionalOnce("definition.intent")==null);
  }});
  Test("private-role-failure-preserves-original-error-and-authority",()=>{var c=new ProtectedCase();using(var a=c.Lease()){
   var original=new InvalidOperationException("fixture admission refused\nprivate detail");bool same=false;
   try{DefinitionWorkerEntry.RunRole(a,"child",()=>{throw original;});}catch(Exception e){same=Object.ReferenceEquals(e,original);}Check(same);
   string[] row=a.ReadOnce("child.failure").Split('\n');Check(row.Length==10&&row[0]=="owned-rpc-definition-failure/1"&&row[1]==a.ContractHash&&row[2]=="child"&&row[4]==a.Origin.ToString()&&row[5]==a.Deadline.ToString());
   Check(Encoding.UTF8.GetString(Convert.FromBase64String(row[7]))==original.Message&&row[8]=="provider-fenced=false;reservation-release=false;retry=false");
   Check(a.ReadOptionalOnce("child.result")==null&&a.ReadOptionalOnce("definition.native")==null);
  }});
  Test("private-role-failure-bounded-unicode-and-no-overwrite",()=>{var c=new ProtectedCase();using(var a=c.Lease()){
   Refuse(()=>DefinitionWorkerEntry.RunRole(a,"child",()=>{throw new InvalidOperationException(new string('\u754c',10000));}));
   string first=a.ReadOnce("child.failure");Check(Encoding.UTF8.GetByteCount(first)<4096&&Encoding.UTF8.GetString(Convert.FromBase64String(first.Split('\n')[7])).Length==512);
   var second=new IOException("second");bool same=false;try{DefinitionWorkerEntry.RunRole(a,"child",()=>{throw second;});}catch(Exception e){same=Object.ReferenceEquals(e,second);}Check(same&&a.ReadOnce("child.failure")==first);
  }});
  Test("private-role-failure-cannot-reopen-disposed-authority",()=>{var c=new ProtectedCase();var a=c.Lease();a.Dispose();var original=new IOException("original");bool same=false;
   try{DefinitionWorkerEntry.RunRole(a,"child",()=>{throw original;});}catch(Exception e){same=Object.ReferenceEquals(e,original);}Check(same&&!File.Exists(Path.Combine(Path.GetDirectoryName(c.Contract),"child.failure")));
  });
  Test("role-success-and-invalid-role-do-not-publish-failure",()=>{var c=new ProtectedCase();using(var a=c.Lease()){
   Check(DefinitionWorkerEntry.RunRole(a,"child",()=>0)==0&&a.ReadOptionalOnce("child.failure")==null);bool called=false;
   Refuse(()=>DefinitionWorkerEntry.RunRole(a,"definition.native",()=>{called=true;return 0;}));Check(!called&&a.ReadOptionalOnce("definition.native")==null);
  }});
  Test("plan-canonical-roundtrip",()=>Check(OwnedVmDefinitionPlan.Parse(Plan().Encode()).Encode()==Plan().Encode()));
  Test("plan-extra-field-refused",()=>Refuse(()=>OwnedVmDefinitionPlan.Parse(Plan().Encode()+"x")));
  Test("plan-total-substitution-refused",()=>Refuse(()=>OwnedVmDefinitionPlan.Parse(Plan().Encode().Replace("support=1073741824","support=0"))));
  Test("protected-definition-plan-and-consumed-journal",()=>{var c=new ProtectedCase();using(var a=c.Lease())using(var p=ProtectedAttempt.PinDefinitionJournalController(c.PlanPath,c.PlanHash,a)){Check(p.DefinitionPlan.Encode()==c.P.Encode());var j=new OwnedDefinitionJournal(p);OwnedVmDefinition.Prepare(c.P,j);Refuse(()=>OwnedVmDefinition.Prepare(c.P,j));Check(j.Read("definition.intent")==c.P.Encode());}});
  Test("definition-contract-not-inert-authority",()=>{var c=new ProtectedCase();Refuse(()=>{using(var a=ProtectedAttempt.PinController(c.Contract,c.Hash)){};});});
  Test("definition-contract-not-start-authority",()=>{var c=new ProtectedCase();Refuse(()=>{using(var a=ProtectedAttempt.PinProviderController(c.Contract,c.Hash)){};});});
  Test("definition-unknown-operation-refused",()=>{var c=new ProtectedCase("start");Refuse(()=>{using(var a=c.Lease()){};});});
  Test("protected-definition-wrong-plan-hash",()=>{var c=new ProtectedCase("define",true);using(var a=c.Lease())Refuse(()=>{using(var p=ProtectedAttempt.PinDefinitionJournalController(c.PlanPath,c.PlanHash,a)){};});});
  Test("definition-worker-cannot-extend-original900s",()=>Refuse(()=>Plan().ValidateWorkerWindow(900000,920000,900001,false)));
  Test("definition-plan-other-boot-refused",()=>{var c=new ProtectedCase("define",false,true);using(var a=c.Lease())Refuse(()=>{using(var p=ProtectedAttempt.PinDefinitionJournalController(c.PlanPath,c.PlanHash,a)){};});});
  Test("reconcile-can-record-observation-but-never-submit",()=>{var c=new ProtectedCase("definition-reconcile");using(var a=c.Lease())using(var p=ProtectedAttempt.PinDefinitionJournalController(c.PlanPath,c.PlanHash,a)){var j=new OwnedDefinitionJournal(p);Refuse(()=>OwnedVmDefinition.Prepare(c.P,j));Refuse(()=>j.WriteOnce("definition.native","x"));Refuse(()=>j.WriteOnce("definition.receipt","x"));j.WriteOnce("definition.job","fixture-observation");Check(j.Read("definition.job")=="fixture-observation");}});
  Test("definition-journal-cannot-publish-start",()=>{var c=new ProtectedCase();using(var a=c.Lease())using(var p=ProtectedAttempt.PinDefinitionJournalController(c.PlanPath,c.PlanHash,a)){var j=new OwnedDefinitionJournal(p);Refuse(()=>j.WriteOnce("start.intent","x"));Refuse(()=>j.WriteOnce("definition.intent","x"));}});
  Test("controller-requires-exclusive-fixed-vm-root",()=>{var c=new ProtectedCase();Check(DefinitionWorkerController.DefinitionRoot(c.P)==Path.GetDirectoryName(c.P.Root));Refuse(()=>DefinitionWorkerController.DefinitionRoot(Plan()));});
 }
 public static int Main(string[] args){try{
  if(args.Length!=1)throw new ArgumentException("Exact compiled entry fixture required");fixtureImage=File.ReadAllBytes(args[0]);if(fixtureImage.Length>262144)throw new ArgumentException("Fixture image bound");
  BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);long end=BoundedWorker.MonotonicMilliseconds()+9000;new Thread(()=>{while(BoundedWorker.MonotonicMilliseconds()<end)Thread.Sleep(5);TerminateProcess(GetCurrentProcess(),124);}){IsBackground=true}.Start();
  Test("synchronous-return-persists-guid-before-off-query",()=>{var c=new Case();var r=c.Run();Check(r.Guid==Id&&r.DefinitionSettled&&!r.StartAuthorized&&!r.ReservationMayRelease&&c.V.Defines==1&&c.V.Reads==0&&c.V.Off==1);});
  Test("lost-response-remains-held",()=>{var c=new Case();c.V.Lose=true;Refuse(()=>c.Run());Check(c.Read().State=="response-lost-held"&&c.V.Defines==1);});
  Test("duplicate-submission-never-calls-native-twice",()=>{var c=new Case();c.Run();Refuse(()=>c.Run());Check(c.V.Defines==1);});
  Test("expired-original-window-before-submit",()=>{var c=new Case();c.R.Clock=901000;Refuse(()=>c.Run());Check(c.V.Defines==0&&c.J.Read("definition.submit")==null);});
  Test("clock-before-origin-refused",()=>{var c=new Case();c.R.Clock=999;Refuse(()=>c.Run());Check(c.V.Defines==0);});
  Test("admission-refusal-consumes-attempt",()=>{var c=new Case();c.R.Deny=true;Refuse(()=>c.Run());c.R.Deny=false;Refuse(()=>c.Run());Check(c.V.Defines==0);});
  Test("receipt-write-failure-does-not-query-provider",()=>{var c=new Case();c.J.Fail="definition.receipt";Refuse(()=>c.Run());Check(c.V.Defines==1&&c.V.Reads==0&&c.V.Off==0&&c.Read().State=="response-lost-held");});
  Test("async-pending-no-system-acknowledgment",()=>{var c=new Case();c.V.Response=new DefinitionResponse(4096,JobRef,null);c.V.State=4;Check(c.Run().State=="definition-pending-held"&&c.V.Associations==0&&c.J.Read("definition.system")==null);});
  Test("async-settled-associated-guid-persisted",()=>{var c=new Case();c.V.Response=new DefinitionResponse(4096,JobRef,null);Check(c.Run().Guid==Id&&c.V.Associations==1&&c.V.Off==1);});
  Test("async-returned-guid-needs-no-association-scan",()=>{var c=new Case();c.V.Response=new DefinitionResponse(4096,JobRef,SystemRef);Check(c.Run().Guid==Id&&c.V.Associations==0);});
  Test("job-identity-change-refuses-reconciliation",()=>{var c=new Case();c.V.Response=new DefinitionResponse(4096,JobRef,null);c.V.State=4;c.Run();c.V.State=7;c.V.Submitted="20261031070200.000000+000";Refuse(()=>c.Read());Check(c.V.Associations==0);});
  Test("association-job-recycle-refused",()=>{var c=new Case();c.V.Response=new DefinitionResponse(4096,JobRef,null);c.V.RecycledAfterAssociation=true;Refuse(()=>c.Run());Check(c.J.Read("definition.system")==null&&c.V.Off==0);});
  Test("completed-job-error-does-not-admit-system",()=>{var c=new Case();c.V.Response=new DefinitionResponse(4096,JobRef,null);c.V.Error=32768;Check(c.Run().State=="definition-failed-held"&&c.V.Associations==0);});
  Test("recurring-job-stays-held",()=>{var c=new Case();c.V.Response=new DefinitionResponse(4096,JobRef,null);c.V.Runs=2;Check(!c.Run().DefinitionSettled&&c.V.Associations==0);});
  Test("provider-refusal-never-admits-or-retries",()=>{var c=new Case();c.V.Response=new DefinitionResponse(4,null,null);Check(c.Run().State=="provider-refused-held");Refuse(()=>c.Run());Check(c.V.Defines==1&&c.V.Off==0);});
  Test("synchronous-missing-system-stays-held",()=>{var c=new Case();c.V.Response=new DefinitionResponse(0,null,null);Refuse(()=>c.Run());Check(c.V.Associations==0&&c.V.Off==0);});
  Test("off-readback-failure-cannot-publish-off",()=>{var c=new Case();c.V.WrongOff=true;Refuse(()=>c.Run());Check(c.J.Read("definition.system")!=null&&c.J.Read("definition.off")==null);});
  Test("result-system-write-failure-prevents-off-query",()=>{var c=new Case();c.J.Fail="definition.system";Refuse(()=>c.Run());Check(c.V.Off==0);});
  Test("reader-loss-refuses-even-durable-result",()=>{var c=new Case();c.Run();c.R.ObservationDenied=true;Refuse(()=>c.Read());Check(c.V.Off==1);});
  Test("permit-keeps-original-clock-and-actual-guid",()=>{var c=new Case();var result=c.Run();var permit=c.P.Permit(result.Guid);Check(permit.Origin==1000&&permit.Deadline==901000&&permit.VmGuid==Id&&permit.TotalBytes==21474836480&&permit.ImageHash==c.P.ProviderImageHash);});
  Test("changed-definition-intent-refused",()=>{var c=new Case();c.J.Data["definition.intent"]+="x";Refuse(()=>c.Run());Check(c.V.Defines==0);});
  Test("resulting-system-remote-host-refused",()=>Refuse(()=>OwnedVmDefinition.SystemReference(@"\\foreign\root\virtualization\v2:"+SystemRef)));
  Test("resulting-system-other-namespace-refused",()=>Refuse(()=>OwnedVmDefinition.SystemReference(@"root\cimv2:"+SystemRef)));
  Test("resulting-system-extra-key-refused",()=>Refuse(()=>OwnedVmDefinition.SystemReference(SystemRef+",Other=\"x\"")));
  Test("resulting-system-guid-not-name-guess",()=>Refuse(()=>OwnedVmDefinition.SystemReference("Msvm_ComputerSystem.Name=\"enclave-owned-rpc-test\"")));
  Test("gen2-settings-exclude-app-isolation-firmware",()=>{var settings=HyperVOwnedDefinition.SystemSettings(Plan());Check((string)settings["VirtualSystemSubType"]=="Microsoft:Hyper-V:SubType:2"&&!settings.ContainsKey("GuestStateFile")&&!settings.ContainsKey("FirmwareFile")&&(ushort)settings["AutomaticStartupAction"]==2&&(ushort)settings["AutomaticShutdownAction"]==4&&!(bool)settings["AutomaticSnapshotsEnabled"]&&(ushort)settings["UserSnapshotType"]==2);});
  Test("static19gib-reservation-not-default-minmax",()=>{var settings=HyperVOwnedDefinition.MemorySettings();Check((ulong)settings["VirtualQuantity"]==19456&&(ulong)settings["Reservation"]==19456&&(ulong)settings["Limit"]==19456&&!(bool)settings["DynamicMemoryEnabled"]);});
  Test("four-vcpu-readback-accepted",()=>HyperVOwnedDefinition.RequireProcessors(new object[]{(ulong)4}));
  Test("wrong-vcpu-readback-refused",()=>Refuse(()=>HyperVOwnedDefinition.RequireProcessors(new object[]{(ulong)2})));
  Test("missing-vcpu-readback-refused",()=>Refuse(()=>HyperVOwnedDefinition.RequireProcessors(new object[]{})));
  Test("duplicate-vcpu-readback-refused",()=>Refuse(()=>HyperVOwnedDefinition.RequireProcessors(new object[]{(ulong)4,(ulong)4})));
  Test("plan-overflow-refused",()=>Refuse(()=>new OwnedVmDefinitionPlan(new string('a',32),new string('b',32),new string('c',64),new string('d',64),@"C:\OwnedRpcFixture\"+new string('a',32),Int64.MaxValue,Int64.MaxValue,new string('e',64),new string('f',64))));
  PredecessorTests();ProtectedTests();count+=OwnedVmBootHarness.Run();
  Console.WriteLine("RESULT tests="+count+" providerCallsAreFakes=true vmChanged=false");return 0;
 }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
