using System;using System.Collections.Generic;using System.Diagnostics;using System.IO;using System.Threading;using System.Text;using System.Security.AccessControl;using System.Security.Principal;using System.Runtime.InteropServices;using Enclave.OwnedRpc;
public static class NativeRpcCleanupDispatchHarness {
 static int count;static byte[] image;
 [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();[DllImport("kernel32.dll")]static extern bool TerminateProcess(IntPtr p,uint code);
 static void Check(bool b){if(!b)throw new Exception("Assertion");}static void Refuse(Action f){bool hit=false;try{f();}catch{hit=true;}Check(hit);}static void Test(string n,Action f){f();count++;Console.WriteLine("PASS "+n);}static string H(char c){return new string(c,64);}
 static void NewDirectory(string path){var a=new DirectorySecurity();a.SetOwner(new SecurityIdentifier("S-1-5-32-544"));a.SetAccessRuleProtection(true,false);foreach(string s in new[]{"S-1-5-18","S-1-5-32-544"})a.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(s),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));Directory.CreateDirectory(path,a);}
 static void Put(string path,byte[] b){var a=new FileSecurity();a.SetOwner(new SecurityIdentifier("S-1-5-32-544"));a.SetAccessRuleProtection(true,false);foreach(string s in new[]{"S-1-5-18","S-1-5-32-544"})a.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(s),FileSystemRights.FullControl,AccessControlType.Allow));using(var f=new FileStream(path,FileMode.CreateNew,FileSystemRights.WriteData,FileShare.None,4096,FileOptions.WriteThrough,a)){f.Write(b,0,b.Length);f.Flush(true);}}
 sealed class Fixture {
  internal readonly string Contract,Hash,Role;internal readonly NativeRpcDefinitionPlan P;
  internal Fixture(string role,Fixture original=null){Role=role;string nonce=Guid.NewGuid().ToString("N"),parent=Path.Combine(Path.GetPathRoot(Environment.SystemDirectory),"rpc-dispatch-"+nonce),root=Path.Combine(parent,nonce);NewDirectory(parent);NewDirectory(root);Put(Path.Combine(root,"entry.exe"),image);long now=BoundedWorker.MonotonicMilliseconds();
   if(original==null){string n=Guid.NewGuid().ToString("N"),r=Path.Combine(parent,n);NewDirectory(r);P=new NativeRpcDefinitionPlan(n,ProtectedAttempt.CurrentBoot(),new string('a',32),"rpc"+new string('b',32),"0x"+H('c'),H('d'),H('e'),H('f'),H('a'),H('b'),H('c'),r,now,now+900000,H('d'),H('e'),ProtectedAttempt.Hash(image));Put(Path.Combine(r,"native-definition-plan.txt"),Encoding.UTF8.GetBytes(P.Encode()));}else P=original.P;
   bool keeper=role=="watch"||role=="watch-backup";string raw=String.Join("\n",new[]{keeper?"owned-native-rpc-lifecycle-v1":"owned-native-rpc-cleanup-worker-v1",nonce,P.Boot,now.ToString(),(keeper?P.Deadline+30000:now+20000).ToString(),P.WorkerImageHash,role,Path.Combine(P.Root,"native-definition-plan.txt"),P.Digest,""});Contract=Path.Combine(root,"contract.txt");Hash=NativeRpcDefinitionPlan.Hash(raw);Put(Contract,Encoding.UTF8.GetBytes(raw));
  }
  internal ProtectedAttempt Lease(){return Role=="watch"||Role=="watch-backup"?ProtectedAttempt.PinNativeLifecycleController(Contract,Hash):ProtectedAttempt.PinNativeCleanupController(Contract,Hash);}
  internal ProtectedAttempt Pin(ProtectedAttempt l){return Role=="watch"||Role=="watch-backup"?ProtectedAttempt.PinNativeLifecycleJournalController(l.PermitPath,l.PermitHash,l):ProtectedAttempt.PinNativeCleanupJournalController(l.PermitPath,l.PermitHash,l);}
 }
 static string Identity(ProtectedAttempt l){using(var p=Process.GetCurrentProcess())return p.Id+","+p.StartTime.ToUniversalTime().ToFileTimeUtc()+","+l.Token+",child";}
 static void Await(ProtectedAttempt l,string name,long end){while(l.ReadOptionalOnce(name)==null){Check(BoundedWorker.MonotonicMilliseconds()<end);Thread.Sleep(5);}}
 static int Child(string[] args){bool producer=args[0]=="--producer";
  using(var lease=producer?ProtectedAttempt.PinNativeLifecycleController(args[1],args[2]):ProtectedAttempt.PinNativeCleanupController(args[1],args[2]))
  using(var pin=producer?ProtectedAttempt.PinNativeLifecycleJournalController(lease.PermitPath,lease.PermitHash,lease):ProtectedAttempt.PinNativeCleanupJournalController(lease.PermitPath,lease.PermitHash,lease)){
   long end=Int64.Parse(args[3]);Check(end>BoundedWorker.MonotonicMilliseconds()&&end<=lease.Deadline);var timer=new Timer(delegate{TerminateProcess(GetCurrentProcess(),125);},null,(int)(end-BoundedWorker.MonotonicMilliseconds()),Timeout.Infinite);
   var journal=new NativeRpcCleanupJournal(pin);
   if(producer){pin.WriteOnce("native-lifecycle.dispatch","inert-producer-local-dispatch");lease.WriteOnce("fixture.armed",Identity(lease));while(true){lease.CheckDeadline();Thread.Sleep(5);}}
   lease.WriteOnce("fixture.armed",Identity(lease));Await(lease,"fixture.go",end);
   string claim=NativeCleanupClaim.Record(pin.NativeDefinitionPlan,lease,H('d'),Identity(lease));
   bool won;try{won=NativeCleanupClaim.Try(journal,claim);}catch(Exception e){if(!(e is IOException)&&!(e is InvalidOperationException)&&!(e is System.ComponentModel.Win32Exception))throw;lease.WriteOnce("fixture.held",e.GetType().Name);return 2;}lease.WriteOnce(won?"fixture.claimed":"fixture.held",NativeRpcDefinitionPlan.Hash(claim));
   if(!won)return 0;
   Await(lease,"fixture.release",end);NativeCleanupClaim.Require(journal,claim);
   // Inert marker only: actual provider submission/settlement is not exercised.
   journal.WriteOnce("native-stop.invoke","INERT-FIXTURE-ONLY:"+NativeRpcDefinitionPlan.Hash(claim));lease.WriteOnce("fixture.result","one-inert-call");GC.KeepAlive(timer);return 0;
  }
 }
 static Process Start(Fixture f,string mode,long end){return Process.Start(new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location,mode+" \""+f.Contract+"\" "+f.Hash+" "+end){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true});}
 static void Handoff(bool beforeLaunch,bool compete,bool killChild){
  var producer=new Fixture("watch");var one=new Fixture("stop",producer);var two=compete?new Fixture("stop",producer):null;
  using(var pl=producer.Lease())using(var pp=producer.Pin(pl))using(var first=one.Lease())using(var second=two==null?null:two.Lease())using(var reader=one.Pin(first)){
   long end=BoundedWorker.MonotonicMilliseconds()+5000;var children=new List<Process>();var handles=new List<IntPtr>();var creations=new List<long>();
   try{
    var parent=Start(producer,"--producer",end);children.Add(parent);handles.Add(parent.Handle);creations.Add(parent.StartTime.ToUniversalTime().ToFileTimeUtc());Await(pl,"fixture.armed",end);
    var j=new NativeRpcCleanupJournal(reader);Check(j.Read("native-lifecycle.dispatch")=="inert-producer-local-dispatch"&&j.Read("native-lifecycle.stop")==null);
    if(beforeLaunch){parent.Kill();Check(parent.WaitForExit(1000));Check(j.Read("native-lifecycle.stop")==null);}
    foreach(var f in compete?new[]{one,two}:new[]{one}){var child=Start(f,"--cleanup-child",end);children.Add(child);handles.Add(child.Handle);creations.Add(child.StartTime.ToUniversalTime().ToFileTimeUtc());}
    Await(first,"fixture.armed",end);if(second!=null)Await(second,"fixture.armed",end);first.WriteOnce("fixture.go","once");if(second!=null)second.WriteOnce("fixture.go","once");
    while(first.ReadOptionalOnce("fixture.claimed")==null&&(second==null||second.ReadOptionalOnce("fixture.claimed")==null)){Check(BoundedWorker.MonotonicMilliseconds()<end);Thread.Sleep(5);}
    string claim=j.Read("native-lifecycle.stop");var d=StartRecords.Parse(claim,new[]{"schema","plan","workers","contract","hash","child"});bool firstWon=StartRecords.Text(d["contract"])==one.Contract;Check(firstWon||compete&&StartRecords.Text(d["contract"])==two.Contract);var winner=firstWon?first:second;var winningProcess=children[firstWon?1:2];Await(winner,"fixture.claimed",end);
    if(!beforeLaunch){parent.Kill();Check(parent.WaitForExit(1000));}Check(!winningProcess.HasExited);long killed=BoundedWorker.MonotonicMilliseconds();
    if(killChild){winningProcess.Kill();Check(winningProcess.WaitForExit(1000));Check(!NativeCleanupClaim.Try(j,"later-worker-cannot-replay"));Check(j.Read("native-stop.invoke")==null);}
    else{winner.WriteOnce("fixture.release","once");Check(winningProcess.WaitForExit(1500)&&winningProcess.ExitCode==0);Check(winner.ReadOnce("fixture.result")=="one-inert-call");Check(j.Read("native-stop.invoke")=="INERT-FIXTURE-ONLY:"+NativeRpcDefinitionPlan.Hash(claim));}
    for(int i=1;i<children.Count;i++){Check(children[i].WaitForExit(1500));if(children[i]!=winningProcess)Check(children[i].ExitCode==0||children[i].ExitCode==2);else if(!killChild)Check(children[i].ExitCode==0);Check(children[i].StandardError.ReadToEnd().Length==0);}
    Check(j.Read("native-lifecycle.stop")==claim&&!File.Exists(Path.Combine(one.P.Root,"native-lifecycle.stop.pending")));Console.WriteLine("producer="+parent.Id+" creation="+creations[0]+" exact-dead="+parent.HasExited+" winner="+winningProcess.Id+" creation="+creations[firstWon?1:2]+" exact-dead="+winningProcess.HasExited+" after-producer-death-ms="+(BoundedWorker.MonotonicMilliseconds()-killed));GC.KeepAlive(handles);
   }finally{foreach(var p in children){if(!p.HasExited){p.Kill();Check(p.WaitForExit(1000));}p.Dispose();}}
  }
 }
 public static int Main(string[] args){try{var timer=new Timer(delegate{TerminateProcess(GetCurrentProcess(),126);},null,20000,Timeout.Infinite);BoundedWorker.EnterSupervisorEnvelope(args.Length==0?256UL*1024*1024:128UL*1024*1024);image=File.ReadAllBytes(System.Reflection.Assembly.GetExecutingAssembly().Location);
  if(args.Length==4&&(args[0]=="--producer"||args[0]=="--cleanup-child"))return Child(args);if(args.Length!=0)return 64;
  Test("actual keeper roles can dispatch locally but cannot consume shared cleanup authority",()=>{var a=new Fixture("watch");var b=new Fixture("watch-backup",a);foreach(var f in new[]{a,b})using(var l=f.Lease())using(var pin=f.Pin(l)){var j=new NativeRpcCleanupJournal(pin);string own=f.Role=="watch"?"native-lifecycle.dispatch":"native-lifecycle.backup-dispatch",other=f.Role=="watch"?"native-lifecycle.backup-dispatch":"native-lifecycle.dispatch";j.WriteOnce(own,"local-once");Refuse(()=>j.WriteOnce(own,"retry"));Refuse(()=>j.WriteOnce(other,"foreign"));Refuse(()=>NativeCleanupClaim.Try(j,"premature-common-claim"));Refuse(()=>j.WriteOnce("native-stop.invoke","forbidden"));}});
  Test("actual cleanup stop child can claim once while reconcile cannot",()=>{var a=new Fixture("stop");var b=new Fixture("stop-reconcile",a);using(var l=b.Lease())using(var pin=b.Pin(l))Refuse(()=>NativeCleanupClaim.Try(new NativeRpcCleanupJournal(pin),"read-only"));using(var l=a.Lease())using(var pin=a.Pin(l)){var j=new NativeRpcCleanupJournal(pin);string c=NativeCleanupClaim.Record(a.P,l,H('d'),Identity(l));Check(NativeCleanupClaim.Try(j,c));NativeCleanupClaim.Require(j,c);Check(!NativeCleanupClaim.Try(j,c));Refuse(()=>NativeCleanupClaim.Require(j,c+"foreign"));}});
  Test("claim binds original plan group lease and exact child identity",()=>{var a=new Fixture("stop");using(var l=a.Lease()){string id=Identity(l);Refuse(()=>NativeCleanupClaim.Record(a.P,l,new string('0',64),id));Refuse(()=>NativeCleanupClaim.Record(a.P,l,H('d'),id.Replace(",child",",owner")));Refuse(()=>NativeCleanupClaim.Record(new Fixture("stop").P,l,H('d'),id));Refuse(()=>NativeCleanupClaim.Record(a.P,l,H('d'),"0,1,"+l.Token+",child"));}});
  Test("producer death before worker launch leaves survivor submission available",()=>Handoff(true,false,false));
  Test("producer death after consumed claim cannot kill independently running worker",()=>Handoff(false,false,false));
  Test("two independently running workers race to one inert call despite producer death",()=>Handoff(false,true,false));
  Test("worker death after claim remains ambiguous without takeover or duplicate call",()=>Handoff(false,false,true));
  Test("actual torn shared claim refuses every contender without native call",()=>{var a=new Fixture("stop");Put(Path.Combine(a.P.Root,"native-lifecycle.stop.pending"),new byte[0]);using(var l=a.Lease())using(var pin=a.Pin(l)){var j=new NativeRpcCleanupJournal(pin);Refuse(()=>NativeCleanupClaim.Try(j,"retry"));Check(j.Read("native-stop.invoke")==null);}});
  Test("native admission covers two overlapping cleanup groups without reducing reserves",()=>{Check(WindowsStartAdmission.NativeRequired==WindowsStartAdmission.Required+(192L+512L)*1048576);Check(WindowsStartAdmission.Required==20L*1073741824+39388L*1048576+18L*1073741824+1073741824+512L*1048576+192L*1048576);});
  Console.WriteLine("TOTAL "+count+" PASS; independent administrator fixture processes and protected claims actual; SYSTEM scheduling transfer provider calls and VM unqualified");GC.KeepAlive(timer);return 0;
 }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
