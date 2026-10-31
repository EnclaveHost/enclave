// Finite transaction faults; native Hyper-V is never called by this harness.
using System;
using System.Collections.Generic;
using System.IO;
using Enclave.OwnedRpc;
public static class ProviderStopHarness {
    sealed class Store:IStartJournal {
        internal readonly Dictionary<string,string> Values=new Dictionary<string,string>();
        readonly HashSet<string> pending=new HashSet<string>();internal string Fail;
        public void WriteOnce(string n,string v){if(Values.ContainsKey(n)||!pending.Add(n))throw new IOException("Consumed");if(Fail==n)throw new IOException("Lost publication");Values.Add(n,v);pending.Remove(n);}
        public string Read(string n){if(pending.Contains(n))throw new IOException("Partial");string v;return Values.TryGetValue(n,out v)?v:null;}
    }
    sealed class Runtime:IStopRuntime {
        internal long Clock=2000;internal bool Live,ReadDenied,StopDenied;
        public long Now{get{return Clock;}}
        public void VerifyBeforeSubmit(StartIdentity id){}
        public void VerifyObservation(StartIdentity id){if(ReadDenied)throw new InvalidOperationException("Read expired");}
        public void VerifyClosedStart(StartIdentity id){VerifyObservation(id);if(Live||Clock<id.Deadline)throw new InvalidOperationException("Start not closed");}
        public void VerifyBeforeStop(StartIdentity id){VerifyClosedStart(id);if(StopDenied)throw new InvalidOperationException("Stop denied");}
    }
    sealed class Starts:IStartProvider {
        internal uint Code;internal int Calls;
        public StartResponse Start(StartIdentity id){Calls++;return new StartResponse(Code,null);}
        public StartJob ReadJob(string reference){throw new Exception("Unexpected start job read");}
    }
    sealed class Stops:IStopProvider {
        internal readonly Store Store;internal readonly Runtime Runtime;
        internal int Calls,Reads,StateReads;internal uint Code=4096,Runs=1;internal ushort JobState=7,Error,VmState=3;
        internal ulong Bytes;internal bool Lost,BadIdentity,Late;internal string Submitted="20261031000000.000000+000";
        readonly string key="Microsoft:stop-01234567-89ab-cdef-0123-456789abcdef";
        internal Stops(Store store,Runtime runtime){Store=store;Runtime=runtime;}
        public StartResponse Stop(StartIdentity id){Calls++;if(Lost)throw new IOException("Lost stop response");return new StartResponse(Code,Code==4096?HyperVStartProvider.ReferenceForId(key):null);}
        public StartJob ReadJob(string reference){Reads++;if(Store.Read("stop.receipt")==null)throw new Exception("Read before persisted receipt");return new StartJob(reference,key,Submitted,JobState,Error,Runs);}
        public OwnedVmState ReadOwnedState(StartIdentity id){StateReads++;if(Late)Runtime.Clock+=2001;return new OwnedVmState(BadIdentity?new string('0',64):ProviderStop.Hash(id.Encode()),VmState,Bytes);}
    }
    sealed class Case {
        internal readonly Store S=new Store();internal readonly Runtime R=new Runtime();internal readonly Starts A=new Starts();internal readonly Stops B;
        internal readonly StartIdentity Id=new StartIdentity(new string('a',32),new string('b',32),new string('c',64),new string('d',64),"01234567-89ab-cdef-0123-456789abcdef","enclave-owned-rpc-"+new string('a',32),"owned-rpc/"+new string('a',32)+"/"+new string('c',64),@"C:\owned\vm",1000,901000,123,100,456,200,new string('e',64));
        internal Case(){B=new Stops(S,R);ProviderStart.Prepare(Id,S);ProviderStart.Submit(Id,S,A,R);R.Clock=Id.Deadline+1;ProviderStop.Prepare(Id,S);}
        internal StopOutcome Submit(){return ProviderStop.Submit(Id,S,A,B,R);}
        internal StopOutcome Read(){return ProviderStop.Reconcile(Id,S,A,B,R);}
    }
    static int Count;
    static void Check(bool condition){if(!condition)throw new Exception("assertion failed");}
    static void Refuse(Action action){bool refused=false;try{action();}catch{refused=true;}Check(refused);}
    static void Test(string name,Action action){action();Count++;Console.WriteLine("PASS "+name);}
    public static int Main(){try {
        Test("settled-start-stop-off-zero",()=>{var c=new Case();var r=c.Submit();Check(r.StartSettled&&r.StopSettled&&r.OwnedOffZeroConfirmed&&!r.ReservationMayRelease&&!r.ProviderOperationFenced&&c.A.Calls==1&&c.B.Calls==1);});
        Test("unknown-start-never-stops",()=>{var c=new Case();c.S.Values.Remove("start.receipt");Check(!c.Submit().StartSettled&&c.B.Calls==0&&!c.S.Values.ContainsKey("stop.submit"));});
        Test("original-worker-live-refuses",()=>{var c=new Case();c.R.Live=true;Refuse(()=>c.Submit());Check(c.B.Calls==0);});
        Test("before-original-deadline-refuses",()=>{var c=new Case();c.R.Clock=c.Id.Deadline-1;Refuse(()=>c.Submit());Check(c.B.Calls==0);});
        Test("lost-stop-response-never-resubmits",()=>{var c=new Case();c.B.Lost=true;Refuse(()=>c.Submit());Check(!c.Read().StopSettled);Refuse(()=>c.Submit());Check(c.B.Calls==1);});
        Test("partial-stop-receipt-held",()=>{var c=new Case();c.S.Fail="stop.receipt";Refuse(()=>c.Submit());Refuse(()=>c.Read());Check(c.B.Calls==1&&c.B.Reads==0);});
        Test("nonterminal-stop-no-state-read",()=>{var c=new Case();c.B.JobState=4;Check(!c.Submit().StopSettled&&c.B.StateReads==0);});
        Test("job-incarnation-change-refuses",()=>{var c=new Case();c.B.JobState=4;c.Submit();c.B.Submitted="20261031000001.000000+000";Refuse(()=>c.Read());});
        Test("job-recurrence-held",()=>{var c=new Case();c.B.Runs=2;Check(!c.Submit().StopSettled&&c.B.StateReads==0);});
        Test("off-with-assigned-memory-held",()=>{var c=new Case();c.B.Bytes=1048576;Check(!c.Submit().OwnedOffZeroConfirmed);});
        Test("saved-not-off",()=>{var c=new Case();c.B.VmState=32769;Check(!c.Submit().OwnedOffZeroConfirmed);});
        Test("foreign-state-identity-refuses",()=>{var c=new Case();c.B.BadIdentity=true;Refuse(()=>c.Submit());});
        Test("late-state-observation-refuses",()=>{var c=new Case();c.B.Late=true;Refuse(()=>c.Submit());});
        Test("completed-stop-still-running-held",()=>{var c=new Case();c.B.Error=5;c.B.VmState=2;var r=c.Submit();Check(r.StopSettled&&!r.OwnedOffZeroConfirmed);});
        Test("synchronous-stop-fresh-state",()=>{var c=new Case();c.B.Code=0;Check(c.Submit().OwnedOffZeroConfirmed&&c.B.Reads==0&&c.B.StateReads==1);});
        Test("cached-terminal-rechecks-state",()=>{var c=new Case();Check(c.Submit().OwnedOffZeroConfirmed);c.B.VmState=2;Check(!c.Read().OwnedOffZeroConfirmed&&c.B.Calls==1&&c.B.StateReads==2);});
        Test("cross-operation-receipt-refuses",()=>{var c=new Case();c.B.Lost=true;Refuse(()=>c.Submit());c.S.Values["stop.receipt"]=c.S.Values["start.receipt"];Refuse(()=>c.Read());});
        Test("read-only-stop-denied",()=>{var c=new Case();c.R.StopDenied=true;Refuse(()=>c.Submit());Check(c.B.Calls==0);});
        Test("read-without-submit-held",()=>{var c=new Case();Check(!c.Read().StopSettled&&c.B.Calls==0);});
        Test("expired-read-authority-refuses",()=>{var c=new Case();c.Submit();c.R.ReadDenied=true;Refuse(()=>c.Read());});
        Test("two-owner-preparations-pending-then-settled",()=>{var c=new Case();string receipt=c.S.Values["start.receipt"];c.S.Values.Remove("start.receipt");Check(!c.Submit().StartSettled);c.S.Values["start.receipt"]=receipt;ProviderStop.Prepare(c.Id,c.S);Check(c.Submit().OwnedOffZeroConfirmed&&c.B.Calls==1);Refuse(()=>ProviderStop.Prepare(c.Id,c.S));});
        Test("two-owner-preparations-before-then-after-deadline",()=>{var c=new Case();c.R.Clock=c.Id.Deadline-1;Refuse(()=>c.Submit());c.R.Clock=c.Id.Deadline+1;ProviderStop.Prepare(c.Id,c.S);Check(c.Submit().OwnedOffZeroConfirmed&&c.B.Calls==1);});
        Test("partial-stop-intent-cannot-resume",()=>{var c=new Case();c.S.Values.Remove("stop.intent");c.S.Fail="stop.intent";Refuse(()=>ProviderStop.Prepare(c.Id,c.S));c.S.Fail=null;Refuse(()=>ProviderStop.Prepare(c.Id,c.S));Check(c.B.Calls==0);});
        Test("different-complete-stop-intent-cannot-resume",()=>{var c=new Case();c.S.Values["stop.intent"]="different";Refuse(()=>ProviderStop.Prepare(c.Id,c.S));Check(c.B.Calls==0);});
        Console.WriteLine("RESULT tests="+Count+" providerCallsAreFakes=true vmChanged=false");return 0;
    }catch(Exception error){Console.Error.WriteLine(error);return 1;}}
}
