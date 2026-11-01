// Explicit SYSTEM-only native definition or original-VM cleanup worker.
// Explicit start roles require independently armed lifecycle custody and a second
// pre-resume handshake. No default manager activation/delete/adoption.
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
    public static class NativeRpcWorkerEntry {
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
        static void ArmOriginalDeadline(long origin,long deadline) {
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
        [DllImport("kernel32.dll",SetLastError=true)]static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
        static IntPtr[] CleanupHandles(ProtectedAttempt a,string name){
            string[] f=a.ReadOnce(name).Split(',');if(f.Length!=4||f[0]!=a.Token)throw new InvalidOperationException("Transferred original cleanup group differs");
            var handles=new IntPtr[3];for(int i=0;i<3;i++){long h=Number(f[i+1]);if(h<=0||h.ToString(CultureInfo.InvariantCulture)!=f[i+1])throw new InvalidOperationException("Exact transferred process handle required");handles[i]=new IntPtr(h);}return handles;
        }
        static void TransferCleanupHandles(ProtectedAttempt a,SuspendedWorkerBinding child){
            if(a.LeaseProfile!="native-cleanup")throw new InvalidOperationException("Cleanup worker lease required");
            var incoming=CleanupHandles(a,"cleanup.handles");var fields=new List<string>{a.Token};
            foreach(var source in incoming){IntPtr remote;if(!DuplicateHandle(GetCurrentProcess(),source,child.BorrowedProcessHandle,out remote,0x1000|0x100000,false,0))throw new Win32Exception(Marshal.GetLastWin32Error());fields.Add(remote.ToInt64().ToString(CultureInfo.InvariantCulture));}
            // Receiver validates exact image/token/PID/creation against original
            // protected group before any operation. Partial transfer stays held;
            // the suspended child's private job terminates it on failure.
            a.WriteOnce("cleanup.child-handles",String.Join(",",fields));
        }
        static int Owner(ProtectedAttempt a,string contract,bool cleanup,bool start) {
            a.WriteOnce("owner.consumed",Identity(a,"owner"));
            if(WaitMessage(a,"admit")!=a.Token)throw new InvalidOperationException("Closed owner gate differs");
            uint pid;long creation;
            using(var observer=Peer(a,"observer",0x40,out pid,out creation)) {
                if(WaitMessage(a,"attached")!=a.Token)throw new InvalidOperationException("Owner admission differs");
                BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);
                string root=Environment.GetEnvironmentVariable("SystemRoot");
                var env=new Dictionary<string,string>{{"SystemRoot",root},{"WINDIR",root},{"TEMP",a.Root},{"TMP",a.Root}};
                ProtectedAttempt startPlan=null;NativeRpcStartRuntime startRuntime=null;
                try{
                if(start){startPlan=ProtectedAttempt.OpenNativeStartJournal(a.PermitPath,a.PermitHash,a);startRuntime=new NativeRpcStartRuntime(a,startPlan,delegate{a.CheckDeadline();BoundedWorker.VerifyObserverBeforeResume(observer.DangerousGetHandle(),pid,creation,a.Deadline);});var journal=new NativeRpcCleanupJournal(startPlan);NativeRpcStart.Prepare(startPlan.NativeDefinitionPlan,journal,new HyperVNativeRpcDefinition(startRuntime,journal),startRuntime);}
                var result=BoundedWorker.RunGuarded(a.Executable,Quote(a.Executable)+(cleanup?" cleanup-child ":start?" start-child ":" child ")+Quote(contract)+" "+a.ContractHash+" "+a.Origin+" "+a.Deadline,
                    a.Root,env,a.Deadline,1000,128UL*1024*1024,delegate(SuspendedWorkerBinding child) {
                        if(cleanup)TransferCleanupHandles(a,child);
                        long remote=BoundedWorker.DuplicateChildToObserver(child,observer.DangerousGetHandle(),pid,creation);
                        a.WriteOnce("child.binding",remote+","+child.ProcessId+","+child.CreationFileTime+","+a.Token+","+a.Deadline);
                        if(start)startPlan.WriteOnce("native-start.registration",StartRecords.Encode(new Dictionary<string,object>{{"plan",startPlan.ContractHash},{"contractPath",contract},{"contractHash",a.ContractHash}}));
                        while(!File.Exists(Path.Combine(a.Root,"release"))) {
                            BoundedWorker.VerifyObserverBeforeResume(observer.DangerousGetHandle(),pid,creation,a.Deadline);Thread.Sleep(5);
                        }
                        if(a.ReadOnce("release")!=a.Token)throw new InvalidOperationException("Child release differs");
                        if(start){var j=new NativeRpcCleanupJournal(startPlan);while(j.Read("native-lifecycle.bound")==null){startRuntime.Check(startPlan.NativeDefinitionPlan,false);Thread.Sleep(5);}string workers=j.Read("native-start.workers");if(j.Read("native-lifecycle.bound")!=NativeRpcDefinitionPlan.Hash(workers))throw new InvalidOperationException("Independent lifecycle peer binding differs");startRuntime.Check(startPlan.NativeDefinitionPlan,true);}
                        BoundedWorker.VerifyObserverBeforeResume(observer.DangerousGetHandle(),pid,creation,a.Deadline);return true;
                    });
                a.WriteOnce("owner.result",result.LocalSuccess?(cleanup?"native-cleanup-observed;provider-fenced=false;reservation-release=false":start?"native-start-observed;rpc-ready=false;provider-fenced=false;reservation-release=false":"native-definition-observed;rpc-ready=false;provider-fenced=false;reservation-release=false"):"native-operation-failed;reservation-release=false");
                return result.LocalSuccess?0:1;
                }finally{if(startRuntime!=null)startRuntime.Dispose();if(startPlan!=null)startPlan.Dispose();}
            }
        }
        static int Observer(ProtectedAttempt a) {
            BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);
            var guard=BoundedWorker.ArmOwnerObserver(a.Origin,a.Deadline,a.Token);
            a.WriteOnce("observer.consumed",Identity(a,"observer"));
            if(WaitMessage(a,"admit")!=a.Token)throw new InvalidOperationException("Closed observer gate differs");
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
        public static int Main(string[] args) {
            try {
                if(args.Length!=5)return 64;
                bool cleanup=args[0]=="cleanup-owner"||args[0]=="cleanup-observer"||args[0]=="cleanup-child";
                bool start=args[0]=="start-owner"||args[0]=="start-observer"||args[0]=="start-child";
                string role=cleanup?args[0].Substring(8):start?args[0].Substring(6):args[0];if(role!="owner"&&role!="observer"&&role!="child")return 64;
                long origin=Number(args[3]),deadline=Number(args[4]);ArmOriginalDeadline(origin,deadline);
                using(var a=cleanup?ProtectedAttempt.OpenNativeCleanupWorker(args[1],args[2]):start?ProtectedAttempt.OpenNativeStartWorker(args[1],args[2]):ProtectedAttempt.OpenNativeDefinitionWorker(args[1],args[2])) {
                    if(a.Origin!=origin || a.Deadline!=deadline)throw new InvalidOperationException("CLI deadline differs from immutable contract");
                    using(var self=Process.GetCurrentProcess())
                        if(!String.Equals(self.MainModule.FileName,a.Executable,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Entry image path differs");
                    if(role=="owner")return Owner(a,args[1],cleanup,start);
                    if(role=="observer")return Observer(a);
                    a.WriteOnce("child.consumed",Identity(a,"child"));
                    uint observerPid,ownerPid;long observerCreation,ownerCreation;
                    using(var observer=Peer(a,"observer",0,out observerPid,out observerCreation))
                    using(var owner=Peer(a,"owner",0,out ownerPid,out ownerCreation)) {
                        string[] binding=a.ReadOnce("child.binding").Split(',');
                        using(var self=Process.GetCurrentProcess())
                            if(binding.Length!=5||binding[1]!=self.Id.ToString(CultureInfo.InvariantCulture)||
                               binding[2]!=self.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(CultureInfo.InvariantCulture)||
                               binding[3]!=a.Token||binding[4]!=a.Deadline.ToString(CultureInfo.InvariantCulture))
                                throw new InvalidOperationException("Released child incarnation differs");
                        if(a.ReadOnce("attached")!=a.Token||a.ReadOnce("release")!=a.Token)throw new InvalidOperationException("Bootstrap gate closed");
                        BoundedWorker.VerifyObserverBeforeResume(observer.DangerousGetHandle(),observerPid,observerCreation,a.Deadline);
                        Action check=delegate {
                            a.CheckDeadline();
                            BoundedWorker.VerifyObserverBeforeResume(observer.DangerousGetHandle(),observerPid,observerCreation,a.Deadline);
                            BoundedWorker.VerifyObserverBeforeResume(owner.DangerousGetHandle(),ownerPid,ownerCreation,a.Deadline);
                        };
                        if(start){
                            using(var plan=ProtectedAttempt.OpenNativeStartJournal(a.PermitPath,a.PermitHash,a))using(var runtime=new NativeRpcStartRuntime(a,plan,check)){
                                var journal=new NativeRpcCleanupJournal(plan);string receipt=NativeRpcStart.Submit(plan.NativeDefinitionPlan,journal,new HyperVNativeRpcDefinition(runtime,journal),runtime);check();
                                a.WriteOnce("child.result",StartRecords.Encode(new Dictionary<string,object>{{"schema","native-rpc-start-worker-result/1"},{"plan",plan.ContractHash},{"receipt",receipt??""},{"state",receipt==null?"held":"native-running-observed"},{"rpcReady",false},{"providerOperationFenced",false},{"reservationMayRelease",false}}));return receipt==null?2:0;
                            }
                        }
                        if(cleanup){
                            using(var plan=ProtectedAttempt.OpenNativeCleanupJournal(a.PermitPath,a.PermitHash,a))
                            using(var group=new NativeRpcStartGroup(plan,CleanupHandles(a,"cleanup.child-handles"))){
                                var journal=new NativeRpcCleanupJournal(plan);var runtime=new NativeRpcCleanupRuntime(a,plan,group,check);
                                var provider=new HyperVNativeRpcDefinition(runtime,journal);var p=plan.NativeDefinitionPlan;
                                string receipt=a.Operation=="stop"?NativeRpcCleanup.Submit(p,journal,provider,runtime):NativeRpcCleanup.Reconcile(p,journal,provider,runtime);
                                check();a.WriteOnce("child.result",StartRecords.Encode(new Dictionary<string,object>{{"schema","native-rpc-cleanup-worker-result/1"},{"plan",p.Digest},{"state",receipt==null?"held":"original-off-zero-observed"},{"receipt",receipt??""},{"providerOperationFenced",false},{"reservationMayRelease",false}}));
                                return receipt==null?2:0;
                            }
                        }
                        using(var plan=ProtectedAttempt.OpenNativeDefinitionJournal(a.PermitPath,a.PermitHash,a))
                        using(var runtime=new NativeRpcWorkerRuntime(a,plan,check)){
                            var p=plan.NativeDefinitionPlan;var journal=new NativeRpcDefinitionJournal(plan);var provider=new HyperVNativeRpcDefinition(runtime,journal);
                            runtime.Check(p,false);NativeRpcDefinitionOutcome result;
                            if(a.Operation=="define"){NativeRpcDefinition.Prepare(p,journal);result=NativeRpcDefinition.Submit(p,journal,provider,runtime);}
                            else result=NativeRpcDefinition.Reconcile(p,journal,provider,runtime);
                            string securityReceipt="",opticalReceipt="",readGrantReceipt="",deviceReceipt="";
                            if(result.State=="defined-native-owned-off"){
                                // Same original lease and asset pins; never reopen a consumed
                                // security operation from a reconcile-only worker.
                                securityReceipt=a.Operation=="define"?NativeRpcSecurity.Submit(p,journal,provider,runtime):
                                    (journal.Read("native-security.intent")==null?null:NativeRpcSecurity.Reconcile(p,journal,provider,runtime));
                                if(securityReceipt==null)throw new InvalidOperationException("Native security operation held; no start or retry");
                                readGrantReceipt=NativeRpcReadGrant.Run(p,journal,runtime,plan.NativeReadAccess(),a.Operation!="define");
                                if(readGrantReceipt==null)throw new InvalidOperationException("Native file read grant held; no start or retry");
                                opticalReceipt=NativeRpcOptical.Configure(p,journal,provider,runtime,a.Operation!="define");
                                if(opticalReceipt==null)throw new InvalidOperationException("Native optical operation held; no start or retry");
                                deviceReceipt=NativeRpcDevicePolicy.Observe(p,journal,provider,runtime);
                            }
                            check();a.WriteOnce("child.result",StartRecords.Encode(new Dictionary<string,object>{{"deviceReceipt",deviceReceipt},{"readGrantReceipt",readGrantReceipt},{"opticalReceipt",opticalReceipt},{"securityReceipt",securityReceipt},{"plan",plan.ContractHash},{"state",result.State},{"vmGuid",result.VmGuid??""},{"ownedReceipt",result.OwnershipReceipt??""},{"settled",result.Settled},{"startAuthorized",false},{"providerOperationFenced",false},{"reservationMayRelease",false}}));
                            return result.State=="defined-native-owned-off"?0:2;
                        }
                    }
                }
            } catch(Exception error) {Console.Error.WriteLine(error.GetType().Name+": "+error.Message);return 1;}
        }
    }
}
