// Explicit SYSTEM legacy handoff worker. The only mutation is the reviewed
// persistent template read fence. VM inventory is read-only; no VM start/stop.
// Uses the same held owner/observer gate; inert contracts cannot select this work.
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
    public static class LegacyHandoffEntry {
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
        static int Owner(ProtectedAttempt a,string contract) {
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
                        long remote=BoundedWorker.DuplicateChildToObserver(child,observer.DangerousGetHandle(),pid,creation);
                        a.WriteOnce("child.binding",remote+","+child.ProcessId+","+child.CreationFileTime+","+a.Token+","+a.Deadline);
                        while(!File.Exists(Path.Combine(a.Root,"release"))) {
                            BoundedWorker.VerifyObserverBeforeResume(observer.DangerousGetHandle(),pid,creation,a.Deadline);Thread.Sleep(5);
                        }
                        if(a.ReadOnce("release")!=a.Token)throw new InvalidOperationException("Child release differs");
                        BoundedWorker.VerifyObserverBeforeResume(observer.DangerousGetHandle(),pid,creation,a.Deadline);return true;
                    });
                a.WriteOnce("owner.result",result.LocalSuccess?"handoff-complete;provider-fenced=false;reservation-release=false":"handoff-failed;reservation-release=false");
                return result.LocalSuccess?0:1;
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
        sealed class ChildAuthority : IDisposable {
            internal ProtectedAttempt A;internal SafeWaitHandle OwnerHandle,ObserverHandle;
            internal uint OwnerPid,ObserverPid;internal long OwnerCreation,ObserverCreation;
            internal void Check(){
                A.CheckDeadline();
                BoundedWorker.VerifyObserverBeforeResume(OwnerHandle.DangerousGetHandle(),OwnerPid,OwnerCreation,A.Deadline);
                BoundedWorker.VerifyObserverBeforeResume(ObserverHandle.DangerousGetHandle(),ObserverPid,ObserverCreation,A.Deadline);
            }
            public void Dispose(){if(OwnerHandle!=null)OwnerHandle.Dispose();if(ObserverHandle!=null)ObserverHandle.Dispose();}
        }
        static ChildAuthority HoldChildAuthority(ProtectedAttempt a){
            var guard=new ChildAuthority{A=a};
            try{
                guard.OwnerHandle=Peer(a,"owner",0,out guard.OwnerPid,out guard.OwnerCreation);
                guard.ObserverHandle=Peer(a,"observer",0,out guard.ObserverPid,out guard.ObserverCreation);
                string[] binding=a.ReadOnce("child.binding").Split(',');
                using(var self=Process.GetCurrentProcess())
                    if(binding.Length!=5||UInt32.Parse(binding[1],CultureInfo.InvariantCulture)!=(uint)self.Id||
                       Number(binding[2])!=self.StartTime.ToUniversalTime().ToFileTimeUtc()||binding[3]!=a.Token||Number(binding[4])!=a.Deadline)
                        throw new InvalidOperationException("Exact child work binding differs");
                if(a.ReadOnce("release")!=a.Token)throw new InvalidOperationException("Closed handoff work gate");
                guard.Check();return guard;
            }catch{guard.Dispose();throw;}
        }
        public static int Main(string[] args) {
            try {
                if(args.Length!=5 || (args[0]!="owner" && args[0]!="observer" && args[0]!="child"))return 64;
                long origin=Number(args[3]),deadline=Number(args[4]);ArmOriginalDeadline(origin,deadline);
                using(var a=ProtectedAttempt.OpenLegacyHandoffWorker(args[1],args[2])) {
                    if(a.Origin!=origin || a.Deadline!=deadline)throw new InvalidOperationException("CLI deadline differs from immutable contract");
                    using(var self=Process.GetCurrentProcess())
                        if(!String.Equals(self.MainModule.FileName,a.Executable,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Entry image path differs");
                    if(args[0]=="owner")return Owner(a,args[1]);
                    if(args[0]=="observer")return Observer(a);
                    a.WriteOnce("child.consumed",Identity(a,"child"));
                    using(var guard=HoldChildAuthority(a)) {
                        LegacyHandoff.Run(a,delegate(){guard.Check();});
                    }

                    return 0;
                }
            } catch(Exception error) {Console.Error.WriteLine(error.GetType().Name+": "+error.Message);return 1;}
        }
    }
}
