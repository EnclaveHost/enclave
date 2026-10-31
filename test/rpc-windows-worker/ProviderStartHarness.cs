// Finite fault-injection tests of the maintained transaction, never Hyper-V calls.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using Enclave.OwnedRpc;
public static class ProviderStartHarness {
    sealed class Store : IStartJournal {
        internal readonly Dictionary<string,string> Values=new Dictionary<string,string>();
        internal readonly HashSet<string> Pending=new HashSet<string>();
        internal string Fail;
        public void WriteOnce(string n,string v){lock(this){if(Values.ContainsKey(n)||!Pending.Add(n))throw new IOException("Consumed");if(Fail==n)throw new IOException("Injected publication failure");Values.Add(n,v);Pending.Remove(n);}}
        public string Read(string n){lock(this){if(Pending.Contains(n))throw new IOException("Partial journal");string s;return Values.TryGetValue(n,out s)?s:null;}}
    }
    sealed class Runtime : IStartRuntime {
        internal long Clock=2000;internal bool Denied,ObservationDenied;
        public long Now {get{return Clock;}}
        public void VerifyBeforeSubmit(StartIdentity id){if(Denied)throw new InvalidOperationException("Guardian/ownership refused");}
        public void VerifyObservation(StartIdentity id){if(ObservationDenied)throw new InvalidOperationException("Read guardian expired");VerifyBeforeSubmit(id);}
    }
    sealed class Provider : IStartProvider {
        internal int Calls,Reads;internal bool Lost,Missing;internal uint Code=4096;internal string Ref=HyperVStartProvider.ReferenceForId("Microsoft:01234567-89ab-cdef-0123-456789abcdef");
        internal ushort State=4,Error;internal uint Runs=1;internal string Time="20261031000000.000000+000";internal Store Journal;internal Action AfterRead;
        public StartResponse Start(StartIdentity id){Interlocked.Increment(ref Calls);if(Lost)throw new IOException("Lost response after submit");return new StartResponse(Code,Code==4096?Ref:null);}
        public StartJob ReadJob(string r){Reads++;if(Journal.Read("start.receipt")==null)throw new Exception("ACK/read before durable response");if(Missing)throw new IOException("Provider GC/unqueryable");if(AfterRead!=null)AfterRead();return new StartJob(Ref,"Microsoft:01234567-89ab-cdef-0123-456789abcdef",Time,State,Error,Runs);}
    }
    static StartIdentity Id(){return new StartIdentity(new string('a',32),new string('b',32),new string('c',64),new string('d',64),"01234567-89ab-cdef-0123-456789abcdef","enclave-owned-rpc-"+new string('a',32),"owned-rpc/"+new string('a',32)+"/"+new string('c',64),@"C:\owned\vm",1000,901000,123,100,456,200,new string('e',64));}
    static void Check(bool v){if(!v)throw new Exception("assertion failed");}
    static void Refuse(Action f){bool refused=false;try{f();}catch{refused=true;}Check(refused);}
    static void ProtectedReadCase(bool pending) {
        string nonce=Guid.NewGuid().ToString("N"),parent=Path.Combine(Path.GetPathRoot(Environment.SystemDirectory),"RpcJournalFixture-"+nonce),root=Path.Combine(parent,nonce);
        var admin=new SecurityIdentifier("S-1-5-32-544");var system=new SecurityIdentifier("S-1-5-18");
        var acl=new DirectorySecurity();acl.SetOwner(admin);acl.SetAccessRuleProtection(true,false);
        foreach(var sid in new[]{admin,system})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        Directory.CreateDirectory(parent,acl);Directory.CreateDirectory(root,acl);
        var fileAcl=new FileSecurity();fileAcl.SetOwner(admin);fileAcl.SetAccessRuleProtection(true,false);
        foreach(var sid in new[]{admin,system})fileAcl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,AccessControlType.Allow));
        Action<string,byte[]> write=delegate(string n,byte[] data){using(var f=new FileStream(Path.Combine(root,n),FileMode.CreateNew,FileSystemRights.WriteData,FileShare.None,4096,FileOptions.WriteThrough,fileAcl)){f.Write(data,0,data.Length);f.Flush(true);}};
        try {
            byte[] image=File.ReadAllBytes(Process.GetCurrentProcess().MainModule.FileName);write("entry.exe",image);
            long origin=BoundedWorker.MonotonicMilliseconds();string contract="owned-rpc-inert-v1\n"+nonce+"\n"+ProtectedAttempt.CurrentBoot()+"\n"+origin+"\n"+(origin+15000)+"\n"+ProtectedAttempt.Hash(image)+"\ninert-v1\n";
            byte[] bytes=Encoding.UTF8.GetBytes(contract);write("contract.txt",bytes);
            if(pending)write("start.receipt.pending",new byte[0]);
            using(var pin=ProtectedAttempt.PinController(Path.Combine(root,"contract.txt"),ProtectedAttempt.Hash(bytes))){
                var j=new ProtectedStartJournal(pin);
                if(pending)Refuse(()=>j.Read("start.receipt"));else Check(j.Read("start.receipt")==null);
            }
        } finally {Directory.Delete(parent,true);}
    }
    static int count;
    static void Test(string n,Action f){f();count++;Console.WriteLine("PASS "+n);}
    public static int Main(){
        try{
            BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);
            long origin=BoundedWorker.MonotonicMilliseconds();BoundedWorker.ArmOwnerObserver(origin,origin+15000,new string('f',128));
            Test("missing intent cannot submit",delegate{var j=new Store();var p=new Provider{Journal=j};Refuse(()=>ProviderStart.Submit(Id(),j,p,new Runtime()));Check(p.Calls==0);});
            Test("prepare one-shot",delegate{var j=new Store();ProviderStart.Prepare(Id(),j);Refuse(()=>ProviderStart.Prepare(Id(),j));});
            Test("partial prepare stays consumed",delegate{var j=new Store{Fail="start.intent"};Refuse(()=>ProviderStart.Prepare(Id(),j));j.Fail=null;Refuse(()=>ProviderStart.Prepare(Id(),j));});
            Test("lost return survives restart without resend",delegate{var j=new Store();var p=new Provider{Journal=j,Lost=true};ProviderStart.Prepare(Id(),j);Refuse(()=>ProviderStart.Submit(Id(),j,p,new Runtime()));Refuse(()=>ProviderStart.Submit(Id(),j,p,new Runtime()));Check(p.Calls==1&&ProviderStart.Reconcile(Id(),j,p,new Runtime()).State=="response-lost-held");});
            Test("receipt persistence failure never acknowledged",delegate{var j=new Store{Fail="start.receipt"};var p=new Provider{Journal=j};ProviderStart.Prepare(Id(),j);Refuse(()=>ProviderStart.Submit(Id(),j,p,new Runtime()));Check(p.Calls==1&&p.Reads==0);j.Fail=null;Refuse(()=>ProviderStart.Submit(Id(),j,p,new Runtime()));Refuse(()=>ProviderStart.Reconcile(Id(),j,p,new Runtime()));});
            Test("response precedes exact job read and GC recovery",delegate{var j=new Store();var p=new Provider{Journal=j};ProviderStart.Prepare(Id(),j);Check(!ProviderStart.Submit(Id(),j,p,new Runtime()).OperationSettled);p.State=7;Check(ProviderStart.Reconcile(Id(),j,p,new Runtime()).OperationSucceeded);p.Missing=true;int reads=p.Reads;var r=ProviderStart.Reconcile(Id(),j,p,new Runtime());Check(r.OperationSettled&&p.Reads==reads&&!r.ProviderOperationFenced&&!r.ReservationMayRelease);});
            Test("job reincarnation stays held",delegate{var j=new Store();var p=new Provider{Journal=j};ProviderStart.Prepare(Id(),j);ProviderStart.Submit(Id(),j,p,new Runtime());p.Time="20261031000001.000000+000";p.State=7;Refuse(()=>ProviderStart.Reconcile(Id(),j,p,new Runtime()));Check(j.Read("start.terminal")==null);});
            Test("absent job does not settle",delegate{var j=new Store();var p=new Provider{Journal=j,Missing=true};ProviderStart.Prepare(Id(),j);Refuse(()=>ProviderStart.Submit(Id(),j,p,new Runtime()));Check(j.Read("start.receipt")!=null&&j.Read("start.terminal")==null);});
            Test("synchronous return persists before success",delegate{var j=new Store();var p=new Provider{Journal=j,Code=0};ProviderStart.Prepare(Id(),j);var r=ProviderStart.Submit(Id(),j,p,new Runtime());Check(r.OperationSucceeded&&p.Reads==0&&j.Read("start.receipt")!=null&&!r.ReservationMayRelease);});
            Test("unknown native return held",delegate{var j=new Store();var p=new Provider{Journal=j,Code=32771};ProviderStart.Prepare(Id(),j);Check(!ProviderStart.Submit(Id(),j,p,new Runtime()).OperationSettled&&p.Reads==0);});
            Test("abnormal suspended killed service not settlement",delegate{foreach(ushort state in new ushort[]{2,3,4,5,6,8,9,10,11,12,65535}){var j=new Store();var p=new Provider{Journal=j,State=state};ProviderStart.Prepare(Id(),j);Check(!ProviderStart.Submit(Id(),j,p,new Runtime()).OperationSettled&&j.Read("start.terminal")==null);}});
            Test("recurring completed job not settlement",delegate{var j=new Store();var p=new Provider{Journal=j,State=7,Runs=0};ProviderStart.Prepare(Id(),j);Check(!ProviderStart.Submit(Id(),j,p,new Runtime()).OperationSettled);});
            Test("completed error is settled not success",delegate{var j=new Store();var p=new Provider{Journal=j,State=7,Error=12};ProviderStart.Prepare(Id(),j);var r=ProviderStart.Submit(Id(),j,p,new Runtime());Check(r.OperationSettled&&!r.OperationSucceeded);});
            Test("terminal persistence failure stays held",delegate{var j=new Store{Fail="start.terminal"};var p=new Provider{Journal=j,State=7};ProviderStart.Prepare(Id(),j);Refuse(()=>ProviderStart.Submit(Id(),j,p,new Runtime()));Check(p.Calls==1);j.Fail=null;Refuse(()=>ProviderStart.Reconcile(Id(),j,p,new Runtime()));});
            Test("original deadline and rollback refuse submit",delegate{foreach(long clock in new long[]{999,901000}){var j=new Store();var p=new Provider{Journal=j};ProviderStart.Prepare(Id(),j);Refuse(()=>ProviderStart.Submit(Id(),j,p,new Runtime{Clock=clock}));Check(p.Calls==0);}});
            Test("guardian refusal consumes gate without invoking",delegate{var j=new Store();var p=new Provider{Journal=j};ProviderStart.Prepare(Id(),j);Refuse(()=>ProviderStart.Submit(Id(),j,p,new Runtime{Denied=true}));Refuse(()=>ProviderStart.Submit(Id(),j,p,new Runtime()));Check(p.Calls==0);});
            Test("concurrent submit exactly one native call",delegate{var j=new Store();var p=new Provider{Journal=j,Code=0};ProviderStart.Prepare(Id(),j);var a=new Thread(()=>{try{ProviderStart.Submit(Id(),j,p,new Runtime());}catch{}});var b=new Thread(()=>{try{ProviderStart.Submit(Id(),j,p,new Runtime());}catch{}});a.Start();b.Start();Check(a.Join(1000)&&b.Join(1000)&&p.Calls==1);});
            Test("exact local reference canonicalizes",delegate{string expected=HyperVStartProvider.ReferenceForId("Microsoft:abc");Check(HyperVStartProvider.CanonicalJobReference(@"\\.\root\virtualization\v2:Msvm_ConcreteJob.InstanceID="+"\"Microsoft:abc\"")==expected);});
            Test("remote wrongnamespace extra keys refused",delegate{foreach(string path in new[]{@"\\untrusted\root\virtualization\v2:Msvm_ConcreteJob.InstanceID="+"\"abc\"",@"root\cimv2:Msvm_ConcreteJob.InstanceID="+"\"abc\"","Other.InstanceID=\"abc\"","Msvm_ConcreteJob.InstanceID=\"abc\",Other=\"x\"","Msvm_ConcreteJob.InstanceID=\"a/b\""})Refuse(()=>HyperVStartProvider.CanonicalJobReference(path));});
            Test("malformed response remains consumed",delegate{var j=new Store();var p=new Provider{Journal=j,Ref="Wrong.InstanceID=\"abc\""};ProviderStart.Prepare(Id(),j);Refuse(()=>ProviderStart.Submit(Id(),j,p,new Runtime()));Refuse(()=>ProviderStart.Submit(Id(),j,p,new Runtime()));Check(p.Calls==1&&j.Read("start.receipt")==null);});
            Test("actual protected adapter definitive absence",delegate{ProtectedReadCase(false);});
            Test("actual protected adapter empty pending is held",delegate{ProtectedReadCase(true);});
            Test("post-startup guarded read settles without restarting",delegate{var j=new Store();var p=new Provider{Journal=j};var r=new Runtime();ProviderStart.Prepare(Id(),j);ProviderStart.Submit(Id(),j,p,r);r.Clock=901001;p.State=7;Check(ProviderStart.Reconcile(Id(),j,p,r).OperationSettled);Refuse(()=>ProviderStart.Submit(Id(),j,p,r));Check(p.Calls==1);});
            Test("expired read guard prevents provider observation",delegate{var j=new Store();var p=new Provider{Journal=j};var r=new Runtime();ProviderStart.Prepare(Id(),j);ProviderStart.Submit(Id(),j,p,r);int reads=p.Reads;r.ObservationDenied=true;Refuse(()=>ProviderStart.Reconcile(Id(),j,p,r));Check(p.Reads==reads&&j.Read("start.terminal")==null);});
            Test("read guard expiry during query cannot publish terminal",delegate{var j=new Store();var p=new Provider{Journal=j};var r=new Runtime();ProviderStart.Prepare(Id(),j);ProviderStart.Submit(Id(),j,p,r);p.State=7;p.AfterRead=()=>{r.ObservationDenied=true;};Refuse(()=>ProviderStart.Reconcile(Id(),j,p,r));Check(j.Read("start.terminal")==null);});
            Check(count==25);Console.WriteLine("RESULT tests="+count+" providerCallsAreFakes=true vmChanged=false");return 0;
        }catch(Exception e){Console.WriteLine("FAIL "+e);return 1;}
    }
}
