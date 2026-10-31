// Disposable hosted tests. No Hyper-V provider calls or VM mutations.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using Enclave.OwnedRpc;
public static class StartupCleanupHarness {
 static int count;
 static void Check(bool ok){if(!ok)throw new Exception("Assertion failed");}
 static void Refuse(Action a){bool failed=false;try{a();}catch{failed=true;}Check(failed);}
 static void Test(string n,Action a){a();count++;Console.WriteLine("PASS "+n);}
 static Dictionary<string,object> Binding(){return new Dictionary<string,object>{{"schema","owned-rpc-startup-cleanup/1"},{"imageHash",new string('e',64)},{"reservedBytes",192L*1048576}};}
 static readonly OwnedVmPermit Permit=new OwnedVmPermit(new string('a',32),new string('b',32),new string('c',64),new string('d',64),"12345678-1234-1234-1234-123456789012",@"C:\owned\vm",1000,901000,19L*1073741824,1073741824);
 static readonly string PermitHash=ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(Permit.Encode()));
 static StartIdentity Identity(){var p=Permit;return new StartIdentity(p.Attempt,p.Boot,p.AdmissionHash,PermitHash,p.VmGuid,p.VmName,p.OwnerNote,p.ConfigurationRoot,p.Origin,p.Deadline,123,100,456,200,p.ImageHash);}
 static string Hash(string s){return ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(s));}
 static Dictionary<string,object> Adoption(){return new Dictionary<string,object>{{"schema","owned-rpc-operator-adoption/1"},{"permit",PermitHash},{"boot",Permit.Boot},{"vmGuid",Permit.VmGuid},{"startIntent",Hash(Identity().Encode())},{"startReceipt",Hash("fixture-receipt-not-readiness")},{"reportHash",new string('f',64)},{"observedAt",2000L},{"decision","retain-owned-vm"}};}
 static void Validate(Dictionary<string,object> d,long now=3000){StartupOperatorAdoption.Validate(StartRecords.Encode(d),Permit,PermitHash,Identity().Encode(),"fixture-receipt-not-readiness",new string('f',64),now);}
 public static int Main(string[] args){try{
  if(args.Length==2&&args[0]=="--watchdog"){
   BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);StartupCleanupController.ArmAbsoluteDeadline(Int64.Parse(args[1]));Thread.Sleep(5000);return 99;
  }
  if(args.Length!=0)throw new ArgumentException("No native mode");
  BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);StartupCleanupController.ArmAbsoluteDeadline(BoundedWorker.MonotonicMilliseconds()+12000);
  Test("cleanup-binding-fixed-reservation",()=>Check(StartupCleanupBinding.Parse(Binding()).ImageHash==new string('e',64)));
  Test("cleanup-underreservation-refused",()=>{var d=Binding();d["reservedBytes"]=128L*1048576;Refuse(()=>StartupCleanupBinding.Parse(d));});
  Test("cleanup-extra-option-refused",()=>{var d=Binding();d["retry"]=true;Refuse(()=>StartupCleanupBinding.Parse(d));});
  Test("cleanup-missing-image-refused",()=>{var d=Binding();d.Remove("imageHash");Refuse(()=>StartupCleanupBinding.Parse(d));});
  Test("cleanup-image-substitution-refused",()=>{var d=Binding();d["imageHash"]="not-a-digest";Refuse(()=>StartupCleanupBinding.Parse(d));});
  Test("original-startup-deadline-retained",()=>Check(StartupCleanupController.CleanupDeadline(1000,901000,2000)==931000));
  Test("arming-at-startup-expiry-refused",()=>Refuse(()=>StartupCleanupController.CleanupDeadline(1000,901000,901000)));
  Test("arming-before-origin-refused",()=>Refuse(()=>StartupCleanupController.CleanupDeadline(1000,901000,999)));
  Test("startup-extension-refused",()=>Refuse(()=>StartupCleanupController.CleanupDeadline(1000,902000,2000)));
  Test("cleanup-overflow-refused",()=>Refuse(()=>StartupCleanupController.CleanupDeadline(Int64.MaxValue-900000,Int64.MaxValue,Int64.MaxValue-1)));
  Test("operator-decision-exact-binding",()=>Validate(Adoption()));
  Test("operator-decision-wrong-vm",()=>{var d=Adoption();d["vmGuid"]="00000000-0000-0000-0000-000000000001";Refuse(()=>Validate(d));});
  Test("operator-decision-wrong-receipt",()=>{var d=Adoption();d["startReceipt"]=new string('0',64);Refuse(()=>Validate(d));});
  Test("operator-decision-other-boot",()=>{var d=Adoption();d["boot"]=new string('0',32);Refuse(()=>Validate(d));});
  Test("operator-decision-expired",()=>Refuse(()=>Validate(Adoption(),901000)));
  Test("operator-decision-future-observation",()=>{var d=Adoption();d["observedAt"]=3001L;Refuse(()=>Validate(d));});
  Test("operator-decision-extra-option",()=>{var d=Adoption();d["release"]=true;Refuse(()=>Validate(d));});
  Test("absent-decision-can-arrive-later",()=>{var p=new StartupAdoptionPoll();int reads=0;Check(!p.Check(()=>true,()=>{reads++;return null;},s=>{throw new Exception();},()=>{}));Check(p.Check(()=>true,()=>{reads++;return "x";},s=>{},()=>{}));Check(reads==2);});
  Test("invalid-decision-read-once-despite-diagnostic-failure",()=>{var p=new StartupAdoptionPoll();int reads=0,logs=0;Func<bool> run=()=>p.Check(()=>true,()=>{reads++;return "x";},s=>{throw new Exception();},()=>{logs++;throw new IOException();});Check(!run()&&!run()&&reads==1&&logs==1);});
  Test("unreadable-decision-does-not-abort-cleanup",()=>{var p=new StartupAdoptionPoll();Check(!p.Check(()=>true,()=>{throw new IOException();},s=>{},()=>{throw new IOException();}));});
  Test("expiry-during-validation-cannot-adopt",()=>{var p=new StartupAdoptionPoll();bool before=true;Check(!p.Check(()=>before,()=>"x",s=>{before=false;},()=>{}));});
  Test("expired-decision-not-read",()=>{var p=new StartupAdoptionPoll();Check(!p.Check(()=>false,()=>{throw new Exception();},s=>{},()=>{}));});
  Test("independent-watchdog-kills-blocked-main",()=>{
   long deadline=BoundedWorker.MonotonicMilliseconds()+500;
   using(var p=Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,"--watchdog "+deadline){UseShellExecute=false,CreateNoWindow=true})){
    IntPtr exact=p.Handle;try{Check(p.WaitForExit(2500));Check(p.ExitCode==127&&BoundedWorker.MonotonicMilliseconds()>=deadline);}finally{if(!p.HasExited){p.Kill();Check(p.WaitForExit(2000));}}
   }
  });
  Console.WriteLine("RESULT tests="+count+" providerCalls=false vmChanged=false");return 0;
 }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
