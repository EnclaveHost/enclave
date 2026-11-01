using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using Enclave.OwnedRpc;
public static class NativeRpcPairHarness {
 static int count;static byte[] image;
 [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")]static extern bool TerminateProcess(IntPtr p,uint code);
 static void Check(bool b){if(!b)throw new Exception("Assertion");}
 static void Refuse(Action f){bool refused=false;try{f();}catch{refused=true;}Check(refused);}
 static void Test(string name,Action f){f();count++;Console.WriteLine("PASS "+name);}
 static void DirectoryNew(string path){var acl=new DirectorySecurity();acl.SetOwner(new SecurityIdentifier("S-1-5-32-544"));acl.SetAccessRuleProtection(true,false);foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));Directory.CreateDirectory(path,acl);}
 static void Put(string path,byte[] b){var acl=new FileSecurity();acl.SetOwner(new SecurityIdentifier("S-1-5-32-544"));acl.SetAccessRuleProtection(true,false);foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));using(var f=new FileStream(path,FileMode.CreateNew,FileSystemRights.WriteData,FileShare.None,4096,FileOptions.WriteThrough,acl)){f.Write(b,0,b.Length);f.Flush(true);}}
 sealed class Fixture {
  internal string Contract,Hash,PlanPath,Profile;internal NativeRpcDefinitionPlan P;
  internal Fixture(ProtectedAttempt pin){P=pin.NativeDefinitionPlan;PlanPath=Path.Combine(P.Root,"native-definition-plan.txt");}
  internal Fixture(string profile,Fixture original=null,long endDelta=0){
   bool backup=profile=="native-lifecycle-backup";if(backup)profile="native-lifecycle";
   Profile=backup?"native-lifecycle-backup":profile;string n=Guid.NewGuid().ToString("N"),boot=ProtectedAttempt.CurrentBoot(),drive=Path.GetPathRoot(Environment.SystemDirectory),parent=Path.Combine(drive,"rpc-lifecycle-ci-"+n),root=Path.Combine(parent,n);DirectoryNew(parent);DirectoryNew(root);Put(Path.Combine(root,"entry.exe"),image);long now=BoundedWorker.MonotonicMilliseconds();
   if(original==null){string id=Guid.NewGuid().ToString("N"),pp=Path.Combine(drive,"rpc-lifecycle-plan-"+id),pr=Path.Combine(pp,id);DirectoryNew(pp);DirectoryNew(pr);
    P=new NativeRpcDefinitionPlan(id,boot,new string('c',32),"rpc"+new string('d',32),"0x"+new string('e',64),new string('f',64),new string('a',64),new string('b',64),new string('c',64),new string('d',64),new string('e',64),pr,now,now+900000,new string('f',64),new string('a',64),ProtectedAttempt.Hash(image));PlanPath=Path.Combine(pr,"native-definition-plan.txt");Put(PlanPath,Encoding.UTF8.GetBytes(P.Encode()));
   }else{P=original.P;PlanPath=original.PlanPath;}
   long end=(profile=="native-lifecycle"?P.Deadline+30000:now+20000)+endDelta;string schema=profile=="native-lifecycle"?"owned-native-rpc-lifecycle-v1":profile=="native-start"?"owned-native-rpc-start-worker-v1":"owned-native-rpc-cleanup-worker-v1",op=profile=="native-lifecycle"?(backup?"watch-backup":"watch"):profile=="native-start"?"start":"stop";
   byte[] raw=Encoding.UTF8.GetBytes(String.Join("\n",new[]{schema,n,boot,now.ToString(),end.ToString(),ProtectedAttempt.Hash(image),op,PlanPath,P.Digest,""}));Contract=Path.Combine(root,"contract.txt");Hash=ProtectedAttempt.Hash(raw);Put(Contract,raw);
  }
  internal ProtectedAttempt Lease(){return (Profile=="native-lifecycle"||Profile=="native-lifecycle-backup")?ProtectedAttempt.PinNativeLifecycleController(Contract,Hash):Profile=="native-start"?ProtectedAttempt.PinNativeStartController(Contract,Hash):ProtectedAttempt.PinNativeCleanupController(Contract,Hash);}
  internal ProtectedAttempt Journal(ProtectedAttempt lease){return (Profile=="native-lifecycle"||Profile=="native-lifecycle-backup")?ProtectedAttempt.PinNativeLifecycleJournalController(PlanPath,P.Digest,lease):Profile=="native-start"?ProtectedAttempt.PinNativeStartJournalController(PlanPath,P.Digest,lease):ProtectedAttempt.PinNativeCleanupJournalController(PlanPath,P.Digest,lease);}
 }
 sealed class Journal:IStartJournal{internal readonly Dictionary<string,string> Values=new Dictionary<string,string>();public string Read(string n){string v;return Values.TryGetValue(n,out v)?v:null;}public void WriteOnce(string n,string v){Values.Add(n,v);}}
 static int Child(string[] args){
  using(var l=ProtectedAttempt.PinNativeLifecycleController(args[1],args[2]))using(var pin=ProtectedAttempt.PinNativeLifecycleJournalController(l.PermitPath,l.PermitHash,l)){
   string raw;while((raw=l.ReadOptionalOnce("fixture.peer"))==null){l.CheckDeadline();Thread.Sleep(5);}var f=raw.Split(',');Check(f.Length==2);int pid=Int32.Parse(f[0]);long creation=Int64.Parse(f[1]);
   using(var peer=Process.GetProcessById(pid)){IntPtr handle=peer.Handle;Check(!peer.HasExited&&peer.StartTime.ToUniversalTime().ToFileTimeUtc()==creation);
    var cleanup=new Fixture("native-cleanup",new Fixture(pin));using(var cleanupLease=cleanup.Lease())using(var cleanupPin=cleanup.Journal(cleanupLease)){var journal=new NativeRpcCleanupJournal(cleanupPin);long end=Int64.Parse(args[3]);Check(end>BoundedWorker.MonotonicMilliseconds()&&end<=pin.NativeDefinitionPlan.Deadline);
    var go=new ManualResetEvent(false);int calls=0;bool won=false;
    var watch=new NativeLifecycleWatch(pin.NativeDefinitionPlan.Origin,end,BoundedWorker.MonotonicMilliseconds,()=>peer.HasExited,reason=>{calls++;won=NativeCleanupClaim.Try(journal,l.Nonce);if(won)pin.WriteOnce("native-lifecycle.result","fixture-only-stop:"+l.Nonce);});
    l.WriteOnce("fixture.armed",pid+","+creation);while(!watch.Done.WaitOne(5))l.CheckDeadline();
    Check(calls==1);Console.WriteLine("exact fixture peer pid="+pid+" creation="+creation+" reason="+watch.Reason+" won="+won+" failure="+(watch.Failure==null?"none":watch.Failure.GetType().Name));GC.KeepAlive(handle);return watch.Failure==null?0:2;}
   }
  }
 }
 static void Pair(int kill){
  var a=new Fixture("native-lifecycle");var b=new Fixture("native-lifecycle-backup",a);long end=BoundedWorker.MonotonicMilliseconds()+1800;
  using(var la=a.Lease())using(var lb=b.Lease())using(var pin=a.Journal(la)){
   var children=new List<Process>();try{
    foreach(var c in new[]{a,b}){var info=new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location,"--pair-peer \""+c.Contract+"\" "+c.Hash+" "+end){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};children.Add(Process.Start(info));}
    var handles=new[]{children[0].Handle,children[1].Handle};long[] creation={children[0].StartTime.ToUniversalTime().ToFileTimeUtc(),children[1].StartTime.ToUniversalTime().ToFileTimeUtc()};
    la.WriteOnce("fixture.peer",children[1].Id+","+creation[1]);lb.WriteOnce("fixture.peer",children[0].Id+","+creation[0]);
    foreach(var l in new[]{la,lb})while(l.ReadOptionalOnce("fixture.armed")==null){Check(BoundedWorker.MonotonicMilliseconds()<end&&!children[0].HasExited&&!children[1].HasExited);Thread.Sleep(5);}
    long killedAt=BoundedWorker.MonotonicMilliseconds();if(kill>=0)children[kill].Kill();
    foreach(var child in children)Check(child.WaitForExit(3000));
    var journal=new NativeRpcCleanupJournal(pin);string winner=journal.Read("native-lifecycle.stop");Check(winner==la.Nonce||winner==lb.Nonce);Check(journal.Read("native-lifecycle.result")=="fixture-only-stop:"+winner);
    if(kill>=0){Check(winner==(kill==0?lb.Nonce:la.Nonce));Check(BoundedWorker.MonotonicMilliseconds()<end);Console.WriteLine("exact killed keeper pid="+children[kill].Id+" creation="+creation[kill]+" survivor exit ms="+(BoundedWorker.MonotonicMilliseconds()-killedAt));}
    foreach(var child in children){Console.Write(child.StandardOutput.ReadToEnd());string error=child.StandardError.ReadToEnd();Check(error.Length==0);}
    GC.KeepAlive(handles);
   }finally{foreach(var child in children){if(!child.HasExited){child.Kill();Check(child.WaitForExit(1000));}child.Dispose();}}
  }
 }
 public static int Main(string[] args){try{
  var timer=new Timer(delegate{TerminateProcess(GetCurrentProcess(),125);},null,20000,Timeout.Infinite);BoundedWorker.EnterSupervisorEnvelope(args.Length==0?256UL*1024*1024:128UL*1024*1024);
  image=File.ReadAllBytes(System.Reflection.Assembly.GetExecutingAssembly().Location);if(args.Length==4&&args[0]=="--pair-peer")return Child(args);if(args.Length!=0)return 64;
  Test("work gate requires matching original group receipts from both keepers",()=>{var j=new Journal();string raw="original-workers",hash=NativeRpcDefinitionPlan.Hash(raw);Check(!NativeLifecycleBinding.Bound(j,null)&&!NativeLifecycleBinding.Bound(j,raw));j.WriteOnce(NativeLifecycleBinding.Key(false,true),hash);Check(!NativeLifecycleBinding.Bound(j,raw));j.Values[NativeLifecycleBinding.Key(true,true)]="foreign";Check(!NativeLifecycleBinding.Bound(j,raw));j.Values[NativeLifecycleBinding.Key(true,true)]=hash;Check(NativeLifecycleBinding.Bound(j,raw));});
  Test("actual keeper journals cannot forge opposite arming binding or group authority",()=>{var primary=new Fixture("native-lifecycle");foreach(bool backup in new[]{false,true}){var c=backup?new Fixture("native-lifecycle-backup",primary):primary;using(var l=c.Lease())using(var p=c.Journal(l)){p.WriteOnce(NativeLifecycleBinding.Key(backup,false),"self");p.WriteOnce(NativeLifecycleBinding.Key(backup,true),"group");Refuse(()=>p.WriteOnce(NativeLifecycleBinding.Key(!backup,false),"foreign"));Refuse(()=>p.WriteOnce(NativeLifecycleBinding.Key(!backup,true),"foreign"));if(backup)Refuse(()=>p.WriteOnce("native-start.workers","forged"));else p.WriteOnce("native-start.workers","original");}}});
  Test("actual keeper contract pins distinguish primary backup and foreign original",()=>{var primary=new Fixture("native-lifecycle");var backup=new Fixture("native-lifecycle-backup",primary);var start=new Fixture("native-start",primary);using(var l=start.Lease())using(var p=start.Journal(l)){Check(p.PinLifecycleEvidence(primary.Contract,primary.Hash,false)!=p.PinLifecycleEvidence(backup.Contract,backup.Hash,true));Refuse(()=>p.PinLifecycleEvidence(primary.Contract,primary.Hash,true));Refuse(()=>p.PinLifecycleEvidence(backup.Contract,backup.Hash,false));var foreign=new Fixture("native-lifecycle-backup");Refuse(()=>p.PinLifecycleEvidence(foreign.Contract,foreign.Hash,true));}});
  Test("actual independent backup claims cleanup when exact primary process dies",()=>Pair(0));
  Test("actual independent primary claims cleanup when exact backup process dies",()=>Pair(1));
  Test("actual two processes at original fixture deadline yield one durable cleanup claimant",()=>Pair(-1));
  Test("torn or consumed cleanup claims cannot authorize a second dispatch",()=>{var c=new Fixture("native-cleanup");using(var l=c.Lease())using(var p=c.Journal(l)){var j=new NativeRpcCleanupJournal(p);Check(NativeCleanupClaim.Try(j,"first"));Check(!NativeCleanupClaim.Try(j,"again"));Check(j.Read("native-lifecycle.stop")=="first");}var torn=new Fixture("native-cleanup");Put(Path.Combine(torn.P.Root,"native-lifecycle.stop.pending"),new byte[0]);using(var l=torn.Lease())using(var p=torn.Journal(l))Refuse(()=>NativeCleanupClaim.Try(new NativeRpcCleanupJournal(p),"retry"));});
  Test("native admission adds second keeper commitment without lowering existing reserves",()=>{Check(WindowsStartAdmission.NativeRequired-WindowsStartAdmission.Required==(192L+512L)*1048576);Check(WindowsStartAdmission.Required==20L*1073741824+39388L*1048576+18L*1073741824+1073741824+512L*1048576+192L*1048576);});
  Console.WriteLine("COMPLETE "+count+" PASS; independent administrator fixture processes and exclusive journal claim actual; SYSTEM keeper topology scheduling transfer and provider cleanup compile only");GC.KeepAlive(timer);return 0;
 }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
