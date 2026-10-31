// Original-deadline containment for the two gated start-worker roles.
// This closes local start execution, NOT an already submitted Hyper-V operation.
using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace Enclave.OwnedRpc {
    public static partial class BoundedWorker {
        static int vmGuardianAttempted;
        static VmStartGuardian processLifetimeVmGuardian;
        public sealed class VmStartGuardian {
            readonly long deadline;
            IntPtr job,owner,observer;
            int attachAttempted;
            public bool PairAssigned {get;private set;}
            public bool ProviderOperationFenced {get{return false;}}
            public bool ReservationMayRelease {get{return false;}}
            internal VmStartGuardian(long originalDeadline){deadline=originalDeadline;}
            internal void Arm() {
                var armed=new ManualResetEvent(false);
                var thread=new Thread(delegate() {
                    armed.Set();
                    while(MonotonicMilliseconds()<deadline)
                        Thread.Sleep((int)Math.Max(1,Math.Min(10,deadline-MonotonicMilliseconds())));
                    // Sole private job handle closes on process death, even when
                    // the calling thread is blocked inside a filesystem/native API.
                    if(!TerminateProcess(GetCurrentProcess(),126))Environment.FailFast("VM start guardian deadline failed");
                });thread.IsBackground=true;thread.Start();
                if(!armed.WaitOne((int)Math.Max(0,Math.Min(1000,deadline-MonotonicMilliseconds()))))
                    throw new InvalidOperationException("VM start watchdog did not arm");
            }
            void BeforeDeadline(){if(MonotonicMilliseconds()>=deadline)throw new InvalidOperationException("Original VM deadline expired");}
            // Both exact pinned roles MUST still be behind their original admit
            // gate, with no children. Assignment cannot capture older children.
            // Any partial assignment stays owned until guardian process death.
            public void AttachGatedPair(IntPtr ownerHandle,uint ownerPid,long ownerCreation,
                IntPtr observerHandle,uint observerPid,long observerCreation) {
                if(Interlocked.Exchange(ref attachAttempted,1)!=0)throw new InvalidOperationException("VM worker pair consumed");
                BeforeDeadline();
                if(ownerPid==observerPid||ownerPid==GetCurrentProcessId()||observerPid==GetCurrentProcessId())throw new InvalidOperationException("Distinct guardian and worker roles required");
                ExactLiveProcess(ownerHandle,ownerPid,ownerCreation);ExactLiveProcess(observerHandle,observerPid,observerCreation);
                Check(DuplicateHandle(GetCurrentProcess(),ownerHandle,GetCurrentProcess(),out owner,0x100|1|QueryLimited|Synchronize,false,0),"Retain VM start owner");
                Check(DuplicateHandle(GetCurrentProcess(),observerHandle,GetCurrentProcess(),out observer,0x100|1|QueryLimited|Synchronize,false,0),"Retain VM start observer");
                job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero,"Create private VM start group");
                var limits=new ExtendedLimits();limits.Basic.Flags=KillOnClose|JobMemory|ActiveLimit|AffinityLimit;
                limits.Basic.ActiveProcessLimit=8;limits.Basic.Affinity=new UIntPtr(2);limits.JobMemory=new UIntPtr(512UL*1024*1024);
                Check(SetInformationJobObject(job,ExtendedLimitsClass,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))),"Set VM start group limits");
                VerifyLimits();BeforeDeadline();
                Check(AssignProcessToJobObject(job,owner),"Assign VM start owner");
                Check(AssignProcessToJobObject(job,observer),"Assign VM start observer");
                bool a,b;Check(IsProcessInJob(owner,job,out a),"Read VM owner membership");Check(IsProcessInJob(observer,job,out b),"Read VM observer membership");
                ExactLiveProcess(owner,ownerPid,ownerCreation);ExactLiveProcess(observer,observerPid,observerCreation);
                VerifyLimits();BeforeDeadline();
                if(!a||!b||Active(job)!=2)throw new InvalidOperationException("VM gated pair membership differs");
                PairAssigned=true;
            }
            void VerifyLimits() {
                ExtendedLimits limits;uint flags;
                Check(QueryLimits(job,ExtendedLimitsClass,out limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits)),IntPtr.Zero),"Read VM start group limits");
                Check(GetHandleInformation(job,out flags),"Read VM start job inheritance");
                if(limits.Basic.Flags!=(KillOnClose|JobMemory|ActiveLimit|AffinityLimit)||limits.Basic.ActiveProcessLimit!=8||
                    limits.Basic.Affinity.ToUInt64()!=2||limits.JobMemory.ToUInt64()!=512UL*1024*1024||(flags&1)!=0)
                    throw new InvalidOperationException("VM start job limits differ");
            }
            public bool ObservePairExited() {
                return PairAssigned&&WaitForSingleObject(owner,0)==WaitObject&&WaitForSingleObject(observer,0)==WaitObject&&Active(job)==0;
            }
        }
        // May arm after preparation; never derives a new deadline from 'now'.
        // The protected entry binds this to the immutable exactly-900s permit.
        public static VmStartGuardian ArmVmStartGuardian(long originalOrigin,long originalDeadline) {
            if(Interlocked.Exchange(ref vmGuardianAttempted,1)!=0)throw new InvalidOperationException("VM guardian consumed");
            long now=MonotonicMilliseconds();
            if(originalOrigin<0||originalOrigin>Int64.MaxValue-900000||originalOrigin>now||
                originalDeadline<=now||originalDeadline<=originalOrigin||originalDeadline-originalOrigin>900000)
                throw new ArgumentException("Original VM guardian timing");
            lock(EnvelopeLock) {
                if(!envelopeVerified||envelopeMemoryBytes!=128UL*1024*1024||operationAttempted||observerAttempted!=0)
                    throw new InvalidOperationException("Unused 128MiB guardian envelope required");
            }
            var guardian=new VmStartGuardian(originalDeadline);processLifetimeVmGuardian=guardian;guardian.Arm();return guardian;
        }
    }
}
