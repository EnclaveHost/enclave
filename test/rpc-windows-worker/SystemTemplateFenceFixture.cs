// Fixed four-byte files inside a protected, one-shot inert attempt. No production
// paths, VM/provider calls, rollback, child process or arbitrary operation input.
using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
namespace Enclave.OwnedRpc {
 public static class SystemTemplateFenceFixture {
  public const string Result="system-template-fixture/1;inherited=true;untrusted-refused=true;normal-authority-unchanged=true;read-denied=true;copy-denied=true;metadata=true;distinct-copies=true;intent-consumed=true;provider-fenced=false;reservation-release=false;token=";
  static void Check(bool value,string message){if(!value)throw new InvalidOperationException(message);}
  static FileSecurity Acl(){
   var s=new FileSecurity();s.SetOwner(new SecurityIdentifier("S-1-5-18"));s.SetAccessRuleProtection(true,false);
   foreach(string id in new[]{"S-1-5-18","S-1-5-32-544"})s.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(id),FileSystemRights.FullControl,AccessControlType.Allow));return s;
  }
  static void Publish(string path,byte[] bytes){
   using(var f=new FileStream(path,FileMode.CreateNew,FileSystemRights.WriteData|FileSystemRights.ReadPermissions,FileShare.None,4096,FileOptions.WriteThrough,Acl())){f.Write(bytes,0,bytes.Length);f.Flush(true);}
  }
  public static void Run(ProtectedAttempt a){
   string stage="system-identity";
   try {
   ProtectedAttempt.RequireSystem();a.CheckDeadline();
   stage="fixture-namespace";
   string records=Path.Combine(a.Root,"template-records");
   var d=new DirectorySecurity();d.SetOwner(new SecurityIdentifier("S-1-5-18"));d.SetAccessRuleProtection(true,false);
   foreach(string id in new[]{"S-1-5-18","S-1-5-32-544"})d.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(id),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
   Check(!Directory.Exists(records),"Fixture already exists");Directory.CreateDirectory(records,d);
   string master=Path.Combine(a.Root,"dummy-master.vmgs"),run=Path.Combine(a.Root,"dummy-running.vmgs"),next=Path.Combine(a.Root,"dummy-new-master.vmgs"),intent=Path.Combine(records,"definition-fence.intent");
   byte[] bytes=new byte[]{1,7,3,9};string hash=ProtectedAttempt.Hash(bytes);
   stage="fixture-files";
   Publish(master,bytes);Publish(run,bytes);Publish(next,bytes);
   // Match the real master: SYSTEM/admin-only inherited rights beneath a
   // protected, held parent. Ordinary ProtectedAttempt files still reject it.
   var inherited=Acl();inherited.SetAccessRuleProtection(false,false);File.SetAccessControl(master,inherited);
   Check(!File.GetAccessControl(master).AreAccessRulesProtected,"Inherited fixture precondition");
   stage="ordinary-authority-refusal";
   bool ordinaryRefused=false;using(var held=File.Open(master,FileMode.Open,FileAccess.Read,FileShare.Read)){
    try{ProtectedAttempt.Authority(held.SafeFileHandle,true,false,master);}catch{ordinaryRefused=true;}
   }Check(ordinaryRefused,"Ordinary strict authority unexpectedly accepted inherited DACL");
   long deadline=Math.Min(a.Deadline,BoundedWorker.MonotonicMilliseconds()+9000);
   stage="untrusted-template-refusal";
   string unsafeMaster=Path.Combine(a.Root,"dummy-untrusted.vmgs");Publish(unsafeMaster,bytes);
   var unsafeAcl=Acl();unsafeAcl.SetAccessRuleProtection(false,false);unsafeAcl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-5-11"),FileSystemRights.WriteData,AccessControlType.Allow));File.SetAccessControl(unsafeMaster,unsafeAcl);
   bool unsafeRefused=false;try{LegacyTemplateFence.Apply(unsafeMaster,hash,4,a.Boot,intent,deadline);}catch{unsafeRefused=true;}
   Check(unsafeRefused&&!File.Exists(intent)&&ProtectedAttempt.Hash(File.ReadAllBytes(unsafeMaster))==hash,"Untrusted template was not refused before intent");
   stage="apply-inherited-fence";
   var receipt=LegacyTemplateFence.Apply(master,hash,4,a.Boot,intent,deadline);
   Check(receipt.PersistentReadDenial&&!receipt.ExistingOperationsSettled&&!receipt.ReservationMayRelease,"Fence receipt scope");
   stage="system-read-refusal";
   bool denied=false;try{File.ReadAllBytes(master);}catch(UnauthorizedAccessException){denied=true;}Check(denied,"SYSTEM content read was not denied");
   stage="system-copy-refusal";
   denied=false;string copy=Path.Combine(a.Root,"dummy-late-copy.vmgs");try{File.Copy(master,copy);}catch(UnauthorizedAccessException){denied=true;}Check(denied&&!File.Exists(copy),"SYSTEM copy was not denied");
   stage="metadata-and-copies";
   Check(File.Exists(master)&&new FileInfo(master).Length==4,"Metadata preflight changed");
   Check(ProtectedAttempt.Hash(File.ReadAllBytes(run))==hash&&ProtectedAttempt.Hash(File.ReadAllBytes(next))==hash,"Independent copies changed");
   stage="immutable-intent";
   byte[] consumed=File.ReadAllBytes(intent);Check(ProtectedAttempt.Hash(consumed)==receipt.IntentHash,"Consumed intent differs");
   bool refused=false;try{LegacyTemplateFence.Apply(master,hash,4,a.Boot,intent,deadline);}catch{refused=true;}
   Check(refused&&ProtectedAttempt.Hash(File.ReadAllBytes(intent))==receipt.IntentHash,"Consumed fence was retried or replaced");
   stage="publish-receipt";
   a.CheckDeadline();a.WriteOnce("template.result",Result+a.Token);
   } catch(Exception error) {
    // Fixed fixture stage/type/HRESULT only. No exception text, paths, ACLs,
    // arbitrary worker output or configuration contents cross this boundary.
    a.WriteOnce("template.failure",stage+";"+error.GetType().Name+";"+error.HResult+";"+a.Token);
    throw;
   }
  }
 }
}
