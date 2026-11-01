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
public static class NativeRpcStateHarness {
 static int count;static readonly byte[] state={1,3,5,7};static byte[] image;
 [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")]static extern bool TerminateProcess(IntPtr p,uint code);
 static void Check(bool b){if(!b)throw new Exception("Assertion");}
 static void Refuse(Action f){bool refused=false;try{f();}catch{refused=true;}Check(refused);}
 static void Test(string name,Action f){f();count++;Console.WriteLine("PASS "+name);}
 static void DirectoryNew(string path){var acl=new DirectorySecurity();acl.SetOwner(new SecurityIdentifier("S-1-5-32-544"));acl.SetAccessRuleProtection(true,false);foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));Directory.CreateDirectory(path,acl);}
 static void Put(string path,byte[] b){var acl=new FileSecurity();acl.SetOwner(new SecurityIdentifier("S-1-5-32-544"));acl.SetAccessRuleProtection(true,false);foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));using(var f=new FileStream(path,FileMode.CreateNew,FileSystemRights.WriteData,FileShare.None,4096,FileOptions.WriteThrough,acl)){f.Write(b,0,b.Length);f.Flush(true);}}
 sealed class Fixture {
  internal string Contract,Hash,PlanPath,Profile;internal NativeRpcDefinitionPlan P;
  internal Fixture(string profile,Fixture original=null,long endDelta=0){
   Profile=profile;string n=Guid.NewGuid().ToString("N"),boot=ProtectedAttempt.CurrentBoot(),drive=Path.GetPathRoot(Environment.SystemDirectory),parent=Path.Combine(drive,"rpc-lifecycle-ci-"+n),root=Path.Combine(parent,n);DirectoryNew(parent);DirectoryNew(root);Put(Path.Combine(root,"entry.exe"),image);long now=BoundedWorker.MonotonicMilliseconds();
   if(original==null){string id=Guid.NewGuid().ToString("N"),pp=Path.Combine(drive,"rpc-lifecycle-plan-"+id),pr=Path.Combine(pp,id);DirectoryNew(pp);DirectoryNew(pr);
    P=new NativeRpcDefinitionPlan(id,boot,new string('c',32),"rpc"+new string('d',32),"0x"+new string('e',64),new string('f',64),new string('a',64),new string('b',64),new string('c',64),new string('d',64),new string('e',64),pr,now,now+900000,new string('f',64),ProtectedAttempt.Hash(state),ProtectedAttempt.Hash(image));PlanPath=Path.Combine(pr,"native-definition-plan.txt");Put(PlanPath,Encoding.UTF8.GetBytes(P.Encode()));Put(P.State,state);
   }else{P=original.P;PlanPath=original.PlanPath;}
   long end=(profile=="native-lifecycle"?P.Deadline+30000:now+20000)+endDelta;string schema=profile=="native-lifecycle"?"owned-native-rpc-lifecycle-v1":profile=="native-start"?"owned-native-rpc-start-worker-v1":profile=="define"||profile=="reconcile"?"owned-native-rpc-definition-worker-v1":"owned-native-rpc-cleanup-worker-v1",op=profile=="native-lifecycle"?"watch":profile=="native-start"?"start":profile=="define"||profile=="reconcile"?profile:"stop";
   byte[] raw=Encoding.UTF8.GetBytes(String.Join("\n",new[]{schema,n,boot,now.ToString(),end.ToString(),ProtectedAttempt.Hash(image),op,PlanPath,P.Digest,""}));Contract=Path.Combine(root,"contract.txt");Hash=ProtectedAttempt.Hash(raw);Put(Contract,raw);
  }
  internal ProtectedAttempt Lease(){return Profile=="native-lifecycle"?ProtectedAttempt.PinNativeLifecycleController(Contract,Hash):Profile=="native-start"?ProtectedAttempt.PinNativeStartController(Contract,Hash):Profile=="define"||Profile=="reconcile"?ProtectedAttempt.PinNativeDefinitionController(Contract,Hash):ProtectedAttempt.PinNativeCleanupController(Contract,Hash);}
  internal ProtectedAttempt Journal(ProtectedAttempt lease){return Profile=="native-lifecycle"?ProtectedAttempt.PinNativeLifecycleJournalController(PlanPath,P.Digest,lease):Profile=="native-start"?ProtectedAttempt.PinNativeStartJournalController(PlanPath,P.Digest,lease):Profile=="define"||Profile=="reconcile"?ProtectedAttempt.PinNativeDefinitionJournalController(PlanPath,P.Digest,lease):ProtectedAttempt.PinNativeCleanupJournalController(PlanPath,P.Digest,lease);}
 }
 static void Pin(ProtectedAttempt p,NativeRpcDefinitionPlan plan){p.PinNativeAsset("guest-state.vmgs",plan.StateHash,64*1024*1024,true);}
 static string Capture(Fixture c){using(var l=c.Lease())using(var p=c.Journal(l)){Pin(p,c.P);p.ObserveNativeState();return new NativeRpcDefinitionJournal(p).Read("native-state.initial");}}
 static void WriteState(string path,long size){using(var f=new FileStream(path,FileMode.Open,FileAccess.Write,FileShare.ReadWrite)){f.SetLength(size);if(size>0){f.WriteByte(9);f.Flush(true);}}}
 static void StartPin(Fixture original,Action<ProtectedAttempt> action){var c=new Fixture("native-start",original);using(var l=c.Lease())using(var p=c.Journal(l)){Pin(p,c.P);action(p);}}
 public static int Main(string[] args){try{
  if(args.Length!=0)return 64;var timer=new Timer(delegate{TerminateProcess(GetCurrentProcess(),125);},null,20000,Timeout.Infinite);BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);image=File.ReadAllBytes(System.Reflection.Assembly.GetExecutingAssembly().Location);
  Test("initial private state digest and incarnation persist before provider submit",()=>{var c=new Fixture("define");using(var l=c.Lease())using(var p=c.Journal(l)){Pin(p,c.P);var j=new NativeRpcDefinitionJournal(p);var f=j.Read("native-state.initial").Split('\n');Check(f.Length==7&&f[1]==c.P.Digest&&f[2]==c.P.StateHash&&f[4]=="4"&&j.Read("native-definition.submit")==null);p.ObserveNativeState();Refuse(()=>Pin(p,c.P));}});
  Test("provider-updated bytes and bounded growth retain original file custody at start",()=>{var c=new Fixture("define");Capture(c);WriteState(c.P.State,8192);Check(ProtectedAttempt.Hash(File.ReadAllBytes(c.P.State))!=c.P.StateHash);StartPin(c,p=>{p.ObserveNativeState();WriteState(c.P.State,16384);p.ObserveNativeState();});});
  Test("missing state receipt cannot adopt even pristine bytes",()=>{var c=new Fixture("define");Refuse(()=>StartPin(c,p=>{}));});
  Test("changed pristine template refuses before initial receipt",()=>{var c=new Fixture("define");WriteState(c.P.State,4);using(var l=c.Lease())using(var p=c.Journal(l)){Refuse(()=>Pin(p,c.P));Check(new NativeRpcDefinitionJournal(p).Read("native-state.initial")==null);}});
  Test("replacement with identical bytes is not the original file incarnation",()=>{var c=new Fixture("define");Capture(c);File.Move(c.P.State,c.P.State+".old");Put(c.P.State,state);Refuse(()=>StartPin(c,p=>{}));});
  Test("held state denies rename and deletion while still permitting provider writes",()=>{var c=new Fixture("define");Capture(c);StartPin(c,p=>{Refuse(()=>File.Move(c.P.State,c.P.State+".old"));Refuse(()=>File.Delete(c.P.State));WriteState(c.P.State,4);p.ObserveNativeState();});});
  Test("empty or oversized state refuses during held custody",()=>{foreach(long size in new[]{0L,64L*1024*1024+1}){var c=new Fixture("define");Capture(c);StartPin(c,p=>{WriteState(c.P.State,size);Refuse(()=>p.ObserveNativeState());});}});
  Test("permissions drift refuses on the exact retained state handle",()=>{var c=new Fixture("define");Capture(c);StartPin(c,p=>{var acl=File.GetAccessControl(c.P.State);acl.SetAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-5-32-544"),FileSystemRights.Read,AccessControlType.Allow));File.SetAccessControl(c.P.State,acl);Refuse(()=>p.ObserveNativeState());});});
  Test("foreign initial receipt cannot authorize another original plan",()=>{var c=new Fixture("define");string raw=Capture(c);var foreign=new Fixture("define");Put(Path.Combine(foreign.P.Root,"native-state.initial"),Encoding.UTF8.GetBytes(raw));Refuse(()=>StartPin(foreign,p=>{}));});
  Test("existing or torn initial custody cannot be recaptured or bypassed",()=>{var c=new Fixture("define");Capture(c);using(var l=c.Lease())using(var p=c.Journal(l))Refuse(()=>Pin(p,c.P));var torn=new Fixture("define");Put(Path.Combine(torn.P.Root,"native-state.initial.pending"),new byte[0]);Refuse(()=>Capture(torn));Refuse(()=>StartPin(torn,p=>{}));});
  Test("only definition role can write initial state custody",()=>{var original=new Fixture("define");foreach(string role in new[]{"native-start","native-lifecycle","native-cleanup","reconcile"}){var c=new Fixture(role,original);using(var l=c.Lease())using(var p=c.Journal(l))Refuse(()=>p.WriteOnce("native-state.initial","forbidden"));}});
  Test("late initial capture after provider submission is refused",()=>{var c=new Fixture("define");using(var l=c.Lease())using(var p=c.Journal(l)){p.WriteOnce("native-definition.submit","consumed");Refuse(()=>Pin(p,c.P));Check(new NativeRpcDefinitionJournal(p).Read("native-state.initial")==null);}});
  Console.WriteLine("COMPLETE "+count+" PASS; actual administrator file and journal custody; provider mutations simulated by in-place writes; SYSTEM Hyper-V VMGS format and growth remain unqualified");GC.KeepAlive(timer);return 0;
 }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
