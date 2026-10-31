// Hosted controller/namespace tests. No Hyper-V call, task registration or VM start.
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Enclave.OwnedRpc;
public static class StartupControllerHarness {
 static int count;
 static void Check(bool value){if(!value)throw new Exception("Startup assertion failed");}
 static void Refuse(Action action){bool failed=false;try{action();}catch{failed=true;}Check(failed);}
 static void Test(string name,Action action){action();count++;Console.WriteLine("PASS "+name);}
 static string Plan(string nonce,string boot,long origin){
  string root=Path.Combine(Path.GetPathRoot(Environment.SystemDirectory),"EnclaveRpcVm-"+nonce,nonce);
  return new OwnedVmDefinitionPlan(nonce,boot,new string('c',64),new string('d',64),root,origin,origin+900000,new string('e',64),new string('f',64)).Encode();
 }
 static string Record(string reference){return StartRecords.Encode(new Dictionary<string,object>{{"receipt",new string('a',64)},{"system",reference}});}
 static void ProtectDirectory(string path){var acl=new DirectorySecurity();acl.SetOwner(new SecurityIdentifier("S-1-5-32-544"));acl.SetAccessRuleProtection(true,false);foreach(string sid in new[]{"S-1-5-32-544","S-1-5-18"})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));Directory.CreateDirectory(path,acl);}
 static void ProtectFile(string path,string content){var acl=new FileSecurity();acl.SetOwner(new SecurityIdentifier("S-1-5-32-544"));acl.SetAccessRuleProtection(true,false);foreach(string sid in new[]{"S-1-5-32-544","S-1-5-18"})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));using(var f=new FileStream(path,FileMode.CreateNew,FileSystemRights.WriteData,FileShare.None,4096,FileOptions.WriteThrough,acl)){byte[] b=Encoding.UTF8.GetBytes(content);f.Write(b,0,b.Length);f.Flush(true);}}
 const string GuidText="12345678-1234-1234-1234-123456789012";
 public static int Main(string[] args){try{
  if(args.Length!=0)throw new ArgumentException("No native mode");
  BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);StartupCleanupController.ArmAbsoluteDeadline(BoundedWorker.MonotonicMilliseconds()+12000);
  string raw=Plan(new string('a',32),new string('b',32),1000);var permit=StartupController.PermitFromDefinition(raw,GuidText);
  Test("original-definition-to-permit",()=>Check(permit.Origin==1000&&permit.Deadline==901000&&permit.TotalBytes==21474836480L&&permit.ImageHash==new string('d',64)));
  Test("definition-schema-refused",()=>Refuse(()=>StartupController.PermitFromDefinition(raw.Replace("owned-rpc-definition/1","other/1"),GuidText)));
  Test("definition-other-root-refused",()=>Refuse(()=>StartupController.PermitFromDefinition(raw.Replace("EnclaveRpcVm-","Different-"),GuidText)));
  Test("definition-noncanonical-clock-refused",()=>Refuse(()=>StartupController.PermitFromDefinition(raw.Replace("\n1000\n","\n01000\n"),GuidText)));
  Test("definition-budget-change-refused",()=>Refuse(()=>StartupController.PermitFromDefinition(raw.Replace("guest=20401094656","guest=34359738368"),GuidText)));
  Test("definition-app-identity-refused",()=>Refuse(()=>StartupController.PermitFromDefinition(raw,Guid.Empty.ToString("D"))));
  Test("recorded-returned-guid",()=>Check(StartupController.DefinedGuid(Record(OwnedVmDefinition.SystemReference("Msvm_ComputerSystem.Name=\""+GuidText+"\"")))==GuidText));
  Test("noncanonical-name-only-record-refused",()=>Refuse(()=>StartupController.DefinedGuid(Record("Msvm_ComputerSystem.Name=\""+GuidText+"\""))));
  Test("remote-returned-guid-refused",()=>Refuse(()=>StartupController.DefinedGuid(Record("\\\\remote\\root\\virtualization\\v2:Msvm_ComputerSystem.Name=\""+GuidText+"\""))));
  Test("returned-guid-extra-key-refused",()=>Refuse(()=>StartupController.DefinedGuid(Record("Msvm_ComputerSystem.Name=\""+GuidText+"\",Other=\"x\""))));
  Test("later-short-worker-keeps-original-deadline",()=>StartupController.ValidateWindow(permit,800000,830000,800010));
  Test("short-worker-cannot-extend-original",()=>Refuse(()=>StartupController.ValidateWindow(permit,890000,920000,890010)));
  Test("late-workgate-refused",()=>Refuse(()=>StartupController.ValidateWindow(permit,800000,830000,805000)));
  Test("before-original-refused",()=>Refuse(()=>StartupController.ValidateWindow(permit,999,20000,1001)));
  Test("overlong-short-worker-refused",()=>Refuse(()=>StartupController.ValidateWindow(permit,2000,32001,2010)));
  Test("initial-host-budget-charges-roles-and-cleanup",()=>Check(StartupController.Required==20L*1073741824+18L*1073741824+39388L*1048576+1073741824+1152L*1048576));
  string nonce=Guid.NewGuid().ToString("N"),parent=Path.Combine(Path.GetPathRoot(Environment.SystemDirectory),"EnclaveRpcVm-"+nonce),root=Path.Combine(parent,nonce);ProtectDirectory(parent);ProtectDirectory(root);
  try{
   long origin=BoundedWorker.MonotonicMilliseconds();string actual=Plan(nonce,ProtectedAttempt.CurrentBoot(),origin),path=Path.Combine(root,"definition-plan.txt");ProtectFile(path,actual);string hash=ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(actual));
   Test("actual-protected-staging-custody",()=>{long now=BoundedWorker.MonotonicMilliseconds();using(var pin=ProtectedAttempt.PinStartupStaging(path,hash,now,now+5000))Check(pin.ReadBootDefinition()==actual);});
   Test("actual-staging-cannot-write-start",()=>{long now=BoundedWorker.MonotonicMilliseconds();using(var pin=ProtectedAttempt.PinStartupStaging(path,hash,now,now+5000))Refuse(()=>pin.WriteOnce("start.submit","forbidden"));Check(!File.Exists(Path.Combine(root,"start.submit"))&&!File.Exists(Path.Combine(root,"start.submit.pending")));});
   Test("actual-staging-held-file-cannot-replace",()=>{long now=BoundedWorker.MonotonicMilliseconds();using(var pin=ProtectedAttempt.PinStartupStaging(path,hash,now,now+5000))Refuse(()=>File.Move(path,path+".moved"));Check(File.Exists(path));});
   Test("actual-staging-wrong-hash-refused",()=>{long now=BoundedWorker.MonotonicMilliseconds();Refuse(()=>{using(var pin=ProtectedAttempt.PinStartupStaging(path,new string('0',64),now,now+5000)){} });});
  }finally{Directory.Delete(parent,true);}
  Console.WriteLine("RESULT tests="+count+" providerCalls=false vmChanged=false targetStartupQualified=false");return 0;
 }catch(Exception error){Console.Error.WriteLine(error);return 1;}}
}
