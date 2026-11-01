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
public static class NativeRpcReadGrantHarness {
 static int count;static bool remaining;
 [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")]static extern bool TerminateProcess(IntPtr p,uint code);
 static void Check(bool ok){if(!ok)throw new Exception("Assertion");}
 static void Refuse(Action f){bool refused=false;try{f();}catch{refused=true;}Check(refused);}
 static void Test(string name,Action f){if(remaining&&!name.StartsWith("actual "))return;f();count++;Console.WriteLine("PASS "+name);}
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
  public NativeDefinitionResponse Response=new NativeDefinitionResponse(0,null,SystemRef);
  public Provider(Journal j){Journal=j;}
  public NativeDefinitionResponse Define(NativeRpcDefinitionPlan p){Defines++;Check(Journal.Read("native-definition.intent")==p.Encode()&&Journal.Read("native-definition.native")!=null);if(Lose)throw new IOException("Lost response");return Response;}
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
 sealed class Security:INativeRpcSecurityProvider {
  internal Journal J;internal int Calls,Reads,Off,Checks;internal bool Lose,WrongSecurity,WrongOff;internal ushort State=7,Error;internal uint Runs=1;internal string Time="20261101070000.000000+000";
  internal NativeDefinitionResponse Response=new NativeDefinitionResponse(0,null,null);
  internal Security(Journal j){J=j;}
  public NativeDefinitionResponse ConfigureSecurity(NativeRpcDefinitionPlan p,string guid,string intent){Check(guid==Id&&J.Read("native-definition.owned")!=null&&J.Read("native-security.native")==intent);J.WriteOnce("native-security.invoke",intent);Calls++;if(Lose)throw new IOException("Lost provider response");return Response;}
  public StartJob ReadJob(string reference){Reads++;Check(reference==JobRef&&J.Read("native-security.receipt")!=null);return new StartJob(reference,"definition-fixture",Time,State,Error,Runs);}
  public void RequireOwnedOff(NativeRpcDefinitionPlan p,string guid){Off++;Check(guid==Id);if(WrongOff)throw new IOException("Owned VM changed");}
  public void RequireSecurity(NativeRpcDefinitionPlan p,string guid){Checks++;Check(guid==Id);if(WrongSecurity)throw new IOException("Security differs");}
 }
 sealed class SecurityCase {
  internal Case C=new Case();internal Security V;internal SecurityCase(){C.Run();V=new Security(C.J);}
  internal string Submit(){return NativeRpcSecurity.Submit(C.P,C.J,V,C.R);}
  internal string Read(){return NativeRpcSecurity.Reconcile(C.P,C.J,V,C.R);}
 }


 const string Sid="S-1-5-83-1-123-456-789-1011";
 sealed class Access:INativeRpcReadAccess {
  internal Journal J;internal Runtime R;internal NativeRpcDefinitionPlan P;internal string Account=Sid,Fail;internal int Applies,Observes,Captures;internal bool Expire,Changed;
  internal Access(SecurityCase c){J=c.C.J;R=c.C.R;P=c.C.P;}
  public string Resolve(string guid){Check(guid==Id);return Account;}
  public string Capture(string name,string sid){Captures++;return name+",00000001:0000000000000002:0000000000000003,1,"+new string('a',64)+","+new string('b',64);}
  public void Apply(string name,string sid,string snapshot){Check(J.Read("native-read.submit")==NativeRpcDefinitionPlan.Hash(J.Read("native-read.intent"))&&J.Read("native-read.receipt")==null);Applies++;if(name==Fail)throw new IOException("Injected failed grant");if(Expire)R.Clock=P.Deadline;}
  public void Observe(string name,string sid,string snapshot){Observes++;if(Changed)throw new IOException("Changed ACL or file identity");}
 }
 sealed class GrantCase {internal SecurityCase C=new SecurityCase();internal Access A;internal GrantCase(){C.Submit();A=new Access(C);}internal string Run(bool ro=false){return NativeRpcReadGrant.Run(C.C.P,C.C.J,C.C.R,A,ro);}}
 static RawSecurityDescriptor Descriptor(){return new RawSecurityDescriptor("O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)");}
 static string AclHash(RawSecurityDescriptor d){return ProtectedAttempt.ReadGrantSecurityHash(d);}
 public static int Main(string[] args){try{
  if(args.Length!=1||args[0]!="--remaining")throw new ArgumentException("Explicit remaining fixture selection required");remaining=true;
  var timer=new Timer(delegate{TerminateProcess(GetCurrentProcess(),125);},null,20000,Timeout.Infinite);BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);fixtureImage=File.ReadAllBytes(System.Reflection.Assembly.GetExecutingAssembly().Location);
  Test("three fixed grants consume intent before mutation and observe without repeat",()=>{var c=new GrantCase();string h=c.Run();Check(h==NativeRpcReadGrant.VerifyCompleted(c.C.C.P,c.C.C.J)&&c.A.Applies==3&&c.A.Captures==3&&c.A.Observes==3);Check(c.Run(true)==h&&c.A.Applies==3&&c.A.Observes==6);});
  Test("partial second ACL mutation stays held with no retry or success receipt",()=>{var c=new GrantCase();c.A.Fail="image.container";Refuse(()=>c.Run());Check(c.A.Applies==2&&c.C.C.J.Read("native-read.receipt")==null);c.A.Fail=null;Check(c.Run()==null&&c.Run(true)==null&&c.A.Applies==2);});
  Test("lost receipt stays held even if all three ACL operations returned",()=>{var c=new GrantCase();c.C.C.J.Fail="native-read.receipt";Refuse(()=>c.Run());Check(c.A.Applies==3&&c.A.Observes==0);c.C.C.J.Fail=null;Check(c.Run()==null&&c.A.Applies==3);});
  Test("read-only lease never creates intent and failed submit never invokes ACL",()=>{var c=new GrantCase();Check(c.Run(true)==null&&c.A.Applies==0&&c.A.Captures==0);c.C.C.J.Fail="native-read.submit";Refuse(()=>c.Run());Check(c.A.Applies==0);c.C.C.J.Fail=null;Check(c.Run()==null&&c.A.Applies==0);});
  Test("changed original VM security and account refuse completed grant",()=>{var c=new GrantCase();c.Run();c.A.Account="S-1-5-83-1-1-2-3-4";Refuse(()=>c.Run(true));c.A.Account=Sid;c.C.C.J.Data.Remove("native-security.observed");Refuse(()=>c.Run(true));Check(c.A.Applies==3);});
  Test("changed observed ACL identity and original deadline prevent success",()=>{var c=new GrantCase();c.A.Changed=true;Refuse(()=>c.Run());Check(c.A.Applies==3);c=new GrantCase();c.A.Expire=true;Refuse(()=>c.Run());Check(c.A.Applies==1&&c.C.C.J.Read("native-read.receipt")==null);});
  Test("tampered fixed file list and receipt context cannot verify",()=>{var c=new GrantCase();c.Run();string raw=c.C.C.J.Data["native-read.intent"];c.C.C.J.Data["native-read.intent"]=raw.Replace("runtime.igvm","guest-state.vmgs");Refuse(()=>NativeRpcReadGrant.VerifyCompleted(c.C.C.P,c.C.C.J));c.C.C.J.Data["native-read.intent"]=raw.Replace(Id,"87654321-4321-4321-4321-210987654321");Refuse(()=>NativeRpcReadGrant.VerifyCompleted(c.C.C.P,c.C.C.J));});
  Test("VM group foreign identities malformed and noncanonical SIDs refused",()=>{foreach(string bad in new[]{"S-1-5-83-0","S-1-5-18","S-1-5-83-1","S-1-5-83-1-1-2-3-4-5","S-1-5-83-1-01-2-3-4"})Refuse(()=>NativeRpcReadGrant.Sid(bad));NativeRpcReadGrant.Sid(Sid);});
  Test("read ACE preserves owner group system admin and grants no writes inheritance",()=>{var before=Descriptor();var next=NativeRpcReadGrant.AddRead(before,Sid);Check(before.DiscretionaryAcl.Count==2&&next.DiscretionaryAcl.Count==3&&next.Owner==before.Owner&&next.Group==before.Group&&next.ControlFlags==before.ControlFlags);var ace=(CommonAce)next.DiscretionaryAcl[2];Check(ace.SecurityIdentifier.Value==Sid&&ace.AccessMask==0x120089&&ace.AceFlags==AceFlags.None&&(ace.AccessMask&0xd0176)==0);Refuse(()=>NativeRpcReadGrant.AddRead(next,Sid));});
  Test("unprotected foreign owner broad access and inherited ACE refused",()=>{foreach(string bad in new[]{"O:BAG:BAD:(A;;FA;;;SY)(A;;FA;;;BA)","O:WDG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)","O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;WD)","O:BAG:BAD:P(A;OI;FA;;;SY)(A;;FA;;;BA)","O:BAG:BAD:P(A;;FA;;;SY)"})Refuse(()=>NativeRpcReadGrant.AddRead(new RawSecurityDescriptor(bad),Sid));});
  Test("descriptor receipt ignores only auto-inherit bookkeeping and detects permission changes",()=>{var a=NativeRpcReadGrant.AddRead(Descriptor(),Sid);var b=new RawSecurityDescriptor(a.ControlFlags|ControlFlags.DiscretionaryAclAutoInherited|ControlFlags.DiscretionaryAclAutoInheritRequired,a.Owner,a.Group,a.SystemAcl,a.DiscretionaryAcl);Check(AclHash(a)==AclHash(b));var c=NativeRpcReadGrant.AddRead(Descriptor(),Sid);((CommonAce)c.DiscretionaryAcl[2]).AccessMask|=2;Check(AclHash(a)!=AclHash(c));c=NativeRpcReadGrant.AddRead(Descriptor(),Sid);c.Group=new SecurityIdentifier("S-1-5-18");Check(AclHash(a)!=AclHash(c));c=NativeRpcReadGrant.AddRead(Descriptor(),Sid);c.SetFlags(c.ControlFlags&~ControlFlags.DiscretionaryAclProtected);Check(AclHash(a)!=AclHash(c));});
  Test("actual held file DACL grant readback preserves identity and denies replacement",()=>{
   string root=Path.Combine(Path.GetPathRoot(Environment.SystemDirectory),"rpc-read-ci-"+Guid.NewGuid().ToString("N"));DirectoryNew(root);string path=Path.Combine(root,"inert.bin");Put(path,new byte[]{42});
   using(var h=ProtectedAttempt.CreateFile(path,0x60081,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero)){
    Check(!h.IsInvalid);Refuse(()=>File.Delete(path));Refuse(()=>File.Move(path,path+".early"));long size;string identity=ProtectedAttempt.ReadGrantFileIdentity(h,out size);Check(size==1);
    var before=new RawSecurityDescriptor(File.GetAccessControl(path).GetSecurityDescriptorBinaryForm(),0);var after=NativeRpcReadGrant.AddRead(before,Sid);
    Refuse(()=>ProtectedAttempt.SetReadGrantOnHandle(h,Sid,new string('0',64),AclHash(after)));
    try{ProtectedAttempt.SetReadGrantOnHandle(h,Sid,AclHash(before),AclHash(after));}catch{Console.WriteLine("ACL planned="+after.GetSddlForm(AccessControlSections.All)+" actual="+ProtectedAttempt.ReadGrantDescriptor(h).GetSddlForm(AccessControlSections.All));throw;}
    Console.WriteLine("ACL flags before="+before.ControlFlags+" planned="+after.ControlFlags+" actual="+ProtectedAttempt.ReadGrantDescriptor(h).ControlFlags);
    Check(AclHash(new RawSecurityDescriptor(File.GetAccessControl(path).GetSecurityDescriptorBinaryForm(),0))==AclHash(after)&&ProtectedAttempt.ReadGrantFileIdentity(h,out size)==identity&&File.ReadAllBytes(path)[0]==42);
    Refuse(()=>File.Delete(path));Refuse(()=>File.Move(path,path+".moved"));Refuse(()=>ProtectedAttempt.SetReadGrantOnHandle(h,Sid,AclHash(before),AclHash(after)));
   }
  });
  Test("actual protected grant journal partial receipt and reconcile write gate",()=>{var c=new ProtectedCase();using(var lease=c.Lease())using(var pin=ProtectedAttempt.PinNativeDefinitionJournalController(c.PlanPath,c.PlanHash,lease)){var j=new NativeRpcDefinitionJournal(pin);j.WriteOnce("native-read.intent","fixed");Refuse(()=>j.WriteOnce("native-read.intent","repeat"));Put(Path.Combine(c.P.Root,"native-read.receipt.pending"),new byte[0]);Refuse(()=>j.Read("native-read.receipt"));}c=new ProtectedCase("reconcile");using(var lease=c.Lease())using(var pin=ProtectedAttempt.PinNativeDefinitionJournalController(c.PlanPath,c.PlanHash,lease)){var j=new NativeRpcDefinitionJournal(pin);foreach(string n in new[]{"intent","submit","receipt"})Refuse(()=>j.WriteOnce("native-read."+n,"deny"));}});
  GC.KeepAlive(timer);Console.WriteLine("TOTAL "+count+" PASS; mocked original provider/account; actual administrator file DACL/journal; no VM/SYSTEM/start/RPC");return 0;
 }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
