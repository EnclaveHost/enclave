using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
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
 public static int Main(){try{
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
  Console.WriteLine("RESULT tests="+count+" providerCallsAreFakes=true vmChanged=false");return 0;
 }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
