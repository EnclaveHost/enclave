// Fixed owned-VM disable after the original start path is closed and settled.
// No VM deletion, broad scans, cancellation assumption, save or reservation release.
using System;
using System.Collections.Generic;
using System.Management;
using System.Text;

namespace Enclave.OwnedRpc {
    public interface IStopRuntime : IStartRuntime {
        // Actual implementation must check current bounded cleanup worker, original
        // boot/permit/deadline and exact original submitter/observer death.
        void VerifyClosedStart(StartIdentity id);
        void VerifyBeforeStop(StartIdentity id);
    }
    public sealed class OwnedVmState {
        public readonly string IdentityHash;
        public readonly ushort EnabledState;
        public readonly ulong AssignedBytes;
        public OwnedVmState(string identityHash,ushort state,ulong bytes){IdentityHash=identityHash;EnabledState=state;AssignedBytes=bytes;}
    }
    public interface IStopProvider {
        StartResponse Stop(StartIdentity id);
        StartJob ReadJob(string exactReference);
        OwnedVmState ReadOwnedState(StartIdentity id);
    }
    public sealed class StopOutcome {
        public readonly string State;
        public readonly bool StartSettled,StopSettled,OwnedOffZeroConfirmed;
        // Off/zero is only a fresh observation; export/write fencing is separate.
        public bool ProviderOperationFenced {get{return false;}}
        public bool ReservationMayRelease {get{return false;}}
        internal StopOutcome(string state,bool start,bool stop,bool off){State=state;StartSettled=start;StopSettled=stop;OwnedOffZeroConfirmed=off;}
    }
    public static class ProviderStop {
        internal static string Hash(string raw){return ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(raw));}
        internal static string Intent(StartIdentity id){return StartRecords.Encode(new Dictionary<string,object>{
            {"schema","owned-rpc-stop-intent/1"},{"startIntent",Hash(id.Encode())},{"vmGuid",id.VmGuid},
            {"contract",id.ContractHash},{"method","RequestStateChange"},{"requestedState",3}});}
        static string BoundIntent(StartIdentity id,IStartJournal journal){string intent=Intent(id);if(journal.Read("stop.intent")!=intent)throw new InvalidOperationException("Exact consumed stop intent required");return Hash(intent);}
        public static void Prepare(StartIdentity id,IStartJournal journal){
            string expected=Intent(id),existing=journal.Read("stop.intent");
            // Preparation is resumable only before any possible submission. Reads
            // of partial/inaccessible records throw. The exclusive stop.submit
            // remains the sole invocation entitlement under concurrent prepares.
            foreach(string name in new[]{"stop.submit","stop.native","stop.receipt","stop.job","stop.terminal"})
                if(journal.Read(name)!=null)throw new InvalidOperationException("Stop submission already consumed; reconcile only");
            if(existing==null)journal.WriteOnce("stop.intent",expected);
            else if(existing!=expected)throw new InvalidOperationException("Prepared stop identity differs");
        }
        static bool StartSettled(StartIdentity id,IStartJournal journal,IStartProvider starts,IStopRuntime runtime) {
            runtime.VerifyClosedStart(id);
            var result=ProviderStart.Reconcile(id,journal,starts,runtime);
            runtime.VerifyClosedStart(id);return result.OperationSettled;
        }
        public static StopOutcome Submit(StartIdentity id,IStartJournal journal,IStartProvider starts,IStopProvider stops,IStopRuntime runtime) {
            string intent=BoundIntent(id,journal);
            if(!StartSettled(id,journal,starts,runtime))return new StopOutcome("start-unsettled-held",false,false,false);
            journal.WriteOnce("stop.submit",intent);
            runtime.VerifyBeforeStop(id);
            StartResponse response=stops.Stop(id); // one native call, no catch-and-retry
            ProviderStart.PersistResponse(journal,"stop",intent,response);
            return Reconcile(id,journal,starts,stops,runtime);
        }
        // Poll only the exact recorded async operation. A pending start has not
        // consumed stop.submit, so settlement can enable the first stop exactly
        // once. Missing/lost responses never become an excuse to submit again.
        internal static StopOutcome Cleanup(StartIdentity id,IStartJournal journal,IStartProvider starts,IStopProvider stops,IStopRuntime runtime,bool maySubmit,long deadline,Action wait){
            if(wait==null||deadline<=runtime.Now||deadline>id.Deadline+30000)throw new InvalidOperationException("Bounded original cleanup window required");
            BoundIntent(id,journal);runtime.VerifyClosedStart(id);
            var start=ProviderStart.Reconcile(id,journal,starts,runtime);
            while(!start.OperationSettled&&start.State.StartsWith("job-state-",StringComparison.Ordinal)&&runtime.Now+1000<deadline){
                wait();runtime.VerifyClosedStart(id);start=ProviderStart.Reconcile(id,journal,starts,runtime);
            }
            if(!start.OperationSettled)return new StopOutcome("start-unsettled-held",false,false,false);
            if(runtime.Now>=deadline)throw new TimeoutException("Original cleanup window expired");
            bool consumed=journal.Read("stop.submit")!=null||journal.Read("stop.native")!=null||journal.Read("stop.receipt")!=null;
            var result=maySubmit&&!consumed?Submit(id,journal,starts,stops,runtime):Reconcile(id,journal,starts,stops,runtime);
            while(!result.OwnedOffZeroConfirmed&&(result.State.StartsWith("stop-job-state-",StringComparison.Ordinal)||result.State=="owned-vm-not-off-zero-held")&&runtime.Now+1000<deadline){
                wait();result=Reconcile(id,journal,starts,stops,runtime);
            }
            return result;
        }
        public static StopOutcome Reconcile(StartIdentity id,IStartJournal journal,IStartProvider starts,IStopProvider stops,IStopRuntime runtime) {
            string intent=BoundIntent(id,journal);
            if(!StartSettled(id,journal,starts,runtime))return new StopOutcome("start-unsettled-held",false,false,false);
            if(journal.Read("stop.submit")!=intent)return new StopOutcome("stop-submission-not-proven",true,false,false);
            var result=ProviderStart.ReconcileOperation(id,journal,stops.ReadJob,runtime,"stop",intent);
            if(!result.OperationSettled)return new StopOutcome("stop-"+result.State,true,false,false);
            runtime.VerifyClosedStart(id);long began=runtime.Now;
            OwnedVmState state=stops.ReadOwnedState(id);
            runtime.VerifyClosedStart(id);long ended=runtime.Now;
            if(ended<began||ended-began>2000||state==null||state.IdentityHash!=Hash(id.Encode()))throw new InvalidOperationException("Fresh owned VM observation unavailable");
            bool off=state.EnabledState==3&&state.AssignedBytes==0;
            return new StopOutcome(off?"owned-off-zero-observed":"owned-vm-not-off-zero-held",true,true,off);
        }
    }
    public sealed class HyperVStopProvider : IStopProvider {
        readonly IStopRuntime runtime;readonly IStartJournal journal;readonly HyperVStartProvider jobs;
        public HyperVStopProvider(IStopRuntime runtime,IStartJournal journal){
            if(runtime==null||journal==null)throw new ArgumentNullException("dependencies");this.runtime=runtime;this.journal=journal;jobs=new HyperVStartProvider(runtime,journal);
        }
        public StartJob ReadJob(string reference){return jobs.ReadJob(reference);}
        static void Owned(StartIdentity id,ManagementObject vm,ManagementObject settings) {
            var notes=settings["Notes"] as string[];
            if((string)vm["Name"]!=id.VmGuid||(string)vm["ElementName"]!=id.VmName||vm["EnabledState"]==null||
                (string)settings["VirtualSystemIdentifier"]!=id.VmGuid||(string)settings["ElementName"]!=id.VmName||
                notes==null||notes.Length!=1||notes[0]!=id.OwnerNote||!String.Equals((string)settings["ConfigurationDataRoot"],id.ConfigurationRoot,StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Original owned VM identity changed");
        }
        public StartResponse Stop(StartIdentity id) {
            ProtectedAttempt.RequireSystem();runtime.VerifyBeforeStop(id);
            string intent=ProviderStop.Intent(id),digest=ProviderStop.Hash(intent);
            if(journal.Read("stop.intent")!=intent||journal.Read("stop.submit")!=digest)throw new InvalidOperationException("Native disable lacks consumed stop intent");
            // Independently settle the original start again at the native boundary.
            // This can never launch or cancel a start; unknown remains held.
            if(!ProviderStart.Reconcile(id,journal,jobs,runtime).OperationSettled)throw new InvalidOperationException("Original start not settled");
            journal.WriteOnce("stop.native",digest);
            var scope=HyperVStartProvider.Scope();
            using(var vm=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_ComputerSystem WHERE Name='"+id.VmGuid+"'"))
            using(var settings=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_VirtualSystemSettingData WHERE VirtualSystemIdentifier='"+id.VmGuid+"' AND VirtualSystemType='Microsoft:Hyper-V:System:Realized'")) {
                Owned(id,vm,settings);
                ushort state=Convert.ToUInt16(vm["EnabledState"]);
                if(state!=2&&state!=3)throw new InvalidOperationException("Owned VM not in admitted stable state");
                using(var input=vm.GetMethodParameters("RequestStateChange")) {
                    // Microsoft documents Disabled(3) for the v2 stop operation;
                    // ShutDown(4) is v1-only. Never use Save or a broad Stop-VM.
                    input["RequestedState"]=(ushort)3;runtime.VerifyBeforeStop(id);
                    using(var output=vm.InvokeMethod("RequestStateChange",input,new InvokeMethodOptions{Timeout=TimeSpan.FromSeconds(2)})) {
                        if(output==null||output["ReturnValue"]==null)throw new InvalidOperationException("No disable response");
                        return new StartResponse(Convert.ToUInt32(output["ReturnValue"]),output["Job"] as string);
                    }
                }
            }
        }
        public OwnedVmState ReadOwnedState(StartIdentity id) {
            ProtectedAttempt.RequireSystem();runtime.VerifyClosedStart(id);
            var scope=HyperVStartProvider.Scope();
            using(var vm=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_ComputerSystem WHERE Name='"+id.VmGuid+"'"))
            using(var memory=HyperVStartProvider.One(scope,"SELECT SystemName,BlockSize,NumberOfBlocks FROM Msvm_Memory WHERE SystemName='"+id.VmGuid+"'"))
            using(var settings=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_VirtualSystemSettingData WHERE VirtualSystemIdentifier='"+id.VmGuid+"' AND VirtualSystemType='Microsoft:Hyper-V:System:Realized'")) {
                Owned(id,vm,settings);
                if(memory["SystemName"]==null||memory["BlockSize"]==null||memory["NumberOfBlocks"]==null||(string)memory["SystemName"]!=id.VmGuid||Convert.ToUInt64(memory["BlockSize"])!=1048576)
                    throw new InvalidOperationException("Original VM assigned-memory observation missing");
                var result=new OwnedVmState(ProviderStop.Hash(id.Encode()),Convert.ToUInt16(vm["EnabledState"]),checked(Convert.ToUInt64(memory["BlockSize"])*Convert.ToUInt64(memory["NumberOfBlocks"])));
                // Re-fetch identity/state after memory to reject a mixed snapshot.
                vm.Get();settings.Get();memory.Get();Owned(id,vm,settings);
                if(Convert.ToUInt16(vm["EnabledState"])!=result.EnabledState||memory["SystemName"]==null||memory["BlockSize"]==null||memory["NumberOfBlocks"]==null||
                    (string)memory["SystemName"]!=id.VmGuid||Convert.ToUInt64(memory["BlockSize"])!=1048576||checked(Convert.ToUInt64(memory["BlockSize"])*Convert.ToUInt64(memory["NumberOfBlocks"]))!=result.AssignedBytes)throw new InvalidOperationException("VM state changed during observation");
                runtime.VerifyClosedStart(id);return result;
            }
        }
    }
}
