// Fixed SYSTEM provider worker. Owner/observer gate one child; no VM creation.
// Start additionally requires the separately armed original VM guardian and live
// reviewed admission. No controller or production activation is supplied here.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Enclave.OwnedRpc {
    public static class ProviderWorkerEntry {
        sealed class StartGuardRefused : Exception {
            internal readonly string Code;
            internal StartGuardRefused(string code):base(code){Code=code;}
        }
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll",SetLastError=true)] static extern SafeWaitHandle OpenProcess(uint access,bool inherit,uint pid);
        [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(IntPtr handle);
        [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle,out long creation,out long exit,out long kernel,out long user);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
        static extern bool QueryFullProcessImageName(IntPtr handle,uint flags,StringBuilder name,ref int length);
        [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out SafeWaitHandle token);
        static long Number(string value) {return Int64.Parse(value,NumberStyles.None,CultureInfo.InvariantCulture);}
        internal static void ArmOriginalDeadline(long origin,long deadline) {
            long now=BoundedWorker.MonotonicMilliseconds();
            if(origin<0 || origin>Int64.MaxValue-30000 || origin>now || now-origin>=5000 || deadline<=now || deadline<=origin || deadline-origin>30000)
                throw new ArgumentException("Original entry timing refused");
            var armed=new ManualResetEvent(false);
            var thread=new Thread(delegate() {
                armed.Set();
                while(BoundedWorker.MonotonicMilliseconds()<deadline)
                    Thread.Sleep((int)Math.Max(1,Math.Min(10,deadline-BoundedWorker.MonotonicMilliseconds())));
                if(!TerminateProcess(GetCurrentProcess(),125))Environment.FailFast("Entry deadline termination failed");
            });thread.IsBackground=true;thread.Start();
            if(!armed.WaitOne((int)Math.Max(0,Math.Min(1000,deadline-BoundedWorker.MonotonicMilliseconds()))))
                throw new InvalidOperationException("Entry watchdog did not arm");
        }
        static string Identity(ProtectedAttempt a,string role) {
            using(var p=Process.GetCurrentProcess())return p.Id+","+p.StartTime.ToUniversalTime().ToFileTimeUtc()+","+a.Token+","+role;
        }
        static string WaitMessage(ProtectedAttempt a,string name) {
            while(!File.Exists(Path.Combine(a.Root,name))) {a.CheckDeadline();Thread.Sleep(5);}
            return a.ReadOnce(name);
        }
        static SafeWaitHandle Peer(ProtectedAttempt a,string role,uint access,out uint pid,out long creation) {
            string[] fields=WaitMessage(a,role+".consumed").Split(',');
            if(fields.Length!=4 || fields[2]!=a.Token || fields[3]!=role)throw new InvalidOperationException("Peer contract binding differs");
            pid=UInt32.Parse(fields[0],NumberStyles.None,CultureInfo.InvariantCulture);creation=Number(fields[1]);
            var handle=OpenProcess(access|0x1000|0x100000,false,pid);
            if(handle.IsInvalid){handle.Dispose();throw new Win32Exception(Marshal.GetLastWin32Error());}
            try {
                long c,e,k,u;IntPtr h=handle.DangerousGetHandle();
                if(GetProcessId(h)!=pid || !GetProcessTimes(h,out c,out e,out k,out u) || c!=creation || WaitForSingleObject(h,0)!=258)
                    throw new InvalidOperationException("Peer incarnation differs");
                var image=new StringBuilder(512);int length=image.Capacity;
                if(!QueryFullProcessImageName(h,0,image,ref length))
                    throw new Win32Exception(Marshal.GetLastWin32Error(),"Peer image query failed");
                if(!String.Equals(image.ToString(),a.Executable,StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Peer executable differs: actual="+image+" expected="+a.Executable);
                SafeWaitHandle token;
                if(!OpenProcessToken(h,8,out token))throw new Win32Exception(Marshal.GetLastWin32Error());
                using(token)using(var identity=new WindowsIdentity(token.DangerousGetHandle()))
                    if(identity.User==null || identity.User.Value!="S-1-5-18")throw new InvalidOperationException("Peer is not SYSTEM");
                a.CheckDeadline();return handle;
            } catch {handle.Dispose();throw;}
        }
        static string Quote(string text) {if(text.IndexOf('"')>=0)throw new ArgumentException("Quote in path");return "\""+text+"\"";}
        static int Owner(ProtectedAttempt a,string contract) {
            using(var vm=ProtectedAttempt.OpenVmJournal(a.PermitPath,a.PermitHash,a,a.Operation!="start")) {
            a.WriteOnce("owner.consumed",Identity(a,"owner"));
            if(WaitMessage(a,"admit")!=a.Token)throw new InvalidOperationException("Closed owner gate differs");
            uint pid;long creation;
            using(var observer=Peer(a,"observer",0x40,out pid,out creation)) {
                if(WaitMessage(a,"attached")!=a.Token)throw new InvalidOperationException("Owner admission differs");
                BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);
                string root=Environment.GetEnvironmentVariable("SystemRoot");
                var env=new Dictionary<string,string>{{"SystemRoot",root},{"WINDIR",root},{"TEMP",a.Root},{"TMP",a.Root}};
                var result=BoundedWorker.RunGuarded(a.Executable,Quote(a.Executable)+" child "+Quote(contract)+" "+a.ContractHash+" "+a.Origin+" "+a.Deadline,
                    a.Root,env,a.Deadline,1000,128UL*1024*1024,delegate(SuspendedWorkerBinding child) {
                        StartIdentity intent;
                        if(a.Operation=="start") {
                            var p=vm.VmPermit;
                            intent=new StartIdentity(p.Attempt,p.Boot,p.AdmissionHash,vm.ContractHash,p.VmGuid,p.VmName,p.OwnerNote,p.ConfigurationRoot,p.Origin,p.Deadline,
                                child.ProcessId,child.CreationFileTime,pid,creation,p.ImageHash);
                            ProviderStart.Prepare(intent,new OwnedVmStartJournal(vm,intent));
                        } else {
                            intent=StartIdentity.Decode(vm.ReadOnce("start.intent"));vm.VmPermit.Bind(intent,vm.ContractHash);
                            if(a.Operation=="stop")ProviderStop.Prepare(intent,new OwnedVmStartJournal(vm,intent));
                        }
                        a.WriteOnce("operation.bound",a.Token+","+vm.ContractHash+","+a.Operation+","+ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(intent.Encode())));
                        long remote=BoundedWorker.DuplicateChildToObserver(child,observer.DangerousGetHandle(),pid,creation);
                        a.WriteOnce("child.binding",remote+","+child.ProcessId+","+child.CreationFileTime+","+a.Token+","+a.Deadline);
                        while(!File.Exists(Path.Combine(a.Root,"release"))) {
                            BoundedWorker.VerifyObserverBeforeResume(observer.DangerousGetHandle(),pid,creation,a.Deadline);Thread.Sleep(5);
                        }
                        if(a.ReadOnce("release")!=a.Token)throw new InvalidOperationException("Child release differs");
                        BoundedWorker.VerifyObserverBeforeResume(observer.DangerousGetHandle(),pid,creation,a.Deadline);return true;
                    });
                a.WriteOnce("owner.result",result.LocalSuccess?"worker-complete;provider-fenced=false;reservation-release=false":"worker-failed;reservation-release=false");
                return result.LocalSuccess?0:1;
            }
        }
        }
        static int Observer(ProtectedAttempt a) {
            // The entry deadline already runs independently. A start observer
            // creates no child/job before the VM guardian assigns the pair;
            // nesting an already unrelated self job would invalidate containment.
            a.WriteOnce("observer.consumed",Identity(a,"observer"));
            if(WaitMessage(a,"admit")!=a.Token)throw new InvalidOperationException("Closed observer gate differs");
            BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);
            var guard=BoundedWorker.ArmOwnerObserver(a.Origin,a.Deadline,a.Token);
            uint pid;long creation;
            using(var owner=Peer(a,"owner",0x100|1,out pid,out creation)) {
                guard.AttachGatedOwner(owner.DangerousGetHandle(),pid,creation);a.WriteOnce("attached",a.Token);
                string[] fields=WaitMessage(a,"child.binding").Split(',');
                if(fields.Length!=5)throw new InvalidOperationException("Child binding shape");
                guard.BindTransferredChild(Number(fields[0]),UInt32.Parse(fields[1],NumberStyles.None,CultureInfo.InvariantCulture),Number(fields[2]),fields[3],Number(fields[4]));
                a.WriteOnce("release",a.Token);
                while(WaitForSingleObject(owner.DangerousGetHandle(),0)==258){a.CheckDeadline();Thread.Sleep(5);}
                bool exited=guard.ObserveOwnerTreeExited();
                while(!exited){a.CheckDeadline();Thread.Sleep(5);exited=guard.ObserveOwnerTreeExited();}
                a.WriteOnce("observer.result",exited?"exact-owner-death;job-empty;provider-fenced=false;reservation-release=false":"cleanup-unconfirmed;reservation-release=false");
                return exited?0:1;
            }
        }

        sealed class Runtime : IStopRuntime,IPhysicalStartRuntime,IDisposable {
            readonly ProtectedAttempt lease,vm;
            readonly StartIdentity original;
            readonly SafeWaitHandle observer,owner;
            readonly uint observerPid,ownerPid,selfPid;
            readonly long observerCreation,ownerCreation,selfCreation;
            SafeWaitHandle guardian;
            HostPhysicalPool physicalPool;
            PhysicalClaim physicalClaim;
            LegacyHandoff.Completion completedHandoff;
            public long Now {get{return BoundedWorker.MonotonicMilliseconds();}}
            public long GuestBytes {get{return vm.VmPermit.GuestBytes;}}
            internal Runtime(ProtectedAttempt lease,ProtectedAttempt vm,StartIdentity original) {
                this.lease=lease;this.vm=vm;this.original=original;
                try {
                    using(var self=Process.GetCurrentProcess()){selfPid=(uint)self.Id;selfCreation=self.StartTime.ToUniversalTime().ToFileTimeUtc();}
                    observer=Peer(lease,"observer",0,out observerPid,out observerCreation);
                    owner=Peer(lease,"owner",0,out ownerPid,out ownerCreation);
                    VerifyObservation(original);
                }catch{Dispose();throw;}
            }
            void Common(StartIdentity id) {
                ProtectedAttempt.RequireSystem();lease.CheckDeadline();vm.CheckDeadline();vm.VmPermit.Bind(id,vm.ContractHash);
                if(id.Encode()!=original.Encode()||lease.LeaseProfile!="provider"||lease.PermitHash!=vm.ContractHash||lease.Boot!=ProtectedAttempt.CurrentBoot())throw new InvalidOperationException("Worker contract changed");
                BoundedWorker.VerifyObserverBeforeResume(observer.DangerousGetHandle(),observerPid,observerCreation,lease.Deadline);
                BoundedWorker.VerifyObserverBeforeResume(owner.DangerousGetHandle(),ownerPid,ownerCreation,lease.Deadline);
                string[] b=lease.ReadOnce("child.binding").Split(',');
                if(b.Length!=5||UInt32.Parse(b[1],CultureInfo.InvariantCulture)!=selfPid||Number(b[2])!=selfCreation||b[3]!=lease.Token||Number(b[4])!=lease.Deadline)
                    throw new InvalidOperationException("Exact guarded child differs");
                if(lease.ReadOnce("attached")!=lease.Token||lease.ReadOnce("release")!=lease.Token||
                    lease.ReadOnce("operation.bound")!=lease.Token+","+vm.ContractHash+","+lease.Operation+","+ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(id.Encode())))
                    throw new InvalidOperationException("One-shot operation release differs");
            }
            public void VerifyObservation(StartIdentity id){Common(id);}
            static void OriginalProcessExited(uint pid,long creation) {
                // Same boot is checked by Common. A reused PID with a different
                // creation time is not the original process; access denial is not death.
                var held=OpenProcess(0x1000|0x100000,false,pid);
                if(held.IsInvalid) {
                    int error=Marshal.GetLastWin32Error();held.Dispose();
                    if(error==87)return; // validated nonzero PID absent on this boot
                    throw new Win32Exception(error,"Original process death unknown");
                }
                using(held) {
                    long c,e,k,u;if(!GetProcessTimes(held.DangerousGetHandle(),out c,out e,out k,out u))throw new Win32Exception(Marshal.GetLastWin32Error());
                    if(c>creation)return;
                    if(c!=creation)throw new InvalidOperationException("Original process creation ordering differs");
                    if(WaitForSingleObject(held.DangerousGetHandle(),0)!=0)throw new StartGuardRefused("original-start-worker-still-live");
                }
            }
            public void VerifyClosedStart(StartIdentity id) {
                Common(id);
                if(lease.Operation!="stop"&&lease.Operation!="stop-reconcile")throw new InvalidOperationException("Cleanup lease required");
                // Expiry alone cannot cancel a native call. Exact original local
                // death AND persisted provider settlement are separate requirements.
                if(Now<id.Deadline)throw new StartGuardRefused("cleanup-before-startup-deadline");
                if(id.WorkerPid==selfPid&&id.WorkerCreation==selfCreation)throw new InvalidOperationException("Cleanup cannot be original submitter");
                OriginalProcessExited(id.WorkerPid,id.WorkerCreation);OriginalProcessExited(id.ObserverPid,id.ObserverCreation);
                Common(id);
            }
            public void VerifyBeforeStop(StartIdentity id) {
                VerifyClosedStart(id);
                if(lease.Operation!="stop")throw new InvalidOperationException("Read-only cleanup cannot disable a VM");
            }

            public void VerifyBeforeSubmit(StartIdentity id) {
                Common(id);
                if(lease.Operation!="start"||id.WorkerPid!=selfPid||id.WorkerCreation!=selfCreation||id.ObserverPid!=observerPid||id.ObserverCreation!=observerCreation)
                    throw new InvalidOperationException("This worker cannot submit the original start");
                vm.VmPermit.ValidateAccess(Now,false);
                // A VM guardian is a distinct process, tied to the ORIGINAL 900s
                // permit. The short-lived owner/observer is not a VM guardian.
                if(lease.GuardianPid==selfPid||lease.GuardianPid==ownerPid||lease.GuardianPid==observerPid)throw new StartGuardRefused("guardian-not-independent");
                if(guardian==null)guardian=GuardianPeer();
                BoundedWorker.VerifyObserverBeforeResume(guardian.DangerousGetHandle(),lease.GuardianPid,lease.GuardianCreation,vm.Deadline);
                string expected=vm.Token+","+lease.GuardianPid+","+lease.GuardianCreation+","+vm.Origin+","+vm.Deadline;
                if(vm.ReadOnce("guardian.armed")!=expected ||
                    vm.ReadOnce("guardian.bound")!=expected+","+lease.Token+","+observerPid+","+observerCreation)
                    throw new StartGuardRefused("guardian-binding-mismatch");
                string accepted=lease.ReadOptionalOnce("guardian.accepted");
                if(accepted==null)lease.WriteOnce("guardian.accepted",expected+","+lease.Token);
                else if(accepted!=expected+","+lease.Token)throw new StartGuardRefused("guardian-binding-mismatch");
                WindowsStartAdmission.Verify(vm,lease,ref completedHandoff);
                if(physicalPool==null)physicalPool=WindowsStartAdmission.AcquireShared(vm,id,lease.Deadline,out physicalClaim);
                Common(id);vm.VmPermit.ValidateAccess(Now,false);
                BoundedWorker.VerifyObserverBeforeResume(guardian.DangerousGetHandle(),lease.GuardianPid,lease.GuardianCreation,vm.Deadline);
            }
            public void ConsumePhysicalStart(StartIdentity id) {
                VerifyBeforeSubmit(id);
                if(physicalPool==null||physicalClaim==null)throw new InvalidOperationException("Shared physical reservation absent");
                physicalPool.ConsumeStart(physicalClaim);
                Common(id);vm.VmPermit.ValidateAccess(Now,false);
                BoundedWorker.VerifyObserverBeforeResume(guardian.DangerousGetHandle(),lease.GuardianPid,lease.GuardianCreation,vm.Deadline);
            }
            SafeWaitHandle GuardianPeer() {
                var h=OpenProcess(0x1000|0x100000,false,lease.GuardianPid);
                if(h.IsInvalid){int e=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(e);}
                try {
                    BoundedWorker.VerifyObserverBeforeResume(h.DangerousGetHandle(),lease.GuardianPid,lease.GuardianCreation,vm.Deadline);
                    var path=new StringBuilder(512);int length=path.Capacity;
                    if(!QueryFullProcessImageName(h.DangerousGetHandle(),0,path,ref length))throw new Win32Exception(Marshal.GetLastWin32Error());
                    if(!String.Equals(path.ToString(),vm.Executable,StringComparison.OrdinalIgnoreCase))throw new StartGuardRefused("guardian-image-mismatch");
                    SafeWaitHandle token;if(!OpenProcessToken(h.DangerousGetHandle(),8,out token))throw new Win32Exception(Marshal.GetLastWin32Error());
                    using(token)using(var identity=new WindowsIdentity(token.DangerousGetHandle()))
                        if(identity.User==null||identity.User.Value!="S-1-5-18")throw new StartGuardRefused("guardian-context-not-system");
                    return h;
                }catch{h.Dispose();throw;}
            }
            public void Dispose(){if(physicalPool!=null)physicalPool.Dispose();if(completedHandoff!=null)completedHandoff.Dispose();if(guardian!=null)guardian.Dispose();if(owner!=null)owner.Dispose();if(observer!=null)observer.Dispose();}
        }

        static int Guardian(string path,string hash,long origin,long deadline) {
            // Independent native deadline is armed BEFORE any protected-file/WMI
            // calls. Envelope bootstrap is bounded by the external launcher too.
            BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);
            var guard=BoundedWorker.ArmVmStartGuardian(origin,deadline);
            using(var vm=ProtectedAttempt.OpenVmGuardian(path,hash)) {
                if(vm.Origin!=origin||vm.Deadline!=deadline)throw new InvalidOperationException("Guardian CLI changed original permit timing");
                uint selfPid;long selfCreation;
                using(var self=Process.GetCurrentProcess()) {
                    selfPid=(uint)self.Id;selfCreation=self.StartTime.ToUniversalTime().ToFileTimeUtc();
                    if(!String.Equals(self.MainModule.FileName,vm.Executable,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Guardian entry path differs");
                }
                vm.WriteOnce("guardian.consumed",Identity(vm,"guardian"));
                string[] request=WaitMessage(vm,"guardian.request").Split('\n');
                if(request.Length!=2)throw new InvalidOperationException("Exact guardian request required");
                using(var a=ProtectedAttempt.OpenProviderWorker(request[0],request[1])) {
                    if(a.Operation!="start"||a.PermitHash!=vm.ContractHash||!String.Equals(a.PermitPath,path,StringComparison.OrdinalIgnoreCase)||
                        a.GuardianPid!=selfPid||a.GuardianCreation!=selfCreation||a.Boot!=vm.Boot||a.ExecutableHash!=vm.ExecutableHash||a.Deadline>vm.Deadline)
                        throw new InvalidOperationException("Guardian worker permit binding differs");
                    uint op,sp;long oc,sc;
                    using(var owner=Peer(a,"owner",0x100|1,out op,out oc))using(var observer=Peer(a,"observer",0x100|1,out sp,out sc)) {
                        if(a.ReadOptionalOnce("admit")!=null)throw new InvalidOperationException("Worker gate already open");
                        guard.AttachGatedPair(owner.DangerousGetHandle(),op,oc,observer.DangerousGetHandle(),sp,sc);
                        string identity=vm.Token+","+selfPid+","+selfCreation+","+vm.Origin+","+vm.Deadline;
                        vm.WriteOnce("guardian.armed",identity);
                        vm.WriteOnce("guardian.bound",identity+","+a.Token+","+sp+","+sc);
                        a.WriteOnce("admit",a.Token);
                        while(!guard.ObservePairExited()){vm.CheckDeadline();Thread.Sleep(5);}
                        // Exact local death is recorded separately from provider
                        // settlement. No reservation is released by this receipt.
                        vm.WriteOnce("guardian.result","exact-pair-death;job-empty;provider-fenced=false;reservation-release=false");
                        // If a native call might have happened, remain attached to
                        // the original deadline. Settlement/VM stop is a separate
                        // unfinished integration; do not pretend local death did it.
                        if(vm.ReadOptionalOnce("start.native")!=null)while(true){vm.CheckDeadline();Thread.Sleep(10);}
                        return 0;
                    }
                }
            }
        }
        public static int Main(string[] args) {
            try {
                if(args.Length!=5 || (args[0]!="owner" && args[0]!="observer" && args[0]!="child" && args[0]!="guardian"))return 64;
                long origin=Number(args[3]),deadline=Number(args[4]);
                if(args[0]=="guardian")return Guardian(args[1],args[2],origin,deadline);
                ArmOriginalDeadline(origin,deadline);
                using(var a=ProtectedAttempt.OpenProviderWorker(args[1],args[2])) {
                    if(a.Origin!=origin || a.Deadline!=deadline)throw new InvalidOperationException("CLI deadline differs from immutable contract");
                    using(var self=Process.GetCurrentProcess())
                        if(!String.Equals(self.MainModule.FileName,a.Executable,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Entry image path differs");
                    if(args[0]=="owner")return Owner(a,args[1]);
                    if(args[0]=="observer")return Observer(a);
                    a.WriteOnce("child.consumed",Identity(a,"child"));
                    using(var vm=ProtectedAttempt.OpenVmJournal(a.PermitPath,a.PermitHash,a,a.Operation!="start")) {
                        var id=StartIdentity.Decode(vm.ReadOnce("start.intent"));
                        var journal=new OwnedVmStartJournal(vm,id);
                        using(var runtime=new Runtime(a,vm,id)) {
                            runtime.VerifyObservation(id);
                            var provider=new HyperVStartProvider(runtime,journal);
                            try {
                                if(a.Operation=="stop"||a.Operation=="stop-reconcile") {
                                    var stops=new HyperVStopProvider(runtime,journal);
                                    var stopped=a.Operation=="stop"?ProviderStop.Submit(id,journal,provider,stops,runtime):ProviderStop.Reconcile(id,journal,provider,stops,runtime);
                                    a.WriteOnce("child.result",stopped.State+";start-settled="+stopped.StartSettled+";stop-settled="+stopped.StopSettled+";owned-off-zero="+stopped.OwnedOffZeroConfirmed+";provider-fenced=false;reservation-release=false");return 0;
                                }
                                var result=a.Operation=="start"?ProviderStart.Submit(id,journal,provider,runtime):ProviderStart.Reconcile(id,journal,provider,runtime);
                                a.WriteOnce("child.result",result.State+";settled="+result.OperationSettled+";provider-fenced=false;reservation-release=false");return 0;
                            }catch(StartGuardRefused denied){a.WriteOnce("child.refusal",denied.Code);return 1;}
                        }
                    }
                }
            } catch(Exception error) {Console.Error.WriteLine(error.GetType().Name+": "+error.Message);return 1;}
        }
    }
}
