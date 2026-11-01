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
 // Synthetic identities with the exact 21-row status/memory shape observed on
 // 2026-10-31. Twelve memory fields are absent; none is silently valued at zero.
 static Dictionary<string,object> Node(bool raw){
  string[] states={"queued","refused","running","failed","failed","failed","failed","failed","failed","stopped","failed","stopped","stopped","refused","refused","refused","refused","refused","refused","refused","refused"};
  long[] sizes={-1,-1,1024,128,512,256,128,128,128,2048,8192,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1};
  var rows=new object[states.Length];
  for(int i=0;i<rows.Length;i++){
   var r=new Dictionary<string,object>{{"id","fixture-"+i},{"status",states[i]},{"isolationHeld",false},{"isolationRetireFailed",false}};
   if(sizes[i]>=0)r.Add("memMb",sizes[i]);
   if(raw){if(i==2)r.Add("isolation",new Dictionary<string,object>{{"kind","fixture"}});}else r.Add("hasIsolation",i==2);
   rows[i]=r;
  }
  return new Dictionary<string,object>{{"deployments",rows}};
 }
 static Dictionary<string,object> Row(Dictionary<string,object> n,int i){return (Dictionary<string,object>)((object[])n["deployments"])[i];}
 static string Receipt(Dictionary<string,object> n,bool raw=false){return WindowsStartAdmission.DeploymentReceipt(n,raw);}
 static void AdmissionTests(){
  Test("admission-four-second-window-boundary",()=>{Check(WindowsStartAdmission.FreshnessMilliseconds==4000);WindowsStartAdmission.RequireFresh(100,3349,"fixture");WindowsStartAdmission.RequireFresh(100,4100,"fixture");Refuse(()=>WindowsStartAdmission.RequireFresh(100,4101,"fixture"));});
  Test("admission-clock-reversal-and-overflow-refused",()=>{Refuse(()=>WindowsStartAdmission.RequireFresh(100,99,"fixture"));Refuse(()=>WindowsStartAdmission.RequireFresh(Int64.MinValue,Int64.MaxValue,"fixture"));});
  Test("admission-timeout-retains-stage-and-elapsed",()=>{try{WindowsStartAdmission.RequireFresh(100,4101,"listeners");throw new Exception("Accepted stale");}catch(TimeoutException e){Check(e.Message.Contains("exceeds four seconds; phase=listeners elapsedMs=4001"));}});
  Test("actual-native-physical-abi-and-wmi-total-agree",()=>{var m=WindowsStartAdmission.Physical();Check(m.Size==64&&m.Total>0&&m.Available<=m.Total);using(var q=new System.Management.ManagementObjectSearcher("root\\cimv2","SELECT TotalVisibleMemorySize FROM Win32_OperatingSystem"))using(var rows=q.Get()){int n=0;foreach(System.Management.ManagementObject row in rows)using(row){n++;Check(m.Total==Convert.ToUInt64(row["TotalVisibleMemorySize"])*1024);}Check(n==1);}});
  Test("actual-native-disk-capacity-bounded",()=>{long free=WindowsStartAdmission.DiskAvailable();Check(free>0&&free<=new DriveInfo(@"C:\").TotalSize);});
  using(var self=System.Diagnostics.Process.GetCurrentProcess()){
   uint pid=(uint)self.Id;long created=self.StartTime.ToUniversalTime().ToFileTimeUtc();string image=self.MainModule.FileName;
   Test("actual-held-manager-query-and-dispose",()=>{var h=new WindowsStartAdmission.HeldManager(pid,created,image);try{h.Check();}finally{h.Dispose();}Refuse(()=>h.Check());});
   Test("actual-held-manager-wrong-creation-refused",()=>Refuse(()=>{using(var h=new WindowsStartAdmission.HeldManager(pid,created+1,image)){} }));
   Test("actual-held-manager-wrong-image-refused",()=>Refuse(()=>{using(var h=new WindowsStartAdmission.HeldManager(pid,created,image+".wrong")){} }));
  }
  var native=new Dictionary<string,object>{{"pid",1},{"alive",true},{"creationFileTime","134375086385617521"},{"image",@"C:\runtime\node.exe"}};
  var recorded=new Dictionary<string,object>{{"pid",1},{"created",DateTime.FromFileTimeUtc(134375086385617520).ToString("o")},{"exe",@"C:\runtime\node.exe"}};
  Test("native-creation-keeps-full-tick-after-cim-cross-binding",()=>Check(WindowsStartAdmission.ManagerCreation(native,recorded)==134375086385617521));
  Test("native-and-cim-different-microsecond-refused",()=>{var n=new Dictionary<string,object>(native);n["creationFileTime"]="134375086385617531";Refuse(()=>WindowsStartAdmission.ManagerCreation(n,recorded));});
  Test("native-manager-receipt-identity-and-liveness-refused",()=>{foreach(string key in new[]{"pid","image","alive","creationFileTime"}){var n=new Dictionary<string,object>(native);n[key]=key=="pid"?(object)2:key=="alive"?(object)false:key=="image"?(object)@"C:\other.exe":"0134375086385617521";Refuse(()=>WindowsStartAdmission.ManagerCreation(n,recorded));}});
  Test("unfenced-failed-to-claiming-remains-different",()=>{var a=Node(false);var b=Node(false);Row(a,3)["status"]="failed";Row(b,3)["status"]="claiming";Check(Receipt(a)!=Receipt(b));});
  Test("fenced-known-unallocated-retry-matches-history",()=>{var a=Node(false);var b=Node(true);Row(a,3)["status"]="failed";Row(b,3)["status"]="claiming";Check(WindowsStartAdmission.DeploymentReceipt(a,false,true)==WindowsStartAdmission.DeploymentReceipt(b,true,true));});
  Test("fenced-retry-does-not-equate-running-or-other-statuses",()=>{var a=Node(false);Row(a,3)["status"]="failed";string expected=WindowsStartAdmission.DeploymentReceipt(a,false,true);foreach(string status in new[]{"running","queued","refused","stopped","fenced-unallocated-retry"}){var b=Node(false);Row(b,3)["status"]=status;Check(expected!=WindowsStartAdmission.DeploymentReceipt(b,false,true));}});
  Test("fenced-retry-memory-change-still-differs",()=>{var a=Node(false);var b=Node(false);Row(a,3)["status"]="failed";Row(b,3)["status"]="claiming";Row(b,3)["memMb"]=256;Check(WindowsStartAdmission.DeploymentReceipt(a,false,true)!=WindowsStartAdmission.DeploymentReceipt(b,false,true));});
  Test("fenced-retry-new-identity-still-differs",()=>{var a=Node(false);var b=Node(false);Row(a,3)["status"]="failed";Row(b,3)["status"]="claiming";Row(b,3)["id"]="new-work";Check(WindowsStartAdmission.DeploymentReceipt(a,false,true)!=WindowsStartAdmission.DeploymentReceipt(b,false,true));});
  Test("fenced-retry-isolation-held-and-retire-cannot-normalize",()=>{foreach(string flag in new[]{"hasIsolation","isolationHeld","isolationRetireFailed"}){var a=Node(false);var b=Node(false);Row(a,3)["status"]="failed";Row(b,3)["status"]="claiming";Row(a,3)[flag]=true;Row(b,3)[flag]=true;Check(WindowsStartAdmission.DeploymentReceipt(a,false,true)!=WindowsStartAdmission.DeploymentReceipt(b,false,true));}});
  Test("fenced-retry-new-isolation-still-differs",()=>{var a=Node(false);var b=Node(false);Row(a,3)["status"]="failed";Row(b,3)["status"]="claiming";Row(b,3)["hasIsolation"]=true;Check(WindowsStartAdmission.DeploymentReceipt(a,false,true)!=WindowsStartAdmission.DeploymentReceipt(b,false,true));});
  Test("claiming-unknown-memory-refused-even-under-fence",()=>{var n=Node(false);Row(n,0)["status"]="claiming";Refuse(()=>Receipt(n));Refuse(()=>WindowsStartAdmission.DeploymentReceipt(n,false,true));});
  Test("fenced-zero-memory-not-normalized-as-retry",()=>{var a=Node(false);var b=Node(false);Row(a,3)["status"]="failed";Row(b,3)["status"]="claiming";Row(a,3)["memMb"]=0;Row(b,3)["memMb"]=0;Check(WindowsStartAdmission.DeploymentReceipt(a,false,true)!=WindowsStartAdmission.DeploymentReceipt(b,false,true));});
  Test("fenced-history-equivalence-never-replaces-live-exact-receipt",()=>{var a=Node(true);var b=Node(true);Row(a,3)["status"]="failed";Row(b,3)["status"]="claiming";Check(WindowsStartAdmission.DeploymentReceipt(a,true,true)==WindowsStartAdmission.DeploymentReceipt(b,true,true)&&Receipt(a,true)!=Receipt(b,true));});
  Test("difference-exact-status-values",()=>{var a=Node(false);var b=Node(false);Row(b,0)["status"]="refused";string d=WindowsStartAdmission.DeploymentDifference(Receipt(a),Receipt(b));Check(d.Contains("changed=1 first=\"fixture-0\" mask=1")&&d.Contains("queued")&&d.Contains("refused"));});
  Test("difference-null-presence-bit",()=>{var a=Node(false);var b=Node(false);Row(b,0)["memMb"]=null;Check(WindowsStartAdmission.DeploymentDifference(Receipt(a),Receipt(b)).Contains("mask=2"));});
  Test("difference-memory-and-isolation-bits",()=>{var a=Node(false);var b=Node(false);Row(b,3)["memMb"]=256;Row(b,3)["hasIsolation"]=true;Check(WindowsStartAdmission.DeploymentDifference(Receipt(a),Receipt(b)).Contains("mask=12"));});
  Test("difference-added-identity-and-total-count",()=>{var a=Node(false);var b=Node(false);Row(b,0)["id"]="aaa-new";string d=WindowsStartAdmission.DeploymentDifference(Receipt(a),Receipt(b));Check(d.Contains("changed=2 first=\"aaa-new\" mask=64")&&d.Contains("expected=null"));});
  Test("difference-type-sensitive-status",()=>{var a=Node(false);var b=Node(false);Row(a,3)["status"]="failed";Row(b,3)["status"]="fenced-unallocated-retry";Check(WindowsStartAdmission.DeploymentDifference(WindowsStartAdmission.DeploymentReceipt(a,false,true),Receipt(b)).Contains("mask=1"));});
  Test("difference-long-values-bounded-no-extra-payload",()=>{var a=Node(false);var b=Node(false);Row(b,0)["status"]=new string('z',4096);Row(b,0)["unrelated"]="private-extra-marker";string d=WindowsStartAdmission.DeploymentDifference(Receipt(a),Receipt(b));Check(d.Length<=450&&d.Contains("sha256:")&&!d.Contains("private-extra-marker")&&!d.Contains(new string('z',100)));});
  Test("difference-format-failure-never-bypasses-refusal",()=>Check(WindowsStartAdmission.DeploymentDifference("malformed","{}")=="comparison-detail-unavailable"));
  string original=Receipt(Node(false));
  Test("node-observed-21-row-shape-raw-matches-projection",()=>Check(original==Receipt(Node(true),true)));
  Test("node-unknown-is-not-zero",()=>{var n=Node(false);Row(n,0)["memMb"]=0;Check(original!=Receipt(n));});
  Test("node-null-is-not-absent",()=>{var n=Node(false);Row(n,0)["memMb"]=null;Check(original!=Receipt(n));});
  Test("node-null-raw-matches-projection",()=>{var n=Node(false);var r=Node(true);Row(n,0)["memMb"]=null;Row(r,0)["memMb"]=null;Check(Receipt(n)==Receipt(r,true));});
  Test("node-memory-change-detected",()=>{var n=Node(false);Row(n,2)["memMb"]=2048;Check(original!=Receipt(n));});
  Test("node-status-change-detected",()=>{var n=Node(false);Row(n,0)["status"]="refused";Check(original!=Receipt(n));});
  Test("node-isolation-change-detected",()=>{var n=Node(false);Row(n,3)["hasIsolation"]=true;Check(original!=Receipt(n));});
  Test("node-held-change-detected",()=>{var n=Node(false);Row(n,3)["isolationHeld"]=true;Check(original!=Receipt(n));});
  Test("node-retire-change-detected",()=>{var n=Node(false);Row(n,3)["isolationRetireFailed"]=true;Check(original!=Receipt(n));});
  Test("node-order-does-not-change-receipt",()=>{var n=Node(false);Array.Reverse((object[])n["deployments"]);Check(original==Receipt(n));});
  Test("node-duplicate-identity-refused",()=>{var n=Node(false);Row(n,0)["id"]="fixture-1";Refuse(()=>Receipt(n));});
  Test("node-negative-memory-refused",()=>{var n=Node(false);Row(n,3)["memMb"]=-1;Refuse(()=>Receipt(n));});
  Test("node-string-memory-refused",()=>{var n=Node(false);Row(n,3)["memMb"]="128";Refuse(()=>Receipt(n));});
  Test("node-fractional-memory-refused",()=>{var n=Node(false);Row(n,3)["memMb"]=128.5;Refuse(()=>Receipt(n));});
  Test("node-running-memory-unknown-refused",()=>{var n=Node(false);Row(n,0)["status"]="running";Refuse(()=>Receipt(n));});
  Test("node-isolated-memory-unknown-refused",()=>{var n=Node(true);Row(n,0)["isolation"]=new object();Refuse(()=>Receipt(n,true));});
  Test("node-held-memory-unknown-refused",()=>{var n=Node(false);Row(n,0)["isolationHeld"]=true;Refuse(()=>Receipt(n));});
  Test("node-retire-memory-unknown-refused",()=>{var n=Node(false);Row(n,0)["isolationRetireFailed"]=true;Refuse(()=>Receipt(n));});
  Test("node-receipt-does-not-replace-pending-authority",()=>Refuse(()=>WindowsStartAdmission.PendingReceipt(new object[]{Node(false),Node(false),Node(false)})));
  Test("node-missing-deployment-inventory-refused",()=>Refuse(()=>Receipt(new Dictionary<string,object>())));
 }
 const string GuidText="12345678-1234-1234-1234-123456789012";
 public static int Main(string[] args){try{
  if(args.Length!=0)throw new ArgumentException("No native mode");
  BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);StartupCleanupController.ArmAbsoluteDeadline(BoundedWorker.MonotonicMilliseconds()+12000);
  AdmissionTests();
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
