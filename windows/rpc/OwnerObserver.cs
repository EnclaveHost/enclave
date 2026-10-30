// One-shot, process-lifetime observer primitive. No provider or VM operations.
// Trusted transport/namespace and target SYSTEM admission are separate gates.
using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace Enclave.OwnedRpc {
    public static partial class BoundedWorker {
        const uint QueryLimited=0x1000, Synchronize=0x100000;
        [DllImport("kernel32.dll",SetLastError=true)]
        static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,
            out IntPtr target,uint access,bool inherit,uint options);
        [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(IntPtr process);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetHandleInformation(IntPtr handle,out uint flags);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
        static int observerAttempted;
        static int childTransferAttempted;
        static OwnerObserver processLifetimeObserver;

        static void ExactLiveProcess(IntPtr handle,uint pid,long creation) {
            long actual,exit,kernel,user;
            if(handle==IntPtr.Zero || pid==0 || creation<=0 || GetProcessId(handle)!=pid)
                throw new InvalidOperationException("Process handle identity differs");
            Check(GetProcessTimes(handle,out actual,out exit,out kernel,out user),"Read held process identity");
            if(actual!=creation || WaitForSingleObject(handle,0)!=WaitTimeout)
                throw new InvalidOperationException("Process incarnation differs or is not live");
        }
        static void BindingToken(string token) {
            // nonce(32) + boot identity(32) + contract digest(64), exact lowercase hex.
            // Shape does not authenticate provenance; only a protected caller may supply it.
            if(token==null || token.Length!=128) throw new ArgumentException("Binding token length");
            foreach(char c in token) if(!((c>='0' && c<='9') || (c>='a' && c<='f')))
                throw new ArgumentException("Binding token encoding");
        }

        // All retained native handles deliberately live until observer process death.
        // No Dispose/finalizer/detach and no concurrent close/query handle-reuse race.
        // Never pass the private job handle to the owner, its descendants, or IPC.
        public sealed class OwnerObserver {
            readonly long origin,deadline;
            readonly string token;
            IntPtr job,owner,child;
            int attachAttempted,bindAttempted;
            public bool OwnerAssigned {get;private set;}
            public bool ChildBound {get;private set;}
            public bool ProviderOperationFenced {get{return false;}}
            public bool ReservationMayRelease {get{return false;}}
            internal OwnerObserver(long originalOrigin,long originalDeadline,string bindingToken) {
                origin=originalOrigin;deadline=originalDeadline;token=bindingToken;
            }
            internal void Arm() {
                // Arm before any job creation, assignment, or possibly blocking binding.
                // The dedicated thread never waits on a binding lock/native Run call.
                var armed=new ManualResetEvent(false);
                var watchdog=new Thread(delegate() {
                    armed.Set();
                    while(MonotonicMilliseconds()<deadline)
                        Thread.Sleep((int)Math.Min(10,Math.Max(1,deadline-MonotonicMilliseconds())));
                    // Kernel process teardown closes the sole owner-job handle even
                    // if the application thread is blocked. Never renew this deadline.
                    if(!TerminateProcess(GetCurrentProcess(),124)) Environment.FailFast("Observer deadline termination failed");
                });
                watchdog.IsBackground=true;watchdog.Start();
                if(!armed.WaitOne((int)Math.Max(0,Math.Min(1000,deadline-MonotonicMilliseconds()))))
                    throw new InvalidOperationException("Independent watchdog did not arm");
                // Keep the event until process teardown too; no Set/Dispose race.
            }
            void BeforeDeadline() {
                if(MonotonicMilliseconds()>=deadline) throw new InvalidOperationException("Original observer deadline expired");
            }
            public void AttachGatedOwner(IntPtr borrowedOwner,uint pid,long creation) {
                if(Interlocked.Exchange(ref attachAttempted,1)!=0) throw new InvalidOperationException("Owner attachment consumed");
                BeforeDeadline();
                if(MonotonicMilliseconds()>=Math.Min(deadline,origin+5000))
                    throw new InvalidOperationException("Original bootstrap cutoff expired");
                if(pid==GetCurrentProcessId()) throw new InvalidOperationException("Observer cannot be its own owner");
                ExactLiveProcess(borrowedOwner,pid,creation);
                // SET_QUOTA + TERMINATE for assignment, limited query + synchronize.
                Check(DuplicateHandle(GetCurrentProcess(),borrowedOwner,GetCurrentProcess(),out owner,
                    0x100|1|QueryLimited|Synchronize,false,0),"Retain exact gated owner");
                job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero,"Create private owner job");
                var limits=new ExtendedLimits();
                limits.Basic.Flags=KillOnClose|JobMemory|ActiveLimit|AffinityLimit;
                limits.Basic.ActiveProcessLimit=4;limits.Basic.Affinity=new UIntPtr(2);
                limits.JobMemory=new UIntPtr(256UL*1024*1024);
                Check(SetInformationJobObject(job,ExtendedLimitsClass,ref limits,
                    (uint)Marshal.SizeOf(typeof(ExtendedLimits))),"Set owner job limits");
                VerifyLimits();BeforeDeadline();
                Check(AssignProcessToJobObject(job,owner),"Assign exact gated owner");
                bool member;Check(IsProcessInJob(owner,job,out member),"Read owner membership");
                ExactLiveProcess(owner,pid,creation);VerifyLimits();BeforeDeadline();
                if(!member || Active(job)!=1) throw new InvalidOperationException("Owner job membership differs");
                // Requires pinned owner code that creates no children before this ACK.
                // Assignment cannot retroactively contain preexisting children.
                OwnerAssigned=true;
            }
            void VerifyLimits() {
                ExtendedLimits actual;
                Check(QueryLimits(job,ExtendedLimitsClass,out actual,
                    (uint)Marshal.SizeOf(typeof(ExtendedLimits)),IntPtr.Zero),"Read owner job limits");
                uint flags;Check(GetHandleInformation(job,out flags),"Read owner job handle flags");
                if(actual.Basic.Flags!=(KillOnClose|JobMemory|ActiveLimit|AffinityLimit) ||
                    actual.Basic.ActiveProcessLimit!=4 || actual.Basic.Affinity.ToUInt64()!=2 ||
                    actual.JobMemory.ToUInt64()!=256UL*1024*1024 || (flags&1)!=0)
                    throw new InvalidOperationException("Owner job limits or inheritance differ");
            }
            // receivedHandle is valid in THIS observer process, transferred once by
            // DuplicateChildToObserver. A protected IPC adapter must authenticate the
            // sender/nonce; this method is not a general untrusted-handle parser.
            public void BindTransferredChild(long receivedHandle,uint pid,long creation,
                string bindingToken,long originalDeadline) {
                if(Interlocked.Exchange(ref bindAttempted,1)!=0) throw new InvalidOperationException("Child binding consumed");
                BeforeDeadline();
                if(!OwnerAssigned || bindingToken!=token || originalDeadline!=deadline || receivedHandle<=0)
                    throw new InvalidOperationException("Child binding context differs");
                child=new IntPtr(receivedHandle);
                ExactLiveProcess(child,pid,creation);
                uint flags;Check(GetHandleInformation(child,out flags),"Read child handle flags");
                bool member;Check(IsProcessInJob(child,job,out member),"Read child owner-job membership");
                if((flags&1)!=0 || !member || WaitForSingleObject(owner,0)!=WaitTimeout)
                    throw new InvalidOperationException("Child not in live owner's job");
                VerifyLimits();BeforeDeadline();ChildBound=true;
            }
            // Observation only; false/exception retains reservation. This does not
            // settle provider operations and never releases resources on its own.
            public bool ObserveOwnerTreeExited() {
                return OwnerAssigned && WaitForSingleObject(owner,0)==WaitObject &&
                    (!ChildBound || WaitForSingleObject(child,0)==WaitObject) && Active(job)==0;
            }
        }
        public static OwnerObserver ArmOwnerObserver(long originalOrigin,long originalDeadline,string bindingToken) {
            if(Interlocked.Exchange(ref observerAttempted,1)!=0) throw new InvalidOperationException("Observer arm consumed");
            BindingToken(bindingToken);
            long now=MonotonicMilliseconds();
            if(originalOrigin<0 || originalOrigin>Int64.MaxValue-30000 || originalOrigin>now ||
                now-originalOrigin>=5000 || originalDeadline<=now ||
                originalDeadline-originalOrigin>30000 || originalDeadline<=originalOrigin)
                throw new ArgumentOutOfRangeException("Original observer timing");
            lock(EnvelopeLock) {
                if(!envelopeVerified || envelopeMemoryBytes!=128UL*1024*1024 || operationAttempted)
                    throw new InvalidOperationException("Observer requires unused self 128MiB envelope");
            }
            var observer=new OwnerObserver(originalOrigin,originalDeadline,bindingToken);
            processLifetimeObserver=observer;observer.Arm();return observer;
        }
        // One invocation per trusted owner callback. No handle is inherited; the
        // observer receives only query/synchronize access, never terminate/job access.
        public static long DuplicateChildToObserver(SuspendedWorkerBinding binding,IntPtr heldObserver,
            uint observerPid,long observerCreation) {
            if(Interlocked.Exchange(ref childTransferAttempted,1)!=0) throw new InvalidOperationException("Child transfer consumed");
            if(binding==null) throw new ArgumentNullException("binding");
            VerifyObserverBeforeResume(heldObserver,observerPid,observerCreation,binding.AbsoluteDeadlineMilliseconds);
            ExactLiveProcess(binding.BorrowedProcessHandle,binding.ProcessId,binding.CreationFileTime);
            IntPtr remote;
            Check(DuplicateHandle(GetCurrentProcess(),binding.BorrowedProcessHandle,heldObserver,
                out remote,QueryLimited|Synchronize,false,0),"Transfer exact child query handle");
            // Lost acknowledgment is ambiguous: no re-duplication or guessed close.
            return remote.ToInt64();
        }
        public static void VerifyObserverBeforeResume(IntPtr heldObserver,uint pid,long creation,long originalDeadline) {
            ExactLiveProcess(heldObserver,pid,creation);
            if(MonotonicMilliseconds()>=originalDeadline) throw new InvalidOperationException("Original owner deadline expired");
        }
    }
}
