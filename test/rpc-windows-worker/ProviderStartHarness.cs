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
    sealed class PhysicalRuntime : IStartRuntime,IPhysicalStartRuntime {
        internal bool Denied;internal int Checks,Consumes;
        public long Now {get{return 2000;}}
        public long GuestBytes {get{return 19L*1024*1024*1024;}}
        public void VerifyBeforeSubmit(StartIdentity id){Checks++;if(Denied)throw new InvalidOperationException("Short lease expired during memory read");}
        public void VerifyObservation(StartIdentity id){VerifyBeforeSubmit(id);}
        public void ConsumePhysicalStart(StartIdentity id){Consumes++;}
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

    sealed class PermitFixture : IDisposable {
        internal readonly string Parent,Root,Hash,ImageHash;
        internal readonly OwnedVmPermit Permit;
        internal readonly StartIdentity Identity;
        readonly byte[] image;
        readonly DirectorySecurity directoryAcl;
        readonly FileSecurity fileAcl;
        internal PermitFixture() {
            string nonce=Guid.NewGuid().ToString("N");
            Parent=Path.Combine(Path.GetPathRoot(Environment.SystemDirectory),"RpcPermitFixture-"+nonce);Root=Path.Combine(Parent,nonce);
            var admin=new SecurityIdentifier("S-1-5-32-544");var system=new SecurityIdentifier("S-1-5-18");
            directoryAcl=new DirectorySecurity();directoryAcl.SetOwner(admin);directoryAcl.SetAccessRuleProtection(true,false);
            fileAcl=new FileSecurity();fileAcl.SetOwner(admin);fileAcl.SetAccessRuleProtection(true,false);
            foreach(var sid in new[]{admin,system}) {
                directoryAcl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
                fileAcl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,AccessControlType.Allow));
            }
            Directory.CreateDirectory(Parent,directoryAcl);Directory.CreateDirectory(Root,directoryAcl);
            image=File.ReadAllBytes(Process.GetCurrentProcess().MainModule.FileName);ImageHash=ProtectedAttempt.Hash(image);
            long now=BoundedWorker.MonotonicMilliseconds();
            Permit=new OwnedVmPermit(nonce,ProtectedAttempt.CurrentBoot(),new string('a',64),ImageHash,Guid.NewGuid().ToString("D"),Path.Combine(Root,"vm"),now,now+900000,19L*1024*1024*1024,1024L*1024*1024);
            byte[] bytes=Encoding.UTF8.GetBytes(Permit.Encode());Hash=ProtectedAttempt.Hash(bytes);
            Write(Root,"vm-permit.txt",bytes);Write(Root,"entry.exe",image);
            Identity=new StartIdentity(Permit.Attempt,Permit.Boot,Permit.AdmissionHash,Hash,Permit.VmGuid,Permit.VmName,Permit.OwnerNote,Permit.ConfigurationRoot,Permit.Origin,Permit.Deadline,123,100,456,200,Permit.ImageHash);
        }
        internal void Write(string root,string name,byte[] data) {
            using(var f=new FileStream(Path.Combine(root,name),FileMode.CreateNew,FileSystemRights.WriteData,FileShare.None,4096,FileOptions.WriteThrough,fileAcl)){f.Write(data,0,data.Length);f.Flush(true);}
        }
        internal ProtectedAttempt Lease(int duration,string boot,string imageHash) {
            string nonce=Guid.NewGuid().ToString("N"),root=Path.Combine(Parent,nonce);Directory.CreateDirectory(root,directoryAcl);
            Write(root,"entry.exe",image);long origin=BoundedWorker.MonotonicMilliseconds();
            string contract="owned-rpc-inert-v1\n"+nonce+"\n"+boot+"\n"+origin+"\n"+(origin+duration)+"\n"+imageHash+"\ninert-v1\n";
            byte[] bytes=Encoding.UTF8.GetBytes(contract);Write(root,"contract.txt",bytes);
            return ProtectedAttempt.PinController(Path.Combine(root,"contract.txt"),ProtectedAttempt.Hash(bytes));
        }
        internal ProtectedAttempt CleanupLease(string operation) {
            string nonce=Guid.NewGuid().ToString("N"),root=Path.Combine(Parent,nonce);Directory.CreateDirectory(root,directoryAcl);Write(root,"entry.exe",image);
            long origin=BoundedWorker.MonotonicMilliseconds();
            string text="owned-rpc-provider-worker-v1\n"+nonce+"\n"+Permit.Boot+"\n"+origin+"\n"+(origin+15000)+"\n"+ImageHash+"\n"+operation+"\n"+Path.Combine(Root,"vm-permit.txt")+"\n"+Hash+"\n0\n0\n";
            byte[] bytes=Encoding.UTF8.GetBytes(text);Write(root,"contract.txt",bytes);return ProtectedAttempt.PinProviderController(Path.Combine(root,"contract.txt"),ProtectedAttempt.Hash(bytes));
        }
        internal ProtectedAttempt Lease(){return Lease(15000,Permit.Boot,ImageHash);}
        internal ProtectedAttempt Open(ProtectedAttempt lease,bool read){return ProtectedAttempt.PinVmJournalController(Path.Combine(Root,"vm-permit.txt"),Hash,lease,read);}
        public void Dispose(){Directory.Delete(Parent,true);}
    }
    static void PermitTests() {
        Test("actual cleanup lease cannot write a start",delegate{using(var f=new PermitFixture())using(var l=f.CleanupLease("stop"))using(var pin=f.Open(l,true)){
            foreach(string n in new[]{"start.intent","start.submit","start.native","start.receipt"})Refuse(()=>pin.WriteOnce(n,"forbidden"));
            var j=new OwnedVmStartJournal(pin,f.Identity);ProviderStop.Prepare(f.Identity,j);Check(j.Read("stop.intent")==ProviderStop.Intent(f.Identity));j.WriteOnce("stop.submit","fixture");
            Refuse(()=>OwnedVmPermit.Parse(f.Permit.Encode().Replace("owned-rpc-vm-permit-v2","owned-rpc-vm-permit-v1")));
        }});
        Test("actual stop reconciliation cannot acquire mutation",delegate{using(var f=new PermitFixture())using(var l=f.CleanupLease("stop-reconcile"))using(var pin=f.Open(l,false)){
            foreach(string n in new[]{"start.intent","start.submit","start.native","start.receipt","stop.intent","stop.submit","stop.native","stop.receipt"})Refuse(()=>pin.WriteOnce(n,"forbidden"));
            pin.WriteOnce("start.job","observation");pin.WriteOnce("stop.terminal","observation");
        }});
        Test("canonical intent decoding preserves original worker",delegate{string raw=Id().Encode();Check(StartIdentity.Decode(raw).Encode()==raw);Refuse(()=>StartIdentity.Decode(raw+" "));Refuse(()=>StartIdentity.Decode(raw.Replace("RequestStateChange","Other")));});
        Test("permit binds VM identity and original intent",delegate{using(var f=new PermitFixture()){Check(OwnedVmPermit.Parse(f.Permit.Encode()).Encode()==f.Permit.Encode());f.Permit.Bind(f.Identity,f.Hash);Refuse(()=>f.Permit.Bind(Id(),f.Hash));Refuse(()=>OwnedVmPermit.Parse(f.Permit.Encode().Replace("fixed-local-start-disable-and-reconcile-v2","inert-v1")));}});
        Test("permit refuses unreviewed aggregate allocation",delegate{using(var f=new PermitFixture()){var p=f.Permit;Refuse(()=>new OwnedVmPermit(p.Attempt,p.Boot,p.AdmissionHash,p.ImageHash,p.VmGuid,p.ConfigurationRoot,p.Origin,p.Deadline,28L*1024*1024*1024,p.SupportBytes));Check(p.TotalBytes==21474836480L&&p.TotalBytes<32000000000L);}});
        Test("permit startup expiry leaves only reconciliation access",delegate{using(var f=new PermitFixture()){var p=f.Permit;p.ValidateAccess(p.Deadline-1,false);Refuse(()=>p.ValidateAccess(p.Deadline,false));p.ValidateAccess(p.Deadline,true);p.ValidateAccess(Int64.MaxValue,true);Refuse(()=>p.ValidateAccess(p.Origin-1,true));}});
        Test("actual journal reopen retains consumed start gate",delegate{using(var f=new PermitFixture()){
            using(var l=f.Lease())using(var pin=f.Open(l,false)){var j=new OwnedVmStartJournal(pin,f.Identity);ProviderStart.Prepare(f.Identity,j);j.WriteOnce("start.submit",new string('a',64));Check(File.GetAccessControl(Path.Combine(f.Root,"start.intent")).GetOwner(typeof(SecurityIdentifier)).Value=="S-1-5-32-544");}
            using(var l=f.Lease())using(var pin=f.Open(l,true)){var id=StartIdentity.Decode(pin.ReadOnce("start.intent"));var j=new OwnedVmStartJournal(pin,id);Check(id.WorkerPid==123&&pin.Deadline==f.Permit.Deadline&&j.Read("start.submit")==new string('a',64));Refuse(()=>j.WriteOnce("start.submit",new string('a',64)));j.WriteOnce("start.job","historical observation fixture");}
            using(var l=f.Lease())using(var pin=f.Open(l,false)){Refuse(()=>new OwnedVmStartJournal(pin,f.Identity).WriteOnce("start.submit",new string('a',64)));}
        }});
        Test("reconciliation cannot create intent native call or response",delegate{using(var f=new PermitFixture())using(var l=f.Lease())using(var pin=f.Open(l,true)){var j=new OwnedVmStartJournal(pin,f.Identity);foreach(string n in new[]{"start.intent","start.submit","start.native","start.receipt"})Refuse(()=>j.WriteOnce(n,f.Identity.Encode()));Check(j.Read("start.intent")==null&&j.Read("start.submit")==null&&j.Read("start.native")==null&&j.Read("start.receipt")==null);}});
        Test("actual reopened partial journal stays held",delegate{using(var f=new PermitFixture()){f.Write(f.Root,"start.receipt.pending",new byte[0]);using(var l=f.Lease())using(var pin=f.Open(l,true)){Refuse(()=>new OwnedVmStartJournal(pin,f.Identity).Read("start.receipt"));}}});
        Test("worker lease disposal closes journal access",delegate{using(var f=new PermitFixture()){var l=f.Lease();using(var pin=f.Open(l,true)){l.Dispose();Refuse(()=>pin.ReadOnce("start.intent"));Refuse(()=>pin.WriteOnce("start.job","late"));Refuse(()=>f.Open(l,true));}}});
        Test("independent lease expiry cannot extend journal access",delegate{using(var f=new PermitFixture())using(var l=f.Lease(1000,f.Permit.Boot,f.ImageHash))using(var pin=f.Open(l,true)){while(BoundedWorker.MonotonicMilliseconds()<l.Deadline)Thread.Sleep(10);Refuse(()=>pin.ReadOptionalOnce("start.receipt"));Refuse(()=>pin.WriteOnce("start.terminal","late"));Check(pin.Deadline==f.Permit.Deadline);}});
        Test("actual permit hash mismatch refuses journal opening",delegate{using(var f=new PermitFixture())using(var l=f.Lease()){Refuse(()=>ProtectedAttempt.PinVmJournalController(Path.Combine(f.Root,"vm-permit.txt"),new string('f',64),l,false));}});
        Test("inert lease cannot masquerade as VM journal",delegate{using(var f=new PermitFixture())using(var l=f.Lease()){Refuse(()=>new OwnedVmStartJournal(l,f.Identity));Refuse(()=>ProtectedAttempt.PinVmJournalController(Path.Combine(l.Root,"contract.txt"),l.ContractHash,l,true));}});
        Test("actual journal rejects altered consumed identity",delegate{using(var f=new PermitFixture()){f.Write(f.Root,"start.intent",Encoding.UTF8.GetBytes(Id().Encode()));using(var l=f.Lease())using(var pin=f.Open(l,true)){var j=new OwnedVmStartJournal(pin,f.Identity);Refuse(()=>j.Read("start.intent"));Refuse(()=>new OwnedVmStartJournal(pin,Id()));}}});
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
            PermitTests();
            Test("native configured memory must match reserved static guest bytes",delegate {
                long bytes=19L*1024*1024*1024;ulong mib=19456;
                var values=new Dictionary<string,object>{{"ResourceType",(ushort)4},{"ResourceSubType","Microsoft:Hyper-V:Memory"},
                    {"AllocationUnits","byte * 2^20"},{"VirtualQuantityUnits","byte * 2^20"},{"VirtualQuantity",mib},{"Reservation",mib},{"Limit",mib},
                    {"DynamicMemoryEnabled",false},{"AutomaticAllocation",true},{"SwapFilesInUse",false}};
                HyperVStartProvider.RequireGuestMemory(values,bytes);
                foreach(string key in new List<string>(values.Keys)){var missing=new Dictionary<string,object>(values);missing[key]=null;Refuse(()=>HyperVStartProvider.RequireGuestMemory(missing,bytes));}
                foreach(string key in new[]{"VirtualQuantity","Reservation","Limit"}){var wrong=new Dictionary<string,object>(values);wrong[key]=mib+1;Refuse(()=>HyperVStartProvider.RequireGuestMemory(wrong,bytes));}
                foreach(string key in new[]{"DynamicMemoryEnabled","SwapFilesInUse"}){var wrong=new Dictionary<string,object>(values);wrong[key]=true;Refuse(()=>HyperVStartProvider.RequireGuestMemory(wrong,bytes));}
                var units=new Dictionary<string,object>(values);units["AllocationUnits"]="byte";Refuse(()=>HyperVStartProvider.RequireGuestMemory(units,bytes));
            });
            Test("final memory read cannot outlive short authority or consume twice",delegate {
                var live=new PhysicalRuntime();int reads=0;
                HyperVStartProvider.GuardPhysicalStart(Id(),live,live,()=>{reads++;});
                Check(reads==2&&live.Checks==3&&live.Consumes==1);
                var expired=new PhysicalRuntime();reads=0;bool invoked=false;
                Refuse(()=>{HyperVStartProvider.GuardPhysicalStart(Id(),expired,expired,()=>{if(++reads==2)expired.Denied=true;});invoked=true;});
                Check(reads==2&&expired.Checks==3&&expired.Consumes==1&&!invoked&&expired.Now<Id().Deadline);
            });
            Check(count==41);Console.WriteLine("RESULT tests="+count+" providerCallsAreFakes=true vmChanged=false");return 0;
        }catch(Exception e){Console.WriteLine("FAIL "+e);return 1;}
    }
}
